using Dapper;

namespace Vystral.Core.Data;

/// <summary>Track D1: what a Library bulk action does. Kind: status | favorite | hidden | collection | played.</summary>
/// <param name="Status">For <c>status</c>: the new status, or null to clear it (validated with <see cref="GameStatus.IsValid"/>).</param>
/// <param name="Value">For favorite, hidden, collection (member) and played: on or off.</param>
/// <param name="CollectionId">For <c>collection</c>: a manual collection (smart collections are refused).</param>
public sealed record BulkAction(string Kind, string? Status = null, bool Value = false, string? CollectionId = null)
{
    public static readonly IReadOnlyList<string> Kinds = ["status", "favorite", "hidden", "collection", "played"];
}

/// <summary>
/// One game's state before a bulk change, for undo: only what the action can touch, plus the status-history rows the
/// change added (undo removes them, so the history reads as if nothing happened).
/// </summary>
public sealed record BulkBefore(string GameId, string? Status, string? StatusChanged, bool Favorite, bool Hidden, string? PlayedMarked,
    bool? Member, IReadOnlyList<long> HistoryIds);

/// <param name="Found">Requested games that exist.</param>
/// <param name="Before">Games the action actually changed, as they were.</param>
public sealed record BulkResult(int Requested, int Found, IReadOnlyList<BulkBefore> Before)
{
    public int Changed => Before.Count;
}

/// <summary>A bulk action that can't apply as asked (its message is shown to the user as is).</summary>
public sealed class BulkEditRefusedException(string message) : Exception(message);

public sealed partial class LibraryRepository
{
    /// <summary>The most games one bulk call may change.</summary>
    public const int MaxBulkGames = 5000;

    /// <summary>
    /// Track D1: applies one action to many games in a single transaction. Games that don't exist, and games already in
    /// the wanted state, are skipped. Returns the previous state of every game it changed (see <see cref="BulkRestore"/>).
    /// Throws <see cref="ArgumentException"/> for an invalid action (nothing is written).
    /// </summary>
    public BulkResult BulkEdit(IReadOnlyList<string> gameIds, BulkAction action, DateTimeOffset? at = null)
    {
        if (!BulkAction.Kinds.Contains(action.Kind, StringComparer.Ordinal)) throw new ArgumentException("Unknown action.", nameof(action));
        if (action.Kind == "status" && !GameStatus.IsValid(action.Status)) throw new ArgumentException("Unknown status.", nameof(action));
        var ids = gameIds.Distinct(StringComparer.Ordinal).ToList();
        if (ids.Count > MaxBulkGames) throw new ArgumentException($"At most {MaxBulkGames} games at a time.", nameof(gameIds));

        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        if (action.Kind == "collection")
        {
            var rule = conn.QuerySingleOrDefault<(string Id, string? Rule)>("SELECT id, rule_json FROM collections WHERE id=@id", new { id = action.CollectionId }, tx);
            if (rule.Id is null) throw new BulkEditRefusedException("That collection no longer exists.");
            if (rule.Rule is not null) throw new BulkEditRefusedException("Smart collections choose their own games, so games can’t be added or removed by hand.");
        }

        var when = (at ?? DateTimeOffset.UtcNow).ToString("O");
        var before = new List<BulkBefore>();
        var found = 0;
        foreach (var id in ids)
        {
            var row = conn.QuerySingleOrDefault<(string Id, string? Status, string? Changed, long Favorite, long Hidden, string? Played)>(
                "SELECT id, status, status_changed, favorite, hidden, played_marked FROM games WHERE id=@id", new { id }, tx);
            if (row.Id is null) continue;
            found++;
            bool? member = action.Kind == "collection"
                ? conn.ExecuteScalar<long>("SELECT COUNT(*) FROM collection_games WHERE collection_id=@c AND game_id=@id", new { c = action.CollectionId, id }, tx) > 0
                : null;
            var history = new List<long>();
            var changed = action.Kind switch
            {
                "status" when row.Status != action.Status => Run(() =>
                {
                    conn.Execute("UPDATE games SET status=@s, status_changed=@when, updated=@when WHERE id=@id", new { s = action.Status, when, id }, tx);
                    conn.Execute("INSERT INTO status_history(game_id, status, at) VALUES (@id, @s, @when)", new { id, s = action.Status, when }, tx);
                    history.Add(conn.ExecuteScalar<long>("SELECT last_insert_rowid()", transaction: tx));
                }),
                "favorite" when (row.Favorite != 0) != action.Value =>
                    Run(() => conn.Execute("UPDATE games SET favorite=@v, updated=@when WHERE id=@id", new { v = action.Value, when, id }, tx)),
                "hidden" when (row.Hidden != 0) != action.Value =>
                    Run(() => conn.Execute("UPDATE games SET hidden=@v, updated=@when WHERE id=@id", new { v = action.Value, when, id }, tx)),
                "played" when (row.Played is not null) != action.Value =>
                    Run(() => conn.Execute("UPDATE games SET played_marked=@v, updated=@when WHERE id=@id", new { v = action.Value ? when : null, when, id }, tx)),
                "collection" when member != action.Value => Run(() => conn.Execute(action.Value
                    ? "INSERT OR IGNORE INTO collection_games(collection_id, game_id) VALUES (@c, @id)"
                    : "DELETE FROM collection_games WHERE collection_id=@c AND game_id=@id", new { c = action.CollectionId, id }, tx)),
                _ => false,
            };
            if (changed) before.Add(new BulkBefore(id, row.Status, row.Changed, row.Favorite != 0, row.Hidden != 0, row.Played, member, history));
        }
        if (before.Count > 0) Audit(conn, tx, "library.bulkEdit", $"{Describe(action)}: {before.Count} of {ids.Count} games");
        tx.Commit();
        return new BulkResult(ids.Count, found, before);
    }

