using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;

namespace Vystral.Windows.DataSources;

/// <summary>
/// One free game (or in-game item) someone is giving away, from GamerPower or Epic's free-games feed.
/// <see cref="Id"/> is opaque (the page opens it with <c>freebies.open</c>; it never sends a URL).
/// </summary>
/// <param name="Store">steam | epic | gog | itch | xbox | ubisoft | ea | battlenet | other</param>
/// <param name="Kind">game | loot | beta</param>
/// <param name="Status">now (claimable today) | upcoming (Epic's next free game)</param>
/// <param name="Worth">The usual price as the source states it (e.g. "$19.99"), or null when it doesn't say.</param>
/// <param name="ImageUrl">A remote image (validated host); the page only ever sees it after the art pipeline cached it.</param>
public sealed record Freebie(string Id, string Source, string Title, string Store, IReadOnlyList<string> Platforms, string Kind, string Status,
    string? Worth, string? StartsAt, string? EndsAt, string? Description, string? ImageUrl, string Url);

/// <summary>
/// Track D4: GamerPower's public giveaways API (<c>www.gamerpower.com/api/giveaways</c>): free PC games and loot on
/// Steam, Epic, GOG, itch.io and more. Keyless; free for personal and commercial use with an active link back to
/// GamerPower.com (VYSTRAL credits it next to every list and opens GamerPower's own page for each giveaway); asks
/// for under 10 requests a second (VYSTRAL makes one every few hours at most). Off by default
/// (<c>dataSources.gamerpower</c>). Track D5's "Free this week" shelf reads it through <c>freebies.get</c>.
/// </summary>
public sealed partial class GamerPowerClient(ProviderTransport transport)
{
    public const string Endpoint = "https://www.gamerpower.com/api/giveaways";
    internal const int MaxItems = 60;
    /// <summary>Image hosts GamerPower uses for giveaway art.</summary>
    public static readonly string[] ImageHosts = ["www.gamerpower.com"];

