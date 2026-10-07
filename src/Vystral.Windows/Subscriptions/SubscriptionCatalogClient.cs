using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Cloud;
using Vystral.Core.Subscriptions;
using Vystral.Windows.Cloud;
using Vystral.Windows.DataSources;

namespace Vystral.Windows.Subscriptions;

/// <summary>One Microsoft Store product as the subscription features need it. Every field was validated.</summary>
/// <param name="GamePassEnd">The earliest end of the product's Game Pass offers in the Store listing (the availabilities
/// that point to a subscription as the way to get it), when it is a real date in the future; null otherwise.</param>
public sealed record SubscriptionProduct(string ProductId, string? Title, string? Pfn, string? PosterUrl, DateTimeOffset? GamePassEnd);

/// <summary>
/// Track V: Microsoft's public Game Pass data, the same grey sources as Track O's Xbox catalogue (undocumented,
/// unauthenticated JSON used by xbox.com's own pages; no cookies, a plain VYSTRAL User-Agent, size-capped, every field
/// validated, refreshed at most daily). Lists come from <c>catalog.gamepass.com</c>; product names, posters and
/// Game Pass end dates from Microsoft's display catalogue. Verified with single low-rate requests on 2026-10-07.
/// </summary>
public sealed partial class SubscriptionCatalogClient(ProviderTransport lists, ProviderTransport display)
{
    /// <summary>"Leaving soon" on xbox.com's Game Pass pages (<c>SubsXGPLeavingSoon</c> in xbox.com's xgpcatPopulate script;
    /// the endpoint answers with the title "Leaving soon"). It lists product IDs only, no dates.</summary>
    public const string LeavingSoonSigl = "cc7fc951-d00f-410e-9e02-5e4628e04163";
    /// <summary>"Recently added" (<c>XGPPMPRecentlyAdded</c>).</summary>
    public const string RecentlyAddedSigl = "3fdd7f57-7092-4b65-bd40-5a9dac1b2b84";
    /// <summary>"Most popular" on PC (<c>pcgaVTpopular</c>).</summary>
    public const string PopularSigl = "a884932a-f02b-40c8-a903-a008c23b1df1";

    public const int MaxPerList = 3000;
    public const int MaxTotal = 12000;
    public const int MaxSiglItems = 200;

    internal static Uri SubscriptionsUri(string market)
    {
        if (!CloudIds.IsMarket(market)) throw new ArgumentException("Invalid market.", nameof(market));
        return new Uri($"https://catalog.gamepass.com/subscriptions?subscription=all&market={market}");
    }

    internal static Uri SiglUri(string siglId, string market)
    {
        if (!CloudIds.IsMarket(market)) throw new ArgumentException("Invalid market.", nameof(market));
        if (siglId is not (LeavingSoonSigl or RecentlyAddedSigl or PopularSigl)) throw new ArgumentException("Unknown list.", nameof(siglId));
        return new Uri($"https://catalog.gamepass.com/sigls/v2?id={siglId}&market={market}&language=en-US");
    }

    /// <summary>The display catalogue. <paramref name="browse"/> asks for the light "browse" template (title and images,
    /// about a quarter of the size); the full answer adds the package family name and the offers' dates.</summary>
    internal static Uri ProductsUri(IReadOnlyList<string> productIds, string market, bool browse)
    {
        if (!CloudIds.IsMarket(market)) throw new ArgumentException("Invalid market.", nameof(market));
        if (productIds.Count is 0 or > XboxCloudCatalogClient.BatchSize || !productIds.All(CloudIds.IsProductId))
            throw new ArgumentException("Invalid product IDs.", nameof(productIds));
        return new Uri($"https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds={string.Join(',', productIds)}&market={market}&languages=en-us" +
                       (browse ? "&fieldsTemplate=browse" : ""));
    }

