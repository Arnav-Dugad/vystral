using System.Globalization;
using System.Text.Json;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;

namespace Vystral.Windows.Discover;

/// <summary>One app in one of Steam's featured lists (featuredcategories), as far as a shelf needs it.</summary>
/// <param name="Price">Null when Steam gives no price (coming soon, or no currency).</param>
public sealed record SteamFeaturedItem(string AppId, string Name, StorePrice? Price, int DiscountPercent, IReadOnlyList<string> Platforms,
    IReadOnlyList<DiscoverImage> Images);

/// <summary>Steam's featured lists by section: top_sellers, specials, new_releases, coming_soon and daily_deal.</summary>
public sealed record SteamFeatured(IReadOnlyDictionary<string, IReadOnlyList<SteamFeaturedItem>> Sections);

/// <summary>
/// What Steam's store says about one app (IStoreBrowseService/GetItems and IStoreQueryService/Query share the shape).
/// <paramref name="Type"/> 0 is a game (4 DLC, 10 hardware, 11 music); <paramref name="Adult"/> marks the content
/// descriptors Steam itself hides by default (adult-only or frequent sexual content).
/// </summary>
public sealed record SteamStoreFacts(
    string AppId, string Name, int Type, bool Visible, bool Free, bool Adult, string? ReleaseDate, int? Year, bool ComingSoon,
    IReadOnlyList<int> TagIds, long? FinalCents, int DiscountPercent, string? PriceText, IReadOnlyList<DiscoverImage> Images)
{
    public bool Showable => Type == 0 && Visible && !Adult;
}

/// <summary>One page of Steam's store query: the apps in order and how many match in all.</summary>
public sealed record SteamStoreQueryPage(IReadOnlyList<SteamStoreFacts> Items, int Total);

/// <summary>
/// Track C3: pure, defensive readers for Discover's browse shelves. Provider JSON is untrusted: wrong types are treated as
/// missing, text is cleaned and clipped, app IDs must be digits, prices and dates are range-checked, images must be HTTPS
/// on Steam's CDN, and every list is capped.
/// </summary>
public static class DiscoverBrowseParsers
{
    public const int MaxPerSection = 40;
    public const int MaxBodyChars = 3_000_000;

    private static readonly string[] Sections = ["top_sellers", "specials", "new_releases", "coming_soon"];

    /// <summary>Steam content descriptors the store itself hides unless you ask: adult-only sexual content (3) and frequent nudity or sexual content (4).</summary>
    private static readonly HashSet<long> AdultDescriptors = [3, 4];

    // ---------- store.steampowered.com/api/featuredcategories ----------

    public static SteamFeatured ParseFeaturedCategories(string json)
    {
        if (json.Length > MaxBodyChars) throw new DataSourceException(DataSourceOutcome.Malformed, "Steam’s answer was too large.");
        using var doc = JsonRead.Parse(json, "Steam");
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new DataSourceException(DataSourceOutcome.Malformed, "Steam’s answer couldn’t be read.");
        var result = new Dictionary<string, IReadOnlyList<SteamFeaturedItem>>(StringComparer.Ordinal);
        foreach (var name in Sections)
            if (JsonRead.Obj(root, name) is { } section) result[name] = Items(section, comingSoon: name == "coming_soon");
        // The daily deal sits under a numbered key ("6") with the id "cat_dailydeal".
        foreach (var prop in root.EnumerateObject().Take(40))
            if (prop.Value.ValueKind == JsonValueKind.Object && JsonRead.Str(prop.Value, "id", 40) == "cat_dailydeal")
            {
                result["daily_deal"] = Items(prop.Value, comingSoon: false);
                break;
            }
        return new SteamFeatured(result);
    }

