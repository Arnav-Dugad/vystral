using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Windows.Services;

namespace Vystral.Windows.DataSources;

// ---------- Bridge DTOs (camelCase; mirrored in ui/src/bridge/types.ts as Track I) ----------

public sealed record ProviderTestDto(string Outcome, string Message, string At);

public sealed record ProviderStatusDto(
    string Id, string Name, string Access, bool Configured, string? KeyMasked, bool Enabled, string? SettingKey,
    ProviderTestDto? LastTest, string? PausedUntil, string Licence, string Attribution, string Host, string Sends, string Uses);

public sealed record DataSourcesStatusDto(IReadOnlyList<ProviderStatusDto> Providers, bool LocalOnly, bool DataSaver, bool FetchMetadata, string PriceCountry);

public sealed record ProviderActionDto(ProviderTestDto Result, DataSourcesStatusDto Status);

public sealed record ArtOptionDto(string Id, string? Thumb, int Width, int Height, string? Style, string? Author, int Score, bool Animated);

public sealed record SgdbGameDto(string Id, string Name, int? Year);

public sealed record ArtOptionsDto(string Kind, SgdbGameDto? Game, string? MatchedBy, IReadOnlyList<ArtOptionDto> Items, IReadOnlyList<SgdbGameDto> Candidates,
    IReadOnlyList<string> Styles, bool PreviewsPaused, bool HasMore);

/// <param name="Pack">Track N: for art applied by an art pack, the pack's name.</param>
public sealed record UserArtDto(string Kind, string Source, string? Author, string? Pack = null);

public sealed record OfferDto(string Id, string Shop, double Price, double? Regular, int Cut);

public sealed record QuoteDto(string Provider, string Name, string? Currency, IReadOnlyList<OfferDto> Offers, double? HistoricalLow, string? HistoricalLowAt,
    string? Fetched, bool Stale, string? Error);

public sealed record DealsDto(string? SteamAppId, string? Reason, string Country, IReadOnlyList<QuoteDto> Quotes);

public sealed record IdentityEntryDto(string Name, string Label, string Value, string? Platform, bool Link);

public sealed record IdentityDto(string? KeyKind, string? KeyValue, string? WikidataId, string? Label, IReadOnlyList<IdentityEntryDto> Ids, string? Fetched, string? Reason);

public sealed record DeckDto(string Category, IReadOnlyList<DeckTest> Tests, string Fetched);

public sealed record AntiCheatDto(IReadOnlyList<string> Names, bool Kernel, string Status, string StatusLabel, string? Reference, string? Updated, string? Slug);

public sealed record CompatDto(DeckDto? Deck, string? DeckReason, AntiCheatDto? AntiCheat, string? AntiCheatReason);

public sealed record EnrichmentSourceDto(string Source, string Name, bool Matched, string? MatchMethod, double? Confidence, string? Url, string Fetched, JsonElement? Facts);

public sealed record EnrichmentDto(IReadOnlyList<EnrichmentSourceDto> Sources, IReadOnlyDictionary<string, string> FieldSources, bool CanFetch, string? Reason);

public sealed record ValueGameDto(string GameId, string Title, IReadOnlyList<string> Platforms, string Since, string SinceSource,
    long? PriceCents, long? RegularCents, string? Currency, string? Formatted, bool NotSold, string? PricedAt);

public sealed record ValueTimelineDto(IReadOnlyList<ValueGameDto> Games, string? Currency, long TotalCents, int Priced, int Unpriced, string? LastPriced,
    string Country, bool PricesEnabled, string? Reason);

/// <summary>
/// Track I: every third-party data source behind one gate. Each call checks Offline mode, the
/// source's own switch and (for images) Data saver; keys come from Credential Manager on demand
/// and never leave this class except as a masked suffix.
/// </summary>
public sealed class DataSourcesService
{
    private readonly LibraryRepository _repo;
    private readonly SettingsService _settings;
    private readonly ArtworkService _artwork;
    private readonly DataSourceKeyStore _keys;
    private readonly Dictionary<string, ProviderTransport> _transports = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<(string GameId, ArtworkKind Kind), Dictionary<string, SgdbImage>> _artOptions = new();
    private readonly SemaphoreSlim _antiCheatGate = new(1, 1);

    public SteamGridDbClient SteamGridDb { get; }
    public IgdbClient Igdb { get; }
    public RawgClient Rawg { get; }
    public CheapSharkClient CheapShark { get; }
    public IsThereAnyDealClient Itad { get; }
    public WikidataClient Wikidata { get; }
    public SteamStoreDataClient SteamStore { get; }
    public AntiCheatClient AntiCheat { get; }
    public EnrichmentService Enrichment { get; }
    /// <summary>Track X: save-game locations (opt-in, keyless) and Workshop item titles (opt-in, keyless).</summary>
    public PcGamingWikiClient PcGamingWiki { get; }
    public WorkshopDetailsClient WorkshopDetails { get; }

    public Func<bool> IsGameActive { get; set; } = () => false;

    public static readonly TimeSpan DealsTtl = TimeSpan.FromHours(6);
    public static readonly TimeSpan DeckTtl = TimeSpan.FromDays(7);
    public static readonly TimeSpan AntiCheatTtl = TimeSpan.FromDays(7);
    public static readonly TimeSpan IdentityTtl = TimeSpan.FromDays(30);
    public static readonly TimeSpan IdentityMissTtl = TimeSpan.FromDays(7);
    public static readonly TimeSpan PriceTtl = TimeSpan.FromHours(24);

