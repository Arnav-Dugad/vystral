using System.Collections.Concurrent;
using System.Net;
using System.Text.RegularExpressions;
using Vystral.Core.Data;
using Vystral.Core.Media;

namespace Vystral.Windows.Services;

/// <summary>What a Home tile needs to animate: a proxied micro-trailer URL, or why there is none.</summary>
/// <param name="Reason">off, gameRunning, noSteamApp, none, notChecked, offline, dataSaver, lookupsOff.</param>
public sealed record LiveTileDto(string GameId, string? Src, string? Reason);

/// <summary>
/// Live tiles on Home: Steam's short silent micro-trailers, served to the page from
/// https://media.vystral.example/live/{gameId}/{key}.mp4. The URL is derived from the trailer VYSTRAL
/// already looked up (<see cref="SteamMicroTrailers.Resolve"/>), downloaded once through an allow-listed,
/// no-redirect client with a hard size cap, checked to be an MP4, and kept in a small least-recently-used
/// disk cache (<see cref="CacheBudgetBytes"/>). Nothing is fetched while Offline mode or Data saver is on or a
/// game runs; nothing at all is served while a game runs or the setting is off.
/// </summary>
public sealed partial class LiveTileService : IDisposable
{
    public const string PathPrefix = "/live/";
    internal const long CacheBudgetBytes = 160L * 1024 * 1024;

    private readonly LibraryRepository _repo;
    private readonly SettingsService _settings;
    private readonly TrailerService _trailers;
    private readonly Func<bool> _gameRunning;
    private readonly HttpClient _media;
    private readonly SemaphoreSlim _downloads = new(2);
    private readonly ConcurrentDictionary<string, Lazy<Task<bool>>> _inflight = new(StringComparer.Ordinal);

    public string CacheDirectory { get; }

