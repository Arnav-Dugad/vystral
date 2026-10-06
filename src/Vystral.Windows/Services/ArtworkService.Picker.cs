using System.Net;
using Vystral.Core.Domain;

namespace Vystral.Windows.Services;

/// <summary>
/// Track I: the artwork picker's downloads. Same rules as every other download: HTTPS only, a
/// host allow-list checked by the caller, size caps, image content type, magic-byte sniffing and
/// atomic writes into the private cache. Thumbnails live under _thumbs/ (cleared with the cache);
/// chosen art is stored as user art (is_user = 1), so scans and metadata fetches never replace it.
/// </summary>
public sealed partial class ArtworkService
{
    private const long MaxThumbBytes = 3 * 1024 * 1024;

    /// <summary>Caches one preview image and returns its cache-relative path (or null when it isn't a safe image).</summary>
    public async Task<string?> CacheThumbAsync(string url, string folder, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return null;
        if (folder.Length is 0 or > 20 || !folder.All(char.IsAsciiLetterLower)) return null;
        var baseName = Path.Combine("_thumbs", folder, Hash(uri.AbsoluteUri));
        foreach (var ext in new[] { ".jpg", ".png", ".webp" })
            if (File.Exists(Path.Combine(paths.ArtCache, baseName + ext))) return (baseName + ext).Replace('\\', '/');
        var bytes = await FetchImageAsync(uri, MaxThumbBytes, ct);
        if (bytes is null) return null;
        var relative = baseName + Extension(bytes);
        var dest = Path.Combine(paths.ArtCache, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        WriteAtomic(dest, bytes);
        return relative.Replace('\\', '/');
    }

    /// <summary>Downloads full-size art the user picked and stores it as their choice for <paramref name="kind"/>.</summary>
    public async Task<bool> DownloadUserArtAsync(string gameId, ArtworkKind kind, string url, string source, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return false;
        var bytes = await FetchImageAsync(uri, MaxBytes, ct);
        if (bytes is null) return false;
        var relative = Path.Combine(gameId, $"{kind.ToString().ToLowerInvariant()}-user-{Hash(uri.AbsoluteUri)}{Extension(bytes)}");
        var dest = Path.Combine(paths.ArtCache, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        WriteAtomic(dest, bytes);
        repo.SetArtwork(gameId, kind, relative, source, isUser: true);
        return true;
    }

    private static string Extension(byte[] bytes) => bytes[0] == 0x89 ? ".png" : bytes[0] == 0xFF ? ".jpg" : ".webp";

    private async Task<byte[]?> FetchImageAsync(Uri uri, long maxBytes, CancellationToken ct)
    {
        try
        {
            using var timeout = RequestTimeouts.Link(ct, RequestTimeouts.Media);
            using var response = await http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden || !response.IsSuccessStatusCode) return null;
            // Redirects must stay on HTTPS.
            if (response.RequestMessage?.RequestUri is { } final && final.Scheme != Uri.UriSchemeHttps) return null;
            if (response.Content.Headers.ContentLength > maxBytes) return null;
            if (!(response.Content.Headers.ContentType?.MediaType ?? "").StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return null;
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[65536];
            int read;
            while ((read = await stream.ReadAsync(chunk, timeout.Token)) > 0)
            {
                buffer.Write(chunk, 0, read);
                if (buffer.Length > maxBytes) return null;
            }
            var bytes = buffer.ToArray();
            return LooksLikeImage(bytes) ? bytes : null;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            Log.Warn("art", "Picker image download failed", new { host = uri.Host, error = ex.GetType().Name });
            return null;
        }
    }
}
