using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Vystral.Core.Data;
using Vystral.Core.Domain;

namespace Vystral.Windows.Services;

/// <summary>
/// Keeps a private artwork cache that the UI can read through a dedicated virtual host.
/// Only files inside the cache folder are ever exposed to the web layer. Downloaded data is
/// treated as untrusted: size-limited, content-sniffed, and written atomically.
/// </summary>
public sealed partial class ArtworkService(AppPaths paths, LibraryRepository repo, HttpClient http)
{
    public const string ArtHost = "art.vystral.example";
    private const long MaxBytes = 12 * 1024 * 1024;
    private const string SteamCdn = "https://shared.akamai.steamstatic.com/store_item_assets/";

    public static string Url(string gameId, string relativeFile) => $"https://{ArtHost}/{relativeFile.Replace('\\', '/')}";

    /// <summary>Copies a local image (e.g. from Steam's cache) into the art cache if it changed.</summary>
    public bool ImportLocal(string gameId, ArtworkKind kind, string sourcePath, string source)
    {
        try
        {
            var info = new FileInfo(sourcePath);
            if (!info.Exists || info.Length == 0 || info.Length > MaxBytes) return false;
            var ext = info.Extension.ToLowerInvariant();
            if (ext is not (".jpg" or ".jpeg" or ".png" or ".webp")) return false;
            var stamp = Hash($"{info.FullName}|{info.Length}|{info.LastWriteTimeUtc.Ticks}");
            var relative = Path.Combine(gameId, $"{kind.ToString().ToLowerInvariant()}-{stamp}{ext}");
            var dest = Path.Combine(paths.ArtCache, relative);
            if (!File.Exists(dest))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                var bytes = File.ReadAllBytes(info.FullName);
                if (!LooksLikeImage(bytes)) return false;
                WriteAtomic(dest, bytes);
            }
            repo.SetArtwork(gameId, kind, relative, source, isUser: source == "user");
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn("art", "Local artwork import failed", new { gameId, kind }, ex);
            return false;
        }
    }

    /// <summary>
    /// Imports the art a store scan found on disk, never replacing art the user picked or a better
    /// downloaded image, and never importing Steam's flat grey placeholder.
    /// </summary>
    public void ImportScanned(string gameId, IReadOnlyDictionary<ArtworkKind, string> found, string source)
    {
        if (found.Count == 0) return;
        var existing = repo.GetArtworkSources(gameId);
        foreach (var (kind, path) in found)
        {
            if (existing.TryGetValue(kind.ToString().ToLowerInvariant(), out var e) && (e.IsUser || !e.Source.EndsWith("-local", StringComparison.Ordinal))) continue;
            long length;
            try { length = new FileInfo(path).Length; }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { continue; }
            if (IsPlaceholder(kind, length)) continue;
            ImportLocal(gameId, kind, path, source);
        }
    }

    /// <summary>When it returns true (Data saver), artwork downloads are skipped; local imports still work.</summary>
    public Func<bool>? SkipDownloads { get; set; }

    public async Task<bool> DownloadAsync(string gameId, ArtworkKind kind, string url, string source, CancellationToken ct)
    {
        if (SkipDownloads?.Invoke() == true) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return false;
        try
        {
            // HttpClient.Timeout stops at the headers with ResponseHeadersRead: limit the body read too.
            using var timeout = RequestTimeouts.Link(ct, RequestTimeouts.Media);
            using var response = await http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden) return false;
            response.EnsureSuccessStatusCode();
            if (response.Content.Headers.ContentLength > MaxBytes) return false;
            var media = response.Content.Headers.ContentType?.MediaType ?? "";
            if (!media.StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return false;

            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(chunk, timeout.Token)) > 0)
            {
                buffer.Write(chunk, 0, read);
                if (buffer.Length > MaxBytes) return false;
            }
            var bytes = buffer.ToArray();
            if (!LooksLikeImage(bytes)) return false;
            if (IsPlaceholder(kind, bytes.Length))
            {
                Log.Info("art", "Skipped a placeholder image", new { gameId, kind, bytes = bytes.Length });
                return false;
            }
            var ext = bytes[0] == 0x89 ? ".png" : bytes[0] == 0xFF ? ".jpg" : ".webp";
            var relative = Path.Combine(gameId, $"{kind.ToString().ToLowerInvariant()}-{Hash(url)}{ext}");
            var dest = Path.Combine(paths.ArtCache, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            WriteAtomic(dest, bytes);
            repo.SetArtwork(gameId, kind, relative, source, isUser: false);
            return true;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            Log.Warn("art", "Artwork download failed", new { gameId, kind, host = uri.Host }, ex);
            return false;
        }
    }

    /// <summary>
    /// Fills missing cover/hero/logo/header artwork for a Steam app from Steam's public CDN.
    /// Falls back to the store's asset index for newer apps that use hashed file names.
    /// </summary>
    public async Task FetchSteamArtworkAsync(string gameId, string appId, CancellationToken ct)
    {
        var existing = repo.GetArtwork(gameId);
        var wanted = new (ArtworkKind Kind, string[] Files)[]
        {
            (ArtworkKind.Cover, ["library_600x900_2x.jpg", "library_600x900.jpg"]),
            (ArtworkKind.Hero, ["library_hero.jpg"]),
            (ArtworkKind.Logo, ["logo.png"]),
            (ArtworkKind.Header, ["header.jpg"]),
        };
        Dictionary<string, string>? hashed = null;
        foreach (var (kind, files) in wanted)
        {
            if (existing.ContainsKey(kind.ToString().ToLowerInvariant())) continue;
            var ok = false;
            foreach (var file in files)
            {
                ok = await DownloadAsync(gameId, kind, $"{SteamCdn}steam/apps/{appId}/{file}", "steam-cdn", ct);
                if (ok) break;
            }
            if (ok || kind == ArtworkKind.Logo) continue;
            hashed ??= await GetHashedAssetsAsync(appId, ct);
            var key = kind switch
            {
                ArtworkKind.Cover => "library_capsule_2x",
                ArtworkKind.Hero => "library_hero",
                _ => "header",
            };
            if (hashed.TryGetValue(key, out var url) || (kind == ArtworkKind.Cover && hashed.TryGetValue("library_capsule", out url)))
                await DownloadAsync(gameId, kind, url, "steam-cdn", ct);
        }
    }

    /// <summary>
    /// Fast first pass for Steam games that have no cover yet (typically owned-but-not-installed
    /// games from the Steam Web API): portrait covers come straight from Steam's public CDN, a few
    /// at a time, instead of waiting behind the rate-limited store-details lookups. Apps that only
    /// have hashed asset names are resolved with one batched asset-index request per 40 apps.
    /// <paramref name="onCover"/> is called after each cover lands so the UI can refresh in batches.
    /// </summary>
    /// <param name="shouldStop">Checked before every download (e.g. a game started); once true, the rest is left for a later run.</param>
    public async Task<int> PrefetchSteamCoversAsync(IReadOnlyList<(string GameId, string AppId)> games, Action onCover, CancellationToken ct,
        Func<bool>? shouldStop = null)
    {
        if (games.Count == 0 || SkipDownloads?.Invoke() == true) return 0;
        var landed = 0;
        var missing = new System.Collections.Concurrent.ConcurrentBag<(string GameId, string AppId)>();
        var options = new ParallelOptions { MaxDegreeOfParallelism = CoverParallelism, CancellationToken = ct };
        bool Stop() => shouldStop?.Invoke() == true;

        await Parallel.ForEachAsync(games, options, async (g, token) =>
        {
            if (!IsSteamAppId(g.AppId) || Stop()) return;
            foreach (var file in (string[])["library_600x900_2x.jpg", "library_600x900.jpg"])
            {
                if (Stop()) return;
                if (await DownloadAsync(g.GameId, ArtworkKind.Cover, $"{SteamCdn}steam/apps/{g.AppId}/{file}", "steam-cdn", token))
                {
                    Interlocked.Increment(ref landed);
                    onCover();
                    return;
                }
            }
            missing.Add(g);
        });

        foreach (var chunk in missing.Chunk(40))
        {
            if (SkipDownloads?.Invoke() == true || Stop()) break;
            var index = await GetHashedAssetsAsync(chunk.Select(c => c.AppId).ToList(), ct);
            await Parallel.ForEachAsync(chunk, options, async (g, token) =>
            {
                if (Stop() || !index.TryGetValue(g.AppId, out var assets)) return;
                if ((assets.TryGetValue("library_capsule_2x", out var url) || assets.TryGetValue("library_capsule", out url)) &&
                    await DownloadAsync(g.GameId, ArtworkKind.Cover, url, "steam-cdn", token))
                {
                    Interlocked.Increment(ref landed);
                    onCover();
                }
            });
        }
        return landed;
    }

    private const int CoverParallelism = 6;

    /// <summary>
    /// Steam answers some classic art URLs with a flat grey 600×900 JPEG (about 4.5 KB) instead of a
    /// 404. Real covers and heroes are far larger, so anything this small is treated as missing.
    /// </summary>
    internal static bool IsPlaceholder(ArtworkKind kind, long bytes) => kind is ArtworkKind.Cover or ArtworkKind.Hero && bytes < 6 * 1024;

    /// <summary>Forgets placeholder covers/heroes cached by earlier versions so they get fetched properly.</summary>
    public int ForgetPlaceholders()
    {
        var forgotten = 0;
        foreach (var kind in (ArtworkKind[])[ArtworkKind.Cover, ArtworkKind.Hero])
            foreach (var (gameId, file) in repo.DownloadedArtwork(kind, "steam-cdn").Concat(repo.DownloadedArtwork(kind, "steam-local")))
            {
                try
                {
                    var info = new FileInfo(Path.Combine(paths.ArtCache, file));
                    if (info.Exists && IsPlaceholder(kind, info.Length) && repo.ForgetDownloadedArtwork(gameId, kind)) forgotten++;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { }
            }
        return forgotten;
    }

    [System.Text.RegularExpressions.GeneratedRegex(@"\A(?:[0-9a-f]{40}/)?[A-Za-z0-9_\-]{1,80}\.(?:jpg|png|webp)\z")]
    private static partial System.Text.RegularExpressions.Regex AssetName();

    private static bool IsSteamAppId(string appId) => appId.Length is > 0 and <= 10 && appId.All(char.IsAsciiDigit);

    private async Task<Dictionary<string, string>> GetHashedAssetsAsync(string appId, CancellationToken ct) =>
        (await GetHashedAssetsAsync([appId], ct)).GetValueOrDefault(appId) ?? [];

    /// <summary>
    /// Maps each requested app to its store asset URLs. Untrusted input: only apps that were asked
    /// for, a URL format inside that app's own CDN folder (optionally with a numeric cache-buster),
    /// and plain image file names (optionally under one SHA-1 folder) are accepted.
    /// </summary>
    internal static Dictionary<string, Dictionary<string, string>> ParseAssetIndex(string json, IReadOnlyCollection<string> ids)
    {
        var result = new Dictionary<string, Dictionary<string, string>>();
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("response", out var response) ||
            !response.TryGetProperty("store_items", out var items) || items.ValueKind != JsonValueKind.Array) return result;
        foreach (var item in items.EnumerateArray())
        {
            if (!item.TryGetProperty("appid", out var idEl) || idEl.ValueKind != JsonValueKind.Number || !idEl.TryGetInt64(out var idNum)) continue;
            var appId = idNum.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (!ids.Contains(appId) || !item.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Object) continue;
            var format = assets.TryGetProperty("asset_url_format", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString()! : "";
            var prefix = $"steam/apps/{appId}/${{FILENAME}}";
            if (!format.StartsWith(prefix, StringComparison.Ordinal) || !CacheBuster().IsMatch(format[prefix.Length..])) continue;
            var map = new Dictionary<string, string>();
            foreach (var prop in assets.EnumerateObject())
            {
                if (prop.Value.ValueKind != JsonValueKind.String || prop.Name == "asset_url_format") continue;
                var name = prop.Value.GetString()!;
                if (!AssetName().IsMatch(name)) continue;
                map[prop.Name] = SteamCdn + format.Replace("${FILENAME}", name);
            }
            result[appId] = map;
        }
        return result;
    }

    [System.Text.RegularExpressions.GeneratedRegex(@"\A(?:\?t=[0-9]{1,12})?\z")]
    private static partial System.Text.RegularExpressions.Regex CacheBuster();

    /// <summary>Looks up hashed store asset file names for up to 40 apps in one documented, keyless request.</summary>
    private async Task<Dictionary<string, Dictionary<string, string>>> GetHashedAssetsAsync(IReadOnlyList<string> appIds, CancellationToken ct)
    {
        var result = new Dictionary<string, Dictionary<string, string>>();
        var ids = appIds.Where(IsSteamAppId).Distinct().Take(40).ToList();
        if (ids.Count == 0) return result;
        try
        {
            var input = JsonSerializer.Serialize(new
            {
                ids = ids.Select(id => new { appid = int.Parse(id) }).ToArray(),
                context = new { language = "english", country_code = "US" },
                data_request = new { include_assets = true },
            });
            var url = $"https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={Uri.EscapeDataString(input)}";
            result = ParseAssetIndex(await http.GetStringAsync(url, ct), ids);
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or KeyNotFoundException or InvalidOperationException
                                       or FormatException or OverflowException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            Log.Warn("art", "Steam asset index lookup failed", new { apps = ids.Count }, ex);
        }
        return result;
    }

    /// <summary>
    /// Caches one achievement icon from Steam's CDN under &lt;gameId&gt;/ach/ so the UI can show it via
    /// the art host (the page itself never loads remote images). Returns the cache-relative path,
    /// or null when the URL isn't a trusted HTTPS Steam CDN image or the download failed.
    /// </summary>
    public async Task<string?> CacheAchievementIconAsync(string gameId, string url, CancellationToken ct)
    {
        if (Integrations.SteamWebApiClient.SafeIconUrl(url) is not { } safe) return null;
        var baseName = Path.Combine(gameId, "ach", Hash(safe));
        foreach (var ext in new[] { ".jpg", ".png", ".webp" })
        {
            if (File.Exists(Path.Combine(paths.ArtCache, baseName + ext))) return baseName + ext;
        }
        if (SkipDownloads?.Invoke() == true) return null;
        try
        {
            using var timeout = RequestTimeouts.Link(ct, RequestTimeouts.Media);
            using var response = await http.GetAsync(safe, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode) return null;
            const long maxIcon = 1024 * 1024;
            if (response.Content.Headers.ContentLength > maxIcon) return null;
            if (!(response.Content.Headers.ContentType?.MediaType ?? "").StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return null;
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[16384];
            int read;
            while ((read = await stream.ReadAsync(chunk, timeout.Token)) > 0)
            {
                buffer.Write(chunk, 0, read);
                if (buffer.Length > maxIcon) return null;
            }
            var bytes = buffer.ToArray();
            if (!LooksLikeImage(bytes)) return null;
            var relative = baseName + (bytes[0] == 0x89 ? ".png" : bytes[0] == 0xFF ? ".jpg" : ".webp");
            var dest = Path.Combine(paths.ArtCache, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            WriteAtomic(dest, bytes);
            return relative;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            Log.Warn("art", "Achievement icon download failed", new { gameId, error = ex.GetType().Name });
            return null;
        }
    }

    /// <summary>True when a cache-relative file exists (cached files can be cleared from Settings).</summary>
    public bool CachedFileExists(string? relative) =>
        relative is not null && !relative.Contains("..") && File.Exists(Path.Combine(paths.ArtCache, relative));

    /// <summary>Deletes cached files that are no longer referenced (user-chosen files included only if unreferenced).</summary>
    public long ClearUnreferenced(IEnumerable<string> referencedRelativeFiles)
    {
        var keep = referencedRelativeFiles.Select(f => Path.GetFullPath(Path.Combine(paths.ArtCache, f))).ToHashSet(StringComparer.OrdinalIgnoreCase);
        long freed = 0;
        foreach (var file in Directory.EnumerateFiles(paths.ArtCache, "*", SearchOption.AllDirectories))
        {
            if (keep.Contains(Path.GetFullPath(file))) continue;
            try
            {
                freed += new FileInfo(file).Length;
                File.Delete(file);
            }
            catch (IOException) { }
        }
        return freed;
    }

    public long CacheSizeBytes()
    {
        try
        {
            return Directory.EnumerateFiles(paths.ArtCache, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length);
        }
        catch (IOException) { return 0; }
    }

    internal static bool LooksLikeImage(ReadOnlySpan<byte> b) =>
        b.Length > 12 && (
            (b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) ||                                     // JPEG
            (b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) ||                     // PNG
            (b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46 && b[8] == 0x57 && b[9] == 0x45)); // RIFF/WEBP

    private static void WriteAtomic(string dest, byte[] bytes)
    {
        var tmp = dest + ".tmp";
        File.WriteAllBytes(tmp, bytes);
        File.Move(tmp, dest, overwrite: true);
    }

    private static string Hash(string s) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(s)))[..12];
}
