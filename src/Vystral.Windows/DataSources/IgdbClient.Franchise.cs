using System.Globalization;
using System.Text.Json;

namespace Vystral.Windows.DataSources;

/// <summary>An IGDB series (collection) or franchise a game belongs to.</summary>
public sealed record IgdbGroup(long Id, string Name, string Kind);

/// <summary>One game in a series, as IGDB lists it. <see cref="GameType"/> is IGDB's game_type (0 main game, 8 remake…).</summary>
public sealed record IgdbSeriesGame(long Id, string Name, string? Date, int? Year, int GameType, string? SteamAppId, string? CoverId);

/// <summary>Track C4: series and franchises for the franchise timeline (the user's own Twitch app, same lane and limits).</summary>
public sealed partial class IgdbClient
{
    /// <summary>Most series are far smaller; a franchise like Mario is clipped here.</summary>
    public const int MaxSeriesGames = 80;

    /// <summary>Main games, standalone expansions, remakes, remasters and expanded editions (not DLC, bundles, mods, ports or updates).</summary>
    internal const string SeriesGameTypes = "0,4,8,9,10";

    /// <summary>The series (collection) a game belongs to, else its main franchise, else its first franchise.</summary>
    public async Task<IgdbGroup?> GetSeriesOfAsync(long gameId, CancellationToken ct)
    {
        if (gameId <= 0) return null;
        var body = await QueryAsync("games",
            $"fields collections.name,franchise.name,franchises.name; where id = {gameId.ToString(CultureInfo.InvariantCulture)};", ct);
        return ParseSeriesOf(body);
    }

    /// <summary>Every main game (and remake, remaster…) in a series or franchise, oldest first.</summary>
    public async Task<IReadOnlyList<IgdbSeriesGame>> GetSeriesGamesAsync(IgdbGroup group, CancellationToken ct)
    {
        if (group.Id <= 0) return [];
        var id = group.Id.ToString(CultureInfo.InvariantCulture);
        var where = group.Kind == "series" ? $"collections = ({id})" : $"(franchise = {id} | franchises = ({id}))";
        var body = await QueryAsync("games",
            "fields name,first_release_date,game_type,external_games.uid,external_games.external_game_source,cover.image_id; " +
            $"where {where} & game_type = ({SeriesGameTypes}) & version_parent = null; sort first_release_date asc; limit {MaxSeriesGames};", ct);
        return ParseSeriesGames(body);
    }

    // ---------- Parsing (pure, unit-tested) ----------

    internal static IgdbGroup? ParseSeriesOf(string json)
    {
        using var doc = JsonRead.Parse(json, "IGDB");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
        var g = doc.RootElement.EnumerateArray().FirstOrDefault();
        if (g.ValueKind != JsonValueKind.Object) return null;
        static IgdbGroup? Group(JsonElement e, string kind) =>
            JsonRead.Long(e, "id") is { } id and > 0 && JsonRead.Str(e, "name", 120) is { } name ? new IgdbGroup(id, name, kind) : null;
        foreach (var c in JsonRead.Arr(g, "collections"))
            if (Group(c, "series") is { } s) return s;
        if (JsonRead.Obj(g, "franchise") is { } f && Group(f, "franchise") is { } main) return main;
        foreach (var f2 in JsonRead.Arr(g, "franchises"))
            if (Group(f2, "franchise") is { } fr) return fr;
        return null;
    }

    internal static IReadOnlyList<IgdbSeriesGame> ParseSeriesGames(string json)
    {
        using var doc = JsonRead.Parse(json, "IGDB");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return [];
        var result = new List<IgdbSeriesGame>();
        var seen = new HashSet<long>();
        foreach (var g in doc.RootElement.EnumerateArray())
        {
            if (result.Count >= MaxSeriesGames) break;
            var id = JsonRead.Long(g, "id");
            var name = JsonRead.Str(g, "name", 160);
            if (id is not > 0 || name is null || !seen.Add(id.Value)) continue;
            var type = JsonRead.Long(g, "game_type") is { } t and >= 0 and <= 30 ? (int)t : 0;
            var released = JsonRead.Long(g, "first_release_date");
            string? date = released is > 0 and < 4102444800 ? DateTimeOffset.FromUnixTimeSeconds(released.Value).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null;
            int? year = date is null ? null : int.Parse(date[..4], CultureInfo.InvariantCulture);
            string? steam = null;
            foreach (var x in JsonRead.Arr(g, "external_games"))
                if (JsonRead.Long(x, "external_game_source") == SteamSource && JsonRead.Str(x, "uid", 12) is { } uid && uid.Length <= 10 && uid.All(char.IsAsciiDigit) && uid[0] != '0')
                {
                    steam = uid;
                    break;
                }
            var cover = JsonRead.Obj(g, "cover") is { } c && JsonRead.Str(c, "image_id", 60) is { } img && IsImageId(img) ? img : null;
            result.Add(new IgdbSeriesGame(id.Value, name, date, year, type, steam, cover));
        }
        // Oldest first; games without a date (not announced yet) go last, by name.
        return result.OrderBy(g => g.Date is null).ThenBy(g => g.Date, StringComparer.Ordinal).ThenBy(g => g.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>IGDB image ids are short lowercase letters and digits.</summary>
    public static bool IsImageId(string? s) => s is { Length: > 0 and <= 40 } && s.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c));

    /// <summary>The cover image URL for an image id (built natively; the id is checked first).</summary>
    public static string? CoverUrl(string? imageId) => IsImageId(imageId) ? $"https://images.igdb.com/igdb/image/upload/t_cover_big/{imageId}.jpg" : null;
}
