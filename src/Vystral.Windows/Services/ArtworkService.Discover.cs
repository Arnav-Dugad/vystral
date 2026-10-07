namespace Vystral.Windows.Services;

/// <summary>
/// Track U: images for games that aren't in the library (Discover). They go through the same safe pipeline as picker
/// thumbnails (HTTPS, host allow-list checked by the caller, size cap, image content type, magic bytes, atomic write)
/// into <c>_thumbs/discover/</c>, which is cleared with the art cache. Nothing is attached to a library game.
/// </summary>
public sealed partial class ArtworkService
{
    private const long MaxDiscoverHeroBytes = 6 * 1024 * 1024;

    /// <summary>Caches one Discover image and returns its art-host URL, or null when it isn't a usable image.</summary>
    /// <param name="kind">cover, hero, logo, header or background (decides the size cap and the placeholder check).</param>
    public async Task<string?> CacheDiscoverImageAsync(string url, string kind, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return null;
        var baseName = Path.Combine("_thumbs", "discover", Hash(uri.AbsoluteUri));
        foreach (var ext in new[] { ".jpg", ".png", ".webp" })
            if (File.Exists(Path.Combine(paths.ArtCache, baseName + ext))) return Url("", baseName + ext);
        var bytes = await FetchImageAsync(uri, kind is "hero" or "background" ? MaxDiscoverHeroBytes : MaxThumbBytes, ct);
        // Steam answers some missing art with a tiny grey stand-in rather than a 404 (see IsPlaceholder).
        if (bytes is null || (kind is "cover" or "hero" && bytes.Length < 6 * 1024)) return null;
        var relative = baseName + Extension(bytes);
        var dest = Path.Combine(paths.ArtCache, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        WriteAtomic(dest, bytes);
        return Url("", relative);
    }

    /// <summary>The art-host URL of a Discover image already in the cache, or null (no network).</summary>
    public string? CachedDiscoverImage(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return null;
        var baseName = Path.Combine("_thumbs", "discover", Hash(uri.AbsoluteUri));
        foreach (var ext in new[] { ".jpg", ".png", ".webp" })
            if (File.Exists(Path.Combine(paths.ArtCache, baseName + ext))) return Url("", baseName + ext);
        return null;
    }

    /// <summary>Steam's store asset index for apps (hashed file names of newer apps); empty when it can't be read.</summary>
    public Task<Dictionary<string, Dictionary<string, string>>> SteamAssetIndexAsync(IReadOnlyList<string> appIds, CancellationToken ct) =>
        GetHashedAssetsAsync(appIds, ct);
}
