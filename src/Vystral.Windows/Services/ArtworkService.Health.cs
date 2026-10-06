using Vystral.Core.Domain;

namespace Vystral.Windows.Services;

public sealed partial class ArtworkService
{
    /// <summary>
    /// Track Q ("Get it again" in the library health check): downloads Steam's art for the given kinds even when a
    /// row exists (placeholder, low resolution, file gone). The current art is replaced only when a download lands
    /// (a failed or offline attempt changes nothing), and art the user chose is never replaced.
    /// </summary>
    public async Task<int> RefetchSteamAsync(string gameId, string appId, IReadOnlyCollection<ArtworkKind> kinds, CancellationToken ct)
    {
        if (!IsSteamAppId(appId) || SkipDownloads?.Invoke() == true) return 0;
        var existing = repo.GetArtwork(gameId);
        var landed = 0;
        Dictionary<string, string>? hashed = null;
        foreach (var kind in kinds.Distinct())
        {
            if (existing.TryGetValue(kind.ToString().ToLowerInvariant(), out var e) && e.IsUser) continue;
            string[] files = kind switch
            {
                ArtworkKind.Cover => ["library_600x900_2x.jpg", "library_600x900.jpg"],
                ArtworkKind.Hero => ["library_hero.jpg"],
                ArtworkKind.Logo => ["logo.png"],
                ArtworkKind.Header => ["header.jpg"],
                _ => [],
            };
            var ok = false;
            foreach (var file in files)
            {
                ok = await DownloadAsync(gameId, kind, $"{SteamCdn}steam/apps/{appId}/{file}", "steam-cdn", ct);
                if (ok) break;
            }
            if (!ok && kind is ArtworkKind.Cover or ArtworkKind.Hero or ArtworkKind.Header)
            {
                hashed ??= await GetHashedAssetsAsync(appId, ct);
                var key = kind switch { ArtworkKind.Cover => "library_capsule_2x", ArtworkKind.Hero => "library_hero", _ => "header" };
                if (hashed.TryGetValue(key, out var url) || (kind == ArtworkKind.Cover && hashed.TryGetValue("library_capsule", out url)))
                    ok = await DownloadAsync(gameId, kind, url, "steam-cdn", ct);
            }
            if (ok) landed++;
        }
        return landed;
    }
}
