using System.Net;
using System.Text;
using System.Text.Json;
using Vystral.Core.Cloud;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;

namespace Vystral.Windows.Cloud;

/// <summary>
/// GeForce NOW's public games list: the GraphQL endpoint nvidia.com's own games page uses (grey: undocumented,
/// unauthenticated, no cookies or special headers). The body is the raw query as <c>text/plain</c>; pages hold up to
/// 750 items and are walked by cursor. Only the fields VYSTRAL needs are asked for and kept.
/// </summary>
public sealed class GfnCatalogClient(ProviderTransport transport)
{
    public const string Endpoint = "https://api-prod.nvidia.com/services/gfngames/v1/gameList";
    public const int MaxPages = 20;
    public const int MaxItems = 15000;

    public sealed record Page(IReadOnlyList<CloudCatalogEntry> Items, string? NextCursor, int Returned);

    /// <summary>The query for one page. Every interpolated value is validated first (country, cursor), so nothing untrusted reaches it.</summary>
    internal static string Query(string country, string cursor)
    {
        if (!CloudIds.IsMarket(country)) throw new ArgumentException("Invalid country.", nameof(country));
        if (!IsCursor(cursor)) throw new ArgumentException("Invalid cursor.", nameof(cursor));
        return $$"""{ apps(country:"{{country}}" language:"en_US" after:"{{cursor}}") { numberReturned pageInfo { endCursor hasNextPage } items { id cmsId title gfn { playType minimumMembershipTierLabel } variants { appStore storeId } } } }""";
    }

    internal static bool IsCursor(string? s) => s is not null && s.Length <= 200 && s.All(c => char.IsAsciiLetterOrDigit(c) || c is '=' or '+' or '/' or '-' or '_');

    public async Task<IReadOnlyList<CloudCatalogEntry>> FetchAllAsync(string country, CancellationToken ct)
    {
        var all = new Dictionary<string, CloudCatalogEntry>(StringComparer.Ordinal);
        var cursor = "";
        for (var page = 0; page < MaxPages; page++)
        {
            var query = Query(country, cursor);
            var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Post, new Uri(Endpoint))
            {
                Content = new StringContent(query, Encoding.UTF8, "text/plain"),
            }, ct);
            if (r.Status != HttpStatusCode.OK)
                throw new DataSourceException(DataSourceOutcome.Malformed, $"GeForce NOW answered with an unexpected status ({(int)r.Status}).");
            var p = ParsePage(r.Body);
            foreach (var e in p.Items) all.TryAdd(e.EntryId, e);
            if (all.Count > MaxItems) throw new DataSourceException(DataSourceOutcome.Malformed, "GeForce NOW’s list was unexpectedly long.");
            if (p.NextCursor is null) return all.Values.ToList();
            cursor = p.NextCursor;
        }
        // Stopping early would quietly hide games; a list this long is unexpected, so keep the last good copy instead.
        throw new DataSourceException(DataSourceOutcome.Malformed, "GeForce NOW’s list had more pages than expected.");
    }

    /// <summary>Parses one page. Wrong types count as missing; entries without a valid ID, cmsId or title are dropped.</summary>
    internal static Page ParsePage(string json)
    {
        using var doc = JsonRead.Parse(json, "GeForce NOW");
        if (JsonRead.Obj(doc.RootElement, "data") is not { } data || JsonRead.Obj(data, "apps") is not { } apps)
            throw new DataSourceException(DataSourceOutcome.Malformed, "GeForce NOW’s games list couldn’t be read.");
        var items = new List<CloudCatalogEntry>();
        foreach (var it in JsonRead.Arr(apps, "items"))
        {
            var id = JsonRead.Str(it, "id", 40);
            var cms = JsonRead.Str(it, "cmsId", 14);
            var title = JsonRead.Str(it, "title", 200);
            if (!CloudIds.IsGfnGameId(id) || !CloudIds.IsCmsId(cms) || title is null) continue;
            var gfn = JsonRead.Obj(it, "gfn");
            var playType = (gfn is { } g ? JsonRead.Str(g, "playType", 30) : null) switch
            {
                "READY_TO_PLAY" => CloudPlayTypes.Ready,
                "INSTALL_TO_PLAY" => CloudPlayTypes.InstallToPlay,
                _ => null,
            };
            var tier = gfn is { } g2 ? JsonRead.Str(g2, "minimumMembershipTierLabel", 30) : null;
            var links = new List<CloudStoreLink>();
            foreach (var v in JsonRead.Arr(it, "variants").Take(16))
            {
                var store = CloudStores.FromGfn(JsonRead.Str(v, "appStore", 20));
                var sid = JsonRead.Str(v, "storeId", 64);
                if (store is null || !CloudIds.IsStoreId(store, sid)) continue;
                if (!links.Any(l => l.Store == store && l.StoreId == sid)) links.Add(new CloudStoreLink(store, sid!));
            }
            items.Add(new CloudCatalogEntry(CloudServices.GeForceNow, id!, cms, title, playType, tier is not null, links));
        }
        string? next = null;
        if (JsonRead.Obj(apps, "pageInfo") is { } info && JsonRead.Bool(info, "hasNextPage"))
        {
            next = JsonRead.Str(info, "endCursor", 200);
            if (!IsCursor(next)) throw new DataSourceException(DataSourceOutcome.Malformed, "GeForce NOW’s games list couldn’t be read.");
        }
        return new Page(items, next, (int)(JsonRead.Long(apps, "numberReturned") ?? items.Count));
    }
}

