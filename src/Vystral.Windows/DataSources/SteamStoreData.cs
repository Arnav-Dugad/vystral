using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vystral.Windows.DataSources;

public sealed record DeckTest(string Text, string Kind);

/// <summary>Steam Deck compatibility as Valve reports it on store pages.</summary>
public sealed record DeckReport(string Category, IReadOnlyList<DeckTest> Tests);

/// <summary>A current Steam store price in the store's own currency (cents), or "no price" for free/unsold apps.</summary>
public sealed record SteamPrice(string AppId, long? FinalCents, long? InitialCents, int DiscountPercent, string? Currency, string? Formatted, bool NotSold);

/// <summary>
/// Public, keyless Steam store endpoints used by Steam's own store pages: the Steam Deck
/// compatibility report (undocumented, grey area: used on demand only, cached for 7 days, and
/// only while "Fetch game details" is on) and batched current prices (appdetails price_overview).
/// </summary>
public sealed partial class SteamStoreDataClient(ProviderTransport transport)
{
    public async Task<DeckReport?> GetDeckReportAsync(string appId, CancellationToken ct)
    {
        if (!IsAppId(appId)) return null;
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get,
            new Uri($"https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID={appId}&l=english")), ct);
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Steam answered with an unexpected status ({(int)r.Status}).");
        return ParseDeck(r.Body, appId);
    }

    /// <summary>Current prices for up to 100 apps in one request, in the given country's currency.</summary>
    public async Task<IReadOnlyList<SteamPrice>> GetPricesAsync(IReadOnlyList<string> appIds, string country, CancellationToken ct)
    {
        var ids = appIds.Where(IsAppId).Distinct().Take(100).ToList();
        if (ids.Count == 0) return [];
        var cc = Country().IsMatch(country) ? country : "US";
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get,
            new Uri($"https://store.steampowered.com/api/appdetails?appids={string.Join(',', ids)}&filters=price_overview&cc={cc}")), ct);
        if (r.Status == HttpStatusCode.Forbidden)
            throw new DataSourceException(DataSourceOutcome.RateLimited, "Steam asked VYSTRAL to slow down. Try again in a few minutes.");
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Steam answered with an unexpected status ({(int)r.Status}).");
        return ParsePrices(r.Body, ids);
    }

    // ---------- Parsing (pure, unit-tested) ----------

    internal static DeckReport? ParseDeck(string json, string appId)
    {
        using var doc = JsonRead.Parse(json, "Steam");
        var root = doc.RootElement;
        if (JsonRead.Long(root, "success") != 1 || JsonRead.Obj(root, "results") is not { } res) return null;
        if (JsonRead.Long(res, "appid") is { } id && id.ToString(CultureInfo.InvariantCulture) != appId) return null;
        var category = JsonRead.Long(res, "resolved_category") switch
        {
            3 => "verified",
            2 => "playable",
            1 => "unsupported",
            _ => "unknown",
        };
        var tests = new List<DeckTest>();
        foreach (var item in JsonRead.Arr(res, "resolved_items"))
        {
            var token = item.TryGetProperty("loc_token", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            if (token is null || token.Length > 160) continue;
            var text = DeckText(token);
            if (text is null) continue;
            var kind = JsonRead.Long(item, "display_type") switch
            {
                4 => "pass",
                3 => "note",
                2 => "fail",
                _ => "info",
            };
            tests.Add(new DeckTest(text, kind));
            if (tests.Count >= 12) break;
        }
        return new DeckReport(category, tests);
    }

    private static readonly Dictionary<string, string> DeckTexts = new(StringComparer.Ordinal)
    {
        ["DefaultControllerConfigFullyFunctional"] = "Everything works with the default controller configuration",
        ["ControllerGlyphsMatchDeckDevice"] = "Shows Steam Deck controller icons",
        ["InterfaceTextIsLegible"] = "Interface text is legible on Steam Deck",
        ["DefaultConfigurationIsPerformant"] = "The default graphics settings perform well on Steam Deck",
        ["DefaultConfigurationIsNotPerformant"] = "The default graphics settings may need adjusting to run well",
        ["UnsupportedAntiCheat_Other"] = "Unsupported because of its anti-cheat",
        ["ControllerGlyphsDoNotMatchDeckDevice"] = "Some controller icons don’t match Steam Deck’s",
        ["InterfaceTextIsNotLegible"] = "Some interface text is small and may be hard to read",
        ["ExternalControllersNotSupportedPrimaryPlayer"] = "External controllers aren’t supported for the primary player",
        ["DefaultControllerConfigNotFullyFunctional"] = "Some functionality needs the touchscreen or virtual keyboard",
        ["TextInputDoesNotAutomaticallyInvokesKeyboard"] = "Text input doesn’t open the on-screen keyboard automatically",
        ["LauncherInteractionIssues"] = "A launcher may need the touchscreen or virtual keyboard",
        ["SingleplayerGameplayAccessibleWithoutLauncher"] = "Single-player works without its launcher",
        ["GameStartupFunctional"] = "The game starts",
    };

    /// <summary>
    /// Plain-English text for one of Valve's result tokens (e.g. "#SteamDeckVerified_TestResult_InterfaceTextIsLegible").
    /// Unknown tokens are spelled out from their name; anything that isn't token-shaped is dropped.
    /// </summary>
    internal static string? DeckText(string token)
    {
        var m = DeckToken().Match(token);
        if (!m.Success) return null;
        var name = m.Groups[1].Value;
        if (DeckTexts.TryGetValue(name, out var text)) return text;
        var words = SplitWords().Replace(name.Replace('_', ' '), " $1").Trim();
        return words.Length == 0 ? null : char.ToUpperInvariant(words[0]) + words[1..].ToLowerInvariant();
    }

    internal static IReadOnlyList<SteamPrice> ParsePrices(string json, IReadOnlyCollection<string> requested)
    {
        using var doc = JsonRead.Parse(json, "Steam");
        var result = new List<SteamPrice>();
        if (doc.RootElement.ValueKind != JsonValueKind.Object) return result;
        foreach (var id in requested)
        {
            if (!doc.RootElement.TryGetProperty(id, out var entry) || entry.ValueKind != JsonValueKind.Object) continue;
            if (!entry.TryGetProperty("success", out var ok) || ok.ValueKind != JsonValueKind.True)
            {
                result.Add(new SteamPrice(id, null, null, 0, null, null, NotSold: true));
                continue;
            }
            if (JsonRead.Obj(entry, "data") is not { } data || JsonRead.Obj(data, "price_overview") is not { } p)
            {
                // Free to play, or not sold on its own.
                result.Add(new SteamPrice(id, null, null, 0, null, null, NotSold: true));
                continue;
            }
            var currency = JsonRead.Str(p, "currency", 3);
            var final = JsonRead.Long(p, "final");
            var initial = JsonRead.Long(p, "initial");
            if (currency is null || !Currency().IsMatch(currency) || final is not (>= 0 and < 100_000_000)) continue;
            result.Add(new SteamPrice(id, final, initial is >= 0 and < 100_000_000 ? initial : null,
                (int)Math.Clamp(JsonRead.Long(p, "discount_percent") ?? 0, 0, 100), currency, JsonRead.Str(p, "final_formatted", 24), false));
        }
        return result;
    }

    private static bool IsAppId(string s) => s.Length is > 0 and <= 10 && s.All(char.IsAsciiDigit);

    [GeneratedRegex(@"\A#Steam(?:Deck(?:Verified)?|OS|Machine|Frame)_TestResult_([A-Za-z0-9_]{1,100})\z")]
    private static partial Regex DeckToken();

    [GeneratedRegex(@"(?<=[a-z])([A-Z])")]
    private static partial Regex SplitWords();

    [GeneratedRegex(@"\A[A-Z]{2}\z")]
    private static partial Regex Country();

    [GeneratedRegex(@"\A[A-Z]{3}\z")]
    private static partial Regex Currency();
}

