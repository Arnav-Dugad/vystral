using System.Globalization;
using System.Text.Json;
using Vystral.Core.Files;
using Vystral.Core.Health;
using Vystral.Core.Providers;
using Vystral.Windows.Ai;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Discover;
using Vystral.Windows.Services;
using Vystral.Windows.Services.Maintenance;
using Vystral.Windows.Services.Money;
using Vystral.Windows.Services.Startup;

namespace Vystral.Windows;

public sealed record CacheClearParams(string Id);

public sealed record CacheInfoDto(string Id, long Bytes, int Items, string? Newest, string? Oldest, bool Clearable);

public sealed record CacheClearResult(string Id, long FreedBytes, int Items, int Failed);

// Track D6: app-wide currency (exchange rates), the Data sources health page, the cache viewer and the crash-free streak.
public sealed partial class AppBackend
{
    public const string CurrencySetting = "app.currency";

    private FxService _fx = null!;
    private StartHistoryStore _starts = null!;
    private Timer? _healthSaveTimer;
    private int _healthSavedVersion = -1;
    private readonly SemaphoreSlim _cacheGate = new(1, 1);

    /// <summary>Every cache the viewer shows, in display order. Ids are the only thing the page can name.</summary>
    internal static readonly string[] CacheIds =
        ["art", "thumbs", "trailers", "news", "prices", "ai", "discover", "tags", "friends", "wishlist", "catalogs", "gamePages", "lookups", "fx", "firstPaint"];

    private string ProviderHealthFile => Path.Combine(Paths.Root, "maintenance", "provider-health.json");

    private void RegisterTrackD6Handlers()
    {
        _fx = new FxService(_http, Paths.Root, () => Settings.GetBool("privacy.localOnly"), _events);
        _starts = new StartHistoryStore(Paths.Root);
        try { _starts.Update(h => StartStreak.BeginStart(h, Version, DateTimeOffset.Now, PreviousRunCrashed)); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Log.Warn("startup", "Couldn't record this start", ex: ex); }

        RegisterProviderHealth();
        LoadProviderHealth();
        _healthSaveTimer = new Timer(_ => SaveProviderHealth(), null, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(2));

        // ---- Currency ----
        Dispatcher.Register("fx.rates", _ =>
        {
            if (!SafeMode) _fx.RefreshInBackground();
            return Task.FromResult<object?>(_fx.Status());
        });
        Dispatcher.Register("fx.refresh", async ct => (object?)await _fx.RefreshAsync(manual: true, ct));

        // ---- Data sources health ----
        Dispatcher.Register("providers.health", _ => Task.FromResult<object?>(new
        {
            at = DateTimeOffset.Now.ToString("O", CultureInfo.InvariantCulture),
            offline = Settings.GetBool("privacy.localOnly"),
            providers = ProviderHealthHub.Registry.Snapshot(),
        }));

        // ---- Cache viewer ----
        Dispatcher.Register("caches.list", _ => Task.FromResult<object?>(CacheIds.Select(MeasureCache).ToList()));
        Dispatcher.Register<CacheClearParams>("caches.clear", async (p, ct) =>
        {
            if (p.Id is not { Length: > 0 and <= 24 } id || !CacheIds.Contains(id, StringComparer.Ordinal))
                throw new BridgeException("invalid", "Unknown cache.");
            if (IsGameActive) throw new BridgeException("busy", "Caches aren’t cleared while a game is running. Try again afterwards.");
            if (!await _cacheGate.WaitAsync(0, ct)) throw new BridgeException("busy", "Another cache is being cleared.");
            try
            {
                var result = await Task.Run(() => ClearCache(id), ct);
                Repository.Audit("caches.clear", $"{id}: {result.FreedBytes} bytes, {result.Items} items");
                _events.Emit("caches.cleared", new { id });
                return result;
            }
            finally { _cacheGate.Release(); }
        });

        // ---- Crash-free streak ----
        Dispatcher.Register("about.streak", _ => Task.FromResult<object?>(StreakSummary()));
    }

    // ---------------- currency ----------------

