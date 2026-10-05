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
public sealed class ArtworkService(AppPaths paths, LibraryRepository repo, HttpClient http)
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

    /// <summary>When it returns true (Data saver), artwork downloads are skipped; local imports still work.</summary>
    public Func<bool>? SkipDownloads { get; set; }

    public async Task<bool> DownloadAsync(string gameId, ArtworkKind kind, string url, string source, CancellationToken ct)
    {
        if (SkipDownloads?.Invoke() == true) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return false;
        try
        {
            using var response = await http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct);
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden) return false;
            response.EnsureSuccessStatusCode();
            if (response.Content.Headers.ContentLength > MaxBytes) return false;
            var media = response.Content.Headers.ContentType?.MediaType ?? "";
            if (!media.StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return false;

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(chunk, ct)) > 0)
            {
                buffer.Write(chunk, 0, read);
                if (buffer.Length > MaxBytes) return false;
            }
            var bytes = buffer.ToArray();
            if (!LooksLikeImage(bytes)) return false;
            var ext = bytes[0] == 0x89 ? ".png" : bytes[0] == 0xFF ? ".jpg" : ".webp";
            var relative = Path.Combine(gameId, $"{kind.ToString().ToLowerInvariant()}-{Hash(url)}{ext}");
            var dest = Path.Combine(paths.ArtCache, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            WriteAtomic(dest, bytes);
            repo.SetArtwork(gameId, kind, relative, source, isUser: false);
            return true;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException && !ct.IsCancellationRequested)
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

    private async Task<Dictionary<string, string>> GetHashedAssetsAsync(string appId, CancellationToken ct)
    {
        var result = new Dictionary<string, string>();
        try
        {
            var input = JsonSerializer.Serialize(new
            {
                ids = new[] { new { appid = int.Parse(appId) } },
                context = new { language = "english", country_code = "US" },
                data_request = new { include_assets = true },
            });
            var url = $"https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={Uri.EscapeDataString(input)}";
            using var doc = JsonDocument.Parse(await http.GetStringAsync(url, ct));
            var item = doc.RootElement.GetProperty("response").GetProperty("store_items")[0];
            if (!item.TryGetProperty("assets", out var assets)) return result;
            var format = assets.TryGetProperty("asset_url_format", out var f) ? f.GetString() : null;
            if (format is null || !format.StartsWith("steam/", StringComparison.Ordinal)) return result;
            foreach (var prop in assets.EnumerateObject())
            {
                if (prop.Value.ValueKind != JsonValueKind.String || prop.Name == "asset_url_format") continue;
                var name = prop.Value.GetString()!;
                if (name.Contains("..") || name.Contains('/') && !name.StartsWith(appId, StringComparison.Ordinal)) continue;
                result[prop.Name] = SteamCdn + format.Replace("${FILENAME}", name);
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or KeyNotFoundException or InvalidOperationException
                                       or IndexOutOfRangeException or FormatException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            Log.Warn("art", "Steam asset index lookup failed", new { appId }, ex);
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
            using var response = await http.GetAsync(safe, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!response.IsSuccessStatusCode) return null;
            const long maxIcon = 1024 * 1024;
            if (response.Content.Headers.ContentLength > maxIcon) return null;
            if (!(response.Content.Headers.ContentType?.MediaType ?? "").StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return null;
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var buffer = new MemoryStream();
            var chunk = new byte[16384];
            int read;
            while ((read = await stream.ReadAsync(chunk, ct)) > 0)
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
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException && !ct.IsCancellationRequested)
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
