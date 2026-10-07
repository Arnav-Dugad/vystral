using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Vystral.Core.Matching;

namespace Vystral.Windows.DataSources;

public sealed record TimeToBeat(long? HastilySeconds, long? NormallySeconds, long? CompletelySeconds, int Count);

public sealed record IgdbGame(
    long Id, string Name, string? Slug, string? Url, string? Summary, IReadOnlyList<string> Genres, IReadOnlyList<string> Themes,
    IReadOnlyList<string> GameModes, IReadOnlyList<string> Perspectives, string? ReleaseDate, int? ReleaseYear,
    IReadOnlyList<string> Developers, IReadOnlyList<string> Publishers, double? AggregatedRating, int AggregatedRatingCount,
    double? TotalRating, int TotalRatingCount, IReadOnlyList<string> Franchises, IReadOnlyList<string> Series, IReadOnlyList<string> Similar);

public sealed record IgdbSearchHit(long Id, string Name, int? ReleaseYear);

/// <summary>
/// IGDB (api.igdb.com/v4) with the user's own Twitch application. The client-credentials token is
/// requested from id.twitch.tv with a form body (the secret never goes in a URL) and kept in memory
/// only, until shortly before it expires. Requests are spaced to stay under IGDB's 4 per second.
/// </summary>
public sealed class IgdbClient(ProviderTransport transport, Func<(string ClientId, string Secret)?> credentials)
{
    public const string TokenUrl = "https://id.twitch.tv/oauth2/token";
    public const string ApiBase = "https://api.igdb.com/v4/";
    /// <summary>IGDB's external_game_source id for Steam.</summary>
    public const int SteamSource = 1;

    private string? _token;
    private string? _tokenFor;
    private DateTimeOffset _tokenExpires;

    /// <summary>Test hook for the clock.</summary>
    internal Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

    public bool HasToken => _token is not null && _tokenExpires > Now();

    public void ForgetToken()
    {
        _token = null;
        _tokenFor = null;
    }

    /// <summary>Gets a token and runs one tiny query, proving both the credentials and the API work.</summary>
    public async Task TestAsync(CancellationToken ct, (string ClientId, string Secret)? overrideCreds = null)
    {
        await QueryAsync("games", "fields id; limit 1;", ct, overrideCreds);
    }

    public async Task<long?> FindBySteamAppIdAsync(string appId, CancellationToken ct)
    {
        if (appId.Length is 0 or > 10 || !appId.All(char.IsAsciiDigit)) return null;
        var body = await QueryAsync("external_games", $"fields game,uid; where external_game_source = {SteamSource} & uid = \"{appId}\"; limit 5;", ct);
        return ParseExternalGame(body, appId);
    }

