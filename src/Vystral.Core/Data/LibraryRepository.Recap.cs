using System.Globalization;
using Dapper;
using Vystral.Core.Domain;

namespace Vystral.Core.Data;

/// <summary>A finished observed session with its game, for recaps (away card, session replay).</summary>
public sealed record RecapSessionRow(
    string Id, string GameId, string Title, string? SteamAppId, string Source, DateTimeOffset Start, DateTimeOffset End, int DurationSeconds, string? PerfSummaryJson);

/// <summary>One unlocked Steam achievement with a parsed unlock time.</summary>
public sealed record RecapUnlockRow(
    string AppId, string ApiName, string DisplayName, string? Description, string? IconFile, string? IconGrayFile, DateTimeOffset UnlockedAt, double? GlobalPercent);

/// <summary>A game that is in the backlog or has never been played, with what is needed to look up cached prices.</summary>
public sealed record BacklogCandidateRow(string GameId, string Title, string? SteamAppId, string? Status, bool NeverPlayed);

/// <summary>A matched IGDB enrichment answer (its facts JSON may hold time-to-beat).</summary>
public sealed record IgdbFactsRow(string GameId, string DataJson, DateTimeOffset Fetched);

/// <summary>
/// Track M (v0.5): read models for the "while you were away" card, session replay, time-to-beat bars and
/// the backlog savings estimate. Uses existing tables only (no migration). Timestamps are stored as
/// round-trip strings that may carry different offsets, so time filtering happens after parsing.
/// </summary>
public sealed partial class LibraryRepository
{
    /// <summary>
    /// Finished sessions with one of <paramref name="sources"/> that ended after <paramref name="since"/>
    /// (newest first, at most <paramref name="limit"/>), joined to their game.
    /// </summary>
    public IReadOnlyList<RecapSessionRow> ObservedSessionsEndedAfter(DateTimeOffset since, IReadOnlyCollection<string> sources, int limit = 500)
    {
        var allowed = sources.Where(SessionSources.IsObserved).Distinct().ToArray();
        if (allowed.Length == 0) return [];
        using var conn = db.Open();
        // Newest-first by start; a generous window so sessions with odd offsets aren't cut off before parsing.
        var rows = conn.Query<(string Id, string GameId, string Title, string? AppId, string Source, string Start, string End, int Duration, string? Perf)>("""
            SELECT s.id, s.game_id, g.title, g.steam_app_id, s.source, s.start, s.end, s.duration_seconds, s.perf_summary_json
            FROM sessions s JOIN games g ON g.id = s.game_id
            WHERE s.end IS NOT NULL AND s.source IN @allowed
            ORDER BY s.start DESC LIMIT @take
            """, new { allowed, take = Math.Clamp(limit, 1, 5000) * 2 });
        return rows.Select(ToRecap).OfType<RecapSessionRow>().Where(r => r.End > since).Take(Math.Clamp(limit, 1, 5000)).ToList();
    }

    /// <summary>One finished observed session with its game, or null.</summary>
    public RecapSessionRow? GetRecapSession(string sessionId)
    {
        using var conn = db.Open();
        var rows = conn.Query<(string Id, string GameId, string Title, string? AppId, string Source, string Start, string End, int Duration, string? Perf)>($"""
            SELECT s.id, s.game_id, g.title, g.steam_app_id, s.source, s.start, s.end, s.duration_seconds, s.perf_summary_json
            FROM sessions s JOIN games g ON g.id = s.game_id
            WHERE s.id = @sessionId AND s.end IS NOT NULL AND s.source IN {SessionSources.ObservedSql}
            """, new { sessionId }).ToList();
        return rows is [var row] ? ToRecap(row) : null;
    }

    private static RecapSessionRow? ToRecap((string Id, string GameId, string Title, string? AppId, string Source, string Start, string End, int Duration, string? Perf) r) =>
        DateTimeOffset.TryParse(r.Start, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var start) &&
        DateTimeOffset.TryParse(r.End, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var end)
            ? new RecapSessionRow(r.Id, r.GameId, r.Title, r.AppId, r.Source, start, end, Math.Max(0, r.Duration), r.Perf)
            : null;

