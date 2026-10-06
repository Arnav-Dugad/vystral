using Dapper;
using Vystral.Core.Domain;

namespace Vystral.Core.Data;

/// <summary>One artwork row as stored (kind is lower-case: cover, hero, logo, header, icon).</summary>
public sealed record ArtworkRow(string GameId, string Kind, string File, string Source, bool IsUser);

/// <summary>
/// Track N: art packs. Art a pack applies is stored like a pick (is_user = 1, so scans and CDN
/// fetches never replace it) but with its own source, <see cref="ArtPackSource"/>, so it can be
/// told apart from art the user chose by hand. Hand-picked art is only ever replaced when the user
/// explicitly asked for it; restoring a pack only touches slots that still hold that pack's file.
/// </summary>
public sealed partial class LibraryRepository
{
    public const string ArtPackSource = "artpack";

    /// <summary>True for art the user chose by hand (picker or file), as opposed to an art pack or a store.</summary>
    public static bool IsHandPicked(ArtworkRow? row) => row is { IsUser: true } && row.Source != ArtPackSource;

    /// <summary>Every artwork row in the library (one query; used to plan art packs).</summary>
    public IReadOnlyList<ArtworkRow> AllArtwork()
    {
        using var conn = db.Open();
        return conn.Query<(string GameId, string Kind, string File, string Source, bool IsUser)>("SELECT game_id, kind, file, source, is_user FROM artwork")
            .Select(r => new ArtworkRow(r.GameId, r.Kind, r.File, r.Source, r.IsUser)).ToList();
    }

    public ArtworkRow? GetArtworkRow(string gameId, ArtworkKind kind)
    {
        using var conn = db.Open();
        var r = conn.QuerySingleOrDefault<(string GameId, string Kind, string File, string Source, bool IsUser)?>(
            "SELECT game_id, kind, file, source, is_user FROM artwork WHERE game_id=@gameId AND kind=@kind",
            new { gameId, kind = kind.ToString().ToLowerInvariant() });
        return r is { } v ? new ArtworkRow(v.GameId, v.Kind, v.File, v.Source, v.IsUser) : null;
    }

    /// <summary>
    /// Stores art-pack art for one slot unless it holds the user's own pick (and <paramref name="replaceHandPicked"/>
    /// is false). The check and the write happen in one transaction, so a pick made while a pack runs is never
    /// overwritten. Returns whether it was written and what the slot held before.
    /// </summary>
    public (bool Written, ArtworkRow? Previous) ApplyPackArtwork(string gameId, ArtworkKind kind, string file, bool replaceHandPicked)
    {
        var k = kind.ToString().ToLowerInvariant();
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var r = conn.QuerySingleOrDefault<(string GameId, string Kind, string File, string Source, bool IsUser)?>(
            "SELECT game_id, kind, file, source, is_user FROM artwork WHERE game_id=@gameId AND kind=@k", new { gameId, k }, tx);
        var previous = r is { } v ? new ArtworkRow(v.GameId, v.Kind, v.File, v.Source, v.IsUser) : null;
        if (IsHandPicked(previous) && !replaceHandPicked) return (false, previous);
        if (conn.ExecuteScalar<long>("SELECT COUNT(*) FROM games WHERE id=@gameId", new { gameId }, tx) == 0) return (false, previous);
        conn.Execute("""
            INSERT INTO artwork(game_id, kind, file, source, is_user, updated) VALUES (@gameId, @k, @file, @source, 1, @now)
            ON CONFLICT(game_id, kind) DO UPDATE SET file=excluded.file, source=excluded.source, is_user=1, updated=excluded.updated
            """, new { gameId, k, file, source = ArtPackSource, now = Now() }, tx);
        tx.Commit();
        return (true, previous);
    }

    /// <summary>
    /// Puts back what a slot held before an art pack, but only while it still holds that pack's file
    /// (<paramref name="packFile"/>): anything chosen since — by hand or by a newer pack — is left alone.
    /// A missing <paramref name="previous"/> means the slot was empty, so the row is removed.
    /// </summary>
    public bool RestorePackArtwork(string gameId, ArtworkKind kind, string packFile, ArtworkRow? previous)
    {
        var k = kind.ToString().ToLowerInvariant();
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var current = conn.QuerySingleOrDefault<(string File, string Source)?>(
            "SELECT file, source FROM artwork WHERE game_id=@gameId AND kind=@k", new { gameId, k }, tx);
        if (current is not { } c || c.Source != ArtPackSource || c.File != packFile) return false;
        if (previous is null)
            conn.Execute("DELETE FROM artwork WHERE game_id=@gameId AND kind=@k", new { gameId, k }, tx);
        else
            conn.Execute("UPDATE artwork SET file=@file, source=@source, is_user=@isUser, updated=@now WHERE game_id=@gameId AND kind=@k",
                new { gameId, k, file = previous.File, source = previous.Source, isUser = previous.IsUser, now = Now() }, tx);
        tx.Commit();
        return true;
    }
}