    private static IReadOnlyList<SteamFeaturedItem> Items(JsonElement section, bool comingSoon)
    {
        var list = new List<SteamFeaturedItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in JsonRead.Arr(section, "items").Take(100))
        {
            // type 0 is an app; packages and bundles have other types.
            if (JsonRead.Long(item, "type") is not 0) continue;
            var id = JsonRead.Str(item, "id", 12);
            var name = JsonRead.Str(item, "name", 200);
            if (id is null || !DiscoverKeys.SteamAppId().IsMatch(id) || name is null || !seen.Add(id)) continue;
            StorePrice? price = null;
            var cut = (int)Math.Clamp(JsonRead.Long(item, "discount_percent") ?? 0, 0, 100);
            if (JsonRead.Str(item, "currency", 3) is { } cur && Currency(cur) && JsonRead.Long(item, "final_price") is >= 0 and < 100_000_000 and var final)
            {
                var initial = JsonRead.Long(item, "original_price") is >= 0 and < 100_000_000 and var o ? o : final;
                // A coming-soon game's 0 is "no price yet", not "free".
                if (!(comingSoon && final == 0)) price = new StorePrice(final, Math.Max(initial, final), cur);
            }
            var platforms = new List<string>();
            if (JsonRead.Bool(item, "windows_available")) platforms.Add("PC");
            if (JsonRead.Bool(item, "mac_available")) platforms.Add("Mac");
            if (JsonRead.Bool(item, "linux_available")) platforms.Add("Linux");
            var images = new List<DiscoverImage>();
            if (DiscoverParsers.SafeImage(JsonRead.Str(item, "header_image", 500)) is { } header) images.Add(new DiscoverImage("header", header));
            list.Add(new SteamFeaturedItem(id, name, price, price is null ? 0 : cut, platforms, images));
            if (list.Count >= MaxPerSection) break;
        }
        return list;
    }

    // ---------- api.steampowered.com IStoreBrowseService/GetItems and IStoreQueryService/Query ----------

    public static IReadOnlyList<SteamStoreFacts> ParseStoreItems(string json) => ParseStoreQuery(json).Items;

    public static SteamStoreQueryPage ParseStoreQuery(string json)
    {
        if (json.Length > MaxBodyChars) throw new DataSourceException(DataSourceOutcome.Malformed, "Steam’s answer was too large.");
        using var doc = JsonRead.Parse(json, "Steam");
        if (JsonRead.Obj(doc.RootElement, "response") is not { } response) throw new DataSourceException(DataSourceOutcome.Malformed, "Steam’s answer couldn’t be read.");
        var total = JsonRead.Obj(response, "metadata") is { } meta ? (int)Math.Clamp(JsonRead.Long(meta, "total_matching_records") ?? 0, 0, 10_000_000) : 0;
        var parsed = new List<(SteamStoreFacts Facts, JsonElement Raw)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in JsonRead.Arr(response, "store_items").Take(200))
        {
            var idNum = JsonRead.Long(item, "appid");
            if (idNum is not (> 0 and < 10_000_000_000)) continue;
            var id = idNum.Value.ToString(CultureInfo.InvariantCulture);
            var name = JsonRead.Str(item, "name", 200);
            if (name is null || !seen.Add(id)) continue;
            var type = (int)Math.Clamp(JsonRead.Long(item, "type") ?? -1, -1, 100);
            var visible = !(item.TryGetProperty("visible", out var v) && v.ValueKind == JsonValueKind.False);
            var adult = JsonRead.Arr(item, "content_descriptorids").Any(d => d.ValueKind == JsonValueKind.Number && d.TryGetInt64(out var n) && AdultDescriptors.Contains(n));
            string? date = null;
            int? year = null;
            var comingSoon = false;
            if (JsonRead.Obj(item, "release") is { } rel)
            {
                comingSoon = JsonRead.Bool(rel, "is_coming_soon");
                if (JsonRead.Long(rel, "steam_release_date") is > 0 and < 4_102_444_800 and var unix)
                {
                    var d = DateTimeOffset.FromUnixTimeSeconds(unix);
                    // Steam stores a placeholder day for "Q3 2027"-style dates: show only what it really promises.
                    var display = comingSoon ? JsonRead.Str(rel, "coming_soon_display", 30) : "date_full";
                    (date, year) = display switch
                    {
                        "date_full" => (d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), d.Year),
                        "date_month" => (d.ToString("yyyy-MM", CultureInfo.InvariantCulture), d.Year),
                        "date_quarter" or "date_year" => ((string?)null, (int?)d.Year),
                        _ => (null, null),
                    };
                }
            }
            var tags = JsonRead.Arr(item, "tagids").Where(t => t.ValueKind == JsonValueKind.Number && t.TryGetInt32(out var n) && n is > 0 and < 10_000_000)
                .Select(t => t.GetInt32()).Distinct().Take(20).ToList();
            long? final = null;
            var cut = 0;
            string? priceText = null;
            if (JsonRead.Obj(item, "best_purchase_option") is { } bp)
            {
                final = JsonRead.Long(bp, "final_price_in_cents") is >= 0 and < 100_000_000 and var f ? f : null;
                cut = (int)Math.Clamp(JsonRead.Long(bp, "discount_pct") ?? 0, 0, 100);
                if (JsonRead.Bool(bp, "hide_discount_pct_for_compliance")) cut = 0;
                priceText = JsonRead.Str(bp, "formatted_final_price", 24);
            }
            parsed.Add((new SteamStoreFacts(id, name, type, visible, JsonRead.Bool(item, "is_free"), adult, date, year, comingSoon, tags, final, cut, priceText, []), item));
            if (parsed.Count >= MaxPerSection * 2) break;
        }

        // Hashed store art, through the same validation the artwork pipeline uses.
        var assets = ArtworkService.ParseAssetIndex(json, parsed.Select(p => p.Facts.AppId).ToList());
        var items = parsed.Select(p => assets.TryGetValue(p.Facts.AppId, out var a) ? p.Facts with { Images = ImagesFrom(a) } : p.Facts).ToList();
        return new SteamStoreQueryPage(items, total);
    }

    private static IReadOnlyList<DiscoverImage> ImagesFrom(Dictionary<string, string> assets)
    {
        var list = new List<DiscoverImage>();
        void Add(string kind, params string[] keys)
        {
            foreach (var k in keys)
                if (assets.TryGetValue(k, out var url) && DiscoverParsers.SafeImage(url) is { } safe) list.Add(new DiscoverImage(kind, safe));
        }
        Add("cover", "library_capsule_2x", "library_capsule");
        Add("hero", "library_hero_2x", "library_hero");
        Add("header", "header_2x", "header");
        return list;
    }

    // ---------- IGDB similar_games ----------

    /// <summary>IGDB's similar_games ID lists by game ID (each capped at 20, in IGDB's order).</summary>
    public static IReadOnlyDictionary<long, IReadOnlyList<long>> ParseIgdbSimilar(string json)
    {
        using var doc = JsonRead.Parse(json, "IGDB");
        var result = new Dictionary<long, IReadOnlyList<long>>();
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return result;
        foreach (var g in doc.RootElement.EnumerateArray().Take(20))
        {
            var id = JsonRead.Long(g, "id") ?? 0;
            if (id is not (> 0 and < 1_000_000_000_000)) continue;
            var similar = JsonRead.Arr(g, "similar_games")
                .Select(s => s.ValueKind == JsonValueKind.Number && s.TryGetInt64(out var n) ? n : s.ValueKind == JsonValueKind.Object ? JsonRead.Long(s, "id") ?? 0 : 0)
                .Where(n => n is > 0 and < 1_000_000_000_000 && n != id).Distinct().Take(20).ToList();
            result[id] = similar;
        }
        return result;
    }

    private static bool Currency(string c) => c.Length == 3 && c.All(char.IsAsciiLetterUpper);

    /// <summary>A plain name for a Steam tag Discover knows (null for the rest).</summary>
    public static string? TagName(int tagId) => DiscoverGenres.ByTag.TryGetValue(tagId, out var g) ? g.Label : null;
}

