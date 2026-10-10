using System.Globalization;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Integrations;

namespace Vystral.Windows.Services;

public sealed record WishlistPointDto(string Day, long Cents);

/// <summary>One wishlisted game. Money is in the currency's minor units (cents), as Steam reports it.</summary>
public sealed record WishlistItemDto(
    string AppId,
    string Name,
    int Priority,
    string? Added,
    string? ReleaseDate,
    bool ComingSoon,
    string? ReleaseText,
    bool IsFree,
    long? PriceCents,
    long? RegularCents,
    int Discount,
    string? Currency,
    string? PriceText,
    bool NotSold,
    long? LowestCents,
    string? LowestCurrency,
    string? LowestSource,
    string? LowestAt,
    IReadOnlyList<WishlistPointDto> History,
    string? Header,
    string? GameId,
    string? PricedAt);

/// <summary>
/// Status: ok | empty | off | notConnected | noAccount | offline | invalidKey | unavailable | rateLimited | notLoaded.
/// <c>Stale</c>: these are the last results VYSTRAL got (the latest refresh didn't finish).
/// </summary>
public sealed record WishlistDto(
    string Status,
    string? Message,
    string? FetchedAt,
    bool Stale,
    bool Refreshing,
    int Count,
    IReadOnlyList<WishlistItemDto> Items,
    string? RetryAt,
    string Country,
    string? LowestSource);

/// <summary>A "Released!" or "Lowest price ever" moment, for the Windows notification.</summary>
public sealed record WishlistAlert(string Kind, string AppId, string Name, string? PriceText);

/// <summary>Cached wishlist entry (JSON). Mutable so a refresh can update it in place.</summary>
public sealed class WishlistCacheItem
{
    public string AppId { get; set; } = "";
    public int Priority { get; set; }
    public DateTimeOffset? Added { get; set; }
    public DateTimeOffset FirstSeen { get; set; }
    public string? Name { get; set; }
    public DateTimeOffset? Release { get; set; }
    public bool ComingSoon { get; set; }
    public string? ReleaseText { get; set; }
    public bool IsFree { get; set; }
    public string? HeaderUrl { get; set; }
    public string? HeaderFile { get; set; }
    public DateTimeOffset? StoreFetched { get; set; }
    public long? PriceCents { get; set; }
    public long? RegularCents { get; set; }
    public int Discount { get; set; }
    public string? Currency { get; set; }
    public string? PriceText { get; set; }
    public bool NotSold { get; set; }
    public DateTimeOffset? PricedAt { get; set; }
    public long? LowCents { get; set; }
    public string? LowCurrency { get; set; }
    public string? LowSource { get; set; }
    public string? LowAt { get; set; }
    public DateTimeOffset? LowFetched { get; set; }
    public List<WishlistPointDto> History { get; set; } = [];
    public bool NotifiedReleased { get; set; }
    public long? NotifiedLowCents { get; set; }
}

public sealed class WishlistCache
{
    public int Version { get; set; } = 1;
    public string? Account { get; set; }
    public string Country { get; set; } = "US";
    public DateTimeOffset? Fetched { get; set; }
    public List<WishlistCacheItem> Items { get; set; } = [];
}

/// <summary>
/// Track W: the user's Steam wishlist (opt-in, <c>wishlist.sync</c>, off by default). Reads the official
/// IWishlistService with the user's own key, store facts (names, release dates, header art) through
/// IStoreBrowseService, current prices through the store's price_overview (the same lane as the library
/// value timeline), and the lowest price ever from IsThereAnyDeal (the user's key) or CheapShark (US
/// dollars), a few games per refresh. Each refresh records the Steam price, so VYSTRAL draws its own
/// price history over time. Never in Offline mode or while a game runs; Data saver stops automatic
/// refreshes and image downloads. Everything is cached in one JSON file in the data folder.
/// </summary>
public sealed class WishlistService
{
    public const string SettingKey = "wishlist.sync";
    public static readonly TimeSpan AutoInterval = TimeSpan.FromHours(12);
    public static readonly TimeSpan ManualMinInterval = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan StoreInfoMaxAge = TimeSpan.FromHours(24);
    public static readonly TimeSpan LowMaxAge = TimeSpan.FromDays(3);
    internal const int MaxStoreLookups = 400;
    internal const int MaxPriceLookups = 600;
    internal const int MaxLowLookupsPerRefresh = 20;
    internal const int MaxHeadersPerRefresh = 60;
    internal const int MaxHistory = 120;
    private const long MaxCacheBytes = 8 * 1024 * 1024;