    /// <summary>
    /// Track D1: puts every game a <see cref="BulkEdit"/> changed back exactly as it was, in one transaction: only the
    /// field the action touched is restored (anything else changed since is kept), and the status-history rows it added
    /// are removed. Games that no longer exist are skipped. Returns how many games were restored.
    /// </summary>
    public int BulkRestore(BulkAction action, IReadOnlyList<BulkBefore> before)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var now = Now();
        var restored = 0;
        foreach (var b in before)
        {
            if (b.HistoryIds.Count > 0) conn.Execute("DELETE FROM status_history WHERE id IN @ids AND game_id=@GameId", new { ids = b.HistoryIds, b.GameId }, tx);
            if (conn.ExecuteScalar<long>("SELECT COUNT(*) FROM games WHERE id=@GameId", new { b.GameId }, tx) == 0) continue;
            switch (action.Kind)
            {
                case "status":
                    conn.Execute("UPDATE games SET status=@Status, status_changed=@StatusChanged, updated=@now WHERE id=@GameId", new { b.Status, b.StatusChanged, now, b.GameId }, tx);
                    break;
                case "favorite":
                    conn.Execute("UPDATE games SET favorite=@Favorite, updated=@now WHERE id=@GameId", new { b.Favorite, now, b.GameId }, tx);
                    break;
                case "hidden":
                    conn.Execute("UPDATE games SET hidden=@Hidden, updated=@now WHERE id=@GameId", new { b.Hidden, now, b.GameId }, tx);
                    break;
                case "played":
                    conn.Execute("UPDATE games SET played_marked=@PlayedMarked, updated=@now WHERE id=@GameId", new { b.PlayedMarked, now, b.GameId }, tx);
                    break;
                case "collection" when b.Member is { } m:
                    conn.Execute(m
                        ? "INSERT OR IGNORE INTO collection_games(collection_id, game_id) SELECT @c, @GameId WHERE EXISTS (SELECT 1 FROM collections WHERE id=@c)"
                        : "DELETE FROM collection_games WHERE collection_id=@c AND game_id=@GameId", new { c = action.CollectionId, b.GameId }, tx);
                    break;
                default:
                    continue;
            }
            restored++;
        }
        if (before.Count > 0) Audit(conn, tx, "library.bulkUndo", $"{Describe(action)}: {restored} games restored");
        tx.Commit();
        return restored;
    }

    private static bool Run(Action a)
    {
        a();
        return true;
    }

    private static string Describe(BulkAction a) => a.Kind switch
    {
        "status" => $"status -> {a.Status ?? "(none)"}",
        "collection" => $"collection {a.CollectionId} {(a.Value ? "add" : "remove")}",
        _ => $"{a.Kind} -> {(a.Value ? "on" : "off")}",
    };
}