/// <summary>
/// Track C3: the genres and tags Discover can browse, with Steam's tag IDs and IGDB's fixed genre, theme or game-mode IDs.
/// Every Steam tag ID here was checked against Steam's store query on 2026-10-10 (each returned games of that kind).
/// </summary>
public static class DiscoverGenres
{
    public sealed record Genre(string Id, string Label, string Kind, int SteamTag, string IgdbField, int IgdbId);

    public static readonly IReadOnlyList<Genre> All =
    [
        new("action", "Action", "genre", 19, "themes", 1),
        new("adventure", "Adventure", "genre", 21, "genres", 31),
        new("rpg", "RPG", "genre", 122, "genres", 12),
        new("strategy", "Strategy", "genre", 9, "genres", 15),
        new("shooter", "Shooter", "genre", 1774, "genres", 5),
        new("racing", "Racing", "genre", 699, "genres", 10),
        new("sports", "Sports", "genre", 701, "genres", 14),
        new("simulation", "Simulation", "genre", 599, "genres", 13),
        new("puzzle", "Puzzle", "genre", 1664, "genres", 9),
        new("platformer", "Platformer", "genre", 1625, "genres", 8),
        new("fighting", "Fighting", "genre", 1743, "genres", 4),
        new("indie", "Indie", "genre", 492, "genres", 32),
        new("open-world", "Open world", "tag", 1695, "themes", 38),
        new("co-op", "Co-op", "tag", 1685, "game_modes", 3),
        new("horror", "Horror", "tag", 1667, "themes", 19),
        new("survival", "Survival", "tag", 1662, "themes", 21),
        new("sci-fi", "Sci-fi", "tag", 3942, "themes", 18),
        new("fantasy", "Fantasy", "tag", 1684, "themes", 17),
        new("sandbox", "Sandbox", "tag", 3810, "themes", 33),
    ];

    public static readonly IReadOnlyDictionary<string, Genre> ById = All.ToDictionary(g => g.Id, StringComparer.Ordinal);
    public static readonly IReadOnlyDictionary<int, Genre> ByTag = All.ToDictionary(g => g.SteamTag);

    /// <summary>
    /// Steam tags too broad to say what a game is like (Singleplayer, Multiplayer, Free to Play, Early Access, Indie,
    /// Great Soundtrack, Atmospheric, 2D, 3D, Casual, Action, Adventure): "Because you played" skips them when it can.
    /// </summary>
    public static readonly HashSet<int> BroadTags = [4182, 3859, 113, 493, 492, 1756, 4166, 3871, 4191, 597, 19, 21];
}