/// <summary>
/// AreWeAntiCheatYet's public dataset (MIT licence; github.com/AreWeAntiCheatYet). Its status
/// describes Linux/Steam Deck support; the anti-cheat names are useful on Windows too.
/// </summary>
public sealed class AntiCheatClient(ProviderTransport transport)
{
    public const string DatasetUrl = "https://raw.githubusercontent.com/AreWeAntiCheatYet/AreWeAntiCheatYet/HEAD/games.json";

    /// <summary>Anti-cheat products widely documented to load a kernel-mode driver on Windows.</summary>
    public static readonly HashSet<string> KernelLevel = new(StringComparer.OrdinalIgnoreCase)
    {
        "Easy Anti-Cheat", "BattlEye", "Vanguard", "EA anticheat", "nProtect GameGuard", "XIGNCODE3", "FACEIT", "ESEA",
        "RICOCHET", "Ricochet", "Anti-Cheat Expert", "Denuvo Anti-Cheat", "EQU8", "miHoYo Protect", "NetEase Anti-Cheat Expert",
    };

    /// <summary>Downloads the dataset unless it is unchanged (ETag). Returns null when not modified.</summary>
    public async Task<(IReadOnlyList<Vystral.Core.Data.AntiCheatRow> Rows, string? ETag)?> DownloadAsync(string? etag, CancellationToken ct)
    {
        var r = await transport.SendAsync(() =>
        {
            var req = new HttpRequestMessage(HttpMethod.Get, new Uri(DatasetUrl));
            if (etag is not null && System.Net.Http.Headers.EntityTagHeaderValue.TryParse(etag, out var tag)) req.Headers.IfNoneMatch.Add(tag);
            return req;
        }, ct);
        if (r.Status == HttpStatusCode.NotModified) return null;
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"GitHub answered with an unexpected status ({(int)r.Status}).");
        return (Parse(r.Body), r.ETag);
    }

    internal static IReadOnlyList<Vystral.Core.Data.AntiCheatRow> Parse(string json)
    {
        using var doc = JsonRead.Parse(json, "AreWeAntiCheatYet");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new DataSourceException(DataSourceOutcome.Malformed, "The anti-cheat list couldn’t be read.");
        var rows = new Dictionary<(string, string), Vystral.Core.Data.AntiCheatRow>();
        foreach (var g in doc.RootElement.EnumerateArray())
        {
            var name = JsonRead.Str(g, "name", 200);
            var status = JsonRead.Str(g, "status", 20);
            if (name is null || status is not ("Supported" or "Running" or "Broken" or "Denied" or "Planned")) continue;
            var anticheats = JsonRead.Names(g, "anticheats", 6);
            var slug = JsonRead.Str(g, "slug", 120) is { } s && s.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-') ? s : null;
            var reference = PriceClientsSafe(JsonRead.Str(g, "reference", 400));
            var changed = JsonRead.Str(g, "dateChanged", 40) is { } d && DateTimeOffset.TryParse(d, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var dt)
                ? dt.ToString("O") : null;
            if (JsonRead.Obj(g, "storeIds") is not { } ids) continue;
            var steam = JsonRead.Str(ids, "steam", 12);
            if (steam is not null && steam.All(char.IsAsciiDigit))
                rows[("steam", steam)] = new("steam", steam, name, slug, status, anticheats, reference, changed);
            if (JsonRead.Obj(ids, "epic") is { } epic && JsonRead.Str(epic, "slug", 120) is { } es && es.All(c => char.IsAsciiLetterOrDigit(c) || c == '-'))
                rows[("epic", es.ToLowerInvariant())] = new("epic", es.ToLowerInvariant(), name, slug, status, anticheats, reference, changed);
        }
        return rows.Values.ToList();
    }

    private static string? PriceClientsSafe(string? url) => IsThereAnyDealClient.SafeHttps(url);
}
