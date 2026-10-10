using System.Text.RegularExpressions;
using Vystral.Windows.DataSources;

namespace Vystral.Windows.Discover;

// Track U: universal game search. Every type here is built from validated provider answers; the page only ever sees
// these DTOs (camelCase, mirrored in ui/src/bridge/types.discover.ts) and never a provider URL.

/// <summary>The search sources, in the order their answers are trusted when fields disagree.</summary>
public static class DiscoverSources
{
    public const string Steam = "steam";
    public const string Igdb = "igdb";
    public const string Rawg = "rawg";
    public const string Wikidata = "wikidata";

    public static readonly IReadOnlyList<string> All = [Steam, Igdb, Rawg, Wikidata];

    public static string Name(string id) => id switch
    {
        Steam => "Steam",
        Igdb => "IGDB",
        Rawg => "RAWG",
        _ => "Wikidata",
    };

    /// <summary>Lower is preferred (for titles, dates and descriptions).</summary>
    public static int Priority(string id) => id switch
    {
        Steam => 0,
        Igdb => 1,
        Wikidata => 2,
        _ => 3,
    };
}

/// <summary>Every identifier a hit or a merged result is known by. All values are validated before they get here.</summary>
public sealed record DiscoverIds(
    string? Steam = null, long? Igdb = null, string? IgdbSlug = null, string? Rawg = null, string? Wikidata = null,
    string? GogId = null, string? GogPath = null, string? Epic = null, string? Microsoft = null)
{
    /// <summary>The union, keeping this record's value where both have one.</summary>
    public DiscoverIds Merge(DiscoverIds o) => new(
        Steam ?? o.Steam, Igdb ?? o.Igdb, IgdbSlug ?? o.IgdbSlug, Rawg ?? o.Rawg, Wikidata ?? o.Wikidata,
        GogId ?? o.GogId, GogPath ?? o.GogPath, Epic ?? o.Epic, Microsoft ?? o.Microsoft);

    /// <summary>True when both sides name the same kind of ID with different values: never the same game.</summary>
    public bool ConflictsWith(DiscoverIds o) =>
        Differ(Steam, o.Steam) || (Igdb is { } a && o.Igdb is { } b && a != b) || Differ(IgdbSlug, o.IgdbSlug) ||
        Differ(Rawg, o.Rawg) || Differ(Wikidata, o.Wikidata);

    /// <summary>True when both sides share at least one strong identifier.</summary>
    public bool SharesWith(DiscoverIds o) =>
        Same(Steam, o.Steam) || (Igdb is { } a && o.Igdb is { } b && a == b) || Same(IgdbSlug, o.IgdbSlug) ||
        Same(Rawg, o.Rawg) || Same(Wikidata, o.Wikidata);

    private static bool Differ(string? a, string? b) => a is not null && b is not null && !string.Equals(a, b, StringComparison.Ordinal);
    private static bool Same(string? a, string? b) => a is not null && b is not null && string.Equals(a, b, StringComparison.Ordinal);
}

/// <summary>An image a result can show, in preference order. Only ever downloaded through the art cache's safe pipeline.</summary>
public sealed record DiscoverImage(string Kind, string Url);

/// <summary>One source's answer for one game.</summary>
/// <param name="Rank">Position in the source's own answer (0 = its best match).</param>
/// <param name="Popularity">A rough, source-specific count (IGDB ratings, RAWG "added"), only used to break ties.</param>
/// <param name="Kind">"game", or "extra" for DLC, soundtracks, bundles and the like (ranked lower).</param>
public sealed record DiscoverHit(
    string Source, string SourceId, string Title, int? Year, string? ReleaseDate, int Rank, DiscoverIds Ids,
    IReadOnlyList<string> Stores, IReadOnlyList<string> Platforms, IReadOnlyList<string> Genres, IReadOnlyList<DiscoverImage> Images,
    StorePrice? Price = null, int Popularity = 0, string Kind = "game");

