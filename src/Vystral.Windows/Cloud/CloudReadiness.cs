using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using Vystral.Windows.Services;
using Vystral.Windows.Services.NetworkHealth;

namespace Vystral.Windows.Cloud;

public sealed record CloudReadinessProbeDto(string Service, string Host, IReadOnlyList<int> Samples, int Attempts, int? LatencyMs, int? JitterMs, double Loss, string? Error);

public sealed record CloudReadinessDto(
    string CheckedAt, string Link, int? LinkMbps, string? WifiBand, bool Metered, IReadOnlyList<CloudReadinessProbeDto> Probes,
    string Level, string Summary, IReadOnlyList<string> Tips, string Method, string? Reason);

/// <summary>The active network adapter as Windows reports it: kind ("ethernet", "wifi", "cellular", "other", "unknown") and link speed.</summary>
public sealed record LinkInfo(string Kind, int? Mbps, string? WifiBand);

/// <summary>
/// Track D5: turns cloud readiness measurements into a level and plain, honest words. Pure (tested). Thresholds follow
/// the vendors' published guidance: GeForce NOW asks for under 80 ms to its data centre (under 40 ms ideally) and 15–25
/// Mbps for 720p–1080p at 60 fps, and both vendors recommend 5 GHz Wi-Fi or Ethernet.
/// </summary>
public static class CloudReadinessClassifier
{
    public const string Method =
        "Six short connections to each service’s public website (no game data, nothing about you). That shows the round trip to a nearby server and how steady it is. " +
        "The stream itself runs from the service’s data centres, so in-game delay can differ, and the link speed is your adapter’s speed to your router, not your internet speed.";

    private static readonly string[] Order = ["unknown", "poor", "fair", "good", "great"];

    /// <summary>Median, mean absolute successive difference and loss for one host.</summary>
    public static (int? Median, int? Jitter, double Loss) Stats(IReadOnlyList<int> samples, int attempts)
    {
        var loss = attempts <= 0 ? 0 : Math.Round(Math.Clamp(1 - samples.Count / (double)attempts, 0, 1), 3);
        if (samples.Count == 0) return (null, null, loss);
        var sorted = samples.Order().ToList();
        var mid = sorted.Count / 2;
        var median = sorted.Count % 2 == 1 ? sorted[mid] : (int)Math.Round((sorted[mid - 1] + sorted[mid]) / 2.0);
        int? jitter = null;
        if (samples.Count > 1)
        {
            double sum = 0;
            for (var i = 1; i < samples.Count; i++) sum += Math.Abs(samples[i] - samples[i - 1]);
            jitter = (int)Math.Round(sum / (samples.Count - 1));
        }
        return (median, jitter, loss);
    }

    private static string Cap(string level, string max) => Array.IndexOf(Order, level) > Array.IndexOf(Order, max) ? max : level;

    public static CloudReadinessDto Classify(IReadOnlyList<CloudReadinessProbeDto> probes, LinkInfo link, bool metered, DateTimeOffset now)
    {
        var answered = probes.Where(p => p.LatencyMs is not null).ToList();
        var tips = new List<string>();
        string level;
        if (answered.Count == 0)
        {
            level = "unknown";
        }
        else
        {
            // The best service is what you'd use; its numbers decide the level.
            var best = answered.OrderBy(p => p.LatencyMs).First();
            var lat = best.LatencyMs!.Value;
            var jit = best.JitterMs ?? 0;
            var loss = best.Loss;
            level = lat <= 30 && jit <= 5 && loss == 0 ? "great"
                : lat <= 50 && jit <= 10 && loss == 0 ? "good"
                : lat <= 80 && jit <= 20 && loss <= 0.17 ? "fair"
                : "poor";
            if (lat > 80) tips.Add($"Round trips around {lat} ms make games feel slow to respond. GeForce NOW recommends under 80 ms, and under 40 ms for fast games.");
            else if (lat > 40 && level != "great") tips.Add($"Round trips around {lat} ms are playable, but fast games feel a little behind. Ethernet or a closer Wi-Fi access point helps.");
            if (jit > 15) tips.Add("Some answers took much longer than others (jitter), which streams feel as stutter. Pausing downloads and video on this network can help.");
            if (loss > 0)
            {
                var missed = probes.Sum(p => p.Attempts - p.Samples.Count);
                var total = probes.Sum(p => p.Attempts);
                tips.Add(missed == 1 ? "One attempt got no answer." : $"{missed} of {total} attempts got no answer.");
            }
        }
        if (link.Kind == "wifi" && link.WifiBand == "2.4")
        {
            level = Cap(level, "good");
            tips.Insert(0, "You’re on 2.4 GHz Wi-Fi. A 5 GHz network or an Ethernet cable usually helps the most.");
        }
        else if (link.Kind == "wifi" && level is not "great" and not "unknown")
        {
            tips.Add("On Wi-Fi, a 5 GHz network or an Ethernet cable gives the steadiest stream.");
        }
        if (link.Kind == "cellular")
        {
            level = Cap(level, "fair");
            tips.Add("You’re on mobile data: streams can use several GB an hour and quality changes as the signal does.");
        }
        if (link.Mbps is { } mbps && mbps < 25 && link.Kind is "ethernet" or "wifi")
        {
            level = Cap(level, "fair");
            tips.Add($"Your adapter’s link is {mbps} Mbps. GeForce NOW recommends at least 25 Mbps for 1080p at 60 fps, and Xbox Cloud Gaming 20 Mbps.");
        }
        if (metered && link.Kind != "cellular") tips.Add("This connection is set as metered: streaming can use several GB an hour.");

        var summary = level switch
        {
            "great" => "Your connection looks great for cloud play.",
            "good" => "Your connection looks good for cloud play.",
            "fair" => "Cloud play should work, with a little more delay than ideal.",
            "poor" => "Cloud play may stutter or look soft on this connection right now.",
            _ => "Neither service answered, so VYSTRAL couldn’t measure anything. Check your connection, then try again.",
        };
        return new CloudReadinessDto(now.ToString("O"), link.Kind, link.Mbps, link.WifiBand, metered, probes, level, summary, tips.Distinct().Take(5).ToList(), Method, null);
    }
}

