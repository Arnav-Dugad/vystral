using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Vystral.Core.Domain;
using Vystral.Core.Matching;

namespace Vystral.Windows.DataSources;

public sealed record SgdbGame(long Id, string Name, int? ReleaseYear);

public sealed record SgdbImage(long Id, string Url, string Thumb, int Width, int Height, string? Style, string? Mime, string? Author, int Score);

/// <summary>Filters for the art picker. Unknown styles are dropped; animated art is off unless asked for.</summary>
public sealed record SgdbFilter(IReadOnlyList<string> Styles, bool Animated, int Page);

/// <summary>
/// SteamGridDB API v2 (https://www.steamgriddb.com/api/v2) with the user's own key (Bearer).
/// Only safe-for-work, non-humor, non-epilepsy-warning art is requested. Image URLs are accepted
/// only on HTTPS steamgriddb.com hosts.
/// </summary>
public sealed class SteamGridDbClient(ProviderTransport transport, Func<string?> apiKey)
{
    public const string Base = "https://www.steamgriddb.com/api/v2/";

    public static readonly IReadOnlyDictionary<ArtworkKind, string[]> Styles = new Dictionary<ArtworkKind, string[]>
    {
        [ArtworkKind.Cover] = ["alternate", "blurred", "white_logo", "material", "no_logo"],
        [ArtworkKind.Hero] = ["alternate", "blurred", "material"],
        [ArtworkKind.Logo] = ["official", "white", "black", "custom"],
        [ArtworkKind.Icon] = ["official", "custom"],
    };

    public static bool Supports(ArtworkKind kind) => Styles.ContainsKey(kind);

    /// <summary>One cheap request that proves the key works.</summary>
    public async Task<int> TestAsync(CancellationToken ct, string? keyOverride = null)
    {
        var body = await GetAsync("search/autocomplete/portal", ct, keyOverride);
        return ParseGames(body).Count;
    }

    public async Task<SgdbGame?> GetGameBySteamAppIdAsync(string appId, CancellationToken ct)
    {
        try
        {
            var body = await GetAsync($"games/steam/{RequireDigits(appId)}", ct);
            using var doc = JsonRead.Parse(body, "SteamGridDB");
            return doc.RootElement.TryGetProperty("data", out var d) ? ParseGame(d) : null;
        }
        catch (DataSourceException ex) when (ex.Message == NotFoundMessage) { return null; }
    }

    public async Task<IReadOnlyList<SgdbGame>> SearchAsync(string term, CancellationToken ct)
    {
        var t = term.Trim();
        if (t.Length is 0 or > 120) return [];
        return ParseGames(await GetAsync($"search/autocomplete/{Uri.EscapeDataString(t)}", ct));
    }

    public async Task<IReadOnlyList<SgdbImage>> GetImagesAsync(ArtworkKind kind, long gameId, SgdbFilter filter, CancellationToken ct)
    {
        try { return ParseImages(await GetAsync(BuildImagePath(kind, gameId, filter), ct)); }
        catch (DataSourceException ex) when (ex.Message == NotFoundMessage) { return []; }
    }

    internal static string BuildImagePath(ArtworkKind kind, long gameId, SgdbFilter filter)
    {
        if (!Styles.TryGetValue(kind, out var allowed)) throw new ArgumentException("Unsupported artwork kind.", nameof(kind));
        var segment = kind switch
        {
            ArtworkKind.Cover => "grids",
            ArtworkKind.Hero => "heroes",
            ArtworkKind.Logo => "logos",
            _ => "icons",
        };
        var q = new List<string>();
        if (kind == ArtworkKind.Cover) q.Add("dimensions=600x900,342x482,660x930");
        var styles = filter.Styles.Where(allowed.Contains).Distinct().ToList();
        if (styles.Count > 0) q.Add("styles=" + string.Join(',', styles));
        q.Add("mimes=" + (kind switch
        {
            ArtworkKind.Logo => "image/png,image/webp",
            ArtworkKind.Icon => "image/png",
            _ => "image/png,image/jpeg,image/webp",
        }));
        q.Add("types=" + (filter.Animated ? "static,animated" : "static"));
        q.Add("nsfw=false");
        q.Add("humor=false");
        q.Add("epilepsy=false");
        if (filter.Page > 0) q.Add("page=" + Math.Clamp(filter.Page, 0, 50).ToString(CultureInfo.InvariantCulture));
        return $"{segment}/game/{gameId.ToString(CultureInfo.InvariantCulture)}?{string.Join('&', q)}";
    }

