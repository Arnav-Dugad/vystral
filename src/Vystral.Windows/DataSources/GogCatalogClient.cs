using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vystral.Windows.DataSources;

/// <summary>One product from GOG's public catalogue search.</summary>
public sealed record GogProduct(string Id, string Title, string? Slug, int? Year, string ProductType);

/// <summary>A trailer GOG lists for a product. GOG hosts its trailers on YouTube, so this is a YouTube video ID.</summary>
public sealed record GogVideo(string YouTubeId);

/// <summary>
/// Track D4: GOG's public catalogue (<c>catalog.gog.com/v1/catalog</c>, title search) and product API
/// (<c>api.gog.com/v2/games/{id}</c>, trailers). Both are keyless JSON that gog.com and GOG Galaxy use themselves and
/// aren't documented for third parties, so this is a "grey" source: off by default (<c>dataSources.gogCatalog</c>),
/// cached, on its own spaced lane, and a failure only means "no GOG data". Nothing about the user is sent; only a
/// game title (search) or a GOG product ID.
/// </summary>
public sealed partial class GogCatalogClient(ProviderTransport transport)
{
    public const string CatalogBase = "https://catalog.gog.com/v1/catalog";
    public const string ProductBase = "https://api.gog.com/v2/games/";
    internal const int MaxProducts = 20;
    internal const int MaxVideos = 6;

    public async Task<IReadOnlyList<GogProduct>> SearchAsync(string title, CancellationToken ct)
    {
        var t = WikidataClient.SparqlText(title);
        if (t.Length is < 2 or > 100) return [];
        // "like:" is GOG's own title search; ordering by score breaks title relevance, so the default order is kept.
        var url = $"{CatalogBase}?limit=10&query=like:{Uri.EscapeDataString(t)}&productType=in:game,pack&locale=en-US";
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri(url)), ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"GOG answered with an unexpected status ({(int)r.Status}).");
        return ParseSearch(r.Body);
    }

    public async Task<IReadOnlyList<GogVideo>> GetVideosAsync(string productId, CancellationToken ct)
    {
        if (!ProductId().IsMatch(productId)) return [];
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri($"{ProductBase}{productId}?locale=en-US")), ct);
        if (r.Status == HttpStatusCode.NotFound) return [];
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"GOG answered with an unexpected status ({(int)r.Status}).");
        return ParseVideos(r.Body);
    }

    public async Task TestAsync(CancellationToken ct)
    {
        var hits = await SearchAsync("Cyberpunk 2077", ct);
        if (hits.Count == 0) throw new DataSourceException(DataSourceOutcome.Malformed, "GOG answered, but without the expected test game.");
    }

    // ---------- Parsing (pure, unit-tested) ----------

    internal static IReadOnlyList<GogProduct> ParseSearch(string json)
    {
        using var doc = JsonRead.Parse(json, "GOG");
        var list = new List<GogProduct>();
        foreach (var p in JsonRead.Arr(doc.RootElement, "products"))
        {
            var id = JsonRead.Str(p, "id", 14);
            var title = JsonRead.Str(p, "title", 200);
            if (id is null || !ProductId().IsMatch(id) || title is null) continue;
            var type = JsonRead.Str(p, "productType", 12) is { } pt && pt is "game" or "pack" or "dlc" ? pt : "game";
            var slug = JsonRead.Str(p, "slug", 120) is { } s && Slug().IsMatch(s) ? s : null;
            list.Add(new GogProduct(id, title, slug, Year(JsonRead.Str(p, "releaseDate", 20) ?? JsonRead.Str(p, "storeReleaseDate", 20)), type));
            if (list.Count >= MaxProducts) break;
        }
        return list;
    }

    internal static IReadOnlyList<GogVideo> ParseVideos(string json)
    {
        using var doc = JsonRead.Parse(json, "GOG");
        if (JsonRead.Obj(doc.RootElement, "_embedded") is not { } embedded) return [];
        var list = new List<GogVideo>();
        foreach (var v in JsonRead.Arr(embedded, "videos"))
        {
            if (JsonRead.Str(v, "provider", 20) != "youtube") continue;
            if (JsonRead.Str(v, "videoId", 20) is { } id && ExternalTrailers.IsYouTubeId(id) && list.All(x => x.YouTubeId != id))
                list.Add(new GogVideo(id));
            if (list.Count >= MaxVideos) break;
        }
        return list;
    }

    /// <summary>"2020.12.10" (catalogue) or "2015-05-19T00:00:00+02:00" (product API) → 2020.</summary>
    internal static int? Year(string? date) =>
        date is { Length: >= 4 } && int.TryParse(date[..4], NumberStyles.None, CultureInfo.InvariantCulture, out var y) && y is > 1950 and < 2200 ? y : null;

    [GeneratedRegex(@"\A[1-9][0-9]{0,11}\z")]
    internal static partial Regex ProductId();

    [GeneratedRegex(@"\A[a-z0-9_\-]{1,120}\z")]
    private static partial Regex Slug();
}
