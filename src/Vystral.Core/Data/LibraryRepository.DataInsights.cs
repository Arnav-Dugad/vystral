using Dapper;
using Vystral.Core.Insights;

namespace Vystral.Core.Data;

/// <summary>One unlocked achievement joined to its game, for the merged feed.</summary>
public sealed record AchievementFeedRow(
    string AppId, string? GameId, string GameTitle, string ApiName, string DisplayName, string? Description,
    string? IconFile, string? IconGrayFile, string UnlockTime, double? GlobalPercent);

/// <summary>Counts across every cached Steam achievement.</summary>
public sealed record AchievementTotals(int Unlocked, int Games, int Rare, int UltraRare, string? LastFetched);

/// <summary>
/// Track F (schema v5): GPU driver per session, background-app snapshots, and read models for the
/// achievement feed, driver comparison and background-app report.
/// </summary>
public sealed partial class LibraryRepository
{
    private const string SteamTitleSql = """
        COALESCE(
          (SELECT g.title FROM installations i JOIN games g ON g.id = i.game_id
           WHERE i.platform = 'steam' AND i.platform_game_id = {0} ORDER BY i.first_seen LIMIT 1),
          (SELECT o.name FROM steam_owned o WHERE o.app_id = {0}),
          'Steam app ' || {0})
        """;

    private const string SteamGameIdSql =
        "(SELECT i.game_id FROM installations i WHERE i.platform = 'steam' AND i.platform_game_id = {0} ORDER BY i.first_seen LIMIT 1)";

    // ---------- GPU driver ----------

    public void SetSessionGpu(string sessionId, string? driver, string? gpuName)
    {
        using var conn = db.Open();
        conn.Execute("UPDATE sessions SET gpu_driver=@driver, gpu_name=@gpuName WHERE id=@sessionId",
            new { sessionId, driver = Clip(driver, 64), gpuName = Clip(gpuName, 128) });
    }

    /// <summary>Finished tracked sessions with the GPU they ran on and their frame-rate summary, oldest first.</summary>
    public IReadOnlyList<DriverSessionRow> GetDriverSessions(string? gameId = null)
    {
        using var conn = db.Open();
        var sql = """
            SELECT id, game_id, start, duration_seconds, gpu_driver, gpu_name, perf_summary_json FROM sessions
            WHERE end IS NOT NULL AND source IN ('tracked','detected','background') AND (@gameId IS NULL OR game_id=@gameId)
            ORDER BY start
            """;
        return conn.Query<(string Id, string GameId, string Start, int Duration, string? Driver, string? Name, string? Perf)>(sql, new { gameId })
            .Where(r => DateTimeOffset.TryParse(r.Start, out _))
            .Select(r => new DriverSessionRow(r.Id, r.GameId, DateTimeOffset.Parse(r.Start), r.Duration, r.Driver, r.Name, PerfFields.Parse(r.Perf)))
            .ToList();
    }

    // ---------- Background apps ----------