    public async Task<IReadOnlyDictionary<string, IReadOnlyList<string>>> FetchListsAsync(string market, CancellationToken ct)
    {
        var r = await lists.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, SubscriptionsUri(market)), ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Game Pass answered with an unexpected status ({(int)r.Status}).");
        return ParseLists(r.Body);
    }

    public async Task<IReadOnlyList<string>> FetchSiglAsync(string siglId, string market, CancellationToken ct)
    {
        var r = await lists.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, SiglUri(siglId, market)), ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Game Pass answered with an unexpected status ({(int)r.Status}).");
        return ParseSigl(r.Body);
    }

    public async Task<IReadOnlyList<SubscriptionProduct>> FetchProductsAsync(IReadOnlyList<string> productIds, string market, bool browse, DateTimeOffset now, CancellationToken ct)
    {
        var r = await display.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, ProductsUri(productIds, market, browse)), ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Microsoft Store answered with an unexpected status ({(int)r.Status}).");
        var asked = new HashSet<string>(productIds, StringComparer.Ordinal);
        return ParseProducts(r.Body, now).Where(p => asked.Contains(p.ProductId)).ToList();
    }

    /// <summary>
    /// <c>{"pc":["9N…",…],"console":[…],…}</c> → only the arrays VYSTRAL reads (<see cref="SubscriptionPlans.CatalogKeys"/>),
    /// with valid, unique product IDs. Anything else is ignored; a non-object answer is an error.
    /// </summary>
    internal static IReadOnlyDictionary<string, IReadOnlyList<string>> ParseLists(string json)
    {
        using var doc = JsonRead.Parse(json, "Game Pass");
        if (doc.RootElement.ValueKind != JsonValueKind.Object) throw new DataSourceException(DataSourceOutcome.Malformed, "The Game Pass lists couldn’t be read.");
        var result = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        var total = 0;
        foreach (var key in SubscriptionPlans.CatalogKeys)
        {
            if (!doc.RootElement.TryGetProperty(key, out var arr) || arr.ValueKind != JsonValueKind.Array) continue;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var ids = new List<string>();
            foreach (var e in arr.EnumerateArray())
            {
                if (e.ValueKind != JsonValueKind.String) continue;
                var id = e.GetString();
                if (CloudIds.IsProductId(id) && seen.Add(id!)) ids.Add(id!);
                if (ids.Count > MaxPerList) throw new DataSourceException(DataSourceOutcome.Malformed, "A Game Pass list was unexpectedly long.");
            }
            total += ids.Count;
            if (total > MaxTotal) throw new DataSourceException(DataSourceOutcome.Malformed, "The Game Pass lists were unexpectedly long.");
            result[key] = ids;
        }
        if (result.Count == 0) throw new DataSourceException(DataSourceOutcome.Malformed, "The Game Pass lists couldn’t be read.");
        return result;
    }

    /// <summary>A SIGL list (header object, then <c>{"id":…}</c> items), with Track O's parser; capped for these short lists.</summary>
    internal static IReadOnlyList<string> ParseSigl(string json)
    {
        try
        {
            var ids = XboxCloudCatalogClient.ParseSigl(json);
            if (ids.Count > MaxSiglItems) throw new DataSourceException(DataSourceOutcome.Malformed, "A Game Pass list was unexpectedly long.");
            return ids;
        }
        catch (DataSourceException ex) when (ex.Outcome == DataSourceOutcome.Malformed && !ex.Message.Contains("Game Pass", StringComparison.Ordinal))
        {
            throw new DataSourceException(DataSourceOutcome.Malformed, "A Game Pass list couldn’t be read.");
        }
    }

    /// <summary>
    /// The display catalogue's <c>Products</c> → title, package family name (full answers only), a poster on Microsoft's
    /// image CDN, and the Game Pass end date. Wrong types count as missing; products without a valid ID are dropped.
    /// </summary>
    internal static IReadOnlyList<SubscriptionProduct> ParseProducts(string json, DateTimeOffset now)
    {
        using var doc = JsonRead.Parse(json, "Microsoft Store");
        if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("Products", out var products) || products.ValueKind != JsonValueKind.Array)
            throw new DataSourceException(DataSourceOutcome.Malformed, "The Microsoft Store answer couldn’t be read.");
        var list = new List<SubscriptionProduct>();
        foreach (var p in products.EnumerateArray().Take(XboxCloudCatalogClient.BatchSize * 2))
        {
            if (p.ValueKind != JsonValueKind.Object) continue;
            var id = JsonRead.Str(p, "ProductId", 20);
            if (!CloudIds.IsProductId(id)) continue;
            var pfn = JsonRead.Obj(p, "Properties") is { } props ? JsonRead.Str(props, "PackageFamilyName", 140) : null;
            if (!CloudIds.IsPackageFamilyName(pfn)) pfn = null;
            var localized = JsonRead.Arr(p, "LocalizedProperties").FirstOrDefault();
            var title = localized.ValueKind == JsonValueKind.Object ? CleanTitle(JsonRead.Str(localized, "ProductTitle", 200)) : null;
            var poster = localized.ValueKind == JsonValueKind.Object ? Poster(localized) : null;
            list.Add(new SubscriptionProduct(id!, title, pfn, poster, GamePassEnd(p, now)));
        }
        return list;
    }

    private static string? CleanTitle(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = new string(s.Where(c => !char.IsControl(c)).ToArray()).Trim();
        return s.Length == 0 ? null : s;
    }

    /// <summary>The Poster (2:3) image, else BoxArt, as a plain https URL on store-images.s-microsoft.com, or null.</summary>
    private static string? Poster(JsonElement localized)
    {
        string? box = null;
        foreach (var img in JsonRead.Arr(localized, "Images").Take(60))
        {
            if (img.ValueKind != JsonValueKind.Object) continue;
            var purpose = JsonRead.Str(img, "ImagePurpose", 40);
            if (purpose is not ("Poster" or "BoxArt")) continue;
            var url = SafeImageUrl(JsonRead.Str(img, "Uri", 300));
            if (url is null) continue;
            if (purpose == "Poster") return url;
            box ??= url;
        }
        return box;
    }

    /// <summary>
    /// Only Microsoft's image CDN, only the <c>/image/apps.…</c> shape it uses for Store art (protocol-relative in the
    /// answer), returned as https with no query. Anything else is dropped.
    /// </summary>
    public static string? SafeImageUrl(string? uri)
    {
        if (uri is null) return null;
        var m = ImageUri().Match(uri);
        return m.Success ? $"https://store-images.s-microsoft.com/image/{m.Groups["path"].Value}" : null;
    }

    [GeneratedRegex(@"\A(?:https:)?//store-images\.s-microsoft\.com/image/(?<path>apps\.[0-9]{1,10}\.[0-9]{1,24}\.[0-9a-f\-]{8,60}(?:\.[0-9a-f\-]{8,60})?)\z")]
    private static partial Regex ImageUri();

    /// <summary>
    /// The earliest end date among the product's offers that point to a subscription (an availability whose
    /// remediation is an <c>Upsell</c> to a <c>CFQ7TTC0…</c> subscription product), if it is real (before year 9000)
    /// and still ahead. On 2026-10-07 every "Leaving soon" game carried one, matching the date the game leaves; it is
    /// shown as "around", because it is a Store listing date rather than an announcement.
    /// </summary>
    internal static DateTimeOffset? GamePassEnd(JsonElement product, DateTimeOffset now)
    {
        DateTimeOffset? earliest = null;
        foreach (var dsa in JsonRead.Arr(product, "DisplaySkuAvailabilities").Take(20))
        {
            foreach (var a in JsonRead.Arr(dsa, "Availabilities").Take(60))
            {
                var upsell = JsonRead.Arr(a, "Remediations").Take(10).Any(r =>
                    JsonRead.Str(r, "Type", 20) == "Upsell" && JsonRead.Str(r, "BigId", 20) is { } big && big.StartsWith("CFQ7TTC0", StringComparison.Ordinal));
                if (!upsell || JsonRead.Obj(a, "Conditions") is not { } c || JsonRead.Str(c, "EndDate", 40) is not { } raw) continue;
                if (!DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var end)) continue;
                if (end.Year >= 9000 || end <= now || end > now.AddDays(120)) continue;
                if (earliest is null || end < earliest) earliest = end;
            }
        }
        return earliest;
    }
}
