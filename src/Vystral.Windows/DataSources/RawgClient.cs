using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Matching;

namespace Vystral.Windows.DataSources;

public sealed record RawgHit(long Id, string Slug, string Name, int? ReleaseYear);

/// <summary>
/// The parts of a RAWG game VYSTRAL keeps. RAWG's Metacritic number is deliberately not read:
/// it is Metacritic's data, not RAWG's, and VYSTRAL already shows Steam's licensed Metacritic link.
/// </summary>
public sealed record RawgGame(long Id, string Slug, string Name, string Url, string? Description, string? Released, int? ReleaseYear,
    IReadOnlyList<string> Genres, IReadOnlyList<string> Developers, IReadOnlyList<string> Publishers,
    double? Rating, int RatingsCount, int? AveragePlaytimeHours, string? Esrb);

/// <summary>RAWG (api.rawg.io) with the user's own key. RAWG requires an active link back on every page that shows its data.</summary>
public sealed partial class RawgClient(ProviderTransport transport, Func<string?> apiKey)
{
    public const string Base = "https://api.rawg.io/api/";
    public const int SteamStoreId = 1;

    public async Task<int> TestAsync(CancellationToken ct, string? keyOverride = null)
    {
        using var doc = JsonRead.Parse(await GetAsync("games?page_size=1", ct, keyOverride), "RAWG");
        return (int)Math.Clamp(JsonRead.Long(doc.RootElement, "count") ?? 0, 0, int.MaxValue);
    }

    public async Task<IReadOnlyList<RawgHit>> SearchAsync(string title, CancellationToken ct)
    {
        var t = title.Trim();
        if (t.Length is 0 or > 150) return [];
        return ParseSearch(await GetAsync($"games?search={Uri.EscapeDataString(t)}&search_precise=true&page_size=10", ct));
    }

    public async Task<RawgGame?> GetGameAsync(string idOrSlug, CancellationToken ct)
    {
        if (!SlugOrId().IsMatch(idOrSlug)) return null;
        try { return ParseGame(await GetAsync($"games/{idOrSlug}", ct)); }
        catch (DataSourceException ex) when (ex.Message == NotFound) { return null; }
    }

    /// <summary>True when RAWG lists this game on Steam under exactly <paramref name="appId"/>.</summary>
    public async Task<bool> HasSteamAppAsync(long rawgId, string appId, CancellationToken ct)
    {
        try { return ParseStoresHasSteamApp(await GetAsync($"games/{rawgId.ToString(CultureInfo.InvariantCulture)}/stores", ct), appId); }
        catch (DataSourceException ex) when (ex.Message == NotFound) { return false; }
    }

    private const string NotFound = "RAWG has no entry for this game.";

    private async Task<string> GetAsync(string pathAndQuery, CancellationToken ct, string? keyOverride = null)
    {
        var key = keyOverride ?? apiKey() ?? throw new DataSourceException(DataSourceOutcome.NotConfigured, "Add your RAWG API key in Settings → Data sources first.");
        var sep = pathAndQuery.Contains('?') ? '&' : '?';
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri($"{Base}{pathAndQuery}{sep}key={Uri.EscapeDataString(key)}")), ct);
        if (r.Status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new DataSourceException(DataSourceOutcome.InvalidKey, "RAWG didn’t accept this API key. Copy it again from rawg.io/apidocs.");
        if (r.Status == HttpStatusCode.NotFound) throw new DataSourceException(DataSourceOutcome.Malformed, NotFound);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"RAWG answered with an unexpected status ({(int)r.Status}).");
        return r.Body;
    }

    // ---------- Parsing (pure, unit-tested) ----------

    internal static IReadOnlyList<RawgHit> ParseSearch(string json)
    {
        using var doc = JsonRead.Parse(json, "RAWG");
        return JsonRead.Arr(doc.RootElement, "results").Select(e =>
        {
            var id = JsonRead.Long(e, "id");
            var slug = JsonRead.Str(e, "slug", 120);
            var name = JsonRead.Str(e, "name", 200);
            return id > 0 && slug is not null && SlugOrId().IsMatch(slug) && name is not null ? new RawgHit(id.Value, slug, name, Year(JsonRead.Str(e, "released", 20))) : null;
        }).OfType<RawgHit>().ToList();
    }

    internal static RawgGame? ParseGame(string json)
    {
        using var doc = JsonRead.Parse(json, "RAWG");
        var g = doc.RootElement;
        var id = JsonRead.Long(g, "id");
        var slug = JsonRead.Str(g, "slug", 120);
        var name = JsonRead.Str(g, "name", 200);
        if (id is not > 0 || slug is null || !SlugOrId().IsMatch(slug) || name is null) return null;
        var released = JsonRead.Str(g, "released", 20);
        if (released is not null && !DateOnly.TryParseExact(released, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) released = null;
        var rating = JsonRead.Num(g, "rating");
        var playtime = JsonRead.Long(g, "playtime");
        return new RawgGame(id.Value, slug, name, $"https://rawg.io/games/{slug}",
            JsonRead.Str(g, "description_raw", 2000) ?? JsonRead.Str(g, "description", 2000), released, Year(released),
            JsonRead.Names(g, "genres"), JsonRead.Names(g, "developers", 4), JsonRead.Names(g, "publishers", 4),
            rating is > 0 and <= 5 ? Math.Round(rating.Value, 2) : null, (int)Math.Clamp(JsonRead.Long(g, "ratings_count") ?? 0, 0, 10_000_000),
            playtime is > 0 and < 10000 ? (int)playtime : null,
            JsonRead.Obj(g, "esrb_rating") is { } esrb ? JsonRead.Str(esrb, "name", 40) : null);
    }

    internal static bool ParseStoresHasSteamApp(string json, string appId)
    {
        using var doc = JsonRead.Parse(json, "RAWG");
        foreach (var s in JsonRead.Arr(doc.RootElement, "results"))
        {
            if (JsonRead.Long(s, "store_id") != SteamStoreId) continue;
            var url = s.TryGetProperty("url", out var u) && u.ValueKind == System.Text.Json.JsonValueKind.String ? u.GetString() : null;
            if (JsonRead.SafeUrl(url, "steampowered.com") is { } safe && SteamAppInUrl().Match(safe) is { Success: true } m && m.Groups[1].Value == appId) return true;
        }
        return false;
    }

    /// <summary>Exact normalized title, unique among results; a known year must agree within one year.</summary>
    public static (RawgHit Hit, double Confidence)? PickExactTitle(string title, int? year, IReadOnlyList<RawgHit> hits)
    {
        var target = TitleNormalizer.Normalize(title).Full;
        var exact = hits.Where(h => TitleNormalizer.Normalize(h.Name).Full == target).ToList();
        if (exact.Count != 1) return null;
        if (year is { } y && exact[0].ReleaseYear is { } hy) return Math.Abs(y - hy) <= 1 ? (exact[0], 0.85) : null;
        return (exact[0], 0.75);
    }

    private static int? Year(string? date) => date is { Length: >= 4 } && int.TryParse(date[..4], NumberStyles.None, CultureInfo.InvariantCulture, out var y) && y is > 1950 and < 2200 ? y : null;

    [GeneratedRegex(@"\A[a-z0-9][a-z0-9\-]{0,119}\z")]
    private static partial Regex SlugOrId();

    [GeneratedRegex(@"store\.steampowered\.com/app/([0-9]{1,10})(?:/|\z|\?)")]
    private static partial Regex SteamAppInUrl();
}
