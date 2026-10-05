using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vystral.Windows.DataSources;

/// <summary>One shop's current price. <see cref="Url"/> is kept exactly as the provider sent it (their terms forbid changing links).</summary>
public sealed record PriceOffer(string Id, string Shop, double Price, double? Regular, int Cut, string Currency, string Url);

/// <summary>A provider's prices for one game. Prices are the provider's, never VYSTRAL's estimates.</summary>
public sealed record PriceQuote(string Provider, string Currency, IReadOnlyList<PriceOffer> Offers, double? HistoricalLow, string? HistoricalLowAt,
    string? ProviderUrl, DateTimeOffset Fetched);

/// <summary>
/// CheapShark (keyless, US dollars). Called only when the user opens a game's page, never to
/// build a catalog (their terms). Deal links go through CheapShark's own redirect, unmodified.
/// </summary>
public sealed partial class CheapSharkClient(ProviderTransport transport)
{
    public const string Base = "https://www.cheapshark.com/api/1.0/";

    public async Task<PriceQuote?> GetBySteamAppIdAsync(string appId, Func<IReadOnlyDictionary<string, string>?> cachedStores,
        Action<IReadOnlyDictionary<string, string>> saveStores, CancellationToken ct)
    {
        if (appId.Length is 0 or > 10 || !appId.All(char.IsAsciiDigit)) return null;
        var gameId = ParseLookup(await GetAsync($"games?steamAppID={appId}", ct), appId);
        if (gameId is null) return null;
        var stores = cachedStores();
        if (stores is null)
        {
            stores = ParseStores(await GetAsync("stores", ct));
            saveStores(stores);
        }
        return ParseGame(await GetAsync($"games?id={gameId}", ct), stores, DateTimeOffset.UtcNow);
    }

    public async Task TestAsync(CancellationToken ct) => ParseStores(await GetAsync("stores", ct));

    private async Task<string> GetAsync(string pathAndQuery, CancellationToken ct)
    {
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri(Base + pathAndQuery)), ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"CheapShark answered with an unexpected status ({(int)r.Status}).");
        return r.Body;
    }

    // ---------- Parsing (pure, unit-tested) ----------

    internal static string? ParseLookup(string json, string appId)
    {
        using var doc = JsonRead.Parse(json, "CheapShark");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
        var ids = doc.RootElement.EnumerateArray()
            .Where(e => JsonRead.Str(e, "steamAppID", 12) == appId)
            .Select(e => JsonRead.Str(e, "gameID", 12)).Where(id => id is not null && id.All(char.IsAsciiDigit)).Distinct().ToList();
        return ids.Count == 1 ? ids[0] : null;
    }

    internal static IReadOnlyDictionary<string, string> ParseStores(string json)
    {
        using var doc = JsonRead.Parse(json, "CheapShark");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new DataSourceException(DataSourceOutcome.Malformed, "CheapShark’s store list couldn’t be read.");
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var s in doc.RootElement.EnumerateArray())
            if (JsonRead.Str(s, "storeID", 6) is { } id && JsonRead.Str(s, "storeName", 60) is { } name) map[id] = name;
        return map;
    }

    internal static PriceQuote? ParseGame(string json, IReadOnlyDictionary<string, string> stores, DateTimeOffset fetched)
    {
        using var doc = JsonRead.Parse(json, "CheapShark");
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return null;
        var offers = new List<PriceOffer>();
        foreach (var d in JsonRead.Arr(root, "deals"))
        {
            var dealId = JsonRead.Str(d, "dealID", 200);
            var price = JsonRead.Num(d, "price");
            if (dealId is null || !DealId().IsMatch(dealId) || price is not (>= 0 and < 100000)) continue;
            double? regular = JsonRead.Num(d, "retailPrice") is >= 0 and < 100000 and var r ? r : null;
            var store = JsonRead.Str(d, "storeID", 6) is { } sid && stores.TryGetValue(sid, out var n) ? n : "Unknown store";
            var cut = regular is > 0 ? (int)Math.Clamp(Math.Round((1 - price.Value / regular.Value) * 100), 0, 100) : 0;
            offers.Add(new PriceOffer(ShortId("cs:" + dealId), store, Math.Round(price.Value, 2), regular, cut, "USD",
                $"https://www.cheapshark.com/redirect?dealID={dealId}"));
            if (offers.Count >= 12) break;
        }
        double? low = null;
        string? lowAt = null;
        if (JsonRead.Obj(root, "cheapestPriceEver") is { } ever && JsonRead.Num(ever, "price") is >= 0 and < 100000 and var lp)
        {
            low = Math.Round(lp, 2);
            lowAt = JsonRead.Long(ever, "date") is > 0 and < 4102444800 and var ts ? DateTimeOffset.FromUnixTimeSeconds(ts).ToString("O") : null;
        }
        if (offers.Count == 0 && low is null) return null;
        return new PriceQuote("cheapshark", "USD", offers.OrderBy(o => o.Price).ToList(), low, lowAt, "https://www.cheapshark.com/", fetched);
    }

    internal static string ShortId(string s) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(s)))[..16];

    [GeneratedRegex(@"\A[A-Za-z0-9%+/=]{8,200}\z")]
    private static partial Regex DealId();
}

/// <summary>
/// IsThereAnyDeal (api.isthereanydeal.com) with the user's own key, sent as the ITAD-API-Key
/// header. Prices and links are shown exactly as ITAD sends them, with a link to ITAD.
/// </summary>
public sealed partial class IsThereAnyDealClient(ProviderTransport transport, Func<string?> apiKey)
{
    public const string Base = "https://api.isthereanydeal.com/";

    public async Task TestAsync(CancellationToken ct, string? keyOverride = null) =>
        _ = await LookupAsync("620", ct, keyOverride); // Portal 2: any valid key can look it up

