using System.Text.Json;
using Dapper;
using Vystral.Core.Health;

namespace Vystral.Core.Data;

/// <summary>Track Q: rows the library health check reads, and its few non-destructive fixes.</summary>
public sealed record HealthRows(
    IReadOnlyList<HealthLaunchRow> Launches,
    IReadOnlyList<HealthArtRow> Art,
    IReadOnlySet<string> MetadataAttempted,
    IReadOnlyDictionary<string, string> SteamAppIds,
    IReadOnlyList<HealthSessionRow> OpenSessions,
    IReadOnlyList<HealthSessionRow> LongSessions);

public sealed partial class LibraryRepository
{
    public HealthRows LoadHealthRows(DateTimeOffset now)
    {
        using var conn = db.Open();
        var launches = conn.Query<(string Id, string Kind, string Value)>("SELECT id, launch_kind, launch_value FROM installations")
            .Select(r => new HealthLaunchRow(r.Id, r.Kind, r.Value)).ToList();
        var art = conn.Query<(string GameId, string Kind, string File, string Source, long IsUser)>("SELECT game_id, kind, file, source, is_user FROM artwork")
            .Select(r => new HealthArtRow(r.GameId, r.Kind, r.File, r.Source, r.IsUser != 0)).ToList();
        var attempted = conn.Query<string>("SELECT id FROM games WHERE metadata_fetched IS NOT NULL").ToHashSet(StringComparer.Ordinal);
        // A game's Steam app: its own, else any of its Steam installations'.
        var steam = conn.Query<(string GameId, string AppId)>("""
            SELECT id, steam_app_id FROM games WHERE steam_app_id IS NOT NULL
            UNION ALL
            SELECT game_id, platform_game_id FROM installations WHERE platform='steam'
            """).GroupBy(r => r.GameId).ToDictionary(g => g.Key, g => g.First().AppId, StringComparer.Ordinal);
        var open = conn.Query<(string Id, string GameId, string Start, int Duration)>(
                "SELECT id, game_id, start, COALESCE(duration_seconds, 0) FROM sessions WHERE end IS NULL ORDER BY start DESC LIMIT 200")
            .Select(r => new HealthSessionRow(r.Id, r.GameId, r.Start, r.Duration)).ToList();
        var longOnes = conn.Query<(string Id, string GameId, string Start, int Duration)>("""
                SELECT id, game_id, start, duration_seconds FROM sessions
                WHERE end IS NOT NULL AND duration_seconds >= @min AND start >= @since
                ORDER BY duration_seconds DESC LIMIT 50
                """, new { min = LibraryHealth.LongSessionSeconds, since = now.AddDays(-365).ToString("O") })
            .Select(r => new HealthSessionRow(r.Id, r.GameId, r.Start, r.Duration)).ToList();
        return new HealthRows(launches, art, attempted, steam, open, longOnes);
    }

    /// <summary>
    /// Points a game you added at its program again (after it was moved). Only user-added ("manual")
    /// installations; the folder, working directory and process hint follow the new file. Nothing on disk changes.
    /// </summary>
    public bool RelocateManualExecutable(string installationId, string exePath)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var platform = conn.ExecuteScalar<string?>("SELECT platform FROM installations WHERE id=@installationId", new { installationId }, tx);
        if (platform != "manual") return false;
        var dir = Path.GetDirectoryName(exePath);
        conn.Execute("""
            UPDATE installations SET launch_value=@exePath, install_path=@dir, launch_workdir=@dir, process_hints_json=@hints,
                state='installed', last_seen=@now
            WHERE id=@installationId
            """, new { exePath, dir, hints = JsonSerializer.Serialize(new[] { Path.GetFileName(exePath) }), now = Now(), installationId }, tx);
        Audit(conn, tx, "health.relocate", $"{installationId}: {exePath}");
        tx.Commit();
        return true;
    }

    /// <summary>
    /// Closes one session left without an end, with the same evidence crash recovery uses (its last performance
    /// sample or heartbeat). Only an open session is touched; its time is kept, never discarded.
    /// </summary>
    public bool CloseOpenSession(string sessionId)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var rows = conn.Query<(string Start, long? LastMs, int Known)>("""
            SELECT s.start, (SELECT MAX(t_offset_ms) FROM perf_samples p WHERE p.session_id = s.id), COALESCE(s.duration_seconds, 0)
            FROM sessions s WHERE s.id=@sessionId AND s.end IS NULL
            """, new { sessionId }, tx).ToList();
        if (rows.Count == 0) return false;
        var r = rows[0];
        var duration = Math.Max((int)((r.LastMs ?? 0) / 1000), r.Known);
        var end = DateTimeOffset.TryParse(r.Start, out var s) ? s.AddSeconds(duration).ToString("O") : r.Start;
        conn.Execute("UPDATE sessions SET duration_seconds=@duration, end=@end WHERE id=@sessionId AND end IS NULL", new { duration, end, sessionId }, tx);
        Audit(conn, tx, "health.closeSession", $"{sessionId}: {duration}s");
        tx.Commit();
        return true;
    }

    /// <summary>Lets the background details lookup try these games again (it skips games already attempted).</summary>
    public int ResetMetadataLookup(IReadOnlyCollection<string> gameIds)
    {
        if (gameIds.Count == 0) return 0;
        using var conn = db.Open();
        return conn.Execute("UPDATE games SET metadata_fetched=NULL WHERE id IN @gameIds", new { gameIds });
    }
}
