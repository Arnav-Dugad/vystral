using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Data;
using Vystral.Core.Media;

namespace Vystral.Windows.Services;

/// <summary>What the detail page needs to know about a game's trailer.</summary>
/// <param name="Reason">Why there is no playable trailer: noSteamApp, none, notChecked, offline, dataSaver, gameRunning, lookupsOff.</param>
public sealed record TrailerDto(bool Available, string? Kind, string? Src, string? Name, string? Reason, string Source);

/// <summary>A proxied trailer response, already size-limited.</summary>
public sealed record TrailerResponse(int Status, string Reason, byte[] Body, string ContentType, string? ContentRange)
{
    public string Headers(string allowOrigin)
    {
        var sb = new StringBuilder();
        sb.Append("Content-Type: ").Append(ContentType).Append("\r\n");
        sb.Append("Content-Length: ").Append(Body.Length).Append("\r\n");
        if (ContentRange is not null) sb.Append("Content-Range: ").Append(ContentRange).Append("\r\nAccept-Ranges: bytes\r\n");
        sb.Append("Cache-Control: max-age=600\r\n");
        sb.Append("X-Content-Type-Options: nosniff\r\n");
        sb.Append("Access-Control-Allow-Origin: ").Append(allowOrigin);
        return sb.ToString();
    }
}

/// <summary>
/// Steam trailers for detail pages, delivered through a filtered proxy on the existing media host
/// (https://media.vystral.example/trailer/{gameId}/…). The page never talks to Steam directly
/// (its CSP forbids it); instead each request is mapped through <see cref="SteamTrailers.ResolveUpstream"/>,
/// which only permits the stored trailer's own playlist and segment files on Steam's video CDN.
/// Nothing is written to disk. Requests are refused while Offline mode or Data saver is on, or a game runs.
/// </summary>
public sealed partial class TrailerService : IDisposable
{
    public const string PathPrefix = "/trailer/";
    private static readonly TimeSpan RecheckAfter = TimeSpan.FromDays(14);
    private static readonly TimeSpan RequestSpacing = TimeSpan.FromMilliseconds(1600);
    internal const int MaxPlaylistBytes = 256 * 1024;
    internal const int MaxSegmentBytes = 12 * 1024 * 1024;
    internal const int MaxRangeChunk = 4 * 1024 * 1024;

    private readonly LibraryRepository _repo;
    private readonly SettingsService _settings;
    private readonly NetworkCostService _network;
    private readonly HttpClient _api;
    private readonly HttpClient _media;
    private readonly Func<bool> _gameRunning;
    private readonly SemaphoreSlim _upstream = new(4);
    private readonly SemaphoreSlim _lookup = new(1);
    private DateTime _nextLookup = DateTime.MinValue;