    /// <summary>The currency every price is shown in: the user's choice, else the Windows region's.</summary>
    public string DisplayCurrency()
    {
        var chosen = Settings.GetString(CurrencySetting);
        return Vystral.Core.Money.FxRates.IsCode(chosen) ? chosen : FxService.RegionCurrency();
    }

    // ---------------- crash-free streak ----------------

    private void StartHistoryOnReady()
    {
        if (_starts is null) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(Services.Rollback.StartupGuard.SuccessDelay, _life.Token);
                if (_selfCheckHardFailure) return; // the same rule as StartupProtection: this start isn't confirmed
                _starts.Update(StartStreak.MarkSteady);
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Log.Warn("startup", "Couldn't update the start history", ex: ex); }
        });
    }

    private void StartHistoryOnCleanExit()
    {
        try { _starts?.Update(h => StartStreak.MarkCleanExit(h, _uiReady && !_selfCheckHardFailure)); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        SaveProviderHealth();
    }

    private StreakSummary StreakSummary()
    {
        var incidents = new List<StreakIncident>();
        try
        {
            foreach (var r in (_selfChecks ?? new SelfCheckStore(Paths.Root)).Load().Reports)
                if (!r.Manual && r.Checks.Any(c => c.Outcome == CheckOutcome.Failed))
                    incidents.Add(new StreakIncident(r.At, "selfCheck", r.Version,
                        $"The check after updating to {r.Version} found a problem: {r.Checks.First(c => c.Outcome == CheckOutcome.Failed).Label.ToLowerInvariant()}"));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
        try
        {
            if (_startup?.Load().LastRollback is { } rb)
                incidents.Add(new StreakIncident(rb.At, "rollback", rb.From, $"VYSTRAL {rb.From} didn’t start twice, so it went back to {rb.To}"));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
        return StartStreak.Summarize(_starts.Load(), incidents, DateTimeOffset.Now, TimeZoneInfo.Local);
    }

    // ---------------- cache viewer ----------------

    private static readonly string[] PriceProviders = ["steam-price", "deals-cheapshark", "deals-itad", "cheapshark-stores"];

    private CacheMeasure Files(params string[] rel) => rel.Aggregate(CacheMeasure.Empty, (m, r) => m.Plus(CacheJanitor.Measure(Paths.Root, r)));

    private static CacheMeasure Db(Vystral.Core.Data.DbCacheStats s) => new(s.Bytes, s.Rows, s.Newest, s.Oldest);

    private CacheInfoDto MeasureCache(string id)
    {
        CacheMeasure m;
        try
        {
            m = id switch
            {
                "art" => CacheJanitor.Measure(Paths.Root, @"cache\art", ["_thumbs", "_avatars", "_store"]),
                "thumbs" => Files(@"cache\art\_thumbs", @"cache\art\_avatars", @"cache\art\_store"),
                "trailers" => Files(@"cache\live"),
                "news" => Files(@"cache\news"),
                "prices" => Db(Repository.ProviderCacheStats(PriceProviders)),
                "ai" => Files(@"cache\ai"),
                "discover" => Db(Repository.ProviderCacheStats(DiscoverService.CacheProviders)),
                "tags" => Files(@"cache\game-pages\steam-tags.json", @"cache\game-pages\steam-tag-names.json"),
                "friends" => Files(@"cache\friends-recent.json"),
                "wishlist" => Files(@"cache\wishlist.json"),
                "catalogs" => Files("subscriptions-cache.json").Plus(Db(Repository.CloudCatalogStats())),
                "gamePages" => Files(@"cache\game-pages\steam-reviews.json", @"cache\game-pages\igdb-game-series.json", @"cache\game-pages\igdb-series.json"),
                "lookups" => Files(@"cache\pcgamingwiki.json", @"cache\workshop-titles.json"),
                "fx" => Files(@"cache\fx"),
                "firstPaint" => Files(@"ui-state\first-paint.json"),
                _ => CacheMeasure.Empty,
            };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Microsoft.Data.Sqlite.SqliteException)
        {
            Log.Warn("caches", "Couldn't measure a cache", new { id }, ex);
            m = CacheMeasure.Empty;
        }
        return new CacheInfoDto(id, m.Bytes, m.Files, m.Newest?.ToString("O", CultureInfo.InvariantCulture), m.Oldest?.ToString("O", CultureInfo.InvariantCulture), true);
    }

    private (long Bytes, int Files, int Failed) Wipe(params string[] rel)
    {
        long b = 0;
        int f = 0, failed = 0;
        foreach (var r in rel)
        {
            var (bytes, files, fails) = CacheJanitor.Clear(Paths.Root, r);
            b += bytes; f += files; failed += fails;
        }
        return (b, f, failed);
    }

    /// <summary>
    /// Clears one cache. Every branch removes only downloaded, re-downloadable data: files through the janitor's
    /// allow-list, rows through cache-only queries, and the owning service's memory so nothing points at deleted files.
    /// </summary>
    private CacheClearResult ClearCache(string id)
    {
        var before = MeasureCache(id);
        (long Bytes, int Files, int Failed) r = (0, 0, 0);
        switch (id)
        {
            case "art":
            {
                var snapshot = Library.Snapshot();
                var keep = snapshot.Games.SelectMany(g => Repository.GetArtwork(g.Id).Where(a => a.Value.IsUser).Select(a => a.Value.File))
                    .Concat(_artPacks?.ReferencedFiles() ?? []);
                r = (Artwork.ClearUnreferenced(keep), before.Items, 0);
                Repository.ForgetAllDownloadedArtwork();
                _discover?.ClearDownloadedCaches();
                _events.Emit("library.changed", new { reason = "artwork" });
                _ = Task.Run(async () =>
                {
                    try { await Library.ScanAsync(_life.Token); }
                    catch (OperationCanceledException) { }
                    catch (Exception ex) { Log.Warn("art", "Re-import after clearing the art cache failed", ex: ex); }
                });
                break;
            }
            case "thumbs":
                r = Wipe(@"cache\art\_thumbs", @"cache\art\_avatars", @"cache\art\_store");
                _discover?.ClearDownloadedCaches();
                break;
            case "trailers":
                r = (_liveTiles?.ClearCache() ?? Wipe(@"cache\live").Bytes, before.Items, 0);
                break;
            case "news":
                r = Wipe(@"cache\news");
                break;
            case "prices":
                r = (before.Bytes, Repository.ClearProviderCaches(PriceProviders), 0);
                break;
            case "ai":
                _aiFeatures?.ClearCaches();
                r = Wipe(@"cache\ai");
                r = (before.Bytes, before.Items, r.Failed);
                break;
            case "discover":
                r = (before.Bytes, Repository.ClearProviderCaches(DiscoverService.CacheProviders), 0);
                _discover?.ClearDownloadedCaches();
                break;
            case "tags":
                _tags?.Forget();
                r = (before.Bytes, before.Items, 0);
                _events.Emit("tags.changed", new { done = 0 });
                break;
            case "friends":
                _friendsHistory?.Forget();
                _friends?.Forget();
                r = (before.Bytes, before.Items, 0);
                break;
            case "wishlist":
                _wishlist?.ClearDownloaded();
                r = Wipe(@"cache\art\_thumbs\wishlist");
                r = (before.Bytes > 0 ? r.Bytes : 0, before.Items, r.Failed);
                break;
            case "catalogs":
                _subs?.ClearDownloaded();
                _cloud?.ClearDownloaded();
                r = (before.Bytes, before.Items, 0);
                break;
            case "gamePages":
                _storeInsights?.ClearReviews();
                _franchise?.ClearCache();
                r = (before.Bytes, before.Items, 0);
                break;
            case "lookups":
                r = Wipe(@"cache\pcgamingwiki.json", @"cache\workshop-titles.json");
                break;
            case "fx":
                r = Wipe(@"cache\fx");
                _fx.Forget();
                if (!SafeMode) _fx.RefreshInBackground();
                break;
            case "firstPaint":
                FirstPaint.Clear();
                r = (before.Bytes, before.Items, 0);
                break;
        }
        Log.Info("caches", "Cache cleared", new { id, bytes = r.Bytes, items = r.Files, failed = r.Failed });
        return new CacheClearResult(id, Math.Max(0, r.Bytes), Math.Max(0, r.Files), r.Failed);
    }

    // ---------------- provider health ----------------

    private DateTimeOffset? FileUpdated(string rel)
    {
        var m = CacheJanitor.Measure(Paths.Root, rel);
        return m.Newest;
    }

    private DateTimeOffset? CloudOk(string svc)
    {
        var raw = Repository.GetInternalValue($"cloud.{svc}.lastOk");
        var parts = raw?.Split('|');
        return parts is [_, var at] && DateTimeOffset.TryParse(at, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t) ? t : null;
    }

    /// <summary>
    /// The Data sources health rows. Each provider says whether it may be used right now (its setting, the user's key,
    /// Offline mode) and, if it caches, when the cache last changed. New providers (Track D4) add a row here; see
    /// <see cref="ProviderHealthHub"/> for the reporting side.
    /// </summary>
    private void RegisterProviderHealth()
    {
        var reg = ProviderHealthHub.Registry;
        bool Offline() => Settings.GetBool("privacy.localOnly");
        bool On(string key) => Settings.GetBool(key);
        ProviderAvailability Gate(bool optIn, params (bool Ok, string Why)[] checks)
        {
            if (Offline()) return ProviderAvailability.Off("Offline mode is on", optIn);
            foreach (var (ok, why) in checks) if (!ok) return ProviderAvailability.Off(why, optIn);
            return ProviderAvailability.On(optIn);
        }
        DateTimeOffset? Prices(params string[] p)
        {
            try { return Repository.ProviderCacheStats(p).Newest; }
            catch (Microsoft.Data.Sqlite.SqliteException) { return null; }
        }

        reg.Register(new ProviderDescriptor("steam.webapi", "Steam Web API", "Steam", "steam", "Owned games, achievements, wishlist, friends, news and tags (with your key)"),
            () => Gate(true, (_steamKeys?.IsConfigured ?? false, "Needs your Steam Web API key")));
        reg.Register(new ProviderDescriptor("steam.store", "Steam store", "Steam", "steam", "Game details, prices, reviews, Steam Deck reports, Discover and Workshop titles"),
            () => Gate(false, (On("library.fetchMetadata") || On("discover.searchOnline") || On("dataSources.storePrices"), "Game details, Discover and store prices are off")),
            () => Prices("steam-price", "steamdeck", DiscoverService.CacheProviders[0]));
        reg.Register(new ProviderDescriptor("igdb", "IGDB", "Game details", "igdb", "Genres, descriptions, release dates, series and similar games"),
            () => Gate(true, (_dataSources?.HasKey(KeyedProvider.Igdb) ?? false, "Needs your Twitch app"), (On("dataSources.enrichment"), "Filling in missing details is off")),
            () => FileUpdated(@"cache\game-pages\igdb-game-series.json"));
        reg.Register(new ProviderDescriptor("rawg", "RAWG", "Game details", "rawg", "Missing details and Discover search"),
            () => Gate(true, (_dataSources?.HasKey(KeyedProvider.Rawg) ?? false, "Needs your RAWG key"), (On("dataSources.enrichment"), "Filling in missing details is off")));
        reg.Register(new ProviderDescriptor("steamgriddb", "SteamGridDB", "Artwork", "steamgriddb", "Community covers, heroes, logos and art packs"),
            () => Gate(true, (_dataSources?.HasKey(KeyedProvider.SteamGridDb) ?? false, "Needs your SteamGridDB key")));
        reg.Register(new ProviderDescriptor("wikidata", "Wikidata", "Game details", "wikidata", "The same game across stores (for duplicate suggestions and links)"),
            () => Gate(false, (On("dataSources.wikidata"), "Turned off")));
        reg.Register(new ProviderDescriptor("itad", "IsThereAnyDeal", "Prices", "itad", "Current deals and the lowest price ever, in your region"),
            () => Gate(true, (_dataSources?.HasKey(KeyedProvider.IsThereAnyDeal) ?? false, "Needs your IsThereAnyDeal key")),
            () => Prices("deals-itad"));
        reg.Register(new ProviderDescriptor("cheapshark", "CheapShark", "Prices", "cheapshark", "Deals and the lowest price ever (US dollars)"),
            () => Gate(false, (On("dataSources.cheapshark"), "Turned off")),
            () => Prices("deals-cheapshark", "cheapshark-stores"));
        reg.Register(new ProviderDescriptor("fx", "Exchange rates", "Prices", null, "Daily rates from Frankfurter (European Central Bank and other central banks) to show prices in your currency"),
            () => Gate(false),
            () => _fx?.Current?.FetchedAt);
        reg.Register(new ProviderDescriptor("pcgamingwiki", "PCGamingWiki", "Game details", "pcgamingwiki", "Where games keep their save files"),
            () => Gate(true, (On("dataSources.pcgamingwiki"), "Turned off")),
            () => FileUpdated(@"cache\pcgamingwiki.json"));
        reg.Register(new ProviderDescriptor("awacy", "AreWeAntiCheatYet", "Game details", "awacy", "Anti-cheat notes on game pages"),
            () => Gate(false, (On("dataSources.antiCheat"), "Turned off")));
        reg.Register(new ProviderDescriptor("gfn.catalog", "GeForce NOW catalogue", "Cloud & subscriptions", "geforce-now", "Which of your games stream on GeForce NOW"),
            () => Gate(true, (On("cloud.enabled"), "Cloud play is off"), (On("cloud.gfn"), "GeForce NOW is off")),
            () => CloudOk("gfn"));
        reg.Register(new ProviderDescriptor("gfn.status", "GeForce NOW status", "Cloud & subscriptions", "geforce-now", "Whether GeForce NOW is up right now"),
            () => Gate(true, (On("cloud.enabled"), "Cloud play is off"), (On("cloud.gfn"), "GeForce NOW is off")));
        reg.Register(new ProviderDescriptor("gamepass.catalog", "Game Pass catalogue", "Cloud & subscriptions", "game-pass", "What your plans include, leaving soon, and Xbox Cloud Gaming"),
            () => Gate(true, (On("subs.catalog") || (On("cloud.enabled") && On("cloud.xbox")), "Off: turn on “Show what my plans include” or Xbox Cloud Gaming")),
            () => _subs?.ListsDownloadedAt ?? CloudOk("xbox"));
        reg.Register(new ProviderDescriptor("msstore", "Microsoft Store", "Cloud & subscriptions", "xbox-cloud", "Names and posters for Game Pass and cloud games"),
            () => Gate(true, (On("subs.catalog") || (On("cloud.enabled") && On("cloud.xbox")), "Only used with the Game Pass lists")));
        foreach (var p in CloudAiProviders.All)
        {
            var provider = p;
            reg.Register(new ProviderDescriptor($"ai-{CloudAiProviders.Id(p)}", CloudAiProviders.Name(p), "Cloud AI", null, $"Optional AI features through {CloudAiProviders.Company(p)}, with your own key"),
                () => Gate(true, (_cloudAi?.IsConfigured(provider) ?? false, "No key added"), (_cloudAi?.OptedIn(provider) ?? false, "Turned off")));
        }
    }

    private sealed record HealthFile(List<ProviderCounters> Providers);

    private void LoadProviderHealth()
    {
        try
        {
            var data = JsonFileCache.Read<HealthFile>(ProviderHealthFile, 64 * 1024);
            ProviderHealthHub.Registry.Import(data?.Providers);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
    }

    private void SaveProviderHealth()
    {
        var v = ProviderHealthHub.Registry.Version;
        if (v == _healthSavedVersion) return;
        if (JsonFileCache.Write(ProviderHealthFile, new HealthFile(ProviderHealthHub.Registry.Export().ToList()))) _healthSavedVersion = v;
    }
}
