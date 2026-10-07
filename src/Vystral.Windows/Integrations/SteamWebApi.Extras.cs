using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vystral.Windows.Integrations;

/// <summary>One wishlist entry from IWishlistService/GetWishlist/v1 (appid, priority, date_added).</summary>
public sealed record WishlistEntry(string AppId, int Priority, DateTimeOffset? Added);

/// <summary>
/// Store facts for one app from IStoreBrowseService/GetItems/v1. Prices here are display-only (Steam
/// doesn't say which currency); VYSTRAL's comparable prices come from the store's price_overview.
/// </summary>
public sealed record StoreItemInfo(
    string AppId,
    string Name,
    DateTimeOffset? ReleaseDate,
    bool ComingSoon,
    string? ReleaseText,
    bool IsFree,
    long? FinalCents,
    long? OriginalCents,
    int DiscountPercent,
    string? FormattedPrice,
    string? HeaderUrl);

/// <summary>One game a friend played recently (IPlayerService/GetRecentlyPlayedGames/v1).</summary>
public sealed record RecentGame(string AppId, int MinutesTwoWeeks, int MinutesForever);

/// <summary>One post from ISteamNews/GetNewsForApp/v2. <see cref="Contents"/> is raw BBCode/HTML: never shown before <see cref="Services.SteamNewsText"/>.</summary>
public sealed record SteamNewsItem(string Gid, string Title, string? Author, DateTimeOffset Date, string Contents, IReadOnlyList<string> Tags, string? FeedLabel);

/// <summary>Track W: wishlist, store facts, friends' recently played games and news.</summary>
public sealed partial class SteamWebApiClient
{
    /// <summary>Steam's own wishlist limit is far below this; anything larger is clipped.</summary>
    public const int MaxWishlist = 3000;
    /// <summary>IStoreBrowseService/GetItems: ids per request (Steam's store pages ask for about this many).</summary>
    public const int StoreItemsBatch = 50;
    public const int MaxNews = 20;