    private readonly SteamApiKeyStore _keys;
    private readonly SteamWebApiClient _api;
    private readonly SettingsService _settings;
    private readonly ArtworkService _artwork;
    private readonly DataSourcesService _sources;
    private readonly Func<string?> _steamId;
    private readonly Func<IReadOnlyDictionary<string, string>> _appToGame;
    private readonly IEventSink _events;
    private readonly string _file;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Lock _lock = new();

    private WishlistCache? _cache;
    private bool _loaded;
    private int _refreshing;
    private DateTimeOffset _lastAttempt = DateTimeOffset.MinValue;
    private DateTimeOffset _retryAt = DateTimeOffset.MinValue;
    private int _failures;
    private (string Status, string Message)? _lastError;

    public Func<bool> IsGameActive { get; set; } = () => false;
    public Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

    public WishlistService(SteamApiKeyStore keys, SteamWebApiClient api, SettingsService settings, ArtworkService artwork, DataSourcesService sources,
        Func<string?> steamId, Func<IReadOnlyDictionary<string, string>> appToGame, IEventSink events, string cacheFile)
    {
        _keys = keys;
        _api = api;
        _settings = settings;
        _artwork = artwork;
        _sources = sources;
        _steamId = steamId;
        _appToGame = appToGame;
        _events = events;
        _file = cacheFile;
    }

    private bool LocalOnly => _settings.GetBool("privacy.localOnly");
    private bool DataSaver => _artwork.SkipDownloads?.Invoke() == true;
    public bool IsRefreshing => Volatile.Read(ref _refreshing) == 1;

    // ---------- Reading ----------

    public WishlistDto Get()
    {
        var country = _sources.Country;
        if (!_settings.GetBool(SettingKey)) return Empty("off", null, country);
        if (!_keys.IsConfigured) return Empty("notConnected", null, country);
        if (_steamId() is not { } steamId) return Empty("noAccount", "No Steam account has signed in on this PC yet.", country);
        var cache = Cache(steamId);
        var note = LocalOnly ? "Offline mode is on, so this is the wishlist saved on this PC." : null;
        if (cache?.Fetched is null)
        {
            if (LocalOnly) return Empty("offline", "Offline mode is on, so VYSTRAL doesn’t ask Steam for your wishlist.", country);
            if (_lastError is { } e && !IsRefreshing) return Empty(e.Status, e.Message, country) with { RetryAt = RetryText() };
            return Empty("notLoaded", null, country) with { Refreshing = IsRefreshing };
        }
        IReadOnlyDictionary<string, string> library;
        try { library = _appToGame(); }
        catch (Exception ex) { Log.Warn("wishlist", "Couldn't map Steam apps to games", ex: ex); library = new Dictionary<string, string>(); }
        List<WishlistItemDto> items;
        lock (_lock) items = cache.Items.Where(i => i.Name is not null).Select(i => ToDto(i, library)).ToList();
        var status = cache.Items.Count == 0 ? "empty" : "ok";
        var message = note ?? (_lastError is { } err ? err.Message : status == "empty"
            ? "Steam didn’t list any games. If your wishlist isn’t empty, check that your Steam profile’s Game details are public."
            : null);
        return new WishlistDto(status, message, cache.Fetched?.ToString("O"), _lastError is not null, IsRefreshing, cache.Items.Count, items,
            _lastError is null ? null : RetryText(), cache.Country, LowestSourceName());
    }

    private string? LowestSourceName() =>
        _sources.HasKey(KeyedProvider.IsThereAnyDeal) ? "IsThereAnyDeal" : _settings.GetBool("dataSources.cheapshark") ? "CheapShark" : null;

