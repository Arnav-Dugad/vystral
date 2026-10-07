namespace Vystral.Windows.Services;

/// <summary>
/// Track V: posters for "Included with your subscriptions" games you don't own yet. The page's CSP allows images only
/// from the app's own hosts, so a poster is copied into the private art cache (<c>_store/</c>) and served through the
/// art host, like friends' avatars. Only https URLs on Microsoft's Store image CDN in its <c>/image/apps.…</c> shape are
/// fetched (see <see cref="Subscriptions.SubscriptionCatalogClient.SafeImageUrl"/>), at 300×450; each file is capped at
/// 400 KB, must be a real JPEG/PNG/WebP, and the folder keeps at most <see cref="MaxStoreImages"/> files.
/// </summary>
public sealed partial class ArtworkService
{
    public const string StoreImageFolder = "_store";
    internal const int MaxStoreImages = 120;
    private const long MaxStoreImageBytes = 400 * 1024;
    private const string StoreImageHost = "store-images.s-microsoft.com";

    /// <summary>The cached poster's cache-relative path, or null (unsafe URL, downloads paused, or the download failed).</summary>
    public async Task<string?> CacheStoreImageAsync(string url, CancellationToken ct)
    {
        if (Subscriptions.SubscriptionCatalogClient.SafeImageUrl(url) is not { } safe) return null;
        var baseName = Path.Combine(StoreImageFolder, Hash(safe));
        foreach (var ext in new[] { ".jpg", ".png", ".webp" })
        {
            if (File.Exists(Path.Combine(paths.ArtCache, baseName + ext))) return baseName + ext;
        }
        if (SkipDownloads?.Invoke() == true) return null;
        try
        {
            using var timeout = RequestTimeouts.Link(ct, RequestTimeouts.Media);
            using var request = new HttpRequestMessage(HttpMethod.Get, safe + "?w=300&h=450&q=80");
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode || response.RequestMessage?.RequestUri is { } final && !final.Host.Equals(StoreImageHost, StringComparison.OrdinalIgnoreCase))
                return null;
            if (response.Content.Headers.ContentLength > MaxStoreImageBytes) return null;
            if (!(response.Content.Headers.ContentType?.MediaType ?? "").StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return null;
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[16384];
            int read;
            while ((read = await stream.ReadAsync(chunk, timeout.Token)) > 0)
            {
                buffer.Write(chunk, 0, read);
                if (buffer.Length > MaxStoreImageBytes) return null;
            }
            var bytes = buffer.ToArray();
            if (!LooksLikeImage(bytes)) return null;
            var relative = baseName + (bytes[0] == 0x89 ? ".png" : bytes[0] == 0xFF ? ".jpg" : ".webp");
            var dest = Path.Combine(paths.ArtCache, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            WriteAtomic(dest, bytes);
            PruneStoreImages();
            return relative;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or UnauthorizedAccessException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            Log.Warn("art", "Store poster download failed", new { error = ex.GetType().Name });
            return null;
        }
    }

    /// <summary>Keeps the poster folder at <see cref="MaxStoreImages"/> files, dropping the oldest.</summary>
    internal int PruneStoreImages(int keep = MaxStoreImages)
    {
        var dir = Path.Combine(paths.ArtCache, StoreImageFolder);
        try
        {
            if (!Directory.Exists(dir)) return 0;
            var removed = 0;
            foreach (var f in new DirectoryInfo(dir).EnumerateFiles().OrderByDescending(f => f.LastWriteTimeUtc).Skip(Math.Max(0, keep)))
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