    public DataSourcesService(LibraryRepository repo, SettingsService settings, ArtworkService artwork, ISecretStore secrets, HttpClient http,
        HttpClient? noRedirectHttp = null)
    {
        _repo = repo;
        _settings = settings;
        _artwork = artwork;
        _keys = new DataSourceKeyStore(secrets);
        ProviderTransport T(string id, string name, int ms, int maxBytes = 4 * 1024 * 1024) =>
            _transports[id] = new ProviderTransport(http, id, name, TimeSpan.FromMilliseconds(ms), maxBytes);
        SteamGridDb = new SteamGridDbClient(T("steamgriddb", "SteamGridDB", 400), () => _keys.GetKey(KeyedProvider.SteamGridDb));
        Igdb = new IgdbClient(T("igdb", "IGDB", 260), _keys.GetTwitch);
        Rawg = new RawgClient(T("rawg", "RAWG", 1000), () => _keys.GetKey(KeyedProvider.Rawg));
        CheapShark = new CheapSharkClient(T("cheapshark", "CheapShark", 1000));
        Itad = new IsThereAnyDealClient(T("itad", "IsThereAnyDeal", 400), () => _keys.GetKey(KeyedProvider.IsThereAnyDeal));
        Wikidata = new WikidataClient(T("wikidata", "Wikidata", 2000));
        SteamStore = new SteamStoreDataClient(T("steamdeck", "Steam", 1600));
        AntiCheat = new AntiCheatClient(T("awacy", "AreWeAntiCheatYet", 1000, 8 * 1024 * 1024));
        Enrichment = new EnrichmentService(repo, Igdb, Rawg, ProviderReady);
        // Track X: PCGamingWiki's app-id lookup answers with a redirect that must be read, not followed, so its lane uses
        // a client without automatic redirects (same connect logic, same user agent).
        var noRedirect = noRedirectHttp;
        if (noRedirect is null)
        {
            noRedirect = new HttpClient(Services.FastConnect.CreateHandler(allowRedirects: false)) { Timeout = http.Timeout };
            foreach (var ua in http.DefaultRequestHeaders.UserAgent) noRedirect.DefaultRequestHeaders.UserAgent.Add(ua);
        }
        PcGamingWiki = new PcGamingWikiClient(_transports["pcgamingwiki"] = new ProviderTransport(noRedirect, "pcgamingwiki", "PCGamingWiki", TimeSpan.FromMilliseconds(1500), 3 * 1024 * 1024));
        WorkshopDetails = new WorkshopDetailsClient(T("workshop", "Steam Workshop", 1600, 2 * 1024 * 1024));
    }

    internal ProviderTransport Transport(string id) => _transports[id];

    /// <summary>Track N: the provider's polite request lane (art packs share SteamGridDB's).</summary>
    public ProviderTransport TransportFor(string id) => _transports[id];

    /// <summary>True when the user's own key (or Twitch app) is stored for a provider.</summary>
    public bool HasKey(KeyedProvider provider) => _keys.IsConfigured(provider);

    // ---------- Gates ----------

    public bool LocalOnly => _settings.GetBool("privacy.localOnly");
    public bool DataSaver => _artwork.SkipDownloads?.Invoke() == true;
    /// <summary>Whether the user's own key/credentials for a source are stored (Track M: time-to-beat bars need IGDB).</summary>
    public bool IsConfigured(KeyedProvider provider) => _keys.IsConfigured(provider);
    public string Country => _settings.GetString("dataSources.priceCountry") is { Length: 2 } c && c.All(char.IsAsciiLetterUpper) ? c : "US";

    private void RequireOnline()
    {
        if (LocalOnly) throw new DataSourceException(DataSourceOutcome.Offline, "Offline mode is on, so VYSTRAL doesn’t contact data sources. Turn it off in Settings → Privacy.");
    }

    /// <summary>True when an enrichment source has credentials, enrichment is on, and nothing forbids network use.</summary>
    public bool ProviderReady(string source) =>
        !LocalOnly && _settings.GetBool("dataSources.enrichment") && !IsGameActive() &&
        source switch
        {
            "igdb" => _keys.IsConfigured(KeyedProvider.Igdb),
            "rawg" => _keys.IsConfigured(KeyedProvider.Rawg),
            _ => false,
        };

    // ---------- Status, connect, test, disconnect ----------

    private sealed record ProviderInfo(string Id, string Name, string Access, KeyedProvider? Keyed, string? SettingKey, string Licence, string Attribution,
        string Host, string Sends, string Uses);

    private static readonly ProviderInfo[] Providers =
    [
        new("steamgriddb", "SteamGridDB", "key", KeyedProvider.SteamGridDb, null, "Community artwork; each image belongs to its author. SteamGridDB terms: personal, non-commercial use.",
            "Artwork from SteamGridDB, credited to its author.", "www.steamgriddb.com, cdn2.steamgriddb.com",
            "Your key, the Steam app ID or title of a game when you open the artwork picker.", "Alternative covers, backgrounds, logos and icons in the artwork picker."),
        new("igdb", "IGDB", "twitch", KeyedProvider.Igdb, "dataSources.enrichment", "Free under the Twitch Developer Services Agreement.",
            "Game details from IGDB.com.", "id.twitch.tv, api.igdb.com",
            "Your Twitch client ID and secret (to get a token), then Steam app IDs or exact titles of games in your library.",
            "Missing descriptions, genres, themes, modes, release dates, studios, ratings, time to beat, series and similar games."),
        new("rawg", "RAWG", "key", KeyedProvider.Rawg, "dataSources.enrichment", "RAWG API terms: free for personal use with an active link to RAWG on every page that shows its data.",
            "Data from RAWG.io.", "api.rawg.io",
            "Your key and the titles (or Wikidata-linked IDs) of games in your library.", "Missing descriptions, genres, release dates, studios, user rating and average playtime."),
        new("itad", "IsThereAnyDeal", "key", KeyedProvider.IsThereAnyDeal, null, "IsThereAnyDeal API terms: data and shop links are shown unchanged, with a link to IsThereAnyDeal.",
            "Prices from IsThereAnyDeal.com.", "api.isthereanydeal.com",
            "Your key, a game’s Steam app ID and your price country, when you open that game’s page.", "Current prices across shops and the historical low on game pages."),
        new("cheapshark", "CheapShark", "keyless", null, "dataSources.cheapshark", "CheapShark API: free; deal links go through CheapShark’s own redirect.",
            "Prices from CheapShark.com.", "www.cheapshark.com",
            "A game’s Steam app ID, only when you open that game’s page.", "Current best price (US dollars) and the lowest price ever on game pages."),
        new("wikidata", "Wikidata", "keyless", null, "dataSources.wikidata", "CC0 (public domain).", "Store IDs from Wikidata.",
            "query.wikidata.org", "Steam app IDs (and GOG product IDs) of games in your library, in batches.",
            "The same game’s IDs on other stores and sites, “Open on…” links and duplicate suggestions."),
        new("steamdeck", "Steam Deck compatibility", "keyless", null, "dataSources.steamDeck", "Valve’s public store data, shown with attribution.",
            "Steam Deck compatibility as reported by Valve on the Steam store.", "store.steampowered.com",
            "A game’s Steam app ID when you open its page (also used for current Steam prices in the library value timeline).",
            "Verified / Playable / Unsupported badges with Valve’s test results."),
        new("awacy", "AreWeAntiCheatYet", "keyless", null, "dataSources.antiCheat", "MIT licence (AreWeAntiCheatYet contributors).",
            "Anti-cheat details per AreWeAntiCheatYet.", "raw.githubusercontent.com",
            "Nothing about you: the whole public list is downloaded at most once a week.", "Which anti-cheat a game uses, and its Linux/Steam Deck status."),
        // Track X (both off by default).
        new("pcgamingwiki", "PCGamingWiki", "keyless", null, "dataSources.pcgamingwiki",
            "CC BY-NC-SA 3.0 (PCGamingWiki contributors). Credited wherever it's shown; looked up on this PC only, never shipped with VYSTRAL.",
            "Save locations from PCGamingWiki, CC BY-NC-SA 3.0.", "www.pcgamingwiki.com",
            "A game's Steam app ID, then its article name, when you open that game's Files tab.",
            "Where a game keeps its saves on Windows, checked against your PC (read-only), with Open folder."),
        new("workshop", "Steam Workshop titles", "keyless", null, "dataSources.workshopTitles", "Valve's public Steam Web API (no key), shown with attribution.",
            "Workshop titles from Steam.", "api.steampowered.com",
            "The Workshop item IDs installed for a game, when you open its Files tab (up to 100 per request).",
            "Names for the Workshop items in a game's mod list instead of bare numbers."),
    ];

