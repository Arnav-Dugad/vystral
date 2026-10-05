using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;

namespace Vystral.Windows.Services.NetworkHealth;

/// <summary>What a probe can know about the user's configuration.</summary>
public sealed record HealthContext(Func<string, bool> Setting, bool SteamWebApiConfigured);

/// <summary>
/// One service VYSTRAL talks to. Other features register their own (see
/// <see cref="NetworkHealthService.Register"/>): a probe is a single lightweight request plus
/// optional rules for when it's hidden or skipped.
/// </summary>
public sealed record HealthProbe
{
    /// <summary>Stable id, e.g. "github.api". Registering the same id again replaces the probe.</summary>
    public required string Id { get; init; }
    /// <summary>Row title, e.g. "GitHub releases".</summary>
    public required string Label { get; init; }
    /// <summary>What VYSTRAL uses it for, e.g. "Update checks".</summary>
    public required string Purpose { get; init; }
    public required Uri Url { get; init; }
    /// <summary>HEAD by default; GET for endpoints that don't answer HEAD.</summary>
    public HttpMethod Method { get; init; } = HttpMethod.Head;
    /// <summary>The host whose addresses are tested one by one (default: the URL's host), e.g. a redirect target.</summary>
    public string? AddressHost { get; init; }
    /// <summary>For CDNs: any HTTP answer (even 403/404 for a bare URL) proves the service is reachable.</summary>
    public bool AnyResponseIsHealthy { get; init; }
    /// <summary>Services on this PC (localhost) are still checked in Offline mode.</summary>
    public bool Local { get; init; }
    /// <summary>Hidden entirely when false (e.g. an optional provider that isn't set up).</summary>
    public Func<HealthContext, bool>? Visible { get; init; }
    /// <summary>A reason the probe is shown but not run (e.g. "Game details are off").</summary>
    public Func<HealthContext, string?>? SkipReason { get; init; }
}

public sealed record HealthProbeInfo(string Id, string Label, string Purpose, string Host, bool Local, string? Skipped);

public sealed record HealthResult(
    string Id, string Label, string Purpose, string Host, string Status, string Summary, string? Detail,
    int? Ms, IReadOnlyList<AddressCheck> Addresses, string CheckedAt);

/// <summary>The network operations a check needs (faked in tests).</summary>
public interface INetworkProbeIo
{
    Task<IPAddress[]> ResolveAsync(string host, CancellationToken ct);
    /// <summary>Opens and closes one TCP connection; throws on failure.</summary>
    Task ConnectAsync(IPAddress address, int port, CancellationToken ct);
    Task<ProbeResponse> SendAsync(HttpMethod method, Uri url, CancellationToken ct);
}

public sealed record ProbeResponse(int Status, IReadOnlyDictionary<string, string> Headers);