/// <summary>
/// Xbox Cloud Gaming's catalogue: the Game Pass "all cloud games" list (a SIGL, used by xbox.com's own pages) and
/// Microsoft's display catalogue for each product's package family name and title. Both are public and unauthenticated.
/// </summary>
public sealed class XboxCloudCatalogClient(ProviderTransport sigl, ProviderTransport display)
{
    public const string AllCloudSigl = "29a81209-df6f-41fd-a528-2ae6b91f719c";
    public const int BatchSize = 20;
    public const int MaxProducts = 3000;

    internal static Uri SiglUri(string market)
    {
        if (!CloudIds.IsMarket(market)) throw new ArgumentException("Invalid market.", nameof(market));
        return new Uri($"https://catalog.gamepass.com/sigls/v2?id={AllCloudSigl}&market={market}&language=en-US");
    }

    internal static Uri DisplayUri(IReadOnlyList<string> productIds, string market)
    {
        if (!CloudIds.IsMarket(market)) throw new ArgumentException("Invalid market.", nameof(market));
        if (productIds.Count is 0 or > BatchSize || !productIds.All(CloudIds.IsProductId)) throw new ArgumentException("Invalid product IDs.", nameof(productIds));
        return new Uri($"https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds={string.Join(',', productIds)}&market={market}&languages=en-us");
    }

