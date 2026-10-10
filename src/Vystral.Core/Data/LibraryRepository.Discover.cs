using System.Globalization;
using Dapper;
using Vystral.Core.Domain;

namespace Vystral.Core.Data;

/// <summary>A library game as universal search needs it: enough to say "In your library".</summary>
public sealed record DiscoverLibraryRow(string Id, string Title, string? SteamAppId, string? ReleaseDate);

/// <summary>
/// Track C3: a library game that could start a "Because you played …" shelf: how much and how recently it was played
/// (VYSTRAL's own sessions, or the store's imported playtime), its genres and, when IGDB matched it, its IGDB ID.
/// </summary>
public sealed record DiscoverSeedRow(
    string Id, string Title, string? SteamAppId, string GenresJson, long TrackedSeconds, long ImportedMinutes,
    DateTimeOffset? LastPlayed, string? IgdbId);

/// <summary>Track U: universal search reads the library only to mark games you already have. No schema change.</summary>
public sealed partial class LibraryRepository
{
    /// <summary>Every visible game with its Steam app ID (from the game, or from a Steam copy) and release date text.</summary>
    public IReadOnlyList<DiscoverLibraryRow> GetDiscoverLibrary()
    {
        using var conn = db.Open();
        // Plain columns only (no expressions), so the column types are known even when there are no rows.
        var rows = conn.Query<(string Id, string Title, string? SteamAppId, string? ReleaseDate, string? SteamCopy)>("""
            SELECT g.id, g.title, g.steam_app_id, g.release_date, i.platform_game_id
            FROM games g LEFT JOIN installations i ON i.game_id = g.id AND i.platform = 'steam'
            WHERE g.hidden = 0
            """);
        return rows.GroupBy(r => r.Id)
            .Select(g => g.First() is var f ? new DiscoverLibraryRow(f.Id, f.Title, f.SteamAppId ?? g.Select(x => x.SteamCopy).FirstOrDefault(c => c is not null), f.ReleaseDate) : null!)
            .ToList();
    }

    /// <summary>
    /// Track C3: IGDB IDs of library games (hidden ones included: a game you hid is still a game you own), from matched
    /// IGDB enrichment. Used only to leave games you already have out of Discover's suggestions.
    /// </summary>
    public IReadOnlyList<long> GetDiscoverLibraryIgdbIds()
    {
        using var conn = db.Open();
        return conn.Query<string?>("SELECT source_id FROM game_enrichment WHERE source = 'igdb' AND matched = 1 AND source_id IS NOT NULL")
            .Select(s => long.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0 ? id : 0)
            .Where(id => id > 0).Distinct().ToList();
    }

    /// <summary>
    /// Track C3: visible games that were played at all (a VYSTRAL session or store playtime), with what "Because you
    /// played" needs to pick its seeds. Sorting and picking happen in the caller (pure, tested).
    /// </summary>
    public IReadOnlyList<DiscoverSeedRow> GetDiscoverSeeds()
    {
        using var conn = db.Open();
        var rows = conn.Query<(string Id, string Title, string? AppId, string Genres, long Tracked, string? LastSession, long Imported, string? ImportedLast, string? Igdb)>($"""
            SELECT g.id, g.title, g.steam_app_id, g.genres_json,
                   (SELECT COALESCE(SUM(s.duration_seconds), 0) FROM sessions s WHERE s.game_id = g.id AND s.source IN {SessionSources.ObservedSql}),
                   (SELECT MAX(s.start) FROM sessions s WHERE s.game_id = g.id AND s.source IN {SessionSources.ObservedSql}),
                   (SELECT COALESCE(MAX(i.imported_playtime_minutes), 0) FROM installations i WHERE i.game_id = g.id),
                   (SELECT MAX(i.imported_last_played) FROM installations i WHERE i.game_id = g.id),
                   (SELECT e.source_id FROM game_enrichment e WHERE e.game_id = g.id AND e.source = 'igdb' AND e.matched = 1)
            FROM games g WHERE g.hidden = 0
            """);
        var steamCopies = conn.Query<(string GameId, string AppId)>("SELECT game_id, platform_game_id FROM installations WHERE platform = 'steam'")
            .GroupBy(r => r.GameId).ToDictionary(g => g.Key, g => g.First().AppId);
        var list = new List<DiscoverSeedRow>();
        foreach (var r in rows)
        {
            DateTimeOffset? last = null;
            foreach (var t in new[] { r.LastSession, r.ImportedLast })
                if (ParseWhen(t) is { } w && (last is null || w > last)) last = w;
            if (r.Tracked <= 0 && r.Imported <= 0 && last is null) continue;
            var appId = r.AppId ?? steamCopies.GetValueOrDefault(r.Id);
            list.Add(new DiscoverSeedRow(r.Id, r.Title, appId is { } a && IsAppId(a) ? a : null, r.Genres ?? "[]", Math.Max(0, r.Tracked),
                Math.Max(0, r.Imported), last, r.Igdb));
        }
        return list;
    }

    /// <summary>ISO text, or unix seconds as text (some stores report it that way).</summary>
    private static DateTimeOffset? ParseWhen(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        if (long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var unix) && unix is > 0 and < 4_102_444_800)
            return DateTimeOffset.FromUnixTimeSeconds(unix);
        return DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) ? d : null;
    }
}