    /// <summary>The single search result whose normalized title equals <paramref name="title"/>; null when none or ambiguous.</summary>
    public static SgdbGame? PickExact(string title, IReadOnlyList<SgdbGame> results)
    {
        var target = TitleNormalizer.Normalize(title).Full;
        var matches = results.Where(g => TitleNormalizer.Normalize(g.Name).Full == target).ToList();
        return matches.Count == 1 ? matches[0] : null;
    }

    private const string NotFoundMessage = "SteamGridDB has no entry for this game.";

    private async Task<string> GetAsync(string pathAndQuery, CancellationToken ct, string? keyOverride = null)
    {
        var key = keyOverride ?? apiKey() ?? throw new DataSourceException(DataSourceOutcome.NotConfigured, "Add your SteamGridDB API key in Settings → Data sources first.");
        var r = await transport.SendAsync(() =>
        {
            var req = new HttpRequestMessage(HttpMethod.Get, new Uri(Base + pathAndQuery));
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            return req;
        }, ct);
        if (r.Status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new DataSourceException(DataSourceOutcome.InvalidKey, "SteamGridDB didn’t accept this API key. Copy it again from your SteamGridDB preferences (API tab).");
        if (r.Status == HttpStatusCode.NotFound) throw new DataSourceException(DataSourceOutcome.Malformed, NotFoundMessage);
        if (r.Status != HttpStatusCode.OK)
            throw new DataSourceException(DataSourceOutcome.Malformed, $"SteamGridDB answered with an unexpected status ({(int)r.Status}).");
        return r.Body;
    }

    // ---------- Parsing (pure, unit-tested) ----------

    internal static IReadOnlyList<SgdbGame> ParseGames(string json)
    {
        using var doc = JsonRead.Parse(json, "SteamGridDB");
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !JsonRead.Bool(root, "success"))
            throw new DataSourceException(DataSourceOutcome.Malformed, "SteamGridDB’s answer couldn’t be read.");
        return JsonRead.Arr(root, "data").Select(ParseGame).OfType<SgdbGame>().Take(20).ToList();
    }

    internal static SgdbGame? ParseGame(JsonElement g)
    {
        var id = JsonRead.Long(g, "id");
        var name = JsonRead.Str(g, "name", 200);
        if (id is not > 0 || name is null) return null;
        int? year = JsonRead.Long(g, "release_date") is { } ts and > 0 and < 4102444800 ? DateTimeOffset.FromUnixTimeSeconds(ts).Year : null;
        return new SgdbGame(id.Value, name, year);
    }

    internal static IReadOnlyList<SgdbImage> ParseImages(string json)
    {
        using var doc = JsonRead.Parse(json, "SteamGridDB");
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !JsonRead.Bool(root, "success"))
            throw new DataSourceException(DataSourceOutcome.Malformed, "SteamGridDB’s answer couldn’t be read.");
        var result = new List<SgdbImage>();
        foreach (var i in JsonRead.Arr(root, "data"))
        {
            // Belt and braces: the request already excludes these.
            if (JsonRead.Bool(i, "nsfw") || JsonRead.Bool(i, "humor") || JsonRead.Bool(i, "epilepsy")) continue;
            var id = JsonRead.Long(i, "id");
            var url = JsonRead.SafeUrl(i.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() : null, "steamgriddb.com");
            var thumb = JsonRead.SafeUrl(i.TryGetProperty("thumb", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null, "steamgriddb.com");
            if (id is not > 0 || url is null) continue;
            var width = (int)Math.Clamp(JsonRead.Long(i, "width") ?? 0, 0, 20000);
            var height = (int)Math.Clamp(JsonRead.Long(i, "height") ?? 0, 0, 20000);
            var style = i.TryGetProperty("style", out var s)
                ? s.ValueKind == JsonValueKind.String ? s.GetString() : s.ValueKind == JsonValueKind.Array ? s.EnumerateArray().FirstOrDefault().ToString() : null
                : null;
            style = style is { Length: > 0 and <= 24 } && style.All(c => char.IsAsciiLetterLower(c) || c == '_') ? style : null;
            var mime = JsonRead.Str(i, "mime", 40);
            var author = JsonRead.Obj(i, "author") is { } a ? JsonRead.Str(a, "name", 60) : null;
            var score = (int)Math.Clamp(JsonRead.Long(i, "score") ?? 0, -100000, 100000);
            result.Add(new SgdbImage(id.Value, url, thumb ?? url, width, height, style, mime, author, score));
            if (result.Count >= 60) break;
        }
        return result;
    }

    private static string RequireDigits(string s) =>
        s.Length is > 0 and <= 10 && s.All(char.IsAsciiDigit) ? s : throw new ArgumentException("Invalid ID.", nameof(s));
}
