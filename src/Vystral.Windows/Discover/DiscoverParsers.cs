using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;

namespace Vystral.Windows.Discover;

/// <summary>Steam's store page details for one app, as far as the Discover page needs them.</summary>
public sealed record SteamAppDetails(
    string AppId, string Name, string Type, string? Description, string? ReleaseDate, int? Year, bool ComingSoon, bool Free,
    IReadOnlyList<string> Developers, IReadOnlyList<string> Publishers, IReadOnlyList<string> Genres, IReadOnlyList<string> Platforms,
    int? Metacritic, DiscoverPriceDto? Price, string? HeaderImage, string? Background);

/// <summary>IGDB's entry for one game (Discover fields).</summary>
public sealed record IgdbDiscoverGame(
    long Id, string Name, string? Slug, string? Summary, string? ReleaseDate, int? Year, IReadOnlyList<string> Genres, IReadOnlyList<string> Platforms,
    IReadOnlyList<string> Developers, IReadOnlyList<string> Publishers, DiscoverIds Ids, IReadOnlyList<string> Stores, IReadOnlyList<DiscoverImage> Images,
    double? Rating, int RatingCount);

/// <summary>RAWG's entry for one game (Discover fields).</summary>
public sealed record RawgDiscoverGame(
    string Slug, string Name, string? Description, string? ReleaseDate, int? Year, IReadOnlyList<string> Genres, IReadOnlyList<string> Platforms,
    IReadOnlyList<string> Developers, IReadOnlyList<string> Publishers, IReadOnlyList<DiscoverImage> Images, double? Rating, int RatingCount);

/// <summary>Wikidata's item for one game: labels for its facts and its store identifiers.</summary>
public sealed record WikidataDiscoverItem(
    string Qid, string? Label, string? Description, string? ReleaseDate, int? Year, IReadOnlyList<string> Genres, IReadOnlyList<string> Developers,
    IReadOnlyList<string> Publishers, IReadOnlyList<string> Platforms, DiscoverIds Ids);

/// <summary>
/// Pure, defensive readers for every Discover answer. Provider JSON is untrusted: wrong types are treated as missing,
/// text is cleaned and clipped, IDs must match strict shapes, image URLs must be HTTPS on the provider's own CDN,
/// and every list is capped.
/// </summary>
public static partial class DiscoverParsers
{
    public const int MaxHitsPerSource = 40;
    private const string SteamCdn = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/";

    /// <summary>Hosts Discover may download images from (checked again at download time).</summary>
    public static readonly string[] ImageHosts =
    [
        "shared.akamai.steamstatic.com", "shared.fastly.steamstatic.com", "shared.cloudflare.steamstatic.com",
        "cdn.akamai.steamstatic.com", "cdn.fastly.steamstatic.com", "cdn.cloudflare.steamstatic.com",
        "store.akamai.steamstatic.com", "store.fastly.steamstatic.com", "steamcdn-a.akamaihd.net",
        "images.igdb.com", "media.rawg.io",
    ];

    public static string? SafeImage(string? url) => JsonRead.SafeUrl(url, ImageHosts);

    /// <summary>The classic, flat Steam CDN art for an app (newer apps may only have hashed names; see the asset index).</summary>
    public static IReadOnlyList<DiscoverImage> SteamFlatImages(string appId) =>
    [
        new("cover", $"{SteamCdn}{appId}/library_600x900_2x.jpg"),
        new("cover", $"{SteamCdn}{appId}/library_600x900.jpg"),
        new("hero", $"{SteamCdn}{appId}/library_hero.jpg"),
        new("logo", $"{SteamCdn}{appId}/logo.png"),
        new("header", $"{SteamCdn}{appId}/header.jpg"),
    ];

    // ---------- Steam store search ----------

