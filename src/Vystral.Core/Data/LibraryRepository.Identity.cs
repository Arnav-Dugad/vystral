using System.Globalization;
using Dapper;

namespace Vystral.Core.Data;

/// <summary>A library game as the cross-store identity resolver sees it (Track D4).</summary>
public sealed record IdentityGame(string GameId, string Title, string? SteamAppId, string? ReleaseDate, string? MetadataSource, IReadOnlyList<string> Platforms);

/// <summary>Track D4: reads for the cross-store identity resolver. No new tables: answers live in provider_cache.</summary>
public sealed partial class LibraryRepository
{
    /// <summary>Every cached body of one provider (fresh or not), keyed by cache key. Capped for safety.</summary>
    public IReadOnlyDictionary<string, (string Body, DateTimeOffset Fetched, bool Fresh)> GetProviderCacheAll(string provider, int limit = 20_000)
    {
        using var conn = db.Open();
        var now = DateTimeOffset.UtcNow;
        var result = new Dictionary<string, (string, DateTimeOffset, bool)>(StringComparer.Ordinal);
        foreach (var r in conn.Query<(string Key, string Body, string Fetched, string Expires)>(
                     "SELECT cache_key, body_json, fetched, expires FROM provider_cache WHERE provider=@provider LIMIT @limit", new { provider, limit }))
        {
            if (DateTimeOffset.TryParse(r.Fetched, CultureInfo.InvariantCulture, out var f) && DateTimeOffset.TryParse(r.Expires, CultureInfo.InvariantCulture, out var e))
                result[r.Key] = (r.Body, f, e > now);
        }
        return result;
    }

    /// <summary>Removes one cached answer (e.g. after the user corrects a match).</summary>
    public void DeleteProviderCache(string provider, string key)
    {
        using var conn = db.Open();
        conn.Execute("DELETE FROM provider_cache WHERE provider=@provider AND cache_key=@key", new { provider, key });
    }

    public IdentityGame? GetIdentityGame(string gameId)
    {
        using var conn = db.Open();
        var g = conn.QuerySingleOrDefault<(string Id, string Title, string? AppId, string? Release, string? Source)?>(
            "SELECT id, title, steam_app_id, release_date, metadata_source FROM games WHERE id=@gameId", new { gameId });
        if (g is not { } row) return null;
        var platforms = conn.Query<string>("SELECT DISTINCT platform FROM installations WHERE game_id=@gameId", new { gameId }).ToList();
        return new IdentityGame(row.Id, row.Title, row.AppId, row.Release, row.Source, platforms);
    }

    /// <summary>Visible games without a Steam app ID of their own (the ones cross-store matching helps), favourites first.</summary>
    public IReadOnlyList<string> GamesWithoutSteamApp(int limit)
    {
        using var conn = db.Open();
        return conn.Query<string>("SELECT id FROM games WHERE steam_app_id IS NULL AND hidden = 0 ORDER BY favorite DESC, added DESC LIMIT @limit", new { limit }).ToList();
    }
}