    /// <summary>The user's own wishlist (the documented service; private wishlists answer with no items).</summary>
    public async Task<IReadOnlyList<WishlistEntry>> GetWishlistAsync(string steamId, CancellationToken ct)
    {
        var key = RequireKey();
        var (status, body) = await GetAsync($"IWishlistService/GetWishlist/v1/?key={key}&steamid={RequireSteamId(steamId)}&format=json", ct);
        if (status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new SteamApiException(SteamApiOutcome.InvalidKey, "Steam didn’t accept your Web API key. Check it in Settings → Library & stores.");
        EnsureOk(status);
        return ParseWishlist(body);
    }

    /// <summary>Names, release dates, prices and header art for up to <see cref="StoreItemsBatch"/> apps per request.</summary>
    public async Task<IReadOnlyList<StoreItemInfo>> GetStoreItemsAsync(IReadOnlyList<string> appIds, string country, string language, CancellationToken ct)
    {
        var result = new List<StoreItemInfo>();
        var cc = country is { Length: 2 } && country.All(char.IsAsciiLetterUpper) ? country : "US";
        var lang = language is "english" ? language : "english";
        foreach (var batch in appIds.Where(IsAppId).Distinct(StringComparer.Ordinal).Chunk(StoreItemsBatch))
        {
            var input = JsonSerializer.Serialize(new
            {
                ids = batch.Select(a => new { appid = uint.Parse(a, CultureInfo.InvariantCulture) }),
                context = new { language = lang, country_code = cc },
                data_request = new { include_basic_info = true, include_release = true, include_assets = true },
            });
            var (status, body) = await GetAsync($"IStoreBrowseService/GetItems/v1/?input_json={Uri.EscapeDataString(input)}", ct);
            EnsureOk(status);
            result.AddRange(ParseStoreItems(body, batch));
        }
        return result;
    }

    /// <summary>A friend's recently played games, or null when their game details aren't public.</summary>
    public async Task<IReadOnlyList<RecentGame>?> GetRecentlyPlayedAsync(string steamId, CancellationToken ct)
    {
        var key = RequireKey();
        var (status, body) = await GetAsync($"IPlayerService/GetRecentlyPlayedGames/v1/?key={key}&steamid={RequireSteamId(steamId)}&count=0&format=json", ct);
        if (status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new SteamApiException(SteamApiOutcome.InvalidKey, "Steam didn’t accept your Web API key. Check it in Settings → Library & stores.");
        EnsureOk(status);
        return ParseRecentlyPlayed(body);
    }

    /// <summary>Official announcements for an app (public, no key).</summary>
    public async Task<IReadOnlyList<SteamNewsItem>> GetNewsAsync(string appId, int count, CancellationToken ct)
    {
        var n = Math.Clamp(count, 1, MaxNews);
        var (status, body) = await GetAsync($"ISteamNews/GetNewsForApp/v2/?appid={RequireAppId(appId)}&count={n}&maxlength=0&feeds=steam_community_announcements&format=json", ct);
        if (status is HttpStatusCode.BadRequest or HttpStatusCode.Forbidden or HttpStatusCode.NotFound) return [];
        EnsureOk(status);
        return ParseNews(body, appId);
    }

    // ---------- Parsing (pure, unit-tested) ----------

    /// <summary>
    /// <c>{"response":{"items":[{"appid":…,"priority":…,"date_added":…}]}}</c>. An empty or private wishlist
    /// answers <c>{"response":{}}</c>, which is an empty list (Steam doesn't say which).
    /// </summary>
    internal static IReadOnlyList<WishlistEntry> ParseWishlist(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("response", out var response) ||
                response.ValueKind != JsonValueKind.Object)
                throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s wishlist answer couldn’t be read.");
            var result = new List<WishlistEntry>();
            if (!response.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) return result;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var i in items.EnumerateArray())
            {
                if (result.Count >= MaxWishlist) break;
                if (AppIdOf(i, "appid") is not { } appId || !seen.Add(appId)) continue;
                var priority = Long(i, "priority") is { } p and >= 0 and <= 100_000 ? (int)p : 0;
                DateTimeOffset? added = Long(i, "date_added") is { } t and > 0 and < 32503680000 ? DateTimeOffset.FromUnixTimeSeconds(t) : null;
                result.Add(new WishlistEntry(appId, priority, added));
            }
            return result;
        }
        catch (JsonException)
        {
            throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s wishlist answer couldn’t be read.");
        }
    }

    internal static IReadOnlyList<StoreItemInfo> ParseStoreItems(string json, IReadOnlyCollection<string> requested)
    {
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 32 });
            var result = new List<StoreItemInfo>();
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("response", out var response) ||
                response.ValueKind != JsonValueKind.Object)
                throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s store answer couldn’t be read.");
            if (!response.TryGetProperty("store_items", out var items) || items.ValueKind != JsonValueKind.Array) return result;
            var wanted = requested.ToHashSet(StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var i in items.EnumerateArray())
            {
                if (i.ValueKind != JsonValueKind.Object) continue;
                var appId = AppIdOf(i, "appid") ?? AppIdOf(i, "id");
                if (appId is null || !wanted.Contains(appId) || !seen.Add(appId)) continue;
                if (Long(i, "success") is { } ok && ok != 1) continue;
                var name = CleanText(Str(i, "name"), 160);
                if (name is null) continue;

                DateTimeOffset? release = null;
                var comingSoon = false;
                string? releaseText = null;
                if (Obj(i, "release") is { } r)
                {
                    var ts = Long(r, "steam_release_date") ?? Long(r, "original_release_date");
                    if (ts is > 0 and < 32503680000) release = DateTimeOffset.FromUnixTimeSeconds(ts.Value);
                    comingSoon = Bool(r, "is_coming_soon");
                    releaseText = CleanText(Str(r, "custom_release_date_message"), 60);
                    // "date_month"/"date_quarter"/"date_year": Steam itself shows only part of the date.
                    var display = Str(r, "coming_soon_display");
                    if (comingSoon && releaseText is null && release is { } d && display is "date_month" or "date_quarter" or "date_year")
                        releaseText = display switch
                        {
                            "date_month" => d.ToString("MMMM yyyy", CultureInfo.InvariantCulture),
                            "date_quarter" => $"Q{(d.Month - 1) / 3 + 1} {d.Year}",
                            _ => d.Year.ToString(CultureInfo.InvariantCulture),
                        };
                    if (comingSoon && display is "date_month" or "date_quarter" or "date_year") release = null; // not a real day
                }

                long? final = null, original = null;
                var discount = 0;
                string? formatted = null;
                if (Obj(i, "best_purchase_option") is { } p)
                {
                    final = Long(p, "final_price_in_cents") is { } f and >= 0 and < 100_000_000 ? f : null;
                    original = Long(p, "original_price_in_cents") is { } o and >= 0 and < 100_000_000 ? o : null;
                    discount = (int)Math.Clamp(Long(p, "discount_pct") ?? 0, 0, 100);
                    formatted = CleanText(Str(p, "formatted_final_price"), 24);
                }
                result.Add(new StoreItemInfo(appId, name, release, comingSoon, releaseText, Bool(i, "is_free"), final, original, discount, formatted,
                    HeaderUrl(appId, Obj(i, "assets"))));
            }
            return result;
        }
        catch (JsonException)
        {
            throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s store answer couldn’t be read.");
        }
    }

    /// <summary>
    /// The header image on Steam's shared CDN. Built only from the validated appid and asset names that
    /// match Steam's shapes; anything else falls back to the standard path for that appid.
    /// </summary>
    internal static string HeaderUrl(string appId, JsonElement? assets)
    {
        const string cdn = "https://shared.akamai.steamstatic.com/store_item_assets/";
        if (assets is { } a && Str(a, "asset_url_format") is { } format && Str(a, "header") is { } header &&
            AssetFormat().Match(format) is { Success: true } m && m.Groups[1].Value == appId && AssetFile().IsMatch(header))
            return cdn + format.Replace("${FILENAME}", header, StringComparison.Ordinal);
        return $"{cdn}steam/apps/{appId}/header.jpg";
    }

    [GeneratedRegex(@"\Asteam/apps/(\d{1,10})/(?:[0-9a-f]{40}/)?\$\{FILENAME\}(?:\?t=\d{1,12})?\z")]
    private static partial Regex AssetFormat();

    [GeneratedRegex(@"\A[A-Za-z0-9_\-]{1,100}\.(?:jpg|png|webp)\z")]
    private static partial Regex AssetFile();

    /// <summary>Null = the friend's game details aren't public (Steam answers <c>{"response":{}}</c>).</summary>
    internal static IReadOnlyList<RecentGame>? ParseRecentlyPlayed(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("response", out var response) ||
                response.ValueKind != JsonValueKind.Object)
                throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s recently played answer couldn’t be read.");
            if (!response.TryGetProperty("total_count", out _)) return null;
            var result = new List<RecentGame>();
            if (!response.TryGetProperty("games", out var games) || games.ValueKind != JsonValueKind.Array) return result;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var g in games.EnumerateArray())
            {
                if (result.Count >= 200) break;
                if (AppIdOf(g, "appid") is not { } appId || !seen.Add(appId)) continue;
                var twoWeeks = (int)Math.Clamp(Long(g, "playtime_2weeks") ?? 0, 0, 20160); // at most every minute of two weeks
                var forever = (int)Math.Clamp(Long(g, "playtime_forever") ?? 0, 0, 100_000_000);
                if (twoWeeks <= 0) continue;
                result.Add(new RecentGame(appId, twoWeeks, Math.Max(forever, twoWeeks)));
            }
            return result;
        }
        catch (JsonException)
        {
            throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s recently played answer couldn’t be read.");
        }
    }

    internal const int MaxNewsBytes = 200_000;

    internal static IReadOnlyList<SteamNewsItem> ParseNews(string json, string appId)
    {
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
            if (doc.RootElement.ValueKind != JsonValueKind.Object || Obj(doc.RootElement, "appnews") is not { } news)
                throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s news answer couldn’t be read.");
            var result = new List<SteamNewsItem>();
            if (!news.TryGetProperty("newsitems", out var items) || items.ValueKind != JsonValueKind.Array) return result;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var n in items.EnumerateArray())
            {
                if (result.Count >= MaxNews) break;
                if (n.ValueKind != JsonValueKind.Object) continue;
                var gid = Str(n, "gid");
                if (gid is not { Length: > 0 and <= 20 } || !gid.All(char.IsAsciiDigit) || !seen.Add(gid)) continue;
                if (AppIdOf(n, "appid") is { } a && a != appId) continue;
                var title = CleanText(Services.SteamNewsText.DecodeEntities(Str(n, "title") ?? ""), 200);
                if (title is null) continue;
                var date = Long(n, "date") is { } t and > 0 and < 32503680000 ? DateTimeOffset.FromUnixTimeSeconds(t) : (DateTimeOffset?)null;
                if (date is null) continue;
                var contents = Str(n, "contents") ?? "";
                if (contents.Length > MaxNewsBytes) contents = contents[..MaxNewsBytes];
                var tags = n.TryGetProperty("tags", out var tg) && tg.ValueKind == JsonValueKind.Array
                    ? tg.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!)
                        .Where(x => x.Length is > 0 and <= 40 && x.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-')).Take(12).ToList()
                    : [];
                result.Add(new SteamNewsItem(gid, title, CleanText(Str(n, "author"), 60), date.Value, contents, tags, CleanText(Str(n, "feedlabel"), 60)));
            }
            return result;
        }
        catch (JsonException)
        {
            throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s news answer couldn’t be read.");
        }
    }

    private static bool IsAppId(string s) => s.Length is > 0 and <= 10 && s.All(char.IsAsciiDigit) && uint.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out var v) && v > 0;

    /// <summary>A positive 32-bit appid from a number or numeric string.</summary>
    private static string? AppIdOf(JsonElement e, string name) =>
        Long(e, name) is { } v and > 0 and <= uint.MaxValue ? v.ToString(CultureInfo.InvariantCulture) : null;

    /// <summary>Numbers or numeric strings (Steam's protobuf-to-JSON writes 64-bit numbers as strings).</summary>
    private static long? Long(JsonElement e, string name)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number when v.TryGetInt64(out var n) => n,
            JsonValueKind.String when v.GetString() is { Length: > 0 and <= 20 } s && long.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n) => n,
            _ => null,
        };
    }

    private static bool Bool(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) &&
        (v.ValueKind == JsonValueKind.True || (v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) && n != 0));

    private static JsonElement? Obj(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object ? v : null;
}
