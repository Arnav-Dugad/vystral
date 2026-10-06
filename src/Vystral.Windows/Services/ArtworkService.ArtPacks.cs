using Vystral.Core.Domain;

namespace Vystral.Windows.Services;

/// <summary>
/// Track N: art packs download through the same safe pipeline as the picker (HTTPS, size cap, image
/// content type, magic-byte sniffing, atomic write into the private cache). The database row is
/// written separately by the art-pack job, which first records what the slot held so it can be undone.
/// </summary>
public sealed partial class ArtworkService
{
    /// <summary>Downloads one art-pack image and returns its cache-relative path, or null when it isn't a safe image.</summary>
    public async Task<string?> DownloadPackArtAsync(string gameId, ArtworkKind kind, string url, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return null;
        if (gameId.Length is 0 or > 64 || !gameId.All(char.IsAsciiLetterOrDigit)) return null;
        var baseName = Path.Combine(gameId, $"{kind.ToString().ToLowerInvariant()}-pack-{Hash(uri.AbsoluteUri)}");
        foreach (var ext in new[] { ".jpg", ".png", ".webp" })
            if (File.Exists(Path.Combine(paths.ArtCache, baseName + ext))) return baseName + ext;
        var bytes = await FetchImageAsync(uri, MaxBytes, ct);
        if (bytes is null || IsPlaceholder(kind, bytes.Length)) return null;
        var relative = baseName + Extension(bytes);
        var dest = Path.Combine(paths.ArtCache, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        WriteAtomic(dest, bytes);
        return relative;
    }
}