    public LiveTileService(LibraryRepository repo, SettingsService settings, TrailerService trailers, string cacheDirectory, Func<bool> gameRunning, string userAgent, HttpMessageHandler? handler = null)
    {
        _repo = repo;
        _settings = settings;
        _trailers = trailers;
        _gameRunning = gameRunning;
        CacheDirectory = cacheDirectory;
        Directory.CreateDirectory(cacheDirectory);
        // Like the trailer proxy: never follows redirects, so an allow-listed URL can't bounce elsewhere.
        _media = new HttpClient(handler ?? new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            ConnectTimeout = TimeSpan.FromSeconds(10),
            ConnectCallback = FastConnect.ConnectAsync,
        }, disposeHandler: handler is null)
        { Timeout = TimeSpan.FromSeconds(30) };
        _media.DefaultRequestHeaders.UserAgent.ParseAdd(userAgent);
    }

    /// <summary>Why no tile may animate at all right now (setting off, or a game is running), else null.</summary>
    public string? BlockReason() =>
        !_settings.GetBool("home.liveTiles") ? "off"
        : _gameRunning() ? "gameRunning"
        : null;

    /// <summary>Describes one game's live tile, looking up its Steam trailer first when it was never checked.</summary>
    public async Task<LiveTileDto> GetAsync(string gameId, CancellationToken ct)
    {
        if (BlockReason() is { } block) return new LiveTileDto(gameId, null, block);
        if (_repo.GetSteamAppId(gameId) is null) return new LiveTileDto(gameId, null, "noSteamApp");

        var row = _repo.GetTrailer(gameId);
        // The trailer service owns the lookup (rate-limited, cached for 14 days, respects every block).
        if (row is null || DateTimeOffset.UtcNow - row.Value.Fetched > TimeSpan.FromDays(14))
        {
            var info = await _trailers.GetAsync(gameId, ct);
            row = _repo.GetTrailer(gameId);
            if (row is null) return new LiveTileDto(gameId, null, info.Reason ?? "notChecked");
        }

        if (SteamMicroTrailers.Resolve(row.Value.Trailer) is not { } uri) return new LiveTileDto(gameId, null, "none");
        var key = SteamMicroTrailers.CacheKey(uri);
        // Not cached yet and the network is off-limits: say why instead of handing out a URL that would 404.
        if (!File.Exists(CachePath(gameId, key)) && _trailers.BlockReason() is { } net) return new LiveTileDto(gameId, null, net);
        return new LiveTileDto(gameId, $"https://{MediaService.MediaHost}{PathPrefix}{gameId}/{key}.mp4", null);
    }

    /// <summary>
    /// Serves one cached micro-trailer (downloading it first if allowed). Returns null (→ 404) for anything
    /// that isn't this game's current micro-trailer, while blocked, or when Steam's answer isn't usable.
    /// </summary>
    public async Task<TrailerResponse?> FetchAsync(string absolutePath, string? rangeHeader, CancellationToken ct)
    {
        if (ParseProxyPath(absolutePath) is not { } parsed) return null;
        var (gameId, key) = parsed;
        if (BlockReason() is not null) return null;
        if (SteamMicroTrailers.Resolve(_repo.GetTrailer(gameId)?.Trailer) is not { } uri || SteamMicroTrailers.CacheKey(uri) != key) return null;

        var path = CachePath(gameId, key);
        if (!File.Exists(path))
        {
            if (_trailers.BlockReason() is not null) return null;
            var ok = await _inflight.GetOrAdd(path, _ => new Lazy<Task<bool>>(() => DownloadAsync(gameId, uri, path, ct))).Value;
            _inflight.TryRemove(path, out _);
            if (!ok) return null;
        }

        byte[] body;
        try
        {
            body = await File.ReadAllBytesAsync(path, ct);
            File.SetLastWriteTimeUtc(path, DateTime.UtcNow); // the LRU clock (last-access times are often disabled on NTFS)
        }
        catch (IOException)
        {
            return null;
        }
        return Slice(body, rangeHeader);
    }

    /// <summary>Applies a single "bytes=a-b" request to a cached file; no or unusable ranges get the whole file.</summary>
    internal static TrailerResponse Slice(byte[] body, string? rangeHeader)
    {
        if (TrailerService.ClampRange(rangeHeader, body.Length) is { } r && r.Start < body.Length)
        {
            var end = Math.Min(r.End, body.Length - 1);
            var part = body.AsSpan((int)r.Start, (int)(end - r.Start + 1)).ToArray();
            return new TrailerResponse(206, "Partial Content", part, "video/mp4", $"bytes {r.Start}-{end}/{body.Length}");
        }
        return new TrailerResponse(200, "OK", body, "video/mp4", null);
    }

    private async Task<bool> DownloadAsync(string gameId, Uri uri, string path, CancellationToken ct)
    {
        await _downloads.WaitAsync(ct);
        var temp = path + ".part";
        try
        {
            // HttpClient.Timeout stops at the headers with ResponseHeadersRead: limit the body read too,
            // so a stalled download can't hold one of the download slots forever.
            using var timeout = RequestTimeouts.Link(ct, RequestTimeouts.Media);
            using var response = await _media.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (response.StatusCode != HttpStatusCode.OK) return false;
            if (response.Content.Headers.ContentLength > SteamMicroTrailers.MaxBytes) return false;
            var body = await ReadCappedAsync(response.Content, SteamMicroTrailers.MaxBytes, timeout.Token);
            if (body is null || !SteamMicroTrailers.LooksLikeMp4(body)) return false;
            await File.WriteAllBytesAsync(temp, body, ct);
            File.Move(temp, path, overwrite: true);
            Evict(gameId, path);
            return true;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or UnauthorizedAccessException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            Log.Warn("live-tiles", "Micro-trailer download failed", new { gameId, host = uri.Host }, ex);
            return false;
        }
        finally
        {
            try { File.Delete(temp); } catch (IOException) { }
            _downloads.Release();
        }
    }

    /// <summary>Drops older copies for the same game, then the least recently shown files until the cache fits its budget.</summary>
    internal void Evict(string? gameId = null, string? keep = null, long budget = CacheBudgetBytes)
    {
        try
        {
            var files = new DirectoryInfo(CacheDirectory).GetFiles("*.mp4").OrderByDescending(f => f.LastWriteTimeUtc).ToList();
            long total = 0;
            foreach (var f in files)
            {
                var stale = gameId is not null && f.Name.StartsWith(gameId + "-", StringComparison.Ordinal) && f.FullName != keep;
                if (stale || (total += f.Length) > budget && f.FullName != keep)
                {
                    try { f.Delete(); } catch (IOException) { }
                }
            }
        }
        catch (IOException ex)
        {
            Log.Warn("live-tiles", "Cache cleanup failed", ex: ex);
        }
    }

    /// <summary>Bytes used by cached micro-trailers.</summary>
    public long CacheBytes() =>
        Directory.Exists(CacheDirectory) ? new DirectoryInfo(CacheDirectory).GetFiles("*.mp4").Sum(f => f.Length) : 0;

    /// <summary>Deletes every cached micro-trailer; returns the bytes freed.</summary>
    public long ClearCache()
    {
        long freed = 0;
        foreach (var f in new DirectoryInfo(CacheDirectory).GetFiles())
        {
            try
            {
                var n = f.Length;
                f.Delete();
                freed += n;
            }
            catch (IOException) { }
        }
        return freed;
    }

    private string CachePath(string gameId, string key) => Path.Combine(CacheDirectory, $"{gameId}-{key}.mp4");

    /// <summary>Splits "/live/{32-hex game id}/{16-hex key}.mp4" into its parts, or null.</summary>
    internal static (string GameId, string Key)? ParseProxyPath(string absolutePath)
    {
        var m = ProxyPath().Match(absolutePath);
        return m.Success ? (m.Groups[1].Value, m.Groups[2].Value) : null;
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
        _downloads.Dispose();
    }

    [GeneratedRegex(@"^/live/([0-9a-f]{32})/([0-9a-f]{16})\.mp4\z")]
    private static partial Regex ProxyPath();
}