    /// <summary>Active PC giveaways (games, loot and betas), newest first.</summary>
    public async Task<IReadOnlyList<Freebie>> GetPcGiveawaysAsync(CancellationToken ct)
    {
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri($"{Endpoint}?platform=pc&sort-by=date")), ct);
        // 201 is GamerPower's "no active giveaways right now".
        if (r.Status == HttpStatusCode.Created) return [];
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"GamerPower answered with an unexpected status ({(int)r.Status}).");
        return Parse(r.Body);
    }

    public async Task<string> TestAsync(CancellationToken ct)
    {
        var list = await GetPcGiveawaysAsync(ct);
        return list.Count > 0 ? $"GamerPower answered with {list.Count.ToString(CultureInfo.InvariantCulture)} giveaways." : "GamerPower answered (no PC giveaways right now).";
    }

    // ---------- Parsing (pure, unit-tested) ----------

    internal static IReadOnlyList<Freebie> Parse(string json)
    {
        using var doc = JsonRead.Parse(json, "GamerPower");
        if (doc.RootElement.ValueKind != System.Text.Json.JsonValueKind.Array) return [];
        var list = new List<Freebie>();
        var seen = new HashSet<long>();
        foreach (var g in doc.RootElement.EnumerateArray())
        {
            var id = JsonRead.Long(g, "id");
            var title = JsonRead.Str(g, "title", 160);
            if (id is not (> 0 and < 100_000_000) || title is null || !seen.Add(id.Value)) continue;
            if (JsonRead.Str(g, "status", 20) is { } status && !status.Equals("Active", StringComparison.OrdinalIgnoreCase)) continue;
            // The page we open is GamerPower's own page about the giveaway (their attribution link), never the redirect.
            var url = JsonRead.SafeUrl(JsonRead.Str(g, "gamerpower_url", 400), "gamerpower.com");
            if (url is null || !new Uri(url).Host.Equals("www.gamerpower.com", StringComparison.OrdinalIgnoreCase)) continue;
            var platforms = (JsonRead.Str(g, "platforms", 200) ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .Select(p => p.Length > 30 ? p[..30] : p).Distinct(StringComparer.OrdinalIgnoreCase).Take(8).ToList();
            var kind = (JsonRead.Str(g, "type", 20) ?? "").ToLowerInvariant() switch { "game" => "game", "beta" => "beta", "early access" => "beta", _ => "loot" };
            var worth = JsonRead.Str(g, "worth", 16) is { } w && Worth().IsMatch(w) ? w : null;
            list.Add(new Freebie($"gp-{id.Value.ToString(CultureInfo.InvariantCulture)}", "gamerpower", CleanTitle(title), StoreOf(platforms), platforms, kind, "now",
                worth, Date(JsonRead.Str(g, "published_date", 30)), Date(JsonRead.Str(g, "end_date", 30)), JsonRead.Str(g, "description", 400),
                JsonRead.SafeUrl(JsonRead.Str(g, "image", 400), ImageHosts) ?? JsonRead.SafeUrl(JsonRead.Str(g, "thumbnail", 400), ImageHosts), url));
            if (list.Count >= MaxItems) break;
        }
        return list;
    }

    /// <summary>"Pony Island (Steam) Giveaway" → "Pony Island".</summary>
    internal static string CleanTitle(string title)
    {
        var t = TitleSuffix().Replace(title, "").Trim();
        return t.Length == 0 ? title : t;
    }

    internal static string StoreOf(IReadOnlyList<string> platforms)
    {
        foreach (var p in platforms)
        {
            var s = p.ToLowerInvariant();
            if (s.Contains("steam")) return "steam";
            if (s.Contains("epic")) return "epic";
            if (s.Contains("gog")) return "gog";
            if (s.Contains("itch")) return "itch";
            if (s.Contains("ubisoft")) return "ubisoft";
            if (s.Contains("origin") || s.Contains("ea app")) return "ea";
            if (s.Contains("battle.net") || s.Contains("battlenet")) return "battlenet";
            if (s.Contains("xbox")) return "xbox";
        }
        return "other";
    }

    /// <summary>GamerPower dates are "yyyy-MM-dd HH:mm:ss" without a zone (or "N/A"); kept as an ISO date-time when valid.</summary>
    internal static string? Date(string? s) =>
        s is not null && DateTime.TryParseExact(s, "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) && d.Year is > 2000 and < 2200
            ? d.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture) : null;

    [GeneratedRegex(@"\s*(\((Steam|Epic Games( Store)?|GOG|itch\.io|IndieGala|Ubisoft|Origin|Xbox|PC)\))?\s*(Giveaway|Key Giveaway)\s*\z", RegexOptions.IgnoreCase)]
    private static partial Regex TitleSuffix();

    [GeneratedRegex(@"\A[$€£]?[0-9]{1,5}([.,][0-9]{2})?\z")]
    private static partial Regex Worth();
}

/// <summary>
/// Track D4: Epic Games Store's public free-games feed (<c>store-site-backend-static.ak.epicgames.com/freeGamesPromotions</c>),
/// the JSON Epic's own store page uses for "Free now" and "Coming soon". Keyless but undocumented ("grey"): off by
/// default (<c>dataSources.epicFreeGames</c>), fetched at most every few hours, cached, and a failure only hides it.
/// </summary>
public sealed partial class EpicFreeGamesClient(ProviderTransport transport)
{
    public const string Endpoint = "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions";
    public static readonly string[] ImageHosts = ["cdn1.epicgames.com"];