    public static IReadOnlyList<DiscoverHit> ParseSteamSearch(string json)
    {
        using var doc = JsonRead.Parse(json, "Steam");
        var hits = new List<DiscoverHit>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in JsonRead.Arr(doc.RootElement, "items"))
        {
            if (JsonRead.Str(item, "type", 20) != "app") continue;
            var id = JsonRead.Str(item, "id", 12);
            var name = JsonRead.Str(item, "name", 200);
            if (id is null || !DiscoverKeys.SteamAppId().IsMatch(id) || name is null || !seen.Add(id)) continue;
            StorePrice? price = null;
            if (JsonRead.Obj(item, "price") is { } p && JsonRead.Str(p, "currency", 3) is { } cur && Currency().IsMatch(cur) &&
                JsonRead.Long(p, "final") is >= 0 and < 100_000_000 and var final)
            {
                var initial = JsonRead.Long(p, "initial") is >= 0 and < 100_000_000 and var i ? i : final;
                price = new StorePrice(final, Math.Max(initial, final), cur);
            }
            var platforms = new List<string>();
            if (JsonRead.Obj(item, "platforms") is { } pl)
            {
                if (JsonRead.Bool(pl, "windows")) platforms.Add("PC");
                if (JsonRead.Bool(pl, "mac")) platforms.Add("Mac");
                if (JsonRead.Bool(pl, "linux")) platforms.Add("Linux");
            }
            hits.Add(new DiscoverHit(DiscoverSources.Steam, id, name, null, null, hits.Count, new DiscoverIds(Steam: id), ["steam"], platforms, [],
                SteamFlatImages(id), price, 0, ExtraTitle().IsMatch(name) ? "extra" : "game"));
            if (hits.Count >= MaxHitsPerSource) break;
        }
        return hits;
    }

    // ---------- IGDB ----------

    /// <summary>IGDB external_game_source ids → VYSTRAL store keys.</summary>
    private static string? IgdbStore(long? source) => source switch
    {
        1 => "steam",
        5 => "gog",
        26 => "epic",
        11 or 31 or 54 => "xbox",
        _ => null,
    };

    /// <summary>IGDB game types that are a playable game in their own right (main game, standalone expansion, remake, remaster, expanded game, port).</summary>
    private static readonly HashSet<long> IgdbGameTypes = [0, 4, 8, 9, 10, 11];

    public static IReadOnlyList<DiscoverHit> ParseIgdbSearch(string json, int rankOffset = 0)
    {
        using var doc = JsonRead.Parse(json, "IGDB");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return [];
        var hits = new List<DiscoverHit>();
        foreach (var g in doc.RootElement.EnumerateArray())
        {
            var game = ReadIgdb(g);
            if (game is null) continue;
            var type = JsonRead.Long(g, "game_type") ?? (JsonRead.Obj(g, "game_type") is { } gt ? JsonRead.Long(gt, "id") : null);
            var kind = type is { } t && !IgdbGameTypes.Contains(t) ? "extra" : "game";
            hits.Add(new DiscoverHit(DiscoverSources.Igdb, game.Id.ToString(CultureInfo.InvariantCulture), game.Name, game.Year, game.ReleaseDate,
                rankOffset + hits.Count, game.Ids, game.Stores, game.Platforms, game.Genres, game.Images, null, game.RatingCount, kind));
            if (hits.Count >= MaxHitsPerSource) break;
        }
        return hits;
    }

    public static IgdbDiscoverGame? ParseIgdbGame(string json)
    {
        using var doc = JsonRead.Parse(json, "IGDB");
        return doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.EnumerateArray().Select(ReadIgdb).FirstOrDefault(g => g is not null) : null;
    }

    private static IgdbDiscoverGame? ReadIgdb(JsonElement g)
    {
        var id = JsonRead.Long(g, "id");
        var name = JsonRead.Str(g, "name", 200);
        if (id is not (> 0 and < 1_000_000_000_000) || name is null) return null;
        var slug = JsonRead.Str(g, "slug", 120) is { } s && DiscoverKeys.Slug().IsMatch(s) ? s : null;
        var released = JsonRead.Long(g, "first_release_date");
        string? date = released is > 0 and < 4102444800 ? DateTimeOffset.FromUnixTimeSeconds(released.Value).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null;
        int? year = released is > 0 and < 4102444800 ? DateTimeOffset.FromUnixTimeSeconds(released.Value).Year : null;

        string? steam = null, gogId = null, epic = null, ms = null;
        var stores = new List<string>();
        foreach (var e in JsonRead.Arr(g, "external_games").Take(60))
        {
            var source = JsonRead.Long(e, "external_game_source") ?? (JsonRead.Obj(e, "external_game_source") is { } src ? JsonRead.Long(src, "id") : null) ?? JsonRead.Long(e, "category");
            var uid = JsonRead.Str(e, "uid", 120);
            if (IgdbStore(source) is not { } store || uid is null) continue;
            switch (source)
            {
                case 1 when DiscoverKeys.SteamAppId().IsMatch(uid): steam ??= uid; break;
                case 5 when uid.Length <= 12 && uid.All(char.IsAsciiDigit): gogId ??= uid; break;
                case 11 when DiscoverKeys.MsBigId().IsMatch(uid): ms ??= uid.ToLowerInvariant(); break;
                case 26 when DiscoverKeys.Slug().IsMatch(uid): epic ??= uid; break;
                default: continue;
            }
            if (!stores.Contains(store)) stores.Add(store);
        }

        var images = new List<DiscoverImage>();
        if (JsonRead.Obj(g, "cover") is { } cover && ImageId(JsonRead.Str(cover, "image_id", 60)) is { } coverId)
            images.Add(new DiscoverImage("cover", $"https://images.igdb.com/igdb/image/upload/t_cover_big_2x/{coverId}.jpg"));
        foreach (var a in JsonRead.Arr(g, "artworks").Take(3))
            if (ImageId(JsonRead.Str(a, "image_id", 60)) is { } art) images.Add(new DiscoverImage("hero", $"https://images.igdb.com/igdb/image/upload/t_1080p/{art}.jpg"));
        foreach (var a in JsonRead.Arr(g, "screenshots").Take(2))
            if (ImageId(JsonRead.Str(a, "image_id", 60)) is { } shot) images.Add(new DiscoverImage("hero", $"https://images.igdb.com/igdb/image/upload/t_1080p/{shot}.jpg"));

        var developers = new List<string>();
        var publishers = new List<string>();
        foreach (var ic in JsonRead.Arr(g, "involved_companies").Take(20))
        {
            var company = JsonRead.Obj(ic, "company") is { } c ? JsonRead.Str(c, "name", 120) : null;
            if (company is null) continue;
            if (JsonRead.Bool(ic, "developer") && !developers.Contains(company) && developers.Count < 4) developers.Add(company);
            if (JsonRead.Bool(ic, "publisher") && !publishers.Contains(company) && publishers.Count < 4) publishers.Add(company);
        }
        var platforms = JsonRead.Arr(g, "platforms").Select(p => PlatformName(JsonRead.Str(p, "name", 80), JsonRead.Str(p, "abbreviation", 20)))
            .OfType<string>().Distinct().Take(8).ToList();
        var rating = JsonRead.Num(g, "total_rating");
        return new IgdbDiscoverGame(id.Value, name, slug, JsonRead.Str(g, "summary", 2000), date, year, JsonRead.Names(g, "genres", 6), platforms,
            developers, publishers, new DiscoverIds(Steam: steam, Igdb: id, IgdbSlug: slug, GogId: gogId, Epic: epic, Microsoft: ms), stores, images,
            rating is >= 0 and <= 100 ? Math.Round(rating.Value, 1) : null, (int)Math.Clamp(JsonRead.Long(g, "total_rating_count") ?? 0, 0, 10_000_000));
    }

    private static string? ImageId(string? id) => id is not null && IgdbImageId().IsMatch(id) ? id : null;

    // ---------- RAWG ----------

    private static string? RawgStore(string? slug) => slug switch
    {
        "steam" => "steam",
        "gog" => "gog",
        "epic-games" => "epic",
        "xbox-store" or "xbox360" or "xbox-one" => "xbox",
        _ => null,
    };

    public static IReadOnlyList<DiscoverHit> ParseRawgSearch(string json, int rankOffset = 0)
    {
        using var doc = JsonRead.Parse(json, "RAWG");
        var hits = new List<DiscoverHit>();
        foreach (var g in JsonRead.Arr(doc.RootElement, "results"))
        {
            var slug = JsonRead.Str(g, "slug", 120);
            var name = JsonRead.Str(g, "name", 200);
            if (slug is null || !DiscoverKeys.Slug().IsMatch(slug) || name is null) continue;
            var (date, year) = IsoDate(JsonRead.Str(g, "released", 20));
            var stores = JsonRead.Arr(g, "stores").Select(s => JsonRead.Obj(s, "store") is { } st ? RawgStore(JsonRead.Str(st, "slug", 40)) : null)
                .OfType<string>().Distinct().ToList();
            var platforms = JsonRead.Arr(g, "platforms").Select(p => JsonRead.Obj(p, "platform") is { } pl ? PlatformName(JsonRead.Str(pl, "name", 80), null) : null)
                .OfType<string>().Distinct().Take(8).ToList();
            var images = new List<DiscoverImage>();
            if (SafeImage(JsonRead.Str(g, "background_image", 400)) is { } bg) images.Add(new DiscoverImage("background", bg));
            hits.Add(new DiscoverHit(DiscoverSources.Rawg, slug, name, year, date, rankOffset + hits.Count, new DiscoverIds(Rawg: slug), stores, platforms,
                JsonRead.Names(g, "genres", 6), images, null, (int)Math.Clamp(JsonRead.Long(g, "added") ?? 0, 0, 10_000_000)));
            if (hits.Count >= MaxHitsPerSource) break;
        }
        return hits;
    }

    public static RawgDiscoverGame? ParseRawgGame(string json)
    {
        var core = RawgClient.ParseGame(json);
        if (core is null) return null;
        using var doc = JsonRead.Parse(json, "RAWG");
        var g = doc.RootElement;
        var images = new List<DiscoverImage>();
        foreach (var field in new[] { "background_image", "background_image_additional" })
            if (SafeImage(JsonRead.Str(g, field, 400)) is { } u) images.Add(new DiscoverImage("background", u));
        var platforms = JsonRead.Arr(g, "platforms").Select(p => JsonRead.Obj(p, "platform") is { } pl ? PlatformName(JsonRead.Str(pl, "name", 80), null) : null)
            .OfType<string>().Distinct().Take(8).ToList();
        return new RawgDiscoverGame(core.Slug, core.Name, core.Description, core.Released, core.ReleaseYear, core.Genres, platforms, core.Developers,
            core.Publishers, images, core.Rating, core.RatingsCount);
    }

    // ---------- Wikidata ----------

    public static IReadOnlyList<DiscoverHit> ParseWikidataSearch(string json)
    {
        using var doc = JsonRead.Parse(json, "Wikidata");
        var bindings = JsonRead.Obj(doc.RootElement, "results") is { } results ? JsonRead.Arr(results, "bindings").ToList() : null;
        if (bindings is null) throw new DataSourceException(DataSourceOutcome.Malformed, "Wikidata’s answer couldn’t be read.");
        var hits = new List<DiscoverHit>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var b in bindings)
        {
            var qid = Value(b, "item") is { } uri && ItemUri().Match(uri) is { Success: true } m ? m.Groups[1].Value : null;
            var label = Value(b, "lbl") is { } l ? MetadataService.Clean(l, 200) : null;
            // Items without an English (or multilingual) label would show as a bare Q-number: not useful in a list.
            if (qid is null || string.IsNullOrEmpty(label) || !seen.Add(qid)) continue;
            var (date, year) = IsoDate(Value(b, "released"));
            var ids = WikidataIds(b, qid);
            hits.Add(new DiscoverHit(DiscoverSources.Wikidata, qid, label, year, date, hits.Count, ids, StoresOf(ids), [], [], []));
            if (hits.Count >= MaxHitsPerSource) break;
        }
        return hits;
    }

    public static WikidataDiscoverItem? ParseWikidataItem(string json, string qid)
    {
        using var doc = JsonRead.Parse(json, "Wikidata");
        var bindings = JsonRead.Obj(doc.RootElement, "results") is { } results ? JsonRead.Arr(results, "bindings").ToList() : null;
        if (bindings is null) throw new DataSourceException(DataSourceOutcome.Malformed, "Wikidata’s answer couldn’t be read.");
        var b = bindings.FirstOrDefault();
        if (b.ValueKind != JsonValueKind.Object) return null;
        var (date, year) = IsoDate(Value(b, "released"));
        static IReadOnlyList<string> Labels(string? joined) => joined is null ? [] :
            joined.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(x => MetadataService.Clean(x, 80))
                .Where(x => x.Length > 0 && !Qid().IsMatch(x)).Distinct(StringComparer.OrdinalIgnoreCase).Take(6).ToList();
        var label = Value(b, "lbl") is { } l ? MetadataService.Clean(l, 200) : null;
        var desc = Value(b, "desc") is { } d ? MetadataService.Clean(d, 300) : null;
        return new WikidataDiscoverItem(qid, string.IsNullOrEmpty(label) ? null : label, string.IsNullOrEmpty(desc) ? null : desc, date, year,
            Labels(Value(b, "genres")), Labels(Value(b, "developers")), Labels(Value(b, "publishers")), Labels(Value(b, "platforms")), WikidataIds(b, qid));
    }

    private static DiscoverIds WikidataIds(JsonElement b, string qid)
    {
        string? V(string name, Regex pattern) => Value(b, "v_" + name) is { Length: <= 120 } v && pattern.IsMatch(v) ? v : null;
        var gogId = Value(b, "v_gogId") is { Length: > 0 and <= 12 } g && g.All(char.IsAsciiDigit) ? g : null;
        return new DiscoverIds(
            Steam: V("steam", DiscoverKeys.SteamAppId()), IgdbSlug: V("igdb", DiscoverKeys.Slug()), Rawg: V("rawg", DiscoverKeys.Slug()), Wikidata: qid,
            GogId: gogId, GogPath: V("gog", DiscoverKeys.GogPath()), Epic: V("epic", DiscoverKeys.Slug()),
            Microsoft: V("microsoft", DiscoverKeys.MsBigId())?.ToLowerInvariant());
    }

    /// <summary>Stores implied by store identifiers.</summary>
    public static IReadOnlyList<string> StoresOf(DiscoverIds ids)
    {
        var list = new List<string>();
        if (ids.Steam is not null) list.Add("steam");
        if (ids.GogId is not null || ids.GogPath is not null) list.Add("gog");
        if (ids.Epic is not null) list.Add("epic");
        if (ids.Microsoft is not null) list.Add("xbox");
        return list;
    }

    private static string? Value(JsonElement binding, string name) =>
        JsonRead.Obj(binding, name) is { } o && o.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    // ---------- Steam app details ----------

    public static SteamAppDetails? ParseSteamDetails(string appId, string json)
    {
        using var doc = JsonRead.Parse(json, "Steam");
        if (JsonRead.Obj(doc.RootElement, appId) is not { } entry || !JsonRead.Bool(entry, "success") ||
            JsonRead.Obj(entry, "data") is not { } data) return null;
        var name = JsonRead.Str(data, "name", 200);
        if (name is null) return null;
        // The answer must be about the app that was asked for (Steam redirects some apps to another).
        if (JsonRead.Long(data, "steam_appid") is { } sid && sid.ToString(CultureInfo.InvariantCulture) != appId) return null;

        IReadOnlyList<string> Strings(string field) =>
            JsonRead.Arr(data, field).Where(x => x.ValueKind == JsonValueKind.String).Select(x => MetadataService.Clean(x.GetString()!, 120))
                .Where(s => s.Length > 0).Distinct().Take(4).ToList();

        var comingSoon = false;
        string? dateText = null;
        if (JsonRead.Obj(data, "release_date") is { } rd)
        {
            comingSoon = JsonRead.Bool(rd, "coming_soon");
            dateText = JsonRead.Str(rd, "date", 40);
        }
        var (isoDate, year) = SteamDate(dateText);
        var platforms = new List<string>();
        if (JsonRead.Obj(data, "platforms") is { } pl)
        {
            if (JsonRead.Bool(pl, "windows")) platforms.Add("PC");
            if (JsonRead.Bool(pl, "mac")) platforms.Add("Mac");
            if (JsonRead.Bool(pl, "linux")) platforms.Add("Linux");
        }
        var free = JsonRead.Bool(data, "is_free");
        DiscoverPriceDto? price = null;
        if (JsonRead.Obj(data, "price_overview") is { } p && JsonRead.Str(p, "currency", 3) is { } cur && Currency().IsMatch(cur))
            price = new DiscoverPriceDto(JsonRead.Str(p, "final_formatted", 24), JsonRead.Str(p, "initial_formatted", 24),
                (int)Math.Clamp(JsonRead.Long(p, "discount_percent") ?? 0, 0, 100), cur, false, comingSoon, "");
        else if (free) price = new DiscoverPriceDto(null, null, 0, null, true, comingSoon, "");
        else if (comingSoon) price = new DiscoverPriceDto(null, null, 0, null, false, true, "");
        var meta = JsonRead.Obj(data, "metacritic") is { } mc && JsonRead.Long(mc, "score") is >= 1 and <= 100 and var score ? (int)score : (int?)null;
        return new SteamAppDetails(appId, name, JsonRead.Str(data, "type", 20) ?? "game", JsonRead.Str(data, "short_description", 1200),
            isoDate, year, comingSoon, free, Strings("developers"), Strings("publishers"),
            JsonRead.Arr(data, "genres").Select(x => JsonRead.Str(x, "description", 40)).OfType<string>().Distinct().Take(6).ToList(),
            platforms, meta, price, SafeImage(JsonRead.Str(data, "header_image", 400)), SafeImage(JsonRead.Str(data, "background_raw", 400)));
    }

    /// <summary>Steam's release date text ("Apr 18, 2011", "18 Apr, 2011", "Q1 2027", "Coming soon") as an ISO date and a year when it says one.</summary>
    internal static (string? Date, int? Year) SteamDate(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return (null, null);
        string[] formats = ["MMM d, yyyy", "d MMM, yyyy", "MMM d yyyy", "d MMM yyyy", "MMMM d, yyyy", "d MMMM, yyyy"];
        if (DateTime.TryParseExact(text.Trim(), formats, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) && d.Year is > 1950 and < 2200)
            return (d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), d.Year);
        var y = YearInText().Match(text);
        return y.Success && int.TryParse(y.Value, NumberStyles.None, CultureInfo.InvariantCulture, out var year) && year is > 1950 and < 2200 ? (null, year) : (null, null);
    }

    /// <summary>"2011-04-18" or "2011-04-18T00:00:00Z" (Wikidata) → ("2011-04-18", 2011).</summary>
    internal static (string? Date, int? Year) IsoDate(string? text)
    {
        if (text is null || text.Length < 4) return (null, null);
        var t = text.TrimStart('+');
        if (t.Length >= 10 && DateOnly.TryParseExact(t[..10], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) && d.Year is > 1950 and < 2200)
            return (d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), d.Year);
        return int.TryParse(t[..4], NumberStyles.None, CultureInfo.InvariantCulture, out var y) && y is > 1950 and < 2200 ? (null, y) : (null, null);
    }

    /// <summary>A short, familiar platform name ("PC (Microsoft Windows)" → "PC").</summary>
    internal static string? PlatformName(string? name, string? abbreviation)
    {
        if (name is null && abbreviation is null) return null;
        var n = name ?? abbreviation!;
        return n switch
        {
            "PC (Microsoft Windows)" or "PC" or "Windows" => "PC",
            "Mac" or "macOS" or "Apple Macintosh" => "Mac",
            "Linux" => "Linux",
            "Xbox Series X|S" or "Xbox Series S/X" => "Xbox Series X|S",
            "PlayStation 5" or "PlayStation 4" or "Xbox One" or "Nintendo Switch" or "Nintendo Switch 2" or "Android" or "iOS" => n,
            _ => n.Length <= 40 ? n : null,
        };
    }

    /// <summary>Soundtracks, season passes, demos and the like, by their title.</summary>
    internal static bool IsExtraTitle(string name) => ExtraTitle().IsMatch(name);

    [GeneratedRegex(@"\b(soundtrack|ost|season pass|artbook|art book|dlc|demo|expansion pass|playtest|dedicated server|sdk)\b", RegexOptions.IgnoreCase)]
    private static partial Regex ExtraTitle();

    [GeneratedRegex(@"\A[A-Z]{3}\z")]
    private static partial Regex Currency();

    [GeneratedRegex(@"\A[a-z0-9]{4,40}\z")]
    private static partial Regex IgdbImageId();

    [GeneratedRegex(@"\Ahttp://www\.wikidata\.org/entity/(Q[0-9]{1,12})\z")]
    private static partial Regex ItemUri();

    [GeneratedRegex(@"\AQ[0-9]{1,12}\z")]
    private static partial Regex Qid();

    [GeneratedRegex(@"\b(19|20|21)[0-9]{2}\b")]
    private static partial Regex YearInText();
}
