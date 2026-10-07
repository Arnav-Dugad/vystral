using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vystral.Windows.DataSources;

public sealed record WikidataIdentity(string Key, string? ItemId, string? Label, IReadOnlyDictionary<string, string> Ids);

/// <summary>
/// Cross-store identity from Wikidata's public SPARQL endpoint (CC0, keyless). Requests carry
/// VYSTRAL's descriptive User-Agent with the project URL (Wikimedia's policy), run one at a
/// time, and batch up to 100 store IDs per query.
/// </summary>
public sealed partial class WikidataClient(ProviderTransport transport)
{
    public const string Endpoint = "https://query.wikidata.org/sparql";
    public const int MaxBatch = 100;

    /// <summary>The store ID kinds VYSTRAL can look up by, and their Wikidata property.</summary>
    public static readonly IReadOnlyDictionary<string, string> KeyProperties = new Dictionary<string, string>
    {
        ["steam"] = "P1733",
        ["gog"] = "P12727",
    };

    /// <summary>Identifiers read for each item: name → (property, validation pattern).</summary>
    internal static readonly (string Name, string Property, Regex Pattern)[] Properties =
    [
        ("steam", "P1733", Digits()),
        ("gog", "P2725", GogPath()),
        ("gogId", "P12727", Digits()),
        ("epic", "P6278", Slug()),
        ("microsoft", "P5885", MsBigId()),
        ("igdb", "P5794", Slug()),
        ("pcgamingwiki", "P6337", WikiTitle()),
        ("hltb", "P2816", Digits()),
        ("steamgriddb", "P12561", Digits()),
        ("itad", "P12570", Slug()),
        ("rawg", "P9968", Slug()),
        ("mobygames", "P11688", Digits()),
    ];

