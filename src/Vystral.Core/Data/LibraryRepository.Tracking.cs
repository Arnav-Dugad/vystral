using Dapper;
using Vystral.Core.Domain;

namespace Vystral.Core.Data;

/// <summary>An open (unfinished) session, as the background tracker needs it to continue or close it.</summary>
public sealed record OpenSessionRow(string Id, string GameId, string? InstallationId, DateTimeOffset Start, string Source);

/// <summary>The most recent session VYSTRAL noticed without launching it (for the Settings status line).</summary>
public sealed record ObservedSessionRow(string Id, string GameId, string GameTitle, string Source, DateTimeOffset Start, DateTimeOffset? End, int DurationSeconds);

/// <summary>
/// Track H: games tracked when they were started outside VYSTRAL (while it was open, or by the
/// background tracker while it was closed). Uses the existing tables only.
/// </summary>
public sealed partial class LibraryRepository
{
    /// <summary>Starts a session with an explicit source (<see cref="SessionSources"/>).</summary>
    public string StartSession(string gameId, string? installationId, DateTimeOffset start, string source)
    {
        if (!SessionSources.IsObserved(source)) throw new ArgumentException("Only observed sessions can be started.", nameof(source));
        using var conn = db.Open();
        var id = NewId();
        conn.Execute("INSERT INTO sessions(id, game_id, installation_id, start, source) VALUES (@id, @gameId, @installationId, @start, @source)",
            new { id, gameId, installationId, start = start.ToString("O"), source });
        return id;
    }

    /// <summary>Installed installations of games that aren't hidden: what the game detector watches for.</summary>
    public IReadOnlyList<Installation> GetDetectableInstallations()
    {
        using var conn = db.Open();
        return conn.Query<InstallationRow>("""
            SELECT i.* FROM installations i JOIN games g ON g.id = i.game_id
            WHERE i.state = 'installed' AND g.hidden = 0
            """).Select(ToDomain).ToList();
    }

    /// <summary>Removes a session and everything recorded with it (used for detections shorter than a minute).</summary>
    public bool DeleteSession(string sessionId)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        conn.Execute("DELETE FROM perf_samples WHERE session_id=@sessionId", new { sessionId }, tx);
        conn.Execute("DELETE FROM session_background_apps WHERE session_id=@sessionId", new { sessionId }, tx);
        var n = conn.Execute("DELETE FROM sessions WHERE id=@sessionId", new { sessionId }, tx);
        tx.Commit();
        return n == 1;
    }

    /// <summary>An unfinished session by id, or null when it doesn't exist or has already ended.</summary>
    public OpenSessionRow? GetOpenSession(string sessionId)
    {
        using var conn = db.Open();
        var rows = conn.Query<(string Id, string GameId, string? InstallationId, string Start, string Source)>(
            "SELECT id, game_id, installation_id, start, source FROM sessions WHERE id=@sessionId AND end IS NULL", new { sessionId }).ToList();
        return rows is [var row] && DateTimeOffset.TryParse(row.Start, out var start)
            ? new OpenSessionRow(row.Id, row.GameId, row.InstallationId, start, row.Source)
            : null;
    }

    /// <summary>Whether a background-app aggregate was already stored for the session.</summary>
    public bool HasBackgroundApps(string sessionId)
    {
        using var conn = db.Open();
        return conn.ExecuteScalar<long>("SELECT COALESCE(bg_snapshots, 0) FROM sessions WHERE id=@sessionId", new { sessionId }) > 0;
    }

    /// <summary>
    /// Like <see cref="RecoverOpenSessions()"/>, but leaves <paramref name="except"/> open (a session the
    /// other tracker process still owns or handed over) and, when known, uses the tracker's own
    /// last-seen time instead of the last performance sample.
    /// </summary>
    public int RecoverOpenSessions(IReadOnlyCollection<string> except, IReadOnlyDictionary<string, DateTimeOffset>? lastSeen = null)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var open = conn.Query<(string Id, string Start, long? LastMs, int Known)>("""
            SELECT s.id, s.start, (SELECT MAX(t_offset_ms) FROM perf_samples p WHERE p.session_id = s.id), COALESCE(s.duration_seconds, 0)
            FROM sessions s WHERE s.end IS NULL
            """, transaction: tx).Where(o => !except.Contains(o.Id)).ToList();
        foreach (var (id, start, lastMs, known) in open)
        {
            // Best evidence of how long it ran: the last performance sample or the last recorded heartbeat.
            var duration = Math.Max((int)((lastMs ?? 0) / 1000), known);
            var parsed = DateTimeOffset.TryParse(start, out var s);
            if (parsed && lastSeen is not null && lastSeen.TryGetValue(id, out var seen) && seen > s)
                duration = Math.Max(duration, (int)Math.Min(int.MaxValue, (seen - s).TotalSeconds));
            var end = parsed ? s.AddSeconds(duration).ToString("O") : start;
            conn.Execute("UPDATE sessions SET duration_seconds=@duration, end=@end WHERE id=@id", new { id, duration, end }, tx);
        }
        tx.Commit();
        return open.Count;
    }

    /// <summary>The newest finished session with one of <paramref name="sources"/>, with its game's title.</summary>
    public ObservedSessionRow? LatestSession(params string[] sources)
    {
        using var conn = db.Open();
        var rows = conn.Query<(string Id, string GameId, string Title, string Source, string Start, string? End, int Duration)>("""
            SELECT s.id, s.game_id, g.title, s.source, s.start, s.end, s.duration_seconds
            FROM sessions s JOIN games g ON g.id = s.game_id
            WHERE s.source IN @sources AND s.end IS NOT NULL
            ORDER BY s.start DESC LIMIT 1
            """, new { sources }).ToList();
        if (rows is not [var row] || !DateTimeOffset.TryParse(row.Start, out var start)) return null;
        DateTimeOffset? end = DateTimeOffset.TryParse(row.End, out var e) ? e : null;
        return new ObservedSessionRow(row.Id, row.GameId, row.Title, row.Source, start, end, row.Duration);
    }

    /// <summary>The time an open session has recorded as played so far, or null when it isn't open or has none.</summary>
    public int? GetOpenSessionSeconds(string sessionId)
    {
        using var conn = db.Open();
        return conn.ExecuteScalar<int?>("SELECT duration_seconds FROM sessions WHERE id=@sessionId AND end IS NULL", new { sessionId });
    }

    /// <summary>Records how long an open session has run so far (its end stays empty until it really ends).</summary>
    public void TouchOpenSession(string sessionId, int seconds)
    {
        using var conn = db.Open();
        conn.Execute("UPDATE sessions SET duration_seconds=MAX(COALESCE(duration_seconds,0), @seconds) WHERE id=@sessionId AND end IS NULL", new { sessionId, seconds });
    }
}