/// <summary>A Steam store price in cents of <paramref name="Currency"/> (ISO 4217), as the store search reports it for the price country.</summary>
public sealed record StorePrice(long FinalCents, long InitialCents, string Currency);

/// <summary>A game as the merged search shows it.</summary>
/// <param name="Key">The page's handle for it: steam-&lt;appid&gt;, igdb-&lt;id&gt;, rawg-&lt;slug&gt; or wd-&lt;QID&gt;.</param>
/// <param name="Stores">Store keys (PlatformKey) where it is sold, as the sources report.</param>
/// <param name="Platforms">Plain platform names ("PC", "PlayStation 5"), capped.</param>
/// <param name="LibraryGameId">The library game it is, when VYSTRAL is sure (Steam app ID, or an exact title and year).</param>
/// <param name="Cover">The cover's art-host URL when it is already cached; otherwise the page asks with discover.image.</param>
/// <param name="ReleaseDate">Track C3 (browse shelves): ISO date (yyyy-MM-dd), or yyyy-MM when Steam only names the month.</param>
/// <param name="ComingSoon">Track C3: not out yet, per the store.</param>
/// <param name="Free">Track C3: free to play, per the store.</param>
/// <param name="PriceText">Track C3: the store's own formatted price, when no price in cents with a currency is known.</param>
/// <param name="DiscountPercent">Track C3: the store's discount with <paramref name="PriceText"/>.</param>
public sealed record DiscoverResultDto(
    string Key, string Title, int? Year, IReadOnlyList<string> Stores, IReadOnlyList<string> Platforms, IReadOnlyList<string> Genres,
    IReadOnlyList<string> Sources, string? SteamAppId, string? LibraryGameId, StorePrice? Price, bool HasCover, string? Cover, double Score, string Kind,
    string? ReleaseDate = null, bool ComingSoon = false, bool Free = false, string? PriceText = null, int DiscountPercent = 0);

/// <summary>Where one source stands in a search.</summary>
/// <param name="State">pending, done, failed or skipped.</param>
/// <param name="Reason">For skipped: off, noKey, offline, gameRunning. For failed: rateLimited, unavailable, invalidKey.</param>
public sealed record DiscoverSourceStateDto(string Id, string Name, string State, string? Reason, int Count, bool HasMore);

/// <param name="Channel">"bar" (command bar) or "page" (the Discover page): a new search cancels the same channel's previous one.</param>
public sealed record DiscoverSearchDto(string SearchId, string Channel, string Query, int Page, IReadOnlyList<DiscoverSourceStateDto> Sources,
    IReadOnlyList<DiscoverResultDto> Results, bool Done, bool HasMore, string? Reason);

public sealed record DiscoverSourceStatusDto(string Id, string Name, string State, string? Reason);

/// <param name="Reason">Why nothing can be searched online: offline, off, or null.</param>
public sealed record DiscoverStatusDto(bool SearchOnline, bool LocalOnly, bool DataSaver, string? Reason, IReadOnlyList<DiscoverSourceStatusDto> Sources);

public sealed record DiscoverPriceDto(string? Formatted, string? Initial, int DiscountPercent, string? Currency, bool Free, bool ComingSoon, string Country);

public sealed record DiscoverLinkDto(string Id, string Label, string? Platform, string Kind);

public sealed record DiscoverCloudDto(string Service, string ServiceName, string? PlayType, bool Premium, string Match, string Note);

/// <summary>Track D5: a Discover card's cloud badge (discover.cloudMap).</summary>
public sealed record DiscoverCloudBadgeDto(string Service, string Match, string? PlayType);

public sealed record DiscoverCreditDto(string Id, string Name, string Note);

public sealed record DiscoverTtbDto(long? HastilySeconds, long? NormallySeconds, long? CompletelySeconds, int Count);

