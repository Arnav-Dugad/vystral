using Dapper;
using Vystral.Core.Domain;

namespace Vystral.Core.Data;

public sealed partial class LibraryRepository
{
    /// <summary>
    /// Steam games (installed or owned) that still have no cover, favourites and recently played
    /// first, then alphabetical, so the part of the library people look at fills in first.
    /// </summary>
    public IReadOnlyList<(string GameId, string AppId)> SteamGamesMissingCover(int limit)
    {
        using var conn = db.Open();
        return conn.Query<(string, string)>("""
            SELECT g.id, g.steam_app_id FROM games g
            WHERE g.steam_app_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM artwork a WHERE a.game_id = g.id AND a.kind = 'cover')
            ORDER BY g.favorite DESC, g.sort_title
            LIMIT @limit
            """, new { limit }).ToList();
    }

    /// <summary>Downloaded (non-user) artwork of one kind, for cache housekeeping.</summary>
    public IReadOnlyList<(string GameId, string File)> DownloadedArtwork(ArtworkKind kind, string source)
    {
        using var conn = db.Open();
        return conn.Query<(string, string)>("SELECT game_id, file FROM artwork WHERE kind=@kind AND source=@source AND is_user=0",
            new { kind = kind.ToString().ToLowerInvariant(), source }).ToList();
    }

    /// <summary>Forgets one non-user artwork row (the file is left for the cache sweep). Never touches user-chosen art.</summary>
    public bool ForgetDownloadedArtwork(string gameId, ArtworkKind kind)
    {
        using var conn = db.Open();
        return conn.Execute("DELETE FROM artwork WHERE game_id=@gameId AND kind=@kind AND is_user=0",
            new { gameId, kind = kind.ToString().ToLowerInvariant() }) > 0;
    }

    /// <summary>Kind → (source, is_user) of a game's artwork rows.</summary>
    public IReadOnlyDictionary<string, (string Source, bool IsUser)> GetArtworkSources(string gameId)
    {
        using var conn = db.Open();
        return conn.Query<(string Kind, string Source, bool IsUser)>("SELECT kind, source, is_user FROM artwork WHERE game_id=@gameId", new { gameId })
            .ToDictionary(a => a.Kind, a => (a.Source, a.IsUser));
    }

    /// <summary>Forgets every downloaded (non-user) artwork row, e.g. after their files were cleared from the cache.</summary>
    public int ForgetAllDownloadedArtwork()
    {
        using var conn = db.Open();
        var forgotten = conn.Execute("DELETE FROM artwork WHERE is_user=0");
        // Heroes and logos for Steam games come with the store details pass, so let it run again.
        conn.Execute("UPDATE games SET metadata_fetched=NULL WHERE steam_app_id IS NOT NULL");
        return forgotten;
    }
}