    public DataSourcesStatusDto Status()
    {
        var list = Providers.Select(p =>
        {
            var configured = p.Keyed is not { } k || _keys.IsConfigured(k);
            var enabled = p.Keyed is not null ? configured && (p.SettingKey is null || _settings.GetBool(p.SettingKey)) : _settings.GetBool(p.SettingKey!);
            return new ProviderStatusDto(p.Id, p.Name, p.Access, configured, p.Keyed is { } kp ? _keys.Masked(kp) : null, enabled, p.SettingKey,
                LastTest(p.Id), _transports.TryGetValue(p.Id, out var t) ? t.BlockedUntil?.ToString("O") : null,
                p.Licence, p.Attribution, p.Host, p.Sends, p.Uses);
        }).ToList();
        return new DataSourcesStatusDto(list, LocalOnly, DataSaver, _settings.GetBool("library.fetchMetadata"), Country);
    }

    private ProviderTestDto? LastTest(string id)
    {
        var raw = _repo.GetInternalValue($"dataSources.lastTest.{id}");
        if (raw is null) return null;
        try { return JsonSerializer.Deserialize<ProviderTestDto>(raw, EnrichmentService.Json); }
        catch (JsonException) { return null; }
    }

    private ProviderTestDto Record(string id, DataSourceOutcome outcome, string message)
    {
        var dto = new ProviderTestDto(Camel(outcome), message, DateTimeOffset.UtcNow.ToString("O"));
        _repo.SetInternalValue($"dataSources.lastTest.{id}", JsonSerializer.Serialize(dto, EnrichmentService.Json));
        return dto;
    }

    private static string Camel(DataSourceOutcome o) => char.ToLowerInvariant(o.ToString()[0]) + o.ToString()[1..];

    public static KeyedProvider? Keyed(string id) => Providers.FirstOrDefault(p => p.Id == id)?.Keyed;

    public static bool IsKnown(string id) => Providers.Any(p => p.Id == id);

    /// <summary>Tests the pasted key with one request and stores it only when the provider accepted it.</summary>
    public async Task<ProviderActionDto> ConnectAsync(string id, string key, string? secret, CancellationToken ct)
    {
        var keyed = Keyed(id) ?? throw new DataSourceException(DataSourceOutcome.Malformed, "This source doesn’t use a key.");
        ProviderTestDto result;
        try
        {
            RequireOnline();
            if (keyed == KeyedProvider.Igdb)
            {
                var creds = DataSourceKeyStore.NormalizeTwitch(key, secret)
                            ?? throw new DataSourceException(DataSourceOutcome.InvalidKey, "A Twitch client ID and client secret are each about 30 letters and digits. Copy both from dev.twitch.tv/console.");
                Igdb.ForgetToken();
                await Igdb.TestAsync(ct, creds);
                _keys.SetTwitch(creds.ClientId, creds.Secret);
                result = Record(id, DataSourceOutcome.Ok, "Connected. IGDB answered with your Twitch application’s token (kept in memory only).");
            }
            else
            {
                var normalized = DataSourceKeyStore.NormalizeKey(keyed, key)
                                 ?? throw new DataSourceException(DataSourceOutcome.InvalidKey, "That doesn’t look like an API key. Copy it again, without spaces.");
                var message = await TestKeyedAsync(keyed, ct, normalized);
                _keys.SetKey(keyed, normalized);
                result = Record(id, DataSourceOutcome.Ok, message);
            }
            _transports[id].ResetPause();
            _repo.Audit("dataSources.connect", id);
        }
        catch (DataSourceException ex)
        {
            result = Record(id, ex.Outcome, ex.Message);
        }
        return new ProviderActionDto(result, Status());
    }

    private async Task<string> TestKeyedAsync(KeyedProvider p, CancellationToken ct, string? keyOverride = null)
    {
        switch (p)
        {
            case KeyedProvider.SteamGridDb:
                await SteamGridDb.TestAsync(ct, keyOverride);
                return "Connected. SteamGridDB accepted the key.";
            case KeyedProvider.Rawg:
                var n = await Rawg.TestAsync(ct, keyOverride);
                return n > 0 ? $"Connected. RAWG lists {n.ToString("N0", CultureInfo.InvariantCulture)} games." : "Connected. RAWG accepted the key.";
            case KeyedProvider.IsThereAnyDeal:
                await Itad.TestAsync(ct, keyOverride);
                return "Connected. IsThereAnyDeal accepted the key.";
            default:
                await Igdb.TestAsync(ct);
                return "Connected. IGDB answered with your Twitch application’s token (kept in memory only).";
        }
    }

