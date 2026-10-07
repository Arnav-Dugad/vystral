using Dapper;

namespace Vystral.Core.Data;

/// <summary>A library game as universal search needs it: enough to say "In your library".</summary>
public sealed record DiscoverLibraryRow(string Id, string Title, string? SteamAppId, string? ReleaseDate);

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
}