/// <summary>
/// Track D5: the cloud readiness check. Only when the user asks (and never in Offline mode): a few sequential TCP
/// connections (no request, no payload) to each service's public website through the same probe I/O Network health
/// uses, plus what Windows says about the active adapter. The last result is kept in memory for a day.
/// </summary>
public sealed class CloudReadinessService(INetworkProbeIo io, Func<DateTimeOffset>? now = null)
{
    public const int Attempts = 6;
    public static readonly TimeSpan AttemptTimeout = TimeSpan.FromSeconds(3);
    public static readonly TimeSpan Gap = TimeSpan.FromMilliseconds(120);

    /// <summary>Fixed, public hosts: nothing from the page decides where VYSTRAL connects.</summary>
    public static readonly IReadOnlyList<(string Service, string Host)> Hosts = [("gfn", "play.geforcenow.com"), ("xbox", "www.xbox.com")];

    private readonly Func<DateTimeOffset> _now = now ?? (() => DateTimeOffset.Now);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private CloudReadinessDto? _last;

    public Func<LinkInfo> Link { get; init; } = ReadLink;
    public TimeSpan Timeout { get; init; } = AttemptTimeout;
    public TimeSpan Pause { get; init; } = Gap;

    public CloudReadinessDto? Last => _last is { } l && DateTimeOffset.TryParse(l.CheckedAt, out var at) && _now() - at < TimeSpan.FromDays(1) ? l : null;

    public async Task<CloudReadinessDto> RunAsync(IEnumerable<string> services, bool metered, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var wanted = services.ToHashSet(StringComparer.Ordinal);
            var hosts = Hosts.Where(h => wanted.Count == 0 || wanted.Contains(h.Service)).ToList();
            var probes = new List<CloudReadinessProbeDto>();
            foreach (var (service, host) in hosts) probes.Add(await MeasureAsync(service, host, ct));
            var dto = CloudReadinessClassifier.Classify(probes, Link(), metered, _now());
            _last = dto;
            Log.Info("cloud", "Cloud readiness checked", new { dto.Level, probes = probes.Select(p => new { p.Service, p.LatencyMs, p.JitterMs, p.Loss }) });
            return dto;
        }
        finally { _gate.Release(); }
    }

    private async Task<CloudReadinessProbeDto> MeasureAsync(string service, string host, CancellationToken ct)
    {
        IPAddress address;
        try
        {
            var all = await io.ResolveAsync(host, ct);
            address = all.FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork) ?? all.FirstOrDefault() ?? throw new SocketException((int)SocketError.HostNotFound);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return new CloudReadinessProbeDto(service, host, [], Attempts, null, null, 1, NetworkErrors.Describe(ex).Text);
        }
        var samples = new List<int>();
        string? error = null;
        for (var i = 0; i < Attempts; i++)
        {
            if (i > 0) await Task.Delay(Pause, ct);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(Timeout);
            var sw = Stopwatch.StartNew();
            try
            {
                await io.ConnectAsync(address, 443, timeout.Token);
                samples.Add((int)Math.Max(1, Math.Round(sw.Elapsed.TotalMilliseconds)));
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                error ??= $"No answer within {Timeout.TotalSeconds:0} s";
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                error ??= NetworkErrors.Describe(ex).Text;
            }
        }
        var (median, jitter, loss) = CloudReadinessClassifier.Stats(samples, Attempts);
        return new CloudReadinessProbeDto(service, host, samples, Attempts, median, jitter, loss, samples.Count == 0 ? error : null);
    }

    /// <summary>The adapter carrying the default route: Ethernet, Wi-Fi or mobile, and its link speed. Read-only.</summary>
    public static LinkInfo ReadLink()
    {
        try
        {
            var nic = NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel))
                .Select(n => (n, props: SafeProps(n)))
                .Where(x => x.props?.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any)) == true)
                .Select(x => x.n)
                .OrderByDescending(n => n.Speed)
                .FirstOrDefault();
            if (nic is null) return new LinkInfo("unknown", null, null);
            var kind = nic.NetworkInterfaceType switch
            {
                NetworkInterfaceType.Wireless80211 => "wifi",
                NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet or NetworkInterfaceType.FastEthernetT or NetworkInterfaceType.FastEthernetFx => "ethernet",
                NetworkInterfaceType.Wwanpp or NetworkInterfaceType.Wwanpp2 => "cellular",
                _ => "other",
            };
            int? mbps = nic.Speed > 0 && nic.Speed < 1_000_000_000_000 ? (int)(nic.Speed / 1_000_000) : null;
            // Windows doesn't say the Wi-Fi band here; it's left unknown rather than guessed.
            return new LinkInfo(kind, mbps, null);
        }
        catch (Exception ex) when (ex is NetworkInformationException or InvalidOperationException or PlatformNotSupportedException)
        {
            return new LinkInfo("unknown", null, null);
        }
    }

    private static IPInterfaceProperties? SafeProps(NetworkInterface n)
    {
        try { return n.GetIPProperties(); }
        catch (NetworkInformationException) { return null; }
    }
}