    public async Task<IReadOnlyList<Freebie>> GetAsync(string country, CancellationToken ct)
    {
        var c = country is { Length: 2 } && country.All(char.IsAsciiLetterUpper) ? country : "US";
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri($"{Endpoint}?locale=en-US&country={c}&allowCountries={c}")), ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Epic answered with an unexpected status ({(int)r.Status}).");
        return Parse(r.Body, DateTimeOffset.UtcNow);
    }

    // ---------- Parsing (pure, unit-tested) ----------

    /// <summary>
    /// Games whose current promotion is 100 % off ("now") or whose next one is ("upcoming"). Discounts that aren't
    /// free, add-ons without a store page and anything without a validated slug are left out.
    /// </summary>
    internal static IReadOnlyList<Freebie> Parse(string json, DateTimeOffset now)
    {
        using var doc = JsonRead.Parse(json, "Epic");
        var elements = JsonRead.Obj(doc.RootElement, "data") is { } d && JsonRead.Obj(d, "Catalog") is { } cat && JsonRead.Obj(cat, "searchStore") is { } ss
            ? JsonRead.Arr(ss, "elements").Take(80).ToList() : [];
        var list = new List<Freebie>();
        foreach (var e in elements)
        {
            var title = JsonRead.Str(e, "title", 160);
            var id = JsonRead.Str(e, "id", 64);
            if (title is null || id is null || !OfferId().IsMatch(id)) continue;
            var slug = Slug(e);
            if (slug is null) continue;
            if (JsonRead.Obj(e, "promotions") is not { } promos) continue;
            var current = FreeWindow(promos, "promotionalOffers", now, requireActive: true);
            var upcoming = current is null ? FreeWindow(promos, "upcomingPromotionalOffers", now, requireActive: false) : null;
            var window = current ?? upcoming;
            if (window is null) continue;
            var kind = JsonRead.Str(e, "offerType", 20) is "ADD_ON" or "DLC" ? "loot" : "game";
            var worth = JsonRead.Obj(e, "price") is { } price && JsonRead.Obj(price, "totalPrice") is { } tp && JsonRead.Obj(tp, "fmtPrice") is { } fmt
                ? JsonRead.Str(fmt, "originalPrice", 16) : null;
            if (worth is "0" or "Free") worth = null;
            list.Add(new Freebie($"epic-{id[..Math.Min(id.Length, 32)].ToLowerInvariant()}", "epic", title, "epic", ["PC", "Epic Games Store"], kind,
                current is not null ? "now" : "upcoming", worth, window.Value.Start, window.Value.End, JsonRead.Str(e, "description", 400),
                Image(e), $"https://store.epicgames.com/en-US/p/{slug}"));
        }
        return list;
    }

    private static (string Start, string End)? FreeWindow(System.Text.Json.JsonElement promos, string field, DateTimeOffset now, bool requireActive)
    {
        foreach (var group in JsonRead.Arr(promos, field))
            foreach (var offer in JsonRead.Arr(group, "promotionalOffers"))
            {
                if (JsonRead.Obj(offer, "discountSetting") is not { } ds || JsonRead.Long(ds, "discountPercentage") != 0) continue;
                if (!DateTimeOffset.TryParse(JsonRead.Str(offer, "startDate", 40), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var start) ||
                    !DateTimeOffset.TryParse(JsonRead.Str(offer, "endDate", 40), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var end) ||
                    end <= start) continue;
                if (requireActive && (now < start || now >= end)) continue;
                if (!requireActive && end <= now) continue;
                return (start.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture),
                    end.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture));
            }
        return null;
    }

    /// <summary>The store page slug: a mapping's pageSlug, else productSlug (without "/home").</summary>
    private static string? Slug(System.Text.Json.JsonElement e)
    {
        foreach (var source in new[] { "catalogNs", "offerMappings" })
        {
            IEnumerable<System.Text.Json.JsonElement> mappings = source == "catalogNs"
                ? JsonRead.Obj(e, "catalogNs") is { } ns ? JsonRead.Arr(ns, "mappings") : []
                : JsonRead.Arr(e, "offerMappings");
            foreach (var m in mappings)
                if (JsonRead.Str(m, "pageSlug", 120) is { } s && SlugPattern().IsMatch(s)) return s;
        }
        var product = JsonRead.Str(e, "productSlug", 120)?.Replace("/home", "", StringComparison.Ordinal);
        return product is not null && SlugPattern().IsMatch(product) ? product : null;
    }

    private static string? Image(System.Text.Json.JsonElement e)
    {
        var images = JsonRead.Arr(e, "keyImages").Select(k => (Type: JsonRead.Str(k, "type", 40), Url: JsonRead.Str(k, "url", 400))).ToList();
        foreach (var type in new[] { "OfferImageWide", "DieselStoreFrontWide", "Thumbnail", "OfferImageTall" })
            if (images.FirstOrDefault(i => i.Type == type).Url is { } u && JsonRead.SafeUrl(u, ImageHosts) is { } safe) return safe;
        return null;
    }

    [GeneratedRegex(@"\A[0-9a-f]{16,64}\z")]
    private static partial Regex OfferId();

    [GeneratedRegex(@"\A[a-z0-9][a-z0-9\-]{0,119}\z")]
    private static partial Regex SlugPattern();
}