    public async Task<PriceQuote?> GetBySteamAppIdAsync(string appId, string country, CancellationToken ct)
    {
        var game = await LookupAsync(appId, ct);
        if (game is null) return null;
        var c = CountryCode().IsMatch(country) ? country : "US";
        var r = await SendAsync(HttpMethod.Post, $"games/prices/v3?country={c}&capacity=8", JsonSerializer.Serialize(new[] { game.Value.Id }), ct, null);
        return ParsePrices(r, game.Value.Id, game.Value.Slug, DateTimeOffset.UtcNow);
    }

    private async Task<(string Id, string? Slug)?> LookupAsync(string appId, CancellationToken ct, string? keyOverride = null)
    {
        if (appId.Length is 0 or > 10 || !appId.All(char.IsAsciiDigit)) return null;
        return ParseLookup(await SendAsync(HttpMethod.Get, $"games/lookup/v1?appid={appId}", null, ct, keyOverride));
    }

    private async Task<string> SendAsync(HttpMethod method, string pathAndQuery, string? body, CancellationToken ct, string? keyOverride)
    {
        var key = keyOverride ?? apiKey() ?? throw new DataSourceException(DataSourceOutcome.NotConfigured, "Add your IsThereAnyDeal API key in Settings → Data sources first.");
        var r = await transport.SendAsync(() =>
        {
            var req = new HttpRequestMessage(method, new Uri(Base + pathAndQuery));
            req.Headers.Add("ITAD-API-Key", key);
            if (body is not null) req.Content = new StringContent(body, Encoding.UTF8, "application/json");
            return req;
        }, ct);
        if (r.Status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new DataSourceException(DataSourceOutcome.InvalidKey, "IsThereAnyDeal didn’t accept this API key. Copy it again from your app on isthereanydeal.com.");
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"IsThereAnyDeal answered with an unexpected status ({(int)r.Status}).");
        return r.Body;
    }

    // ---------- Parsing (pure, unit-tested) ----------

    internal static (string Id, string? Slug)? ParseLookup(string json)
    {
        using var doc = JsonRead.Parse(json, "IsThereAnyDeal");
        var root = doc.RootElement;
        if (!JsonRead.Bool(root, "found") || JsonRead.Obj(root, "game") is not { } g) return null;
        var id = JsonRead.Str(g, "id", 40);
        if (id is null || !Guid.TryParse(id, out _)) return null;
        var slug = JsonRead.Str(g, "slug", 120);
        return (id, slug is not null && Slug().IsMatch(slug) ? slug : null);
    }

    internal static PriceQuote? ParsePrices(string json, string gameId, string? slug, DateTimeOffset fetched)
    {
        using var doc = JsonRead.Parse(json, "IsThereAnyDeal");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
        var entry = doc.RootElement.EnumerateArray().FirstOrDefault(e => JsonRead.Str(e, "id", 40) == gameId);
        if (entry.ValueKind != JsonValueKind.Object) return null;
        var offers = new List<PriceOffer>();
        string? currency = null;
        foreach (var d in JsonRead.Arr(entry, "deals"))
        {
            var shop = JsonRead.Obj(d, "shop") is { } s ? JsonRead.Str(s, "name", 60) : null;
            var price = JsonRead.Obj(d, "price") is { } p ? Money(p) : null;
            // ITAD's links lead to many shops (often through its own itad.link redirect), so any plain HTTPS URL is accepted as sent.
            var url = SafeHttps(d.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() : null);
            if (shop is null || price is null || url is null) continue;
            var regular = JsonRead.Obj(d, "regular") is { } rg ? Money(rg) : null;
            currency ??= price.Value.Currency;
            if (price.Value.Currency != currency) continue;
            offers.Add(new PriceOffer(CheapSharkClient.ShortId("itad:" + url), shop, price.Value.Amount, regular?.Amount,
                (int)Math.Clamp(JsonRead.Long(d, "cut") ?? 0, 0, 100), currency, url));
            if (offers.Count >= 12) break;
        }
        var lowAll = JsonRead.Obj(entry, "historyLow") is { } hl && JsonRead.Obj(hl, "all") is { } all ? Money(all) : null;
        if (lowAll is { } l && currency is not null && l.Currency != currency) lowAll = null;
        if (offers.Count == 0 && lowAll is null) return null;
        return new PriceQuote("itad", currency ?? lowAll!.Value.Currency, offers.OrderBy(o => o.Price).ToList(), lowAll?.Amount, null,
            slug is null ? "https://isthereanydeal.com/" : $"https://isthereanydeal.com/game/{slug}/info/", fetched);
    }

    internal static string? SafeHttps(string? url) =>
        url is { Length: <= 600 } && Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
        uri.IsDefaultPort && uri.UserInfo.Length == 0 && !uri.HostNameType.Equals(UriHostNameType.IPv4) && !uri.HostNameType.Equals(UriHostNameType.IPv6)
            ? uri.AbsoluteUri : null;

    private static (double Amount, string Currency)? Money(JsonElement m)
    {
        var amount = JsonRead.Num(m, "amount");
        var currency = JsonRead.Str(m, "currency", 3);
        return amount is >= 0 and < 1_000_000 && currency is not null && CurrencyCode().IsMatch(currency) ? (Math.Round(amount.Value, 2), currency) : null;
    }

    [GeneratedRegex(@"\A[A-Z]{2}\z")]
    private static partial Regex CountryCode();

    [GeneratedRegex(@"\A[A-Z]{3}\z")]
    private static partial Regex CurrencyCode();

    [GeneratedRegex(@"\A[a-z0-9][a-z0-9\-]{0,119}\z")]
    private static partial Regex Slug();
}