    public async Task<IReadOnlyList<WikidataIdentity>> LookupAsync(string keyKind, IReadOnlyList<string> keys, CancellationToken ct)
    {
        var query = BuildQuery(keyKind, keys);
        if (query is null) return [];
        var r = await transport.SendAsync(() =>
        {
            var req = new HttpRequestMessage(HttpMethod.Post, new Uri(Endpoint))
            {
                Content = new FormUrlEncodedContent([new("query", query), new("format", "json")]),
            };
            req.Headers.Accept.ParseAdd("application/sparql-results+json");
            return req;
        }, ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Wikidata answered with an unexpected status ({(int)r.Status}).");
        return Parse(r.Body, keys);
    }

    // ---------- Track U: Discover ----------

    /// <summary>
    /// Games whose name matches <paramref name="term"/>, through Wikidata's own entity search inside one SPARQL query
    /// (keyless, CC0). Only items that are a video game (Q7889) come back, with their release date and store IDs.
    /// </summary>
    public async Task<string> DiscoverSearchAsync(string term, CancellationToken ct)
    {
        var query = BuildDiscoverSearch(term);
        if (query is null) return """{"results":{"bindings":[]}}""";
        return await PostAsync(query, ct);
    }

    /// <summary>One item's facts (labels of genres, studios and platforms) and store IDs.</summary>
    public async Task<string?> DiscoverItemAsync(string qid, CancellationToken ct)
    {
        var query = BuildDiscoverItem(qid);
        return query is null ? null : await PostAsync(query, ct);
    }

    private async Task<string> PostAsync(string query, CancellationToken ct)
    {
        var r = await transport.SendAsync(() =>
        {
            var req = new HttpRequestMessage(HttpMethod.Post, new Uri(Endpoint))
            {
                Content = new FormUrlEncodedContent([new("query", query), new("format", "json")]),
            };
            req.Headers.Accept.ParseAdd("application/sparql-results+json");
            return req;
        }, ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Wikidata answered with an unexpected status ({(int)r.Status}).");
        return r.Body;
    }

    /// <summary>The search text as a safe SPARQL string literal body: no quotes, backslashes, braces or control characters.</summary>
    internal static string SparqlText(string term) =>
        new string(term.Trim().Where(c => !char.IsControl(c) && c is not ('"' or '\\' or '{' or '}' or '<' or '>')).Take(100).ToArray()).Trim();

    private static readonly (string Name, string Property)[] DiscoverIdProperties =
        [("steam", "P1733"), ("gogId", "P12727"), ("gog", "P2725"), ("epic", "P6278"), ("microsoft", "P5885"), ("igdb", "P5794"), ("rawg", "P9968")];

    internal static string? BuildDiscoverSearch(string term)
    {
        var t = SparqlText(term);
        if (t.Length < 2) return null;
        var sb = new StringBuilder("SELECT ?item (SAMPLE(?label) AS ?lbl) (MIN(?date) AS ?released) (MIN(?ord) AS ?rank)");
        foreach (var (name, _) in DiscoverIdProperties) sb.Append($" (SAMPLE(?{name}) AS ?v_{name})");
        sb.Append(" WHERE { SERVICE wikibase:mwapi { bd:serviceParam wikibase:endpoint \"www.wikidata.org\"; wikibase:api \"EntitySearch\"; ");
        sb.Append("mwapi:search \"").Append(t).Append("\"; mwapi:language \"en\"; mwapi:limit \"40\". ?item wikibase:apiOutputItem mwapi:item. ?ord wikibase:apiOrdinal true. } ");
        sb.Append("?item wdt:P31 wd:Q7889 . ");
        sb.Append("OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) IN (\"en\", \"mul\")) } OPTIONAL { ?item wdt:P577 ?date } ");
        foreach (var (name, prop) in DiscoverIdProperties) sb.Append($"OPTIONAL {{ ?item wdt:{prop} ?{name} }} ");
        sb.Append("} GROUP BY ?item ORDER BY ?rank LIMIT 25");
        return sb.ToString();
    }

    internal static string? BuildDiscoverItem(string qid)
    {
        if (!WikidataItem().IsMatch(qid)) return null;
        var sb = new StringBuilder("SELECT ?item (SAMPLE(?label) AS ?lbl) (SAMPLE(?d) AS ?desc) (MIN(?date) AS ?released)");
        sb.Append(" (GROUP_CONCAT(DISTINCT ?genreL; separator=\"|\") AS ?genres) (GROUP_CONCAT(DISTINCT ?devL; separator=\"|\") AS ?developers)");
        sb.Append(" (GROUP_CONCAT(DISTINCT ?pubL; separator=\"|\") AS ?publishers) (GROUP_CONCAT(DISTINCT ?platL; separator=\"|\") AS ?platforms)");
        foreach (var (name, _) in DiscoverIdProperties) sb.Append($" (SAMPLE(?{name}) AS ?v_{name})");
        sb.Append(" WHERE { VALUES ?item { wd:").Append(qid).Append(" } ");
        sb.Append("OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) IN (\"en\", \"mul\")) } ");
        sb.Append("OPTIONAL { ?item schema:description ?d FILTER(LANG(?d) = \"en\") } OPTIONAL { ?item wdt:P577 ?date } ");
        sb.Append("OPTIONAL { ?item wdt:P136 ?genre . ?genre rdfs:label ?genreL FILTER(LANG(?genreL) = \"en\") } ");
        sb.Append("OPTIONAL { ?item wdt:P178 ?dev . ?dev rdfs:label ?devL FILTER(LANG(?devL) IN (\"en\", \"mul\")) } ");
        sb.Append("OPTIONAL { ?item wdt:P123 ?pub . ?pub rdfs:label ?pubL FILTER(LANG(?pubL) IN (\"en\", \"mul\")) } ");
        sb.Append("OPTIONAL { ?item wdt:P400 ?plat . ?plat rdfs:label ?platL FILTER(LANG(?platL) = \"en\") } ");
        foreach (var (name, prop) in DiscoverIdProperties) sb.Append($"OPTIONAL {{ ?item wdt:{prop} ?{name} }} ");
        sb.Append("} GROUP BY ?item");
        return sb.ToString();
    }

    /// <summary>Builds one batched query; only well-formed numeric keys are included. Null when nothing is left to ask.</summary>
    internal static string? BuildQuery(string keyKind, IReadOnlyList<string> keys)
    {
        if (!KeyProperties.TryGetValue(keyKind, out var keyProp)) throw new ArgumentException("Unknown key kind.", nameof(keyKind));
        var values = keys.Where(k => Digits().IsMatch(k)).Distinct().Take(MaxBatch).ToList();
        if (values.Count == 0) return null;
        var sb = new StringBuilder();
        sb.Append("SELECT ?key ?item (SAMPLE(?label) AS ?lbl) (SAMPLE(?isGame) AS ?game)");
        foreach (var (name, _, _) in Properties) sb.Append($" (SAMPLE(?{name}) AS ?v_{name})");
        sb.Append(" WHERE { VALUES ?key { ");
        foreach (var v in values) sb.Append('"').Append(v).Append("\" ");
        sb.Append($"}} ?item wdt:{keyProp} ?key . ");
        sb.Append("OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) IN (\"en\", \"mul\")) } ");
        sb.Append("OPTIONAL { ?item wdt:P31 wd:Q7889 . BIND(1 AS ?isGame) } ");
        foreach (var (name, prop, _) in Properties) sb.Append($"OPTIONAL {{ ?item wdt:{prop} ?{name} }} ");
        sb.Append("} GROUP BY ?key ?item");
        return sb.ToString();
    }

    /// <summary>
    /// One identity per requested key: when several items share a key (editions, remasters), the
    /// one that is a "video game" (Q7889) with the most identifiers wins. Keys without an item are
    /// returned with no item so the absence can be cached too.
    /// </summary>
    internal static IReadOnlyList<WikidataIdentity> Parse(string json, IReadOnlyList<string> requested)
    {
        using var doc = JsonRead.Parse(json, "Wikidata");
        var bindings = JsonRead.Obj(doc.RootElement, "results") is { } results ? JsonRead.Arr(results, "bindings").ToList() : null;
        if (bindings is null) throw new DataSourceException(DataSourceOutcome.Malformed, "Wikidata’s answer couldn’t be read.");
        var wanted = requested.Where(k => Digits().IsMatch(k)).ToHashSet(StringComparer.Ordinal);
        var best = new Dictionary<string, (WikidataIdentity Identity, int Score)>(StringComparer.Ordinal);
        foreach (var b in bindings)
        {
            var key = Value(b, "key");
            var item = Value(b, "item") is { } uri && ItemUri().Match(uri) is { Success: true } m ? m.Groups[1].Value : null;
            if (key is null || !wanted.Contains(key) || item is null) continue;
            var ids = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var (name, _, pattern) in Properties)
                if (Value(b, "v_" + name) is { Length: <= 120 } v && pattern.IsMatch(v)) ids[name] = name == "microsoft" ? v.ToLowerInvariant() : v;
            var label = Value(b, "lbl") is { } l ? Vystral.Windows.Services.MetadataService.Clean(l, 200) : null;
            var score = (Value(b, "game") is not null ? 100 : 0) + ids.Count;
            if (!best.TryGetValue(key, out var current) || score > current.Score)
                best[key] = (new WikidataIdentity(key, item, string.IsNullOrEmpty(label) ? null : label, ids), score);
        }
        return wanted.Select(k => best.TryGetValue(k, out var x) ? x.Identity : new WikidataIdentity(k, null, null, new Dictionary<string, string>())).ToList();
    }

    /// <summary>A public page for an identifier, built only from validated values. Null for unknown names.</summary>
    public static string? PageUrl(string name, string value)
    {
        var p = Properties.FirstOrDefault(x => x.Name == name);
        if (name == "wikidata") return WikidataItem().IsMatch(value) ? $"https://www.wikidata.org/wiki/{value}" : null;
        if (p.Name is null || !p.Pattern.IsMatch(value)) return null;
        return name switch
        {
            "steam" => $"https://store.steampowered.com/app/{value}/",
            "gog" => $"https://www.gog.com/en/{value}",
            "epic" => $"https://store.epicgames.com/p/{value}",
            "microsoft" => $"https://apps.microsoft.com/detail/{value.ToUpperInvariant()}",
            "igdb" => $"https://www.igdb.com/games/{value}",
            "pcgamingwiki" => $"https://www.pcgamingwiki.com/wiki/{Uri.EscapeDataString(value)}",
            "hltb" => $"https://howlongtobeat.com/game/{value}",
            "steamgriddb" => $"https://www.steamgriddb.com/game/{value}",
            "itad" => $"https://isthereanydeal.com/game/{value}/info/",
            "rawg" => $"https://rawg.io/games/{value}",
            "mobygames" => $"https://www.mobygames.com/game/{value}/",
            _ => null,
        };
    }

    private static string? Value(JsonElement binding, string name) =>
        JsonRead.Obj(binding, name) is { } o && o.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    [GeneratedRegex(@"\A[0-9]{1,12}\z")]
    private static partial Regex Digits();

    [GeneratedRegex(@"\Agame/[a-z0-9_]{1,100}\z")]
    private static partial Regex GogPath();

    [GeneratedRegex(@"\A[a-z0-9][a-z0-9\-]{0,119}\z")]
    private static partial Regex Slug();

    [GeneratedRegex(@"\A[0-9A-Za-z]{12}\z")]
    private static partial Regex MsBigId();

    [GeneratedRegex(@"\A[\p{L}\p{N}_\-:().,'!&+]{1,120}\z")]
    private static partial Regex WikiTitle();

    [GeneratedRegex(@"\Ahttp://www\.wikidata\.org/entity/(Q[0-9]{1,12})\z")]
    private static partial Regex ItemUri();

    [GeneratedRegex(@"\AQ[0-9]{1,12}\z")]
    private static partial Regex WikidataItem();
}