    public async Task<IReadOnlyList<string>> FetchCloudProductIdsAsync(string market, CancellationToken ct)
    {
        var r = await sigl.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, SiglUri(market)), ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Xbox answered with an unexpected status ({(int)r.Status}).");
        return ParseSigl(r.Body);
    }

    /// <summary>The SIGL is a header object followed by <c>{"id":"&lt;product id&gt;"}</c> items.</summary>
    internal static IReadOnlyList<string> ParseSigl(string json)
    {
        using var doc = JsonRead.Parse(json, "Xbox");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new DataSourceException(DataSourceOutcome.Malformed, "The Xbox cloud games list couldn’t be read.");
        var ids = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var header = false;
        foreach (var e in doc.RootElement.EnumerateArray())
        {
            if (JsonRead.Str(e, "siglId", 60) is not null) { header = true; continue; }
            var id = JsonRead.Str(e, "id", 20);
            if (CloudIds.IsProductId(id) && seen.Add(id!)) ids.Add(id!);
            if (ids.Count > MaxProducts) throw new DataSourceException(DataSourceOutcome.Malformed, "The Xbox cloud games list was unexpectedly long.");
        }
        if (!header) throw new DataSourceException(DataSourceOutcome.Malformed, "The Xbox cloud games list couldn’t be read.");
        return ids;
    }

    public async Task<IReadOnlyList<(string ProductId, string? Pfn, string? Title)>> FetchProductsAsync(IReadOnlyList<string> productIds, string market, CancellationToken ct)
    {
        var r = await display.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, DisplayUri(productIds, market)), ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Microsoft Store answered with an unexpected status ({(int)r.Status}).");
        var found = ParseProducts(r.Body);
        // Products the catalogue didn't return are recorded as unknown, so they aren't asked for again every day.
        var asked = new HashSet<string>(productIds, StringComparer.Ordinal);
        return found.Where(p => asked.Contains(p.ProductId))
            .Concat(productIds.Where(id => found.All(f => f.ProductId != id)).Select(id => (id, (string?)null, (string?)null)))
            .ToList();
    }

    internal static IReadOnlyList<(string ProductId, string? Pfn, string? Title)> ParseProducts(string json)
    {
        using var doc = JsonRead.Parse(json, "Microsoft Store");
        if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("Products", out var products) || products.ValueKind != JsonValueKind.Array)
            throw new DataSourceException(DataSourceOutcome.Malformed, "The Microsoft Store answer couldn’t be read.");
        var list = new List<(string, string?, string?)>();
        foreach (var p in products.EnumerateArray().Take(BatchSize * 2))
        {
            var id = JsonRead.Str(p, "ProductId", 20);
            if (!CloudIds.IsProductId(id)) continue;
            var pfn = JsonRead.Obj(p, "Properties") is { } props ? JsonRead.Str(props, "PackageFamilyName", 140) : null;
            if (!CloudIds.IsPackageFamilyName(pfn)) pfn = null;
            var title = JsonRead.Arr(p, "LocalizedProperties").Select(l => JsonRead.Str(l, "ProductTitle", 200)).FirstOrDefault(t => t is not null);
            list.Add((id!, pfn, title));
        }
        return list;
    }
}

/// <summary>GeForce NOW's public Atlassian Statuspage summary (a documented, allowed API).</summary>
public sealed record CloudServiceStatusDto(string Service, string Indicator, string Description, int Components, int Degraded, IReadOnlyList<string> Incidents, string CheckedAt, string? Error);

public sealed class GfnStatusClient(ProviderTransport transport)
{
    public const string SummaryUrl = "https://status.geforcenow.com/api/v2/summary.json";

    public async Task<CloudServiceStatusDto> FetchAsync(CancellationToken ct)
    {
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri(SummaryUrl)), ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"GeForce NOW’s status page answered with an unexpected status ({(int)r.Status}).");
        return Parse(r.Body, DateTimeOffset.UtcNow);
    }

    internal static CloudServiceStatusDto Parse(string json, DateTimeOffset at)
    {
        using var doc = JsonRead.Parse(json, "GeForce NOW status");
        var root = doc.RootElement;
        if (JsonRead.Obj(root, "status") is not { } status) throw new DataSourceException(DataSourceOutcome.Malformed, "GeForce NOW’s status couldn’t be read.");
        var indicator = JsonRead.Str(status, "indicator", 20) switch
        {
            "none" => "none",
            "minor" => "minor",
            "major" => "major",
            "critical" => "critical",
            "maintenance" => "maintenance",
            _ => "unknown",
        };
        var description = JsonRead.Str(status, "description", 120) ?? "Status unknown";
        var components = JsonRead.Arr(root, "components").Take(500).Where(c => !JsonRead.Bool(c, "group")).ToList();
        var degraded = components.Count(c => JsonRead.Str(c, "status", 30) is { } s && s != "operational");
        var incidents = JsonRead.Arr(root, "incidents").Take(20)
            .Select(i => JsonRead.Str(i, "name", 120)).Where(n => n is not null).Take(3).Select(n => n!).ToList();
        return new CloudServiceStatusDto(CloudServices.GeForceNow, indicator, description, components.Count, degraded, incidents, at.ToString("O"), null);
    }
}