    /// <summary>Achievements of one Steam app unlocked between <paramref name="from"/> and <paramref name="to"/> (inclusive), oldest first.</summary>
    public IReadOnlyList<RecapUnlockRow> UnlocksBetween(string appId, DateTimeOffset from, DateTimeOffset to)
    {
        if (!IsAppId(appId) || to < from) return [];
        using var conn = db.Open();
        return conn.Query<(string AppId, string Api, string Name, string? Desc, string? Icon, string? Gray, string Unlock, double? Pct)>("""
                SELECT app_id, api_name, display_name, description, icon_file, icon_gray_file, unlock_time, global_percent
                FROM steam_achievements WHERE app_id = @appId AND achieved = 1 AND unlock_time IS NOT NULL
                """, new { appId })
            .Select(r => DateTimeOffset.TryParse(r.Unlock, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at)
                ? new RecapUnlockRow(r.AppId, r.Api, r.Name, r.Desc, r.Icon, r.Gray, at, r.Pct) : null)
            .OfType<RecapUnlockRow>()
            .Where(r => r.UnlockedAt >= from && r.UnlockedAt <= to)
            .OrderBy(r => r.UnlockedAt).ThenBy(r => r.ApiName, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>Whether Steam achievements were ever fetched for this app (so "none unlocked" means something).</summary>
    public bool AchievementsFetched(string appId)
    {
        using var conn = db.Open();
        return conn.ExecuteScalar<long>("SELECT COUNT(*) FROM steam_achievement_fetch WHERE app_id=@appId AND status IN ('ok','none')", new { appId }) > 0;
    }

    /// <summary>Matched IGDB answers whose facts mention time to beat (games that aren't hidden).</summary>
    public IReadOnlyList<IgdbFactsRow> IgdbTimeToBeatRows()
    {
        using var conn = db.Open();
        return conn.Query<(string GameId, string Data, string Fetched)>("""
                SELECT e.game_id, e.data_json, e.fetched FROM game_enrichment e JOIN games g ON g.id = e.game_id
                WHERE e.source = 'igdb' AND e.matched = 1 AND g.hidden = 0 AND instr(e.data_json, '"timeToBeat"') > 0
                """)
            .Select(r => new IgdbFactsRow(r.GameId, r.Data,
                DateTimeOffset.TryParse(r.Fetched, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var f) ? f : DateTimeOffset.MinValue))
            .ToList();
    }

    /// <summary>
    /// Visible games marked "backlog", plus games without a status that were never played: no session VYSTRAL
    /// observed and no playtime or last-played date from any store (and not marked as played by the user; Track D1).
    /// </summary>
    public IReadOnlyList<BacklogCandidateRow> BacklogCandidates()
    {
        using var conn = db.Open();
        return conn.Query<(string Id, string Title, string? AppId, string? Status, long Sessions, long Imported, long LastPlayed, long Marked)>($"""
                SELECT g.id, g.title, g.steam_app_id, g.status,
                       (SELECT COUNT(*) FROM sessions s WHERE s.game_id = g.id AND s.source IN {SessionSources.ObservedSql}),
                       (SELECT COALESCE(MAX(i.imported_playtime_minutes), 0) FROM installations i WHERE i.game_id = g.id),
                       (SELECT COUNT(*) FROM installations i WHERE i.game_id = g.id AND i.imported_last_played IS NOT NULL),
                       g.played_marked IS NOT NULL
                FROM games g WHERE g.hidden = 0
                ORDER BY g.sort_title
                """)
            .Select(r => (r, never: r.Sessions == 0 && r.Imported <= 0 && r.LastPlayed == 0 && r.Marked == 0))
            .Where(x => x.r.Status == "backlog" || (x.r.Status is null && x.never))
            .Select(x => new BacklogCandidateRow(x.r.Id, x.r.Title, x.r.AppId is { } a && IsAppId(a) ? a : null, x.r.Status, x.never))
            .ToList();
    }
}