    public async Task<long?> FindBySlugAsync(string slug, CancellationToken ct)
    {
        if (slug.Length is 0 or > 120 || !slug.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-')) return null;
        var body = await QueryAsync("games", $"fields id; where slug = \"{slug}\"; limit 2;", ct);
        using var doc = JsonRead.Parse(body, "IGDB");
        var ids = doc.RootElement.ValueKind == JsonValueKind.Array
            ? doc.RootElement.EnumerateArray().Select(e => JsonRead.Long(e, "id")).Where(i => i > 0).ToList() : [];
        return ids.Count == 1 ? ids[0] : null;
    }

    public async Task<IReadOnlyList<IgdbSearchHit>> SearchAsync(string title, CancellationToken ct)
    {
        var t = EscapeApicalypse(title);
        if (t.Length is 0 or > 150) return [];
        return ParseSearch(await QueryAsync("games", $"search \"{t}\"; fields id,name,first_release_date; limit 10;", ct));
    }

    public async Task<IgdbGame?> GetGameAsync(long id, CancellationToken ct)
    {
        const string fields = "fields name,slug,url,summary,genres.name,themes.name,game_modes.name,player_perspectives.name,first_release_date," +
                              "involved_companies.company.name,involved_companies.developer,involved_companies.publisher," +
                              "aggregated_rating,aggregated_rating_count,total_rating,total_rating_count,franchises.name,collections.name,similar_games.name;";
        return ParseGame(await QueryAsync("games", $"{fields} where id = {id.ToString(CultureInfo.InvariantCulture)};", ct));
    }

    public async Task<TimeToBeat?> GetTimeToBeatAsync(long id, CancellationToken ct)
    {
        try
        {
            return ParseTimeToBeat(await QueryAsync("game_time_to_beats",
                $"fields game_id,hastily,normally,completely,count; where game_id = {id.ToString(CultureInfo.InvariantCulture)};", ct));
        }
        catch (DataSourceException ex) when (ex.Outcome == DataSourceOutcome.Malformed)
        {
            return null; // optional data
        }
    }

    // ---------- Track U: Discover (any game, owned or not) ----------

    public const int DiscoverPageSize = 20;

    private const string DiscoverSearchFields =
        "fields name,slug,first_release_date,cover.image_id,platforms.name,platforms.abbreviation,genres.name," +
        "external_games.uid,external_games.external_game_source,total_rating_count,game_type;";

    private const string DiscoverGameFields =
        "fields name,slug,summary,first_release_date,cover.image_id,artworks.image_id,screenshots.image_id,platforms.name,platforms.abbreviation," +
        "genres.name,external_games.uid,external_games.external_game_source,involved_companies.company.name,involved_companies.developer," +
        "involved_companies.publisher,total_rating,total_rating_count,game_type;";

    /// <summary>One page of a title search with the fields Discover lists. Returns IGDB's raw answer (see DiscoverParsers).</summary>
    public async Task<string> DiscoverSearchAsync(string term, int page, CancellationToken ct)
    {
        var t = EscapeApicalypse(term);
        if (t.Length is 0 or > 100) return "[]";
        var offset = Math.Clamp(page, 0, 9) * DiscoverPageSize;
        return await QueryAsync("games", $"search \"{t}\"; {DiscoverSearchFields} limit {DiscoverPageSize}; offset {offset.ToString(CultureInfo.InvariantCulture)};", ct);
    }

    /// <summary>One game with the fields Discover's page shows. Returns IGDB's raw answer.</summary>
    public async Task<string> DiscoverGameAsync(long id, CancellationToken ct) =>
        await QueryAsync("games", $"{DiscoverGameFields} where id = {id.ToString(CultureInfo.InvariantCulture)};", ct);

    /// <summary>One game by its slug (Wikidata stores IGDB slugs). Returns IGDB's raw answer.</summary>
    public async Task<string> DiscoverGameBySlugAsync(string slug, CancellationToken ct)
    {
        if (slug.Length is 0 or > 120 || !slug.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-')) return "[]";
        return await QueryAsync("games", $"{DiscoverGameFields} where slug = \"{slug}\"; limit 2;", ct);
    }

    // ---------- Transport ----------

    private async Task<string> QueryAsync(string endpoint, string body, CancellationToken ct, (string ClientId, string Secret)? overrideCreds = null)
    {
        var creds = overrideCreds ?? credentials()
                    ?? throw new DataSourceException(DataSourceOutcome.NotConfigured, "Add your Twitch client ID and secret in Settings → Data sources first.");
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var token = await GetTokenAsync(creds, ct, force: attempt > 0);
            var r = await transport.SendAsync(() =>
            {
                var req = new HttpRequestMessage(HttpMethod.Post, new Uri(ApiBase + endpoint)) { Content = new StringContent(body, Encoding.UTF8, "text/plain") };
                req.Headers.Add("Client-ID", creds.ClientId);
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                return req;
            }, ct);
            if (r.Status == HttpStatusCode.Unauthorized && attempt == 0) continue; // token revoked or expired early: get a new one once
            if (r.Status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                throw new DataSourceException(DataSourceOutcome.InvalidKey, "IGDB didn’t accept your Twitch application. Check the client ID and secret.");
            if (r.Status != HttpStatusCode.OK)
                throw new DataSourceException(DataSourceOutcome.Malformed, $"IGDB answered with an unexpected status ({(int)r.Status}).");
            return r.Body;
        }
        throw new DataSourceException(DataSourceOutcome.InvalidKey, "IGDB didn’t accept your Twitch application.");
    }

    private async Task<string> GetTokenAsync((string ClientId, string Secret) creds, CancellationToken ct, bool force)
    {
        if (!force && _token is not null && _tokenFor == creds.ClientId && _tokenExpires > Now()) return _token;
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Post, new Uri(TokenUrl))
        {
            Content = new FormUrlEncodedContent([
                new("client_id", creds.ClientId),
                new("client_secret", creds.Secret),
                new("grant_type", "client_credentials"),
            ]),
        }, ct);
        if (r.Status is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new DataSourceException(DataSourceOutcome.InvalidKey, "Twitch didn’t accept this client ID and secret. Copy them again from your application at dev.twitch.tv/console.");
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Twitch answered with an unexpected status ({(int)r.Status}).");
        var (token, lifetime) = ParseToken(r.Body);
        _token = token;
        _tokenFor = creds.ClientId;
        _tokenExpires = Now() + lifetime - TimeSpan.FromMinutes(5);
        return token;
    }

    // ---------- Parsing (pure, unit-tested) ----------

    internal static (string Token, TimeSpan Lifetime) ParseToken(string json)
    {
        using var doc = JsonRead.Parse(json, "Twitch");
        var token = doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("access_token", out var t) && t.ValueKind == JsonValueKind.String
            ? t.GetString() : null;
        if (token is null || token.Length is < 10 or > 200 || !token.All(char.IsAsciiLetterOrDigit))
            throw new DataSourceException(DataSourceOutcome.Malformed, "Twitch’s token answer couldn’t be read.");
        var seconds = JsonRead.Long(doc.RootElement, "expires_in") ?? 3600;
        return (token, TimeSpan.FromSeconds(Math.Clamp(seconds, 600, 90L * 24 * 3600)));
    }

    internal static long? ParseExternalGame(string json, string appId)
    {
        using var doc = JsonRead.Parse(json, "IGDB");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
        var games = doc.RootElement.EnumerateArray()
            .Where(e => JsonRead.Str(e, "uid", 20) == appId)
            .Select(e => JsonRead.Long(e, "game")).Where(g => g > 0).Distinct().ToList();
        return games.Count == 1 ? games[0] : null;
    }

    internal static IReadOnlyList<IgdbSearchHit> ParseSearch(string json)
    {
        using var doc = JsonRead.Parse(json, "IGDB");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return [];
        return doc.RootElement.EnumerateArray().Select(e =>
        {
            var id = JsonRead.Long(e, "id");
            var name = JsonRead.Str(e, "name", 200);
            return id > 0 && name is not null ? new IgdbSearchHit(id.Value, name, Year(JsonRead.Long(e, "first_release_date"))) : null;
        }).OfType<IgdbSearchHit>().ToList();
    }

    internal static IgdbGame? ParseGame(string json)
    {
        using var doc = JsonRead.Parse(json, "IGDB");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
        var g = doc.RootElement.EnumerateArray().FirstOrDefault();
        var id = JsonRead.Long(g, "id");
        var name = JsonRead.Str(g, "name", 200);
        if (id is not > 0 || name is null) return null;
        var developers = new List<string>();
        var publishers = new List<string>();
        foreach (var ic in JsonRead.Arr(g, "involved_companies"))
        {
            var company = JsonRead.Obj(ic, "company") is { } c ? JsonRead.Str(c, "name", 120) : null;
            if (company is null) continue;
            if (JsonRead.Bool(ic, "developer") && !developers.Contains(company)) developers.Add(company);
            if (JsonRead.Bool(ic, "publisher") && !publishers.Contains(company)) publishers.Add(company);
        }
        var released = JsonRead.Long(g, "first_release_date");
        return new IgdbGame(
            id.Value, name, JsonRead.Str(g, "slug", 120), JsonRead.SafeUrl(JsonRead.Str(g, "url", 300), "igdb.com"),
            JsonRead.Str(g, "summary", 2000), JsonRead.Names(g, "genres"), JsonRead.Names(g, "themes"), JsonRead.Names(g, "game_modes"),
            JsonRead.Names(g, "player_perspectives"),
            released is > 0 and < 4102444800 ? DateTimeOffset.FromUnixTimeSeconds(released.Value).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null,
            Year(released), developers.Take(4).ToList(), publishers.Take(4).ToList(),
            Rating(JsonRead.Num(g, "aggregated_rating")), Count(JsonRead.Long(g, "aggregated_rating_count")),
            Rating(JsonRead.Num(g, "total_rating")), Count(JsonRead.Long(g, "total_rating_count")),
            JsonRead.Names(g, "franchises", 4), JsonRead.Names(g, "collections", 4), JsonRead.Names(g, "similar_games", 10));
    }

    internal static TimeToBeat? ParseTimeToBeat(string json)
    {
        using var doc = JsonRead.Parse(json, "IGDB");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
        var e = doc.RootElement.EnumerateArray().FirstOrDefault();
        if (e.ValueKind != JsonValueKind.Object) return null;
        static long? Secs(long? v) => v is > 0 and < 36_000_000 ? v : null; // under 10,000 hours
        var t = new TimeToBeat(Secs(JsonRead.Long(e, "hastily")), Secs(JsonRead.Long(e, "normally")), Secs(JsonRead.Long(e, "completely")),
            Count(JsonRead.Long(e, "count")));
        return t.HastilySeconds is null && t.NormallySeconds is null && t.CompletelySeconds is null ? null : t;
    }

    /// <summary>
    /// Title fallback: only an IGDB result whose normalized title equals ours and that is the only
    /// such result. With a known release year on both sides it must match within one year
    /// (confidence 0.85); without one, 0.75. Anything else is not a match.
    /// </summary>
    public static (long Id, double Confidence)? PickExactTitle(string title, int? year, IReadOnlyList<IgdbSearchHit> hits)
    {
        var target = TitleNormalizer.Normalize(title).Full;
        var exact = hits.Where(h => TitleNormalizer.Normalize(h.Name).Full == target).ToList();
        if (exact.Count != 1) return null;
        var hit = exact[0];
        if (year is { } y && hit.ReleaseYear is { } hy) return Math.Abs(y - hy) <= 1 ? (hit.Id, 0.85) : null;
        return (hit.Id, 0.75);
    }

    internal static string EscapeApicalypse(string s) =>
        new string(s.Trim().Where(c => !char.IsControl(c) && c is not ('"' or '\\' or ';')).ToArray());

    private static int? Year(long? unix) => unix is > 0 and < 4102444800 ? DateTimeOffset.FromUnixTimeSeconds(unix.Value).Year : null;
    private static double? Rating(double? v) => v is >= 0 and <= 100 ? Math.Round(v.Value, 1) : null;
    private static int Count(long? v) => (int)Math.Clamp(v ?? 0, 0, 10_000_000);
}