    public TrailerService(LibraryRepository repo, SettingsService settings, NetworkCostService network, HttpClient api, Func<bool> gameRunning, string userAgent)
    {
        _repo = repo;
        _settings = settings;
        _network = network;
        _api = api;
        _gameRunning = gameRunning;
        // A dedicated client that never follows redirects, so an allow-listed URL can't bounce elsewhere.
        _media = new HttpClient(new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            ConnectTimeout = TimeSpan.FromSeconds(10),
            ConnectCallback = FastConnect.ConnectAsync,
        })
        { Timeout = TimeSpan.FromSeconds(25) };
        _media.DefaultRequestHeaders.UserAgent.ParseAdd(userAgent);
    }

    /// <summary>Data saver is on manually, or automatically because Windows reports a metered connection.</summary>
    public bool DataSaverActive => _settings.GetBool("dataSaver.enabled") || (_settings.GetBool("dataSaver.onMetered") && _network.Current.Metered);

    /// <summary>Why trailer network traffic isn't allowed right now, or null when it is.</summary>
    public string? BlockReason() =>
        _settings.GetBool("privacy.localOnly") ? "offline"
        : _gameRunning() ? "gameRunning"
        : DataSaverActive ? "dataSaver"
        : null;

    /// <summary>Describes the trailer for a game, looking it up on Steam first if it was never checked or is stale.</summary>
    public async Task<TrailerDto> GetAsync(string gameId, CancellationToken ct)
    {
        const string source = "Steam";
        var appId = _repo.GetSteamAppId(gameId);
        if (appId is null || !AppId().IsMatch(appId)) return new TrailerDto(false, null, null, null, "noSteamApp", source);

        var row = _repo.GetTrailer(gameId);
        var block = BlockReason();
        var stale = row is null || row.Value.SteamAppId != appId || DateTimeOffset.UtcNow - row.Value.Fetched > RecheckAfter;
        if (stale && block is null)
        {
            if (!_settings.GetBool("library.fetchMetadata"))
            {
                if (row is null) return new TrailerDto(false, null, null, null, "lookupsOff", source);
            }
            else
            {
                await LookupAsync(gameId, appId, ct);
                row = _repo.GetTrailer(gameId);
            }
        }
        if (block is not null) return new TrailerDto(false, null, null, row?.Trailer?.Name, block, source);
        if (row is null) return new TrailerDto(false, null, null, null, "notChecked", source);
        if (row.Value.Trailer is not { } t) return new TrailerDto(false, null, null, null, "none", source);

        var hls = t.Format == "hls";
        var src = $"https://{MediaService.MediaHost}{PathPrefix}{gameId}/{(hls ? SteamTrailers.MasterEntry : SteamTrailers.FileEntry)}";
        return new TrailerDto(true, hls ? "hls" : "file", src, t.Name, null, source);
    }

    private async Task LookupAsync(string gameId, string appId, CancellationToken ct)
    {
        await _lookup.WaitAsync(ct);
        try
        {
            var wait = _nextLookup - DateTime.UtcNow;
            if (wait > TimeSpan.Zero) await Task.Delay(wait, ct);
            _nextLookup = DateTime.UtcNow + RequestSpacing;
            var json = await _api.GetStringAsync($"https://store.steampowered.com/api/appdetails?appids={appId}&l=english", ct);
            _repo.SetTrailer(gameId, appId, SteamTrailers.Select(appId, json));
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            // Keep whatever was known before; try again on a later visit.
            Log.Warn("trailer", "Trailer lookup failed", new { gameId }, ex);
        }
        finally
        {
            _lookup.Release();
        }
    }

    /// <summary>
    /// Serves one proxied trailer file. Returns null (→ 404) for anything not allow-listed, when
    /// trailers aren't allowed right now, or when Steam doesn't answer with a usable response.
    /// </summary>
    public async Task<TrailerResponse?> FetchAsync(string absolutePath, string? rangeHeader, CancellationToken ct)
    {
        if (ParseProxyPath(absolutePath) is not { } parsed) return null;
        var (gameId, relative) = parsed;
        if (BlockReason() is not null) return null;
        if (_repo.GetTrailer(gameId)?.Trailer is not { } trailer) return null;
        var upstream = SteamTrailers.ResolveUpstream(trailer, relative);
        if (upstream is null) return null;

        var single = relative == SteamTrailers.FileEntry;
        var limit = relative.EndsWith(".m3u8", StringComparison.Ordinal) ? MaxPlaylistBytes : single ? MaxRangeChunk : MaxSegmentBytes;
        using var request = new HttpRequestMessage(HttpMethod.Get, upstream);
        if (single)
        {
            var (start, end) = ClampRange(rangeHeader, MaxRangeChunk) ?? (0, MaxRangeChunk - 1);
            request.Headers.Range = new RangeHeaderValue(start, end);
        }

        await _upstream.WaitAsync(ct);
        try
        {
            using var response = await _media.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if (response.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.PartialContent)) return null;
            if (response.Content.Headers.ContentLength > limit) return null;
            var body = await ReadCappedAsync(response.Content, limit, ct);
            if (body is null) return null;
            var type = SteamTrailers.ContentTypeFor(trailer, relative);
            if (response.StatusCode == HttpStatusCode.PartialContent && response.Content.Headers.ContentRange is { } cr)
                return new TrailerResponse(206, "Partial Content", body, type, cr.ToString());
            return new TrailerResponse(200, "OK", body, type, null);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            Log.Warn("trailer", "Trailer request failed", new { gameId, host = upstream.Host }, ex);
            return null;
        }
        finally
        {
            _upstream.Release();
        }
    }

    /// <summary>Splits "/trailer/{32-hex id}/{relative}" into its parts, or null.</summary>
    internal static (string GameId, string Relative)? ParseProxyPath(string absolutePath)
    {
        var m = ProxyPath().Match(absolutePath);
        return m.Success ? (m.Groups[1].Value, m.Groups[2].Value) : null;
    }

    /// <summary>
    /// Turns a single "bytes=a-b" / "bytes=a-" request into a range no larger than <paramref name="maxChunk"/>.
    /// A server may answer with less than was asked for; the media element then asks for the rest.
    /// Returns null for absent, multi-range or suffix ranges (the caller starts at byte 0).
    /// </summary>
    internal static (long Start, long End)? ClampRange(string? header, long maxChunk)
    {
        if (header is null) return null;
        var m = RangeHeader().Match(header.Trim());
        if (!m.Success || !long.TryParse(m.Groups[1].Value, out var start)) return null;
        var end = start + maxChunk - 1;
        if (m.Groups[2].Success && long.TryParse(m.Groups[2].Value, out var requested))
        {
            if (requested < start) return null;
            end = Math.Min(end, requested);
        }
        return (start, end);
    }

    private static async Task<byte[]?> ReadCappedAsync(HttpContent content, int limit, CancellationToken ct)
    {
        await using var stream = await content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(chunk, ct)) > 0)
        {
            buffer.Write(chunk, 0, read);
            if (buffer.Length > limit) return null;
        }
        return buffer.ToArray();
    }

    public void Dispose()
    {
        _media.Dispose();
        _upstream.Dispose();
        _lookup.Dispose();
    }

    [GeneratedRegex(@"^/trailer/([0-9a-f]{32})/([A-Za-z0-9_./\-]{1,120})\z")]
    private static partial Regex ProxyPath();

    [GeneratedRegex(@"^bytes=([0-9]{1,15})-([0-9]{1,15})?\z")]
    private static partial Regex RangeHeader();

    [GeneratedRegex(@"^[0-9]{1,10}\z")]
    private static partial Regex AppId();
}
