using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Files;

namespace Vystral.Windows.DataSources;

/// <summary>
/// Track X: PCGamingWiki's documented public APIs (CC BY-NC-SA 3.0 content, credited wherever it's shown and never shipped
/// with VYSTRAL). A Steam app id is matched to its article with the Cargo API (<c>action=cargoquery</c> on
/// <c>Infobox_game.Steam_AppID</c>); when the wiki refuses anonymous Cargo queries, with its documented
/// <c>/api/appid.php</c> redirect instead (read from the Location header; the redirect is never followed). The article's
/// wikitext then comes from MediaWiki's <c>action=parse</c>. One polite lane, size-capped answers, no cookies or keys.
/// </summary>
public sealed partial class PcGamingWikiClient(ProviderTransport transport)
{
    public const string Host = "www.pcgamingwiki.com";
    public const string Api = "https://www.pcgamingwiki.com/w/api.php";
    private DateTime _cargoDeniedUntil = DateTime.MinValue;

    /// <summary>The article title for a Steam app id, or null when the wiki has none.</summary>
    public async Task<string?> FindBySteamAppIdAsync(string appId, CancellationToken ct)
    {
        if (!AppId().IsMatch(appId)) return null;
        if (_cargoDeniedUntil < DateTime.UtcNow)
        {
            var url = $"{Api}?action=cargoquery&tables=Infobox_game&fields=Infobox_game._pageName%3DPage&where=Infobox_game.Steam_AppID%20HOLDS%20%22{appId}%22&limit=2&format=json";
            var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri(url)), ct);
            if (r.Status == HttpStatusCode.OK)
            {
                var (page, denied) = ParseCargo(r.Body);
                if (!denied) return page;
                _cargoDeniedUntil = DateTime.UtcNow.AddHours(24); // ask Cargo again tomorrow
            }
        }
        var lookup = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri($"https://{Host}/api/appid.php?appid={appId}")), ct);
        if ((int)lookup.Status is >= 300 and < 400) return TitleFromRedirect(lookup.Location);
        if (lookup.Status == HttpStatusCode.NotFound) return null;
        throw new DataSourceException(DataSourceOutcome.Malformed, $"PCGamingWiki answered with an unexpected status ({(int)lookup.Status}).");
    }

    /// <summary>An article's wikitext (the API follows wiki redirects itself).</summary>
    public async Task<(string Title, string Wikitext)?> WikitextAsync(string title, CancellationToken ct)
    {
        if (!IsTitle(title)) return null;
        var url = $"{Api}?action=parse&page={Uri.EscapeDataString(title)}&prop=wikitext&redirects=1&format=json&formatversion=2";
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri(url)), ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"PCGamingWiki answered with an unexpected status ({(int)r.Status}).");
        return ParseWikitext(r.Body);
    }

    public async Task<string> TestAsync(CancellationToken ct)
    {
        var page = await FindBySteamAppIdAsync("620", ct);
        return page is null ? "PCGamingWiki answered, but without the expected test article." : "PCGamingWiki answered.";
    }

    /// <summary>The public article link, built natively from a validated title.</summary>
    public static Uri ArticleUrl(string title) => new($"https://{Host}/wiki/{Uri.EscapeDataString(title.Replace(' ', '_')).Replace("%2F", "/")}");

    // ---------- parsing (pure, unit-tested) ----------

    /// <summary>{"cargoquery":[{"title":{"Page":"Portal 2"}}]} → the page; an API error "permissiondenied" → denied.</summary>
    internal static (string? Page, bool Denied) ParseCargo(string json)
    {
        using var doc = JsonRead.Parse(json, "PCGamingWiki");
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return (null, false);
        if (JsonRead.Obj(root, "error") is { } error) return (null, JsonRead.Str(error, "code", 60) is "permissiondenied" or "badaccess-groups" or "readapidenied");
        var pages = JsonRead.Arr(root, "cargoquery")
            .Select(e => JsonRead.Obj(e, "title") is { } t ? JsonRead.Str(t, "Page", 260) : null)
            .Where(p => p is not null && IsTitle(p)).Distinct().ToList();
        return (pages.Count == 1 ? pages[0] : null, false); // two articles claiming one app id: don't guess
    }

    /// <summary>"https://www.pcgamingwiki.com/wiki/Portal_2" → "Portal 2". Any other host or shape → null.</summary>
    internal static string? TitleFromRedirect(Uri? location)
    {
        if (location is null) return null;
        if (!location.IsAbsoluteUri) location = new Uri(new Uri($"https://{Host}/"), location);
        if (location.Scheme != "https" || !location.Host.Equals(Host, StringComparison.OrdinalIgnoreCase) || !location.IsDefaultPort) return null;
        if (!string.IsNullOrEmpty(location.Query) || !string.IsNullOrEmpty(location.UserInfo)) return null;
        var path = location.AbsolutePath;
        if (!path.StartsWith("/wiki/", StringComparison.Ordinal)) return null;
        string title;
        try { title = Uri.UnescapeDataString(path["/wiki/".Length..]).Replace('_', ' ').Trim(); }
        catch (UriFormatException) { return null; }
        return IsTitle(title) && !InOtherNamespace(title) ? title : null;
    }

    private static readonly HashSet<string> Namespaces = new(StringComparer.OrdinalIgnoreCase)
    {
        "Special", "File", "Image", "Category", "Template", "User", "Talk", "Help", "MediaWiki", "Module", "Property", "Form",
        "PCGamingWiki", "Project", "Media", "Company", "Series", "Engine", "Topic", "Glossary", "List", "Template talk", "User talk",
    };

    /// <summary>Articles only: "Half-Life 2: Episode One" is fine, "Special:Search" or "File:x.png" isn't.</summary>
    private static bool InOtherNamespace(string title)
    {
        var colon = title.IndexOf(':');
        return colon > 0 && Namespaces.Contains(title[..colon].Trim());
    }

    internal static (string Title, string Wikitext)? ParseWikitext(string json)
    {
        using var doc = JsonRead.Parse(json, "PCGamingWiki");
        if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
        if (JsonRead.Obj(doc.RootElement, "parse") is not { } parse) return null;
        var title = JsonRead.Str(parse, "title", 260);
        var text = parse.TryGetProperty("wikitext", out var w)
            ? w.ValueKind == JsonValueKind.String ? w.GetString() : w.ValueKind == JsonValueKind.Object && w.TryGetProperty("*", out var star) && star.ValueKind == JsonValueKind.String ? star.GetString() : null
            : null;
        if (title is null || !IsTitle(title) || text is null) return null;
        return (title, text.Length > 2_000_000 ? text[..2_000_000] : text);
    }

    /// <summary>A plausible article title: 1–200 characters, no control, markup or URL characters.</summary>
    public static bool IsTitle(string? title) =>
        title is { Length: > 0 and <= 200 } && !title.Any(c => char.IsControl(c) || c is '|' or '#' or '<' or '>' or '[' or ']' or '{' or '}' or '\\');

    /// <summary>The save locations an article lists (see <see cref="SaveLocations.ParseWikitext"/>).</summary>
    public static IReadOnlyList<WikiSaveLocation> SaveLocationsOf(string wikitext) => SaveLocations.ParseWikitext(wikitext);

    [GeneratedRegex(@"^[0-9]{1,10}\z")]
    private static partial Regex AppId();
}