    private string? RetryText() => _retryAt > Now() ? _retryAt.ToString("O") : null;

    private WishlistItemDto ToDto(WishlistCacheItem i, IReadOnlyDictionary<string, string> library) => new(
        i.AppId, i.Name!, i.Priority, i.Added?.ToString("O"), i.Release?.ToString("O"), i.ComingSoon, i.ReleaseText, i.IsFree,
        i.PriceCents, i.RegularCents, i.Discount, i.Currency, i.PriceText, i.NotSold,
        i.LowCents, i.LowCurrency, i.LowSource, i.LowAt, i.History.ToList(),
        _artwork.CachedFileExists(i.HeaderFile) ? ArtworkService.Url("", i.HeaderFile!) : null,
        library.TryGetValue(i.AppId, out var gid) ? gid : null, i.PricedAt?.ToString("O"));

    private static WishlistDto Empty(string status, string? message, string country) => new(status, message, null, false, false, 0, [], null, country, null);

    /// <summary>The store page for an app on the cached wishlist (built from the validated appid), or null.</summary>
    public Uri? StoreUrl(string appId)
    {
        if (appId.Length is 0 or > 10 || !appId.All(char.IsAsciiDigit)) return null;
        var steamId = _steamId();
        var cache = steamId is null ? null : Cache(steamId);
        lock (_lock)
            return cache?.Items.Any(i => i.AppId == appId) == true ? new Uri($"https://store.steampowered.com/app/{appId}/") : null;
    }

    // ---------- Refreshing ----------

