using Dapper;
using Microsoft.Data.Sqlite;
using Vystral.Core.Media;

namespace Vystral.Core.Data;

/// <summary>The play statuses a user can give a game. <c>null</c> means "no status".</summary>
public static class GameStatus
{
    public const string Backlog = "backlog";
    public const string Playing = "playing";
    public const string Beaten = "beaten";
    public const string Completed = "completed";
    public const string Abandoned = "abandoned";

    public static readonly IReadOnlyList<string> All = [Backlog, Playing, Beaten, Completed, Abandoned];

    public static bool IsValid(string? status) => status is null || All.Contains(status, StringComparer.Ordinal);
}

/// <summary>Result of a status change. <see cref="Changed"/> is false when the game already had that status.</summary>
public sealed record StatusChange(string GameId, string? Previous, string? Status, string? ChangedAt, bool Changed);

/// <summary>One row of status history, as sent to the UI for charts.</summary>
public sealed record StatusHistoryEntry(string GameId, string? Status, string At);

public sealed partial class LibraryRepository
{
    /// <summary>
    /// Sets (or clears, with null) a game's play status. Records a history row and an audit entry
    /// only when the value actually changes. Returns null when the game doesn't exist.
    /// The status must already be validated with <see cref="GameStatus.IsValid"/>.
    /// </summary>
    public StatusChange? SetStatus(string gameId, string? status, DateTimeOffset? at = null)
    {
        if (!GameStatus.IsValid(status)) throw new ArgumentException("Unknown status.", nameof(status));
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var row = conn.QuerySingleOrDefault<(string Id, string? Status, string? Changed)>(
            "SELECT id, status, status_changed FROM games WHERE id=@gameId", new { gameId }, tx);
        if (row.Id is null) return null;
        if (row.Status == status) return new StatusChange(gameId, row.Status, status, row.Changed, false);

        var when = (at ?? DateTimeOffset.UtcNow).ToString("O");
        conn.Execute("UPDATE games SET status=@status, status_changed=@when, updated=@when WHERE id=@gameId",
            new { status, when, gameId }, tx);
        conn.Execute("INSERT INTO status_history(game_id, status, at) VALUES (@gameId, @status, @when)",
            new { gameId, status, when }, tx);
        Audit(conn, tx, "game.setStatus", $"{gameId}: {row.Status ?? "(none)"} -> {status ?? "(none)"}");
        tx.Commit();
        return new StatusChange(gameId, row.Status, status, when, true);
    }

    /// <summary>Status history for games that still exist, oldest first.</summary>
    public IReadOnlyList<StatusHistoryEntry> GetStatusHistory()
    {
        using var conn = db.Open();
        return conn.Query<(string GameId, string? Status, string At)>("""
                SELECT h.game_id, h.status, h.at FROM status_history h
                JOIN games g ON g.id = h.game_id
                ORDER BY h.at, h.id
                """)
            .Select(r => new StatusHistoryEntry(r.GameId, r.Status, r.At)).ToList();
    }

    /// <summary>Current status per game, for the library snapshot.</summary>
    private static Dictionary<string, (string? Status, string? Changed)> LoadStatuses(SqliteConnection conn) =>
        conn.Query<(string Id, string? Status, string? Changed)>("SELECT id, status, status_changed FROM games WHERE status IS NOT NULL")
            .ToDictionary(r => r.Id, r => (r.Status, r.Changed));

    // ---------- Trailer metadata ----------

    /// <summary>Stores the chosen trailer for a game, or records that none was usable (<paramref name="trailer"/> null).</summary>
    public void SetTrailer(string gameId, string steamAppId, SteamTrailer? trailer, DateTimeOffset? fetched = null)
    {
        using var conn = db.Open();
        conn.Execute("""
            INSERT INTO game_media(game_id, kind, steam_app_id, movie_id, name, format, url, thumbnail, highlight, fetched)
            SELECT @gameId, 'trailer', @steamAppId, @movieId, @name, @format, @url, @thumbnail, @highlight, @fetched
            WHERE EXISTS (SELECT 1 FROM games WHERE id=@gameId)
            ON CONFLICT(game_id, kind) DO UPDATE SET steam_app_id=excluded.steam_app_id, movie_id=excluded.movie_id,
              name=excluded.name, format=excluded.format, url=excluded.url, thumbnail=excluded.thumbnail,
              highlight=excluded.highlight, fetched=excluded.fetched
            """, new
        {
            gameId, steamAppId,
            movieId = trailer?.MovieId, name = trailer?.Name,
            format = trailer?.Format ?? "none", url = trailer?.Url, thumbnail = trailer?.Thumbnail,
            highlight = trailer?.Highlight ?? false,
            fetched = (fetched ?? DateTimeOffset.UtcNow).ToString("O"),
        });
    }

    /// <summary>
    /// The stored trailer row for a game. <c>Trailer</c> is null when the store had nothing usable;
    /// the whole result is null when the store was never checked.
    /// </summary>
    public (SteamTrailer? Trailer, string SteamAppId, DateTimeOffset Fetched)? GetTrailer(string gameId)
    {
        using var conn = db.Open();
        var r = conn.QuerySingleOrDefault<TrailerRow>(
            "SELECT steam_app_id, movie_id, name, format, url, thumbnail, highlight, fetched FROM game_media WHERE game_id=@gameId AND kind='trailer'",
            new { gameId });
        if (r is null) return null;
        var fetched = DateTimeOffset.TryParse(r.fetched, out var f) ? f : DateTimeOffset.MinValue;
        var trailer = r.format != "none" && r.url is not null
            ? new SteamTrailer(r.steam_app_id, r.movie_id ?? "", r.name, r.format, r.url, r.thumbnail, r.highlight != 0)
            : null;
        return (trailer, r.steam_app_id, fetched);
    }

    /// <summary>The exact Steam appid recorded for a game (from a Steam installation), if any.</summary>
    public string? GetSteamAppId(string gameId)
    {
        using var conn = db.Open();
        return conn.ExecuteScalar<string?>("SELECT steam_app_id FROM games WHERE id=@gameId", new { gameId });
    }

#pragma warning disable IDE1006
    private sealed class TrailerRow
    {
        public string steam_app_id { get; init; } = "";
        public string? movie_id { get; init; }
        public string? name { get; init; }
        public string format { get; init; } = "none";
        public string? url { get; init; }
        public string? thumbnail { get; init; }
        public long highlight { get; init; }
        public string fetched { get; init; } = "";
    }
#pragma warning restore IDE1006
}
