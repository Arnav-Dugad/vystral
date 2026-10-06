namespace Vystral.Windows.Services;

/// <summary>
/// Track P: friends' Steam avatars. The page's CSP allows images only from the app's own hosts, so
/// avatars are copied into the private art cache (<c>_avatars/</c>) and served through the art host,
/// exactly like achievement icons. Only HTTPS URLs on Steam's avatar CDN with a hash-shaped path are
/// fetched (see <see cref="Integrations.SteamWebApiClient.SafeAvatarUrl"/>); each file is capped at
/// 256 KB, must be a real JPEG/PNG/WebP, and the folder keeps at most <see cref="MaxAvatarFiles"/> files.
/// </summary>
public sealed partial class ArtworkService
{
    public const string AvatarFolder = "_avatars";
    internal const int MaxAvatarFiles = 400;
    private const long MaxAvatarBytes = 256 * 1024;

    /// <summary>The cached avatar's cache-relative path, or null (unsafe URL, download skipped or failed).</summary>
    public async Task<string?> CacheAvatarAsync(string url, CancellationToken ct)
    {
        if (Integrations.SteamWebApiClient.SafeAvatarUrl(url) is not { } safe) return null;
        var baseName = Path.Combine(AvatarFolder, Hash(safe));
        foreach (var ext in new[] { ".jpg", ".png", ".webp" })
        {
            var existing = Path.Combine(paths.ArtCache, baseName + ext);
            if (File.Exists(existing))
            {
                try { File.SetLastAccessTimeUtc(existing, DateTime.UtcNow); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
                return baseName + ext;
            }
        }
        if (SkipDownloads?.Invoke() == true) return null;
        try
        {
            using var timeout = RequestTimeouts.Link(ct, RequestTimeouts.Media);
            using var request = new HttpRequestMessage(HttpMethod.Get, safe);
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            // A redirect is never followed to another host: the handler's redirects land here as non-success.
            if (!response.IsSuccessStatusCode || response.RequestMessage?.RequestUri is { } final && !Integrations.SteamWebApiClient.AvatarHosts.Contains(final.Host.ToLowerInvariant()))
                return null;
            if (response.Content.Headers.ContentLength > MaxAvatarBytes) return null;
            if (!(response.Content.Headers.ContentType?.MediaType ?? "").StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return null;
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[16384];
            int read;
            while ((read = await stream.ReadAsync(chunk, timeout.Token)) > 0)
            {
                buffer.Write(chunk, 0, read);
                if (buffer.Length > MaxAvatarBytes) return null;
            }
            var bytes = buffer.ToArray();
            if (!LooksLikeImage(bytes)) return null;
            var relative = baseName + (bytes[0] == 0x89 ? ".png" : bytes[0] == 0xFF ? ".jpg" : ".webp");
            var dest = Path.Combine(paths.ArtCache, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            WriteAtomic(dest, bytes);
            return relative;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or UnauthorizedAccessException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            Log.Warn("art", "Avatar download failed", new { error = ex.GetType().Name });
            return null;
        }
    }

    /// <summary>Keeps the avatar folder at <see cref="MaxAvatarFiles"/> files, dropping the least recently used.</summary>
    public int PruneAvatars(int keep = MaxAvatarFiles)
    {
        var dir = Path.Combine(paths.ArtCache, AvatarFolder);
        try
        {
            if (!Directory.Exists(dir)) return 0;
            var files = new DirectoryInfo(dir).EnumerateFiles().OrderByDescending(f => f.LastAccessTimeUtc > f.LastWriteTimeUtc ? f.LastAccessTimeUtc : f.LastWriteTimeUtc).ToList();
            var removed = 0;
            foreach (var f in files.Skip(Math.Max(0, keep)))
            {
                try { f.Delete(); removed++; } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            }
            return removed;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }
}