    /// <summary>
    /// Replaces the background-app aggregate of a session (called every ~30 s while it runs and at the end),
    /// together with its snapshot count and memory load.
    /// </summary>
    public void SaveBackgroundApps(string sessionId, IReadOnlyList<BackgroundAppSample> apps, int snapshots, double? memLoadAvg, double? memLoadMax)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        conn.Execute("UPDATE sessions SET bg_snapshots=@snapshots, mem_load_avg=@memLoadAvg, mem_load_max=@memLoadMax WHERE id=@sessionId",
            new { sessionId, snapshots, memLoadAvg, memLoadMax }, tx);
        conn.Execute("DELETE FROM session_background_apps WHERE session_id=@sessionId", new { sessionId }, tx);
        foreach (var a in apps.DistinctBy(a => a.Name, StringComparer.OrdinalIgnoreCase).Take(64))
        {
            if (Clip(a.Name, 128) is not { Length: > 0 } name) continue;
            conn.Execute("""
                INSERT INTO session_background_apps(session_id, name, samples, avg_mb, max_mb, avg_cpu)
                SELECT @sessionId, @name, @Samples, @AvgMb, @MaxMb, @AvgCpu WHERE EXISTS (SELECT 1 FROM sessions WHERE id=@sessionId)
                """, new { sessionId, name, a.Samples, a.AvgMb, a.MaxMb, a.AvgCpu }, tx);
        }
        tx.Commit();
    }

    public IReadOnlyList<BackgroundAppSample> GetBackgroundApps(string sessionId)
    {
        using var conn = db.Open();
        return conn.Query<(string Name, int Samples, double? AvgMb, double? MaxMb, double? AvgCpu)>(
                "SELECT name, samples, avg_mb, max_mb, avg_cpu FROM session_background_apps WHERE session_id=@sessionId ORDER BY avg_mb DESC",
                new { sessionId })
            .Select(r => new BackgroundAppSample(r.Name, r.Samples, r.AvgMb, r.MaxMb, r.AvgCpu)).ToList();
    }

    /// <summary>Sessions that have background-app snapshots, and every app row recorded for them.</summary>
    public (IReadOnlyList<ImpactSessionRow> Sessions, IReadOnlyList<BackgroundAppRow> Apps) GetImpactData()
    {
        using var conn = db.Open();
        var sessions = conn.Query<(string Id, string GameId, string Start, int Duration, int? Snapshots, string? Perf, double? MemAvg, double? MemMax)>("""
                SELECT id, game_id, start, duration_seconds, bg_snapshots, perf_summary_json, mem_load_avg, mem_load_max
                FROM sessions WHERE end IS NOT NULL AND source IN ('tracked','detected','background') AND COALESCE(bg_snapshots, 0) > 0
                ORDER BY start
                """)
            .Where(r => DateTimeOffset.TryParse(r.Start, out _))
            .Select(r => new ImpactSessionRow(r.Id, r.GameId, DateTimeOffset.Parse(r.Start), r.Duration, r.Snapshots ?? 0,
                PerfFields.Parse(r.Perf), r.MemAvg, r.MemMax))
            .ToList();
        var apps = conn.Query<(string SessionId, string Name, int Samples, double? AvgMb, double? MaxMb, double? AvgCpu)>("""
                SELECT b.session_id, b.name, b.samples, b.avg_mb, b.max_mb, b.avg_cpu
                FROM session_background_apps b JOIN sessions s ON s.id = b.session_id
                WHERE s.end IS NOT NULL
                """)
            .Select(r => new BackgroundAppRow(r.SessionId, r.Name, r.Samples, r.AvgMb, r.MaxMb, r.AvgCpu))
            .ToList();
        return (sessions, apps);
    }

    public IReadOnlyList<string> GetHiddenBackgroundApps()
    {
        using var conn = db.Open();
        return conn.Query<string>("SELECT name FROM hidden_background_apps ORDER BY name").ToList();
    }

    /// <summary>Hides (or shows again) an app in the background-app report. Names are stored lower-case.</summary>
    public void SetBackgroundAppHidden(string name, bool hidden)
    {
        var key = Clip(name, 128)?.ToLowerInvariant();
        if (string.IsNullOrEmpty(key)) return;
        using var conn = db.Open();
        conn.Execute(hidden
            ? "INSERT OR IGNORE INTO hidden_background_apps(name, added) VALUES (@key, @now)"
            : "DELETE FROM hidden_background_apps WHERE name=@key", new { key, now = Now() });
    }

    // ---------- Achievement feed ----------

    /// <summary>Unlocked achievements across every cached Steam game, newest unlock first.</summary>
    public IReadOnlyList<AchievementFeedRow> GetAchievementFeed(int offset, int limit)
    {
        using var conn = db.Open();
        var sql = $"""
            SELECT a.app_id, {string.Format(SteamGameIdSql, "a.app_id")} AS game_id, {string.Format(SteamTitleSql, "a.app_id")} AS title,
                   a.api_name, a.display_name, a.description, a.icon_file, a.icon_gray_file, a.unlock_time, a.global_percent
            FROM steam_achievements a
            WHERE a.achieved = 1 AND a.unlock_time IS NOT NULL
            ORDER BY a.unlock_time DESC, a.app_id, a.sort_order, a.api_name
            LIMIT @limit OFFSET @offset
            """;
        return conn.Query<(string AppId, string? GameId, string Title, string Api, string Name, string? Desc, string? Icon, string? Gray, string Unlock, double? Pct)>(
                sql, new { offset = Math.Max(0, offset), limit = Math.Clamp(limit, 1, 500) })
            .Select(r => new AchievementFeedRow(r.AppId, r.GameId, r.Title, r.Api, r.Name, r.Desc, r.Icon, r.Gray, r.Unlock, r.Pct))
            .ToList();
    }

    public int CountUnlockedAchievements()
    {
        using var conn = db.Open();
        return conn.ExecuteScalar<int>("SELECT COUNT(*) FROM steam_achievements WHERE achieved = 1 AND unlock_time IS NOT NULL");
    }

    public AchievementTotals GetAchievementTotals()
    {
        using var conn = db.Open();
        var t = conn.QuerySingle<(int Unlocked, int Games, int Rare, int Ultra)>("""
            SELECT COALESCE(SUM(achieved), 0),
                   COUNT(DISTINCT app_id),
                   COALESCE(SUM(CASE WHEN achieved = 1 AND global_percent IS NOT NULL AND global_percent <= @rare THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN achieved = 1 AND global_percent IS NOT NULL AND global_percent <= @ultra THEN 1 ELSE 0 END), 0)
            FROM steam_achievements
            """, new { rare = AchievementInsights.RarePercent, ultra = AchievementInsights.UltraRarePercent });
        var last = conn.ExecuteScalar<string?>("SELECT MAX(fetched) FROM steam_achievement_fetch WHERE status IN ('ok', 'none', 'private')");
        return new AchievementTotals(t.Unlocked, t.Games, t.Rare, t.Ultra, last);
    }

    /// <summary>Per-app progress with the rarest still-locked achievement, for the near-completion shelf.</summary>
    public IReadOnlyList<AchievementProgressRow> GetAchievementProgress()
    {
        using var conn = db.Open();
        var sql = $"""
            SELECT p.app_id, {string.Format(SteamGameIdSql, "p.app_id")} AS game_id, {string.Format(SteamTitleSql, "p.app_id")} AS title,
                   p.total, p.unlocked, p.last_unlock,
                   r.display_name, r.global_percent, r.hidden
            FROM (
              SELECT app_id, COUNT(*) AS total, SUM(achieved) AS unlocked,
                     MAX(CASE WHEN achieved = 1 THEN unlock_time END) AS last_unlock
              FROM steam_achievements GROUP BY app_id
            ) p
            LEFT JOIN steam_achievements r ON r.app_id = p.app_id AND r.api_name = (
              SELECT x.api_name FROM steam_achievements x WHERE x.app_id = p.app_id AND x.achieved = 0
              ORDER BY x.global_percent IS NULL, x.global_percent, x.sort_order LIMIT 1)
            """;
        return conn.Query<(string AppId, string? GameId, string Title, int Total, int Unlocked, string? Last, string? RName, double? RPct, long? RHidden)>(sql)
            .Select(r => new AchievementProgressRow(r.AppId, r.GameId, r.Title, r.Total, r.Unlocked, r.Last, r.RName, r.RPct, r.RHidden == 1))
            .ToList();
    }

    private static string? Clip(string? s, int max)
    {
        if (s is null) return null;
        s = new string(s.Where(c => !char.IsControl(c)).ToArray()).Trim();
        return s.Length == 0 ? null : s.Length > max ? s[..max] : s;
    }
}