    public async Task<ProviderActionDto> TestAsync(string id, CancellationToken ct)
    {
        if (!IsKnown(id)) throw new DataSourceException(DataSourceOutcome.Malformed, "Unknown data source.");
        ProviderTestDto result;
        try
        {
            RequireOnline();
            string message;
            if (Keyed(id) is { } k)
            {
                if (!_keys.IsConfigured(k)) throw new DataSourceException(DataSourceOutcome.NotConfigured, "No key is stored for this source.");
                message = await TestKeyedAsync(k, ct);
            }
            else
            {
                message = id switch
                {
                    "cheapshark" => await Do(async () => { await CheapShark.TestAsync(ct); return "CheapShark answered."; }),
                    "wikidata" => await Do(async () =>
                    {
                        var r = await Wikidata.LookupAsync("steam", ["620"], ct);
                        return r.Count == 1 && r[0].ItemId is not null ? "Wikidata answered." : "Wikidata answered, but without the expected test item.";
                    }),
                    "steamdeck" => await Do(async () => await SteamStore.GetDeckReportAsync("620", ct) is not null ? "Steam answered." : "Steam answered without a report."),
                    "pcgamingwiki" => await PcGamingWiki.TestAsync(ct), // Track X
                    "workshop" => await WorkshopDetails.TestAsync(ct),  // Track X
                    _ =>await Do(async () => $"Downloaded {await RefreshAntiCheatAsync(force: true, ct)} entries."),
                };
            }
            result = Record(id, DataSourceOutcome.Ok, message);
        }
        catch (DataSourceException ex)
        {
            result = Record(id, ex.Outcome, ex.Message);
        }
        return new ProviderActionDto(result, Status());

        static async Task<string> Do(Func<Task<string>> f) => await f();
    }

    public DataSourcesStatusDto Disconnect(string id)
    {
        var keyed = Keyed(id) ?? throw new DataSourceException(DataSourceOutcome.Malformed, "This source doesn’t use a key.");
        _keys.Clear(keyed);
        if (keyed == KeyedProvider.Igdb) Igdb.ForgetToken();
        if (keyed == KeyedProvider.IsThereAnyDeal) _repo.ClearProviderCache("deals-itad");
        _repo.SetInternalValue($"dataSources.lastTest.{id}", null);
        _repo.Audit("dataSources.disconnect", id);
        return Status();
    }

    // ---------- Art picker (SteamGridDB) ----------

    public async Task<ArtOptionsDto> GetArtOptionsAsync(string gameId, ArtworkKind kind, IReadOnlyList<string> styles, bool animated, int page,
        long? sgdbGameId, CancellationToken ct)
    {
        if (!SteamGridDbClient.Supports(kind)) throw new DataSourceException(DataSourceOutcome.Malformed, "SteamGridDB doesn’t offer this kind of artwork.");
        RequireOnline();
        if (!_keys.IsConfigured(KeyedProvider.SteamGridDb))
            throw new DataSourceException(DataSourceOutcome.NotConfigured, "Add your SteamGridDB API key in Settings → Data sources to browse alternatives.");
        var game = _repo.GetGame(gameId) ?? throw new DataSourceException(DataSourceOutcome.Malformed, "That game no longer exists.");
        var allowedStyles = SteamGridDbClient.Styles[kind];

        SgdbGame? sgdb = null;
        string? matchedBy = null;
        IReadOnlyList<SgdbGame> candidates = [];
        if (sgdbGameId is > 0)
        {
            sgdb = new SgdbGame(sgdbGameId.Value, game.Title, null);
            matchedBy = "chosen";
        }
        else if (game.SteamAppId is { } appId && await SteamGridDb.GetGameBySteamAppIdAsync(appId, ct) is { } bySteam)
        {
            sgdb = bySteam;
            matchedBy = "steam";
        }
        else
        {
            candidates = await SteamGridDb.SearchAsync(game.Title, ct);
            if (SteamGridDbClient.PickExact(game.Title, candidates) is { } exact)
            {
                sgdb = exact;
                matchedBy = "title";
                candidates = [];
            }
        }

        var items = new List<ArtOptionDto>();
        var hasMore = false;
        if (sgdb is not null)
        {
            var images = await SteamGridDb.GetImagesAsync(kind, sgdb.Id, new SgdbFilter(styles, animated, page), ct);
            hasMore = images.Count >= 50;
            var map = _artOptions.AddOrUpdate((gameId, kind), _ => [], (_, existing) => page == 0 ? [] : existing);
            lock (map)
            {
                foreach (var img in images)
                {
                    var optionId = img.Id.ToString(CultureInfo.InvariantCulture);
                    map[optionId] = img;
                }
            }
            items.AddRange(images.Select(img => new ArtOptionDto(img.Id.ToString(CultureInfo.InvariantCulture), CachedThumb(img.Thumb),
                img.Width, img.Height, img.Style, img.Author, img.Score, IsAnimated(img))));
        }
        return new ArtOptionsDto(kind.ToString().ToLowerInvariant(), sgdb is null ? null : new SgdbGameDto(sgdb.Id.ToString(CultureInfo.InvariantCulture), sgdb.Name, sgdb.ReleaseYear),
            matchedBy, items, candidates.Take(8).Select(c => new SgdbGameDto(c.Id.ToString(CultureInfo.InvariantCulture), c.Name, c.ReleaseYear)).ToList(),
            allowedStyles, DataSaver, hasMore);
    }

    private static bool IsAnimated(SgdbImage img) => img.Mime is "image/webp" or "image/gif" && img.Url.Contains("/animated", StringComparison.OrdinalIgnoreCase);