/// <summary>
/// Settings → Privacy → Network health. Runs only when asked ("Check now"), never in the
/// background: per service it resolves every address, tries each one briefly (the same addresses
/// <see cref="FastConnect"/> races), then makes one lightweight request. Offline mode skips
/// everything that leaves this PC.
/// </summary>
public sealed class NetworkHealthService
{
    public static readonly TimeSpan AddressTimeout = TimeSpan.FromSeconds(3);
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);
    private const int MaxAddresses = 8;

    private readonly INetworkProbeIo _io;
    private readonly Func<HealthContext> _context;
    private readonly Func<DateTimeOffset> _now;
    private readonly Lock _lock = new();
    private readonly List<HealthProbe> _probes = [];

    public NetworkHealthService(INetworkProbeIo io, Func<HealthContext> context, Func<DateTimeOffset>? now = null, bool builtIns = true)
    {
        _io = io;
        _context = context;
        _now = now ?? (() => DateTimeOffset.Now);
        if (builtIns) foreach (var p in BuiltInProbes()) Register(p);
    }

    /// <summary>Extension point: adds (or replaces, by id) a service shown in Network health.</summary>
    public void Register(HealthProbe probe)
    {
        lock (_lock)
        {
            _probes.RemoveAll(p => p.Id == probe.Id);
            _probes.Add(probe);
        }
    }

    public IReadOnlyList<HealthProbeInfo> List()
    {
        var ctx = _context();
        return [.. Snapshot().Where(p => p.Visible?.Invoke(ctx) ?? true).Select(p => new HealthProbeInfo(p.Id, p.Label, p.Purpose, HostOf(p), p.Local, Skip(p, ctx)))];
    }

    public async Task<IReadOnlyList<HealthResult>> CheckAsync(string? id, CancellationToken ct)
    {
        var ctx = _context();
        var probes = Snapshot().Where(p => (p.Visible?.Invoke(ctx) ?? true) && (id is null || p.Id == id)).ToList();
        if (id is not null && probes.Count == 0) throw new ArgumentException("Unknown service.");
        var results = await Task.WhenAll(probes.Select(p => RunAsync(p, ctx, ct)));
        Log.Info("network", "Network health checked", new { results = results.Select(r => new { r.Id, r.Status, r.Ms }) });
        return results;
    }

    private async Task<HealthResult> RunAsync(HealthProbe p, HealthContext ctx, CancellationToken ct)
    {
        var host = HostOf(p);
        if (Skip(p, ctx) is { } reason)
            return new HealthResult(p.Id, p.Label, p.Purpose, host, "skipped", reason, null, null, [], _now().ToString("O"));

        var addressTask = CheckAddressesAsync(host, p.Url.Port, ct);
        var httpTask = RequestAsync(p, ct);
        await Task.WhenAll(addressTask, httpTask);
        var (dnsError, addresses) = addressTask.Result;
        var (status, ms, failure, headers) = httpTask.Result;

        var verdict = HealthClassifier.Classify(new HealthObservation
        {
            Host = host,
            DnsError = dnsError,
            Addresses = addresses,
            HttpStatus = status,
            HttpMs = ms,
            HttpFailure = failure,
            Headers = headers,
            AnyResponseIsHealthy = p.AnyResponseIsHealthy,
            TimeoutSeconds = RequestTimeout.TotalSeconds,
            Now = _now(),
        });
        return new HealthResult(p.Id, p.Label, p.Purpose, host, verdict.Status, verdict.Summary, verdict.Detail, ms, addresses, _now().ToString("O"));
    }

    private async Task<(string? DnsError, IReadOnlyList<AddressCheck> Addresses)> CheckAddressesAsync(string host, int port, CancellationToken ct)
    {
        IPAddress[] resolved;
        try
        {
            resolved = IPAddress.TryParse(host, out var literal) ? [literal] : await _io.ResolveAsync(host, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return (NetworkErrors.Describe(ex).Text, []);
        }
        var checks = await Task.WhenAll(resolved.Take(MaxAddresses).Select(async a =>
        {
            var sw = Stopwatch.StartNew();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(AddressTimeout);
            try
            {
                await _io.ConnectAsync(a, port, timeout.Token);
                return new AddressCheck(a.ToString(), Family(a), true, (int)sw.ElapsedMilliseconds, null);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return new AddressCheck(a.ToString(), Family(a), false, null, $"No answer within {AddressTimeout.TotalSeconds:0} s");
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return new AddressCheck(a.ToString(), Family(a), false, null, NetworkErrors.Describe(ex).Text);
            }
        }));
        return (resolved.Length == 0 ? "No addresses" : null, checks);
    }

    private async Task<(int? Status, int? Ms, NetworkFailure? Failure, IReadOnlyDictionary<string, string> Headers)> RequestAsync(HealthProbe p, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(RequestTimeout);
        try
        {
            var response = await _io.SendAsync(p.Method, p.Url, timeout.Token);
            return (response.Status, (int)sw.ElapsedMilliseconds, null, response.Headers);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return (null, null, new NetworkFailure("timeout", $"No answer within {RequestTimeout.TotalSeconds:0} s"), new Dictionary<string, string>());
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return (null, null, NetworkErrors.Describe(ex), new Dictionary<string, string>());
        }
    }

    private string? Skip(HealthProbe p, HealthContext ctx)
    {
        if (!p.Local && ctx.Setting("privacy.localOnly")) return "Skipped: Offline mode is on";
        return p.SkipReason?.Invoke(ctx);
    }

    private List<HealthProbe> Snapshot()
    {
        lock (_lock) return [.. _probes];
    }

    private static string HostOf(HealthProbe p) => p.AddressHost ?? p.Url.Host;
    private static string Family(IPAddress a) => a.AddressFamily == AddressFamily.InterNetworkV6 ? "IPv6" : "IPv4";

    /// <summary>The services VYSTRAL itself uses. Hosts match the real requests in the code.</summary>
    public static IEnumerable<HealthProbe> BuiltInProbes() =>
    [
        new()
        {
            Id = "github.api", Label = "GitHub releases", Purpose = "Update checks",
            // /rate_limit doesn't count against the limit and reports how much is left.
            Url = new Uri("https://api.github.com/rate_limit"), Method = HttpMethod.Get,
        },
        new()
        {
            Id = "github.download", Label = "GitHub downloads", Purpose = "Downloading updates",
            Url = new Uri(UpdateService.RepositoryUrl + "/releases/latest/download/releases.win.json"), Method = HttpMethod.Get,
            // Release files redirect here; this is the host whose addresses can be partly unreachable.
            AddressHost = "release-assets.githubusercontent.com",
        },
        new()
        {
            Id = "steam.store", Label = "Steam store", Purpose = "Game details",
            Url = new Uri("https://store.steampowered.com/api/appdetails?appids=10&filters=basic"), Method = HttpMethod.Get,
            SkipReason = c => c.Setting("library.fetchMetadata") ? null : "Not used: game details are off",
        },
        new()
        {
            Id = "steam.cdn", Label = "Steam image servers", Purpose = "Artwork",
            Url = new Uri("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg"),
            AnyResponseIsHealthy = true,
            SkipReason = c => c.Setting("library.fetchArtwork") ? null : "Not used: artwork downloads are off",
        },
        new()
        {
            Id = "steam.webapi", Label = "Steam Web API", Purpose = "Owned games and achievements (your key)",
            // A keyless endpoint: the check never sends your key anywhere.
            Url = new Uri("https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/"), Method = HttpMethod.Get,
            Visible = c => c.SteamWebApiConfigured,
        },
        new()
        {
            Id = "steam.video", Label = "Steam video servers", Purpose = "Trailers",
            Url = new Uri("https://video.akamai.steamstatic.com/"), AnyResponseIsHealthy = true,
            SkipReason = c => !c.Setting("library.fetchMetadata") ? "Not used: game details are off"
                : c.Setting("dataSaver.enabled") ? "Not used: Data saver is on" : null,
        },
        new()
        {
            Id = "ollama", Label = "Local AI (Ollama)", Purpose = "Assistant, on this PC",
            Url = new Uri("http://127.0.0.1:11434/api/version"), Method = HttpMethod.Get, Local = true,
            Visible = c => c.Setting("ai.enabled"),
        },
    ];
}