    /// <summary>
    /// Starts a refresh in the background when allowed. Manual refreshes may run every <see cref="ManualMinInterval"/>
    /// (also with Data saver on); automatic ones every <see cref="AutoInterval"/>. Returns false with a reason otherwise.
    /// </summary>
    public (bool Started, string? Reason) StartRefresh(bool manual, CancellationToken life)
    {
        if (!_settings.GetBool(SettingKey)) return (false, "off");
        if (!_keys.IsConfigured) return (false, "notConnected");
        if (_steamId() is not { } steamId) return (false, "noAccount");
        if (LocalOnly) return (false, "offline");
        if (IsGameActive()) return (false, "gameRunning");
        if (!manual && DataSaver) return (false, "dataSaver");
        var now = Now();
        var cache = Cache(steamId);
        if (manual ? now - _lastAttempt < ManualMinInterval : (now < _retryAt || cache?.Fetched is { } f && now - f < AutoInterval)) return (false, "recent");
        if (Interlocked.Exchange(ref _refreshing, 1) == 1) return (false, "running");
        _lastAttempt = now;
        _ = Task.Run(async () =>
        {
            try { await RefreshAsync(steamId, life); }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Error("wishlist", "Wishlist refresh failed", ex); }
            finally
            {
                Volatile.Write(ref _refreshing, 0);
                _events.Emit("wishlist.changed", new { refreshing = false });
            }
        }, CancellationToken.None);
        return (true, null);
    }

    /// <summary>Runs one refresh now (tests and the background loop use it directly).</summary>
    internal async Task RefreshAsync(string steamId, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var country = _sources.Country;
            var cache = Cache(steamId) ?? new WishlistCache { Account = JsonFileCache.AccountKey(steamId) };
            if (cache.Country != country)
            {
                // Prices are per country: forget them (and their history) rather than mix currencies.
                foreach (var i in cache.Items) ResetPrices(i);
                cache.Country = country;
            }
            var now = Now();
            IReadOnlyList<WishlistEntry> entries;
            try
            {
                entries = await _api.GetWishlistAsync(steamId, ct);
            }
            catch (SteamApiException ex)
            {
                Fail(ex);
                return;
            }

            var before = cache.Items.ToDictionary(i => i.AppId, StringComparer.Ordinal);
            var next = new List<WishlistCacheItem>(entries.Count);
            foreach (var e in entries)
            {
                var item = before.TryGetValue(e.AppId, out var known) ? known : new WishlistCacheItem { AppId = e.AppId, FirstSeen = now };
                item.Priority = e.Priority;
                item.Added = e.Added;
                next.Add(item);
            }
            // Snapshots of what the previous refresh knew, so alerts are only raised for real changes.
            var previous = next.Where(i => before.ContainsKey(i.AppId)).ToDictionary(i => i.AppId, Snapshot, StringComparer.Ordinal);
            lock (_lock)
            {
                cache.Items = next;
                cache.Fetched = now;
            }

            // Store facts (names, release, header URL) for new and day-old entries.
            var needStore = next.Where(i => i.Name is null || i.StoreFetched is null || now - i.StoreFetched > StoreInfoMaxAge).Take(MaxStoreLookups).ToList();
            try
            {
                foreach (var batch in needStore.Chunk(SteamWebApiClient.StoreItemsBatch))
                {
                    if (IsGameActive()) break;
                    var infos = await _api.GetStoreItemsAsync(batch.Select(i => i.AppId).ToList(), country, "english", ct);
                    var map = infos.ToDictionary(x => x.AppId, StringComparer.Ordinal);
                    lock (_lock)
                    {
                        foreach (var i in batch)
                        {
                            if (!map.TryGetValue(i.AppId, out var info)) continue;
                            ApplyStoreInfo(i, info, now);
                        }
                    }
                }
            }
            catch (SteamApiException ex)
            {
                Log.Info("wishlist", "Store details stopped for this refresh", new { outcome = ex.Outcome.ToString() });
            }
            Save(cache);
            _events.Emit("wishlist.changed", new { refreshing = true });

            // Current prices in the user's price country (store price_overview, 100 apps per request).
            try
            {
                foreach (var chunk in next.Where(i => !i.IsFree).Select(i => i.AppId).Take(MaxPriceLookups).Chunk(100))
                {
                    if (IsGameActive() || LocalOnly) break;
                    var prices = await _sources.SteamStore.GetPricesAsync(chunk, country, ct);
                    lock (_lock)
                        foreach (var p in prices)
                            if (next.FirstOrDefault(i => i.AppId == p.AppId) is { } item) ApplyPrice(item, p, now);
                }
            }
            catch (DataSourceException ex)
            {
                Log.Info("wishlist", "Prices stopped for this refresh", new { outcome = ex.Outcome.ToString() });
            }

            await RefreshLowsAsync(next, country, now, ct);
            if (!DataSaver) await CacheHeadersAsync(next, ct);

            var alerts = new List<WishlistAlert>();
            lock (_lock)
                foreach (var i in next)
                    alerts.AddRange(Alerts(previous.TryGetValue(i.AppId, out var p) ? p : null, i, now));
            Save(cache);
            _failures = 0;
            _retryAt = DateTimeOffset.MinValue;
            _lastError = null;
            Log.Info("wishlist", "Wishlist refreshed", new { items = next.Count, alerts = alerts.Count });
            if (alerts.Count > 0)
                _events.Emit("wishlist.alerts", new { items = alerts.Take(6).Select(a => new { kind = a.Kind, appId = a.AppId, name = a.Name, price = a.PriceText }).ToList() });
        }
        finally
        {
            _gate.Release();
        }
    }

    private void Fail(SteamApiException ex)
    {
        _failures++;
        _retryAt = Now() + FriendsActivityService.Backoff(ex.Outcome, _failures);
        var status = ex.Outcome switch
        {
            SteamApiOutcome.InvalidKey => "invalidKey",
            SteamApiOutcome.RateLimited => "rateLimited",
            _ => "unavailable",
        };
        _lastError = (status, ex.Message);
        Log.Info("wishlist", "Wishlist refresh failed", new { status, failures = _failures });
    }

    /// <summary>Lowest price ever: IsThereAnyDeal with the user's key (their price country), else CheapShark (US dollars).</summary>
    private async Task RefreshLowsAsync(List<WishlistCacheItem> items, string country, DateTimeOffset now, CancellationToken ct)
    {
        var itad = _sources.HasKey(KeyedProvider.IsThereAnyDeal);
        var cheapshark = !itad && _settings.GetBool("dataSources.cheapshark");
        if (!itad && !cheapshark) return;
        var source = itad ? "itad" : "cheapshark";
        var due = items
            .Where(i => !i.IsFree && !i.NotSold && i.Name is not null && (i.LowFetched is null || i.LowSource != source || now - i.LowFetched > LowMaxAge))
            .OrderByDescending(i => i.Discount > 0).ThenBy(i => i.LowFetched ?? DateTimeOffset.MinValue).ThenBy(i => i.Priority)
            .Take(MaxLowLookupsPerRefresh).ToList();
        foreach (var item in due)
        {
            if (IsGameActive() || LocalOnly) return;
            try
            {
                var quote = itad
                    ? await _sources.Itad.GetBySteamAppIdAsync(item.AppId, country, ct)
                    : await _sources.CheapShark.GetBySteamAppIdAsync(item.AppId, () => new Dictionary<string, string>(), _ => { }, ct);
                lock (_lock) ApplyLow(item, quote, source, now);
            }
            catch (DataSourceException ex)
            {
                // One provider problem ends this phase; the rest wait for the next refresh.
                Log.Info("wishlist", "Lowest-price lookups stopped for this refresh", new { provider = source, outcome = ex.Outcome.ToString() });
                return;
            }
        }
    }

    private async Task CacheHeadersAsync(List<WishlistCacheItem> items, CancellationToken ct)
    {
        var wanted = items.Where(i => i.HeaderUrl is not null && !_artwork.CachedFileExists(i.HeaderFile)).Take(MaxHeadersPerRefresh).ToList();
        using var lane = new SemaphoreSlim(3, 3);
        await Task.WhenAll(wanted.Select(async i =>
        {
            await lane.WaitAsync(ct);
            try
            {
                if (IsGameActive() || DataSaver) return;
                // HeaderUrl was built natively from the appid and Steam-shaped asset names (see SteamWebApiClient.HeaderUrl).
                var rel = await _artwork.CacheThumbAsync(i.HeaderUrl!, "wishlist", ct);
                if (rel is not null) lock (_lock) i.HeaderFile = rel;
            }
            finally { lane.Release(); }
        }));
    }

    // ---------- Pure steps (unit-tested) ----------

    internal static void ApplyStoreInfo(WishlistCacheItem item, StoreItemInfo info, DateTimeOffset now)
    {
        item.Name = info.Name;
        item.Release = info.ReleaseDate;
        item.ComingSoon = info.ComingSoon;
        item.ReleaseText = info.ReleaseText;
        item.IsFree = info.IsFree;
        item.HeaderUrl = info.HeaderUrl;
        item.StoreFetched = now;
    }

    /// <summary>Records the current Steam price and adds it to the history when it changed (one point per day).</summary>
    internal static void ApplyPrice(WishlistCacheItem item, SteamPrice price, DateTimeOffset now)
    {
        item.PricedAt = now;
        if (price.NotSold || price.FinalCents is null || price.Currency is null)
        {
            item.NotSold = !item.IsFree && price.NotSold;
            item.PriceCents = null;
            item.RegularCents = null;
            item.Discount = 0;
            item.PriceText = null;
            return;
        }
        if (item.Currency is { } c && c != price.Currency)
        {
            // Steam changed the currency for this country: older points aren't comparable.
            item.History.Clear();
            item.LowCents = null;
            item.LowFetched = null;
        }
        item.NotSold = false;
        item.PriceCents = price.FinalCents;
        item.RegularCents = price.InitialCents ?? price.FinalCents;
        item.Discount = price.DiscountPercent;
        item.Currency = price.Currency;
        item.PriceText = price.Formatted;
        var day = now.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        // One point per day (the latest price that day); runs of equal prices are compacted below.
        if (item.History.Count > 0 && item.History[^1].Day == day)
            item.History[^1] = new WishlistPointDto(day, price.FinalCents.Value);
        else
            item.History.Add(new WishlistPointDto(day, price.FinalCents.Value));
        Compact(item.History);
    }

    /// <summary>
    /// Keeps the history small: a run of three or more equal prices keeps only its first and last point
    /// (the line looks the same), and at most <see cref="MaxHistory"/> points remain.
    /// </summary>
    internal static void Compact(List<WishlistPointDto> history)
    {
        for (var i = history.Count - 2; i >= 1; i--)
            if (history[i].Cents == history[i - 1].Cents && history[i].Cents == history[i + 1].Cents) history.RemoveAt(i);
        if (history.Count > MaxHistory) history.RemoveRange(0, history.Count - MaxHistory);
    }

    internal static void ApplyLow(WishlistCacheItem item, PriceQuote? quote, string source, DateTimeOffset now)
    {
        item.LowFetched = now;
        item.LowSource = source;
        if (quote?.HistoricalLow is not { } low || low < 0 || quote.Currency is not { Length: 3 } currency)
        {
            item.LowCents = null;
            item.LowCurrency = null;
            item.LowAt = null;
            return;
        }
        item.LowCents = (long)Math.Round(low * 100, MidpointRounding.AwayFromZero);
        item.LowCurrency = currency;
        item.LowAt = quote.HistoricalLowAt;
    }

    private static void ResetPrices(WishlistCacheItem i)
    {
        i.PriceCents = i.RegularCents = null;
        i.Discount = 0;
        i.Currency = i.PriceText = null;
        i.PricedAt = null;
        i.History.Clear();
        i.LowCents = null;
        i.LowCurrency = i.LowSource = i.LowAt = null;
        i.LowFetched = null;
        i.NotifiedLowCents = null;
    }

    internal sealed record ItemSnapshot(bool Known, bool ComingSoon, long? PriceCents, string? Currency);

    private static ItemSnapshot Snapshot(WishlistCacheItem i) => new(i.Name is not null, i.ComingSoon, i.PriceCents, i.Currency);

    /// <summary>
    /// "Released!" when a game that was coming soon at the previous refresh is out now (within three days of its
    /// date); "lowest price ever" when the Steam price dropped since the previous refresh to (or below) the lowest
    /// price the price source has recorded, in the same currency. Each fires once per game (per price).
    /// Nothing fires for a game seen for the first time, so turning the feature on never floods notifications.
    /// </summary>
    internal static IEnumerable<WishlistAlert> Alerts(ItemSnapshot? before, WishlistCacheItem after, DateTimeOffset now)
    {
        if (before is not { Known: true } || after.Name is null) yield break;
        if (before.ComingSoon && !after.ComingSoon && !after.NotifiedReleased &&
            (after.Release is null || (now - after.Release.Value).Duration() < TimeSpan.FromDays(3)))
        {
            after.NotifiedReleased = true;
            yield return new WishlistAlert("released", after.AppId, after.Name, after.PriceText);
        }
        if (after.PriceCents is { } price and > 0 && before.PriceCents is { } was && price < was && before.Currency == after.Currency &&
            after.LowCents is { } low && after.LowCurrency == after.Currency && price <= low && after.NotifiedLowCents != price)
        {
            after.NotifiedLowCents = price;
            yield return new WishlistAlert(price < low ? "newLow" : "atLow", after.AppId, after.Name, after.PriceText);
        }
    }

    // ---------- Cache file ----------

    private WishlistCache? Cache(string steamId)
    {
        lock (_lock)
        {
            if (!_loaded)
            {
                _cache = Validate(JsonFileCache.Read<WishlistCache>(_file, MaxCacheBytes));
                _loaded = true;
            }
            if (_cache is not null && _cache.Account != JsonFileCache.AccountKey(steamId))
            {
                // Another Steam account: this wishlist isn't theirs.
                _cache = null;
                JsonFileCache.Delete(_file);
            }
            return _cache;
        }
    }

    private void Save(WishlistCache cache)
    {
        lock (_lock)
        {
            _cache = cache;
            JsonFileCache.Write(_file, cache);
        }
    }

    /// <summary>
    /// Track D6 (cache viewer): forgets what was downloaded for the wishlist — store facts, header pictures (their files
    /// are cleared with the thumbnails) and lowest prices — so the next sync fetches them again. The price history
    /// VYSTRAL recorded and which alerts were already sent are kept: Steam can't give those back.
    /// </summary>
    public void ClearDownloaded()
    {
        lock (_lock)
        {
            if (!_loaded)
            {
                _cache = Validate(JsonFileCache.Read<WishlistCache>(_file, MaxCacheBytes));
                _loaded = true;
            }
            if (_cache is null) return;
            _cache.Fetched = null;
            foreach (var i in _cache.Items)
            {
                i.HeaderFile = null;
                i.StoreFetched = null;
                i.LowFetched = null;
            }
            JsonFileCache.Write(_file, _cache);
        }
        _lastAttempt = DateTimeOffset.MinValue;
        _retryAt = DateTimeOffset.MinValue;
    }

    /// <summary>When the wishlist was last synced (for the cache viewer).</summary>
    public DateTimeOffset? LastSynced
    {
        get
        {
            lock (_lock)
            {
                if (!_loaded) return null;
                return _cache?.Fetched;
            }
        }
    }

    /// <summary>Removes the cached wishlist (feature turned off, key removed).</summary>
    public void Forget()
    {
        lock (_lock)
        {
            _cache = null;
            _loaded = true;
            JsonFileCache.Delete(_file);
        }
        _lastError = null;
        _failures = 0;
        _retryAt = DateTimeOffset.MinValue;
        _lastAttempt = DateTimeOffset.MinValue;
    }

    /// <summary>Everything read back from disk is checked again (the file sits in a user-writable folder).</summary>
    internal static WishlistCache? Validate(WishlistCache? c)
    {
        if (c is null || c.Version != 1 || c.Account is not { Length: 16 } || !c.Account.All(char.IsAsciiHexDigitLower)) return null;
        if (c.Country is not { Length: 2 } || !c.Country.All(char.IsAsciiLetterUpper)) c.Country = "US";
        c.Items = (c.Items ?? []).Where(i => i is not null && i.AppId is { Length: > 0 and <= 10 } && i.AppId.All(char.IsAsciiDigit))
            .DistinctBy(i => i.AppId).Take(SteamWebApiClient.MaxWishlist).ToList();
        foreach (var i in c.Items)
        {
            i.Name = SteamWebApiClient.CleanText(i.Name, 160);
            i.ReleaseText = SteamWebApiClient.CleanText(i.ReleaseText, 60);
            i.PriceText = SteamWebApiClient.CleanText(i.PriceText, 24);
            i.Currency = i.Currency is { Length: 3 } cur && cur.All(char.IsAsciiLetterUpper) ? cur : null;
            i.LowCurrency = i.LowCurrency is { Length: 3 } lc && lc.All(char.IsAsciiLetterUpper) ? lc : null;
            i.LowSource = i.LowSource is "itad" or "cheapshark" ? i.LowSource : null;
            i.LowAt = i.LowAt is { Length: <= 40 } at && DateTimeOffset.TryParse(at, CultureInfo.InvariantCulture, DateTimeStyles.None, out _) ? at : null;
            i.Discount = Math.Clamp(i.Discount, 0, 100);
            if (i.PriceCents is < 0 or > 100_000_000) i.PriceCents = null;
            if (i.RegularCents is < 0 or > 100_000_000) i.RegularCents = null;
            if (i.LowCents is < 0 or > 100_000_000) i.LowCents = null;
            i.HeaderUrl = i.HeaderUrl is { } h && h.StartsWith("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/" + i.AppId + "/", StringComparison.Ordinal) &&
                          h.Length <= 300 && !h.Contains("..", StringComparison.Ordinal) ? h : null;
            i.HeaderFile = i.HeaderFile is { } f && f.StartsWith("_thumbs/wishlist/", StringComparison.Ordinal) && f.Length <= 60 && !f.Contains("..", StringComparison.Ordinal) ? f : null;
            i.History = (i.History ?? []).Where(p => p is not null && p.Day is { Length: 10 } && DateOnly.TryParseExact(p.Day, "yyyy-MM-dd", out _) && p.Cents is >= 0 and <= 100_000_000)
                .TakeLast(MaxHistory).ToList();
        }
        return c;
    }
}