    private string? CachedThumb(string url)
    {
        // Only report a thumbnail the cache already holds; otherwise the page asks for it with art.thumb.
        var hash = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(new Uri(url).AbsoluteUri)))[..12];
        foreach (var ext in new[] { ".jpg", ".png", ".webp" })
        {
            var rel = $"_thumbs/sgdb/{hash}{ext}";
            if (_artwork.CachedFileExists(rel)) return ArtworkService.Url("", rel);
        }
        return null;
    }

    private SgdbImage Option(string gameId, ArtworkKind kind, string optionId)
    {
        if (_artOptions.TryGetValue((gameId, kind), out var map))
            lock (map)
                if (map.TryGetValue(optionId, out var img)) return img;
        throw new DataSourceException(DataSourceOutcome.Malformed, "That image is no longer in the list. Refresh the picker and try again.");
    }

    /// <summary>Downloads one preview (through the safe image pipeline) and returns its art-host URL.</summary>
    public async Task<string?> GetArtThumbAsync(string gameId, ArtworkKind kind, string optionId, bool force, CancellationToken ct)
    {
        var img = Option(gameId, kind, optionId);
        if (CachedThumb(img.Thumb) is { } cached) return cached;
        RequireOnline();
        if (DataSaver && !force) throw new DataSourceException(DataSourceOutcome.Disabled, "Data saver is on, so previews aren’t downloaded.");
        if (JsonRead.SafeUrl(img.Thumb, "steamgriddb.com") is not { } safe) return null;
        var rel = await _artwork.CacheThumbAsync(safe, "sgdb", ct);
        return rel is null ? null : ArtworkService.Url("", rel);
    }

    /// <summary>Downloads the full-size image and makes it the user's choice for this slot.</summary>
    public async Task<bool> ApplyArtAsync(string gameId, ArtworkKind kind, string optionId, CancellationToken ct)
    {
        var img = Option(gameId, kind, optionId);
        RequireOnline();
        if (JsonRead.SafeUrl(img.Url, "steamgriddb.com") is not { } safe) return false;
        if (!await _artwork.DownloadUserArtAsync(gameId, kind, safe, "steamgriddb", ct)) return false;
        _repo.SetProviderCache("art-credit", $"{gameId}:{kind.ToString().ToLowerInvariant()}",
            JsonSerializer.Serialize(new { author = img.Author, id = img.Id }), TimeSpan.FromDays(3650));
        _repo.Audit("game.setArtwork", $"{gameId} {kind} steamgriddb:{img.Id}");
        return true;
    }

    public IReadOnlyList<UserArtDto> UserArt(string gameId) =>
        _repo.UserArtwork(gameId).Select(kv =>
        {
            string? author = null, pack = null;
            if (kv.Value is "steamgriddb" or LibraryRepository.ArtPackSource && _repo.GetProviderCache("art-credit", $"{gameId}:{kv.Key}") is { } c)
            {
                try
                {
                    using var doc = JsonDocument.Parse(c.Body);
                    author = JsonRead.Str(doc.RootElement, "author", 60);
                    if (kv.Value == LibraryRepository.ArtPackSource) pack = JsonRead.Str(doc.RootElement, "pack", 40);
                }
                catch (JsonException) { }
            }
            return new UserArtDto(kv.Key, kv.Value == "user" ? "file" : kv.Value, author, pack);
        }).ToList();

    // ---------- Deals (CheapShark, IsThereAnyDeal) ----------

    public async Task<DealsDto> GetDealsAsync(string gameId, bool refresh, CancellationToken ct)
    {
        var game = _repo.GetGame(gameId) ?? throw new DataSourceException(DataSourceOutcome.Malformed, "That game no longer exists.");
        return await GetDealsForSteamAppAsync(game.SteamAppId, refresh, ct);
    }

    /// <summary>Track U: prices by Steam app ID, for games that aren't in the library too (Discover pages). Same cache and rules.</summary>
    public async Task<DealsDto> GetDealsForSteamAppAsync(string? steamAppId, bool refresh, CancellationToken ct)
    {
        var country = Country;
        if (steamAppId is not { } appId || appId.Length is 0 or > 10 || !appId.All(char.IsAsciiDigit)) return new DealsDto(null, "noSteamId", country, []);
        var quotes = new List<QuoteDto>();
        if (_settings.GetBool("dataSources.cheapshark"))
            quotes.Add(await QuoteAsync("cheapshark", "CheapShark", appId, refresh,
                () => CheapShark.GetBySteamAppIdAsync(appId, CachedStores, s => _repo.SetProviderCache("cheapshark-stores", "all", JsonSerializer.Serialize(s), TimeSpan.FromDays(7)), ct)));
        if (_keys.IsConfigured(KeyedProvider.IsThereAnyDeal))
            quotes.Add(await QuoteAsync("itad", "IsThereAnyDeal", $"{appId}:{country}", refresh, () => Itad.GetBySteamAppIdAsync(appId, country, ct)));
        string? reason = quotes.Count == 0 ? "disabled" : LocalOnly && quotes.All(q => q.Fetched is null) ? "offline" : null;
        return new DealsDto(appId, reason, country, quotes);
    }

    private IReadOnlyDictionary<string, string>? CachedStores()
    {
        if (_repo.GetProviderCache("cheapshark-stores", "all") is not { Fresh: true } c) return null;
        try { return JsonSerializer.Deserialize<Dictionary<string, string>>(c.Body); }
        catch (JsonException) { return null; }
    }

    private async Task<QuoteDto> QuoteAsync(string provider, string name, string key, bool refresh, Func<Task<PriceQuote?>> fetch)
    {
        var cacheProvider = $"deals-{provider}";
        var cached = _repo.GetProviderCache(cacheProvider, key);
        if (cached is { Fresh: true } && !refresh) return ToQuote(provider, name, cached.Value.Body, cached.Value.Fetched, stale: false, null);
        if (LocalOnly)
            return cached is { } c0 ? ToQuote(provider, name, c0.Body, c0.Fetched, stale: true, null) : new QuoteDto(provider, name, null, [], null, null, null, false, null);
        try
        {
            var quote = await fetch();
            var body = JsonSerializer.Serialize(quote, EnrichmentService.Json);
            _repo.SetProviderCache(cacheProvider, key, body, DealsTtl);
            return ToQuote(provider, name, body, DateTimeOffset.UtcNow, stale: false, null);
        }
        catch (DataSourceException ex)
        {
            return cached is { } c ? ToQuote(provider, name, c.Body, c.Fetched, stale: true, ex.Message) : new QuoteDto(provider, name, null, [], null, null, null, false, ex.Message);
        }
    }

    private static QuoteDto ToQuote(string provider, string name, string body, DateTimeOffset fetched, bool stale, string? error)
    {
        PriceQuote? q = null;
        try { q = JsonSerializer.Deserialize<PriceQuote?>(body, EnrichmentService.Json); }
        catch (JsonException) { }
        return q is null
            ? new QuoteDto(provider, name, null, [], null, null, fetched.ToString("O"), stale, error)
            : new QuoteDto(provider, name, q.Currency, q.Offers.Select(o => new OfferDto(o.Id, o.Shop, o.Price, o.Regular, o.Cut)).ToList(),
                q.HistoricalLow, q.HistoricalLowAt, fetched.ToString("O"), stale, error);
    }

    /// <summary>The link of one offer previously shown for this game (the page never sends URLs).</summary>
    public string? OfferUrl(string gameId, string offerId)
    {
        var game = _repo.GetGame(gameId);
        return OfferUrlForSteamApp(game?.SteamAppId, offerId);
    }

    /// <summary>Track U: the link of one offer previously shown for a Steam app (the page never sends URLs).</summary>
    public string? OfferUrlForSteamApp(string? steamAppId, string offerId)
    {
        if (steamAppId is not { } appId) return null;
        foreach (var (provider, key) in new[] { ("deals-cheapshark", appId), ("deals-itad", $"{appId}:{Country}") })
        {
            if (_repo.GetProviderCache(provider, key) is not { } c) continue;
            try
            {
                var q = JsonSerializer.Deserialize<PriceQuote?>(c.Body, EnrichmentService.Json);
                if (q?.Offers.FirstOrDefault(o => o.Id == offerId) is { } offer) return IsThereAnyDealClient.SafeHttps(offer.Url);
            }
            catch (JsonException) { }
        }
        return null;
    }

    // ---------- Identity (Wikidata) ----------

    private (string Kind, string Value)? IdentityKey(Game game)
    {
        if (game.SteamAppId is { } appId) return ("steam", appId);
        var gog = _repo.GetInstallations(game.Id).FirstOrDefault(i => i.Platform == PlatformId.Gog)?.PlatformGameId;
        return gog is not null && gog.All(char.IsAsciiDigit) && gog.Length <= 12 ? ("gog", gog) : null;
    }

    public async Task<IdentityDto> GetIdentityAsync(string gameId, bool refresh, CancellationToken ct)
    {
        var game = _repo.GetGame(gameId) ?? throw new DataSourceException(DataSourceOutcome.Malformed, "That game no longer exists.");
        if (IdentityKey(game) is not { } key) return new IdentityDto(null, null, null, null, [], null, "noStoreId");
        var row = _repo.GetExternalIds(key.Kind, key.Value);
        var stale = row is null || DateTimeOffset.UtcNow - row.Fetched > (row.WikidataId is null ? IdentityMissTtl : IdentityTtl);
        string? reason = null;
        if ((stale || refresh) && _settings.GetBool("dataSources.wikidata"))
        {
            if (LocalOnly) reason = "offline";
            else
            {
                try
                {
                    var found = await Wikidata.LookupAsync(key.Kind, [key.Value], ct);
                    foreach (var f in found) _repo.UpsertExternalIds(key.Kind, f.Key, f.ItemId, f.Label, f.Ids);
                    row = _repo.GetExternalIds(key.Kind, key.Value);
                }
                catch (DataSourceException ex)
                {
                    reason = ex.Outcome == DataSourceOutcome.RateLimited ? "rateLimited" : "unavailable";
                }
            }
        }
        else if (!_settings.GetBool("dataSources.wikidata") && row is null) reason = "disabled";
        return ToIdentity(key, row, reason);
    }

    private static readonly (string Name, string Label, string? Platform)[] IdentityLabels =
    [
        ("steam", "Steam", "steam"), ("gog", "GOG", "gog"), ("gogId", "GOG product", null), ("epic", "Epic Games Store", "epic"),
        ("microsoft", "Microsoft Store", "xbox"), ("igdb", "IGDB", null), ("pcgamingwiki", "PCGamingWiki", null), ("hltb", "HowLongToBeat", null),
        ("steamgriddb", "SteamGridDB", null), ("itad", "IsThereAnyDeal", null), ("rawg", "RAWG", null), ("mobygames", "MobyGames", null),
    ];

    private static IdentityDto ToIdentity((string Kind, string Value) key, ExternalIdRow? row, string? reason)
    {
        if (row is null) return new IdentityDto(key.Kind, key.Value, null, null, [], null, reason ?? "notChecked");
        var entries = new List<IdentityEntryDto>();
        foreach (var (name, label, platform) in IdentityLabels)
            if (row.Ids.TryGetValue(name, out var v))
                entries.Add(new IdentityEntryDto(name, label, v, platform, WikidataClient.PageUrl(name, v) is not null));
        return new IdentityDto(key.Kind, key.Value, row.WikidataId, row.Label, entries, row.Fetched.ToString("O"), reason ?? (row.WikidataId is null ? "notFound" : null));
    }

    /// <summary>The page for one of a game's cross-store IDs (built natively from validated values).</summary>
    public string? IdentityUrl(string gameId, string name)
    {
        var game = _repo.GetGame(gameId);
        if (game is null || IdentityKey(game) is not { } key || _repo.GetExternalIds(key.Kind, key.Value) is not { } row) return null;
        if (name == "wikidata") return row.WikidataId is { } q ? WikidataClient.PageUrl("wikidata", q) : null;
        return row.Ids.TryGetValue(name, out var v) ? WikidataClient.PageUrl(name, v) : null;
    }

    /// <summary>Background: fills identity rows for the library's Steam games, 100 per query, one query at a time.</summary>
    public async Task<int> RefreshLibraryIdentityAsync(int max, CancellationToken ct)
    {
        if (LocalOnly || !_settings.GetBool("dataSources.wikidata")) return 0;
        var pending = _repo.SteamAppIdsNeedingIdentity(IdentityTtl, IdentityMissTtl, max);
        var done = 0;
        foreach (var chunk in pending.Chunk(WikidataClient.MaxBatch))
        {
            if (IsGameActive() || LocalOnly) break;
            var found = await Wikidata.LookupAsync("steam", chunk, ct);
            foreach (var f in found) _repo.UpsertExternalIds("steam", f.Key, f.ItemId, f.Label, f.Ids);
            done += found.Count;
        }
        return done;
    }

    // ---------- Compatibility (Steam Deck, anti-cheat) ----------

    public async Task<CompatDto> GetCompatAsync(string gameId, CancellationToken ct)
    {
        var game = _repo.GetGame(gameId) ?? throw new DataSourceException(DataSourceOutcome.Malformed, "That game no longer exists.");
        return await GetCompatForSteamAppAsync(game.SteamAppId, ct);
    }

    /// <summary>Track U: Steam Deck and anti-cheat by Steam app ID, for games that aren't in the library too. Same cache and rules.</summary>
    public async Task<CompatDto> GetCompatForSteamAppAsync(string? steamAppId, CancellationToken ct)
    {
        DeckDto? deck = null;
        string? deckReason = null;
        if (steamAppId is not { } appId || appId.Length is 0 or > 10 || !appId.All(char.IsAsciiDigit)) deckReason = "noSteamId";
        else if (!_settings.GetBool("dataSources.steamDeck") || !_settings.GetBool("library.fetchMetadata")) deckReason = "disabled";
        else
        {
            var cached = _repo.GetProviderCache("steamdeck", appId);
            if (cached is { Fresh: true } c) deck = ToDeck(c.Body, c.Fetched);
            else if (LocalOnly)
            {
                deckReason = "offline";
                if (cached is { } stale) deck = ToDeck(stale.Body, stale.Fetched);
            }
            else
            {
                try
                {
                    var report = await SteamStore.GetDeckReportAsync(appId, ct);
                    var body = JsonSerializer.Serialize(report ?? new DeckReport("unknown", []), EnrichmentService.Json);
                    _repo.SetProviderCache("steamdeck", appId, body, DeckTtl);
                    deck = ToDeck(body, DateTimeOffset.UtcNow);
                }
                catch (DataSourceException)
                {
                    deckReason = "unavailable";
                    if (cached is { } stale) deck = ToDeck(stale.Body, stale.Fetched);
                }
            }
        }

        AntiCheatDto? ac = null;
        string? acReason = null;
        if (!_settings.GetBool("dataSources.antiCheat")) acReason = "disabled";
        else
        {
            if (!LocalOnly && AntiCheatStale())
            {
                try { await RefreshAntiCheatAsync(force: false, ct); }
                catch (DataSourceException) { acReason = "unavailable"; }
            }
            if (deckReason != "noSteamId" && steamAppId is { } sid && _repo.GetAntiCheat("steam", sid) is { } row) ac = ToAntiCheat(row);
            else acReason ??= _repo.AntiCheatCount() == 0 ? (LocalOnly ? "offline" : "notLoaded") : "notListed";
        }
        return new CompatDto(deck, deckReason, ac, ac is null ? acReason : null);
    }

    private static DeckDto? ToDeck(string body, DateTimeOffset fetched)
    {
        try
        {
            var r = JsonSerializer.Deserialize<DeckReport>(body, EnrichmentService.Json);
            return r is null ? null : new DeckDto(r.Category, r.Tests, fetched.ToString("O"));
        }
        catch (JsonException) { return null; }
    }

    public static AntiCheatDto ToAntiCheat(AntiCheatRow r) => new(
        r.AntiCheats, r.AntiCheats.Any(AntiCheatClient.KernelLevel.Contains), r.Status,
        r.Status switch
        {
            "Supported" => "Supported on Linux/Steam Deck",
            "Running" => "Runs on Linux/Steam Deck (not officially supported)",
            "Broken" => "Doesn’t work on Linux/Steam Deck",
            "Denied" => "Linux/Steam Deck blocked by the developer",
            _ => "Linux/Steam Deck support planned",
        },
        r.Reference, r.DateChanged, r.Slug);

    private bool AntiCheatStale()
    {
        var last = _repo.GetInternalValue("dataSources.antiCheat.fetched");
        return last is null || !DateTimeOffset.TryParse(last, CultureInfo.InvariantCulture, out var at) || DateTimeOffset.UtcNow - at > AntiCheatTtl || _repo.AntiCheatCount() == 0;
    }

    /// <summary>Downloads AreWeAntiCheatYet's list when it's older than a week (or <paramref name="force"/>). Returns the entry count.</summary>
    public async Task<int> RefreshAntiCheatAsync(bool force, CancellationToken ct)
    {
        RequireOnline();
        await _antiCheatGate.WaitAsync(ct);
        try
        {
            if (!force && !AntiCheatStale()) return _repo.AntiCheatCount();
            var etag = _repo.AntiCheatCount() > 0 && !force ? _repo.GetInternalValue("dataSources.antiCheat.etag") : null;
            var result = await AntiCheat.DownloadAsync(etag, ct);
            if (result is { } r)
            {
                if (r.Rows.Count < 50) throw new DataSourceException(DataSourceOutcome.Malformed, "The anti-cheat list looked incomplete, so it wasn’t used.");
                _repo.ReplaceAntiCheat(r.Rows);
                _repo.SetInternalValue("dataSources.antiCheat.etag", r.ETag);
            }
            _repo.SetInternalValue("dataSources.antiCheat.fetched", DateTimeOffset.UtcNow.ToString("O"));
            return _repo.AntiCheatCount();
        }
        finally
        {
            _antiCheatGate.Release();
        }
    }

    public IReadOnlyDictionary<string, AntiCheatDto> AntiCheatMap() =>
        _settings.GetBool("dataSources.antiCheat")
            ? _repo.AntiCheatForLibrary().GroupBy(x => x.GameId).ToDictionary(g => g.Key, g => ToAntiCheat(g.First().Row))
            : new Dictionary<string, AntiCheatDto>();

    // ---------- Enrichment details for the game page ----------

    public EnrichmentDto GetEnrichment(string gameId)
    {
        var sources = _repo.GetEnrichment(gameId).Select(e =>
        {
            JsonElement? facts = null;
            if (e.Matched)
            {
                try
                {
                    using var doc = JsonDocument.Parse(e.DataJson);
                    facts = doc.RootElement.Clone();
                }
                catch (JsonException) { }
            }
            return new EnrichmentSourceDto(e.Source, e.Source == "igdb" ? "IGDB" : "RAWG", e.Matched, e.MatchMethod, e.Confidence,
                e.Url is null ? null : JsonRead.SafeUrl(e.Url, "igdb.com", "rawg.io"), e.Fetched.ToString("O"), facts);
        }).ToList();
        var canFetch = ProviderReady("igdb") || ProviderReady("rawg");
        var reason = canFetch ? null : LocalOnly ? "offline" : !_settings.GetBool("dataSources.enrichment") ? "disabled" :
            !_keys.IsConfigured(KeyedProvider.Igdb) && !_keys.IsConfigured(KeyedProvider.Rawg) ? "noKeys" : IsGameActive() ? "gameRunning" : null;
        return new EnrichmentDto(sources, _repo.GetFieldSources(gameId), canFetch, reason);
    }

    /// <summary>Fetches details for one game now from every ready source. Returns the filled fields.</summary>
    public async Task<IReadOnlyList<string>> EnrichNowAsync(string gameId, CancellationToken ct)
    {
        var game = _repo.GetGame(gameId) ?? throw new DataSourceException(DataSourceOutcome.Malformed, "That game no longer exists.");
        RequireOnline();
        var filled = new List<string>();
        foreach (var source in new[] { "igdb", "rawg" })
            if (ProviderReady(source)) filled.AddRange(await Enrichment.EnrichAsync(source, gameId, game.Title, game.SteamAppId, game.ReleaseDate, ct));
        return filled.Distinct().ToList();
    }

    // ---------- Library value timeline ----------

    public ValueTimelineDto GetValueTimeline()
    {
        var sources = _repo.LibraryValueSources().Where(s => !s.Hidden).ToList();
        var country = Country;
        var appIds = sources.Where(s => s.SteamAppId is not null).Select(s => $"{country}:{s.SteamAppId}").ToList();
        var prices = _repo.GetProviderCacheMany("steam-price", appIds);
        var games = new List<ValueGameDto>();
        DateTimeOffset? lastPriced = null;
        foreach (var s in sources)
        {
            var (since, label) = Since(s);
            SteamPrice? price = null;
            DateTimeOffset? pricedAt = null;
            if (s.SteamAppId is { } a && prices.TryGetValue($"{country}:{a}", out var c))
            {
                try { price = JsonSerializer.Deserialize<SteamPrice>(c.Body, EnrichmentService.Json); }
                catch (JsonException) { }
                pricedAt = c.Fetched;
                if (lastPriced is null || c.Fetched > lastPriced) lastPriced = c.Fetched;
            }
            games.Add(new ValueGameDto(s.GameId, s.Title, s.Platforms, since.ToString("O"), label, price?.FinalCents, price?.InitialCents, price?.Currency,
                price?.Formatted, price?.NotSold ?? false, pricedAt?.ToString("O")));
        }
        var currency = games.Where(g => g.Currency is not null).GroupBy(g => g.Currency).OrderByDescending(g => g.Count()).FirstOrDefault()?.Key;
        var priced = games.Where(g => g.PriceCents is not null && g.Currency == currency).ToList();
        var enabled = _settings.GetBool("dataSources.storePrices");
        return new ValueTimelineDto(games.OrderBy(g => g.Since, StringComparer.Ordinal).ToList(), currency, priced.Sum(g => g.PriceCents ?? 0), priced.Count,
            games.Count - priced.Count, lastPriced?.ToString("O"), country, enabled, !enabled ? "disabled" : LocalOnly ? "offline" : null);
    }

    /// <summary>
    /// The earliest honest evidence that a game was in the library, with what it is. Steam's Web API
    /// has no purchase dates and VYSTRAL never decrypts Steam's licence cache, so this is "in your
    /// library by", never "bought on".
    /// </summary>
    internal static (DateTimeOffset At, string Source) Since(LibraryValueSource s)
    {
        var candidates = new List<(DateTimeOffset, string)> { (s.Added, "firstSeen") };
        if (s.FirstSession is { } fs) candidates.Add((fs, "firstSession"));
        if (s.FirstAchievement is { } fa) candidates.Add((fa, "firstAchievement"));
        if (s.StoreLastPlayed is { } lp) candidates.Add((lp, "storeLastPlayed"));
        return candidates.OrderBy(c => c.Item1).First();
    }

    /// <summary>Fetches missing or day-old Steam prices for the library (100 apps per request).</summary>
    public async Task<ValueTimelineDto> RefreshPricesAsync(CancellationToken ct)
    {
        if (!_settings.GetBool("dataSources.storePrices")) throw new DataSourceException(DataSourceOutcome.Disabled, "Store prices are turned off in Settings → Data sources.");
        RequireOnline();
        var country = Country;
        var appIds = _repo.LibraryValueSources().Where(s => !s.Hidden && s.SteamAppId is not null).Select(s => s.SteamAppId!).Distinct().ToList();
        var cached = _repo.GetProviderCacheMany("steam-price", appIds.Select(a => $"{country}:{a}").ToList());
        var due = appIds.Where(a => !cached.TryGetValue($"{country}:{a}", out var c) || !c.Fresh).ToList();
        foreach (var chunk in due.Chunk(100))
        {
            if (IsGameActive()) break;
            foreach (var p in await SteamStore.GetPricesAsync(chunk, country, ct))
                _repo.SetProviderCache("steam-price", $"{country}:{p.AppId}", JsonSerializer.Serialize(p, EnrichmentService.Json), PriceTtl);
        }
        return GetValueTimeline();
    }
}