/// <summary>
/// Track X: Steam Workshop item titles from Valve's public, keyless <c>ISteamRemoteStorage/GetPublishedFileDetails</c>
/// (a documented Web API POST). Opt-in; only the item ids go out, in batches of up to 100.
/// </summary>
public sealed class WorkshopDetailsClient(ProviderTransport transport)
{
    public const string Url = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
    public const int Batch = 100;

    public async Task<IReadOnlyList<WorkshopTitle>> TitlesAsync(IReadOnlyList<string> itemIds, CancellationToken ct)
    {
        var ids = itemIds.Where(ModManifests.IsItemId).Distinct(StringComparer.Ordinal).Take(Batch).ToList();
        if (ids.Count == 0) return [];
        var form = new List<KeyValuePair<string, string>> { new("itemcount", ids.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)) };
        form.AddRange(ids.Select((id, i) => new KeyValuePair<string, string>($"publishedfileids[{i}]", id)));
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Post, new Uri(Url)) { Content = new FormUrlEncodedContent(form) }, ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Steam answered with an unexpected status ({(int)r.Status}).");
        return ModManifests.ParsePublishedFileDetails(r.Body).Where(t => ids.Contains(t.ItemId)).ToList();
    }

    /// <summary>Asks for one well-known item (Steam's own Workshop sample is not guaranteed, so any answer shape counts).</summary>
    public async Task<string> TestAsync(CancellationToken ct)
    {
        await TitlesAsync(["1"], ct);
        return "Steam answered.";
    }
}