/// <summary>Everything the page for a game that isn't in the library shows.</summary>
/// <param name="TrailerId">A stand-in game ID the trailer proxy accepts for this game's Steam trailer (32 hex), or null.</param>
/// <param name="CloudReason">off (cloud play is off), noData (no catalogue yet), none (not listed), or null when listed.</param>
public sealed record DiscoverDetailsDto(
    string Key, string Title, int? Year, string? ReleaseDate, string? Description, string? DescriptionSource,
    IReadOnlyList<string> Genres, IReadOnlyList<string> Developers, IReadOnlyList<string> Publishers,
    IReadOnlyList<string> Platforms, IReadOnlyList<string> Stores, string? SteamAppId, string? LibraryGameId,
    DiscoverPriceDto? Price, DiscoverTtbDto? TimeToBeat, int? Metacritic, double? Rating, int RatingCount,
    DeckDto? Deck, AntiCheatDto? AntiCheat, IReadOnlyList<DiscoverLinkDto> Links,
    IReadOnlyList<DiscoverCloudDto> Cloud, string? CloudReason, string? TrailerId, bool Watching,
    IReadOnlyList<DiscoverCreditDto> Credits, IReadOnlyList<string> Notes, string Fetched, string? Reason, bool HasHero, bool HasLogo, bool HasCover);

/// <summary>A game on the local "Watching" list (prices and news are looked at when its page opens).</summary>
public sealed record DiscoverWatchDto(string Key, string Title, int? Year, string? SteamAppId, string AddedAt, string? PriceWhenAdded, string? Cover);

/// <summary>Strict shapes for every identifier that can reach a URL.</summary>
public static partial class DiscoverKeys
{
    [GeneratedRegex(@"\A(?:steam-[0-9]{1,10}|igdb-[0-9]{1,12}|rawg-[a-z0-9][a-z0-9\-]{0,119}|wd-Q[0-9]{1,12})\z")]
    public static partial Regex KeyPattern();

    [GeneratedRegex(@"\A[0-9]{1,10}\z")]
    public static partial Regex SteamAppId();

    [GeneratedRegex(@"\A[a-z0-9][a-z0-9\-]{0,119}\z")]
    public static partial Regex Slug();

    [GeneratedRegex(@"\AQ[0-9]{1,12}\z")]
    public static partial Regex Qid();

    [GeneratedRegex(@"\A[0-9A-Za-z]{12}\z")]
    public static partial Regex MsBigId();

    [GeneratedRegex(@"\Agame/[a-z0-9_]{1,100}\z")]
    public static partial Regex GogPath();

    public static bool IsKey(string? key) => key is not null && KeyPattern().IsMatch(key);

    public static string KeyFor(DiscoverIds ids, string fallbackSource, string fallbackId) =>
        ids.Steam is { } s ? $"steam-{s}"
        : ids.Igdb is { } i ? $"igdb-{i}"
        : ids.Rawg is { } r ? $"rawg-{r}"
        : ids.Wikidata is { } q ? $"wd-{q}"
        : $"{(fallbackSource == DiscoverSources.Wikidata ? "wd" : fallbackSource)}-{fallbackId}";

    /// <summary>What a key says by itself, for pages opened after a restart (nothing cached yet).</summary>
    public static DiscoverIds IdsFromKey(string key)
    {
        var dash = key.IndexOf('-');
        var kind = key[..dash];
        var value = key[(dash + 1)..];
        return kind switch
        {
            "steam" => new DiscoverIds(Steam: value),
            "igdb" => new DiscoverIds(Igdb: long.Parse(value, System.Globalization.CultureInfo.InvariantCulture)),
            "rawg" => new DiscoverIds(Rawg: value),
            _ => new DiscoverIds(Wikidata: value),
        };
    }

    /// <summary>The stand-in "game ID" the trailer proxy uses for a Steam app that isn't in the library.</summary>
    public static string TrailerId(string steamAppId) =>
        Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"vystral.discover.steam:{steamAppId}")))[..32];
}