/// <summary>Real network I/O: system DNS, one TCP connect per address, and HttpClient with <see cref="FastConnect"/>.</summary>
public sealed class SystemNetworkProbeIo(string version) : INetworkProbeIo, IDisposable
{
    private readonly HttpClient _http = CreateClient(version);

    private static HttpClient CreateClient(string version)
    {
        var handler = FastConnect.CreateHandler();
        handler.UseCookies = false;
        handler.ConnectTimeout = NetworkHealthService.RequestTimeout;
        var http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"VYSTRAL/{version}");
        return http;
    }

    public Task<IPAddress[]> ResolveAsync(string host, CancellationToken ct) => Dns.GetHostAddressesAsync(host, ct);

    public async Task ConnectAsync(IPAddress address, int port, CancellationToken ct)
    {
        using var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        await socket.ConnectAsync(new IPEndPoint(address, port), ct);
    }

    public async Task<ProbeResponse> SendAsync(HttpMethod method, Uri url, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, url);
        // Headers only: the body is never downloaded.
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in new[] { "X-RateLimit-Remaining", "X-RateLimit-Limit", "X-RateLimit-Reset", "Retry-After" })
            if (response.Headers.TryGetValues(name, out var values)) headers[name] = values.First();
        return new ProbeResponse((int)response.StatusCode, headers);
    }

    public void Dispose() => _http.Dispose();
}
