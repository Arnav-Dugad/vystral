using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Integrations;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.TrackW;

public sealed class WishlistServiceTests : IDisposable
{
    private const string Key = "0123456789ABCDEF0123456789ABCDEF";
    private const string SteamId = "76561197960287930";
    private static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, (byte)'J', (byte)'F', (byte)'I', (byte)'F', 0, 1, 1, 0, 0, 1];

    private readonly TestDb _t = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly SettingsService _settings;
    private readonly ArtworkService _artwork;
    private readonly FakeHandler _handler;
    private readonly WishlistService _svc;
    private readonly Events _events = new();
    private readonly string _file;
    private DateTimeOffset _now = new(2026, 3, 10, 12, 0, 0, TimeSpan.Zero);
    private string _steamId = SteamId;
    private bool _dataSaver;
    private bool _gameRunning;
    private long _hadesPrice = 2499;
    private bool _bgComingSoon = true;
    private HttpStatusCode _wishlistStatus = HttpStatusCode.OK;

    private sealed class Events : IEventSink
    {
        public List<(string Name, string Json)> All { get; } = [];
        public void Emit(string eventName, object? payload) { lock (All) All.Add((eventName, JsonSerializer.Serialize(payload, BridgeDispatcher.Json))); }
    }

    public WishlistServiceTests()
    {
        _handler = new FakeHandler(Respond);
        var http = new HttpClient(_handler);
        var keys = new SteamApiKeyStore(_secrets);
        var api = new SteamWebApiClient(http, keys.Get) { Delay = (_, _) => Task.CompletedTask };
        _settings = new SettingsService(_t.Repo);
        _artwork = new ArtworkService(new AppPaths(_t.Dir.Dir("data")), _t.Repo, http) { SkipDownloads = () => _dataSaver };
        var sources = new DataSourcesService(_t.Repo, _settings, _artwork, _secrets, http);
        sources.Transport("steamdeck").Delay = (_, _) => Task.CompletedTask;
        sources.Transport("cheapshark").Delay = (_, _) => Task.CompletedTask;
        _file = Path.Combine(_t.Dir.Dir("data"), "cache", "wishlist.json");
        _svc = new WishlistService(keys, api, _settings, _artwork, sources, () => _steamId, () => new Dictionary<string, string> { ["620"] = new('d', 32) },
            _events, _file)
        {
            IsGameActive = () => _gameRunning,
            Now = () => _now,
        };
    }

    public void Dispose() => _t.Dispose();

    private HttpResponseMessage Respond(HttpRequestMessage req)
    {
        var uri = req.RequestUri!;
        if (uri.Host == "shared.akamai.steamstatic.com")
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Jpeg) { Headers = { ContentType = new("image/jpeg") } } };
        if (uri.AbsolutePath.Contains("GetWishlist"))
            return _wishlistStatus != HttpStatusCode.OK ? FakeHandler.Json(_wishlistStatus, "") : FakeHandler.Json(HttpStatusCode.OK,
                """{"response":{"items":[{"appid":1145360,"priority":1,"date_added":1693526400},{"appid":1086940,"priority":2,"date_added":1700000000},{"appid":620,"priority":3}]}}""");
        if (uri.AbsolutePath.Contains("IStoreBrowseService"))
            return FakeHandler.Json(HttpStatusCode.OK, $$$"""
                {"response":{"store_items":[
                  {"id":1145360,"success":1,"name":"Hades","appid":1145360,"release":{"steam_release_date":1600300800,"is_coming_soon":false},"assets":{"asset_url_format":"steam/apps/1145360/${FILENAME}?t=1","header":"header.jpg"}},
                  {"id":1086940,"success":1,"name":"Baldur's Gate 3","appid":1086940,"release":{"steam_release_date":{{{_now.AddHours(-2).ToUnixTimeSeconds()}}},"is_coming_soon":{{{(_bgComingSoon ? "true" : "false")}}}}},
                  {"id":620,"success":1,"name":"Portal 2","appid":620,"is_free":true}
                ]}}
                """);
        if (uri.Host == "store.steampowered.com" && uri.AbsolutePath == "/api/appdetails")
        {
            var overview = JsonSerializer.Serialize(new
            {
                currency = "USD", initial = 2499, final = _hadesPrice, discount_percent = (int)Math.Round((1 - _hadesPrice / 2499.0) * 100),
                final_formatted = "$" + (_hadesPrice / 100.0).ToString("0.00", System.Globalization.CultureInfo.InvariantCulture),
            });
            return FakeHandler.Json(HttpStatusCode.OK, """{"1145360":{"success":true,"data":{"price_overview":""" + overview + """}},"1086940":{"success":true,"data":[]}}""");
        }
        if (uri.Host == "www.cheapshark.com" && uri.Query.Contains("steamAppID=1145360"))
            return FakeHandler.Json(HttpStatusCode.OK, """[{"gameID":"777","steamAppID":"1145360"}]""");
        if (uri.Host == "www.cheapshark.com" && uri.Query.Contains("id=777"))
            return FakeHandler.Json(HttpStatusCode.OK, """{"info":{"title":"Hades"},"cheapestPriceEver":{"price":"9.99","date":1690000000},"deals":[]}""");
        if (uri.Host == "www.cheapshark.com")
            return FakeHandler.Json(HttpStatusCode.OK, "[]");
        return FakeHandler.Json(HttpStatusCode.NotFound, "");
    }

    private void Enable()
    {
        _secrets.Write(SteamApiKeyStore.Target, Key);
        _settings.Set(WishlistService.SettingKey, JsonValue.Create(true));
    }

    private Task Refresh() => _svc.RefreshAsync(_steamId, TestContext.Current.CancellationToken);

    [Fact]
    public void Off_by_default_then_needs_a_key_and_an_account()
    {
        Assert.False(_settings.GetBool(WishlistService.SettingKey));
        Assert.Equal("off", _svc.Get().Status);
        _settings.Set(WishlistService.SettingKey, JsonValue.Create(true));
        Assert.Equal("notConnected", _svc.Get().Status);
        _secrets.Write(SteamApiKeyStore.Target, Key);
        Assert.Equal("notLoaded", _svc.Get().Status);
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public void Offline_mode_game_running_and_data_saver_stop_refreshes()
    {
        Enable();
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        Assert.Equal((false, "offline"), _svc.StartRefresh(manual: true, TestContext.Current.CancellationToken));
        Assert.Equal("offline", _svc.Get().Status);
        _settings.Set("privacy.localOnly", JsonValue.Create(false));
        _gameRunning = true;
        Assert.Equal((false, "gameRunning"), _svc.StartRefresh(manual: true, TestContext.Current.CancellationToken));
        _gameRunning = false;
        _dataSaver = true;
        Assert.Equal((false, "dataSaver"), _svc.StartRefresh(manual: false, TestContext.Current.CancellationToken));
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public async Task Refresh_reads_wishlist_store_facts_prices_and_lowest_price()
    {
        Enable();
        await Refresh();
        var w = _svc.Get();
        Assert.Equal("ok", w.Status);
        Assert.Equal(3, w.Count);
        var hades = w.Items.Single(i => i.AppId == "1145360");
        Assert.Equal("Hades", hades.Name);
        Assert.Equal(2499, hades.PriceCents);
        Assert.Equal("USD", hades.Currency);
        Assert.Equal(999, hades.LowestCents);         // CheapShark's lowest ever, in cents
        Assert.Equal("USD", hades.LowestCurrency);
        Assert.Equal("cheapshark", hades.LowestSource);
        Assert.Single(hades.History);
        Assert.StartsWith("https://art.vystral.example/_thumbs/wishlist/", hades.Header);
        var portal = w.Items.Single(i => i.AppId == "620");
        Assert.True(portal.IsFree);
        Assert.Equal(new string('d', 32), portal.GameId);   // already in the library
        Assert.True(w.Items.Single(i => i.AppId == "1086940").ComingSoon);
        Assert.Equal("CheapShark", w.LowestSource);

        // Only Steam's API host, Steam's store, Steam's CDN and CheapShark were contacted; the key went only to Steam's API.
        Assert.All(_handler.Requests, u => Assert.Contains(u.Host, new[] { "api.steampowered.com", "store.steampowered.com", "shared.akamai.steamstatic.com", "www.cheapshark.com" }));
        Assert.All(_handler.Requests.Where(u => u.Query.Contains(Key)), u => Assert.Equal("api.steampowered.com", u.Host));
        Assert.True(File.Exists(_file));
        Assert.DoesNotContain(SteamId, File.ReadAllText(_file)); // the cache never holds the SteamID
        Assert.DoesNotContain(_events.All, e => e.Name == "wishlist.alerts"); // first sight never notifies
    }

    [Fact]
    public async Task Release_and_lowest_price_notify_once_and_history_grows()
    {
        Enable();
        await Refresh();

        _now = _now.AddDays(1).AddHours(1); // store facts are a day old now
        _bgComingSoon = false;   // released today
        _hadesPrice = 999;       // matches the lowest price ever
        await Refresh();
        var alerts = _events.All.Where(e => e.Name == "wishlist.alerts").ToList();
        Assert.Single(alerts);
        Assert.Contains("\"kind\":\"released\"", alerts[0].Json);
        Assert.Contains("\"kind\":\"atLow\"", alerts[0].Json);
        Assert.Contains("Baldur", alerts[0].Json);

        var hades = _svc.Get().Items.Single(i => i.AppId == "1145360");
        Assert.Equal([2499L, 999L], hades.History.Select(p => p.Cents));
        Assert.Equal(60, hades.Discount);

        // Same state again: nothing new to say.
        _now = _now.AddDays(1);
        await Refresh();
        Assert.Single(_events.All, e => e.Name == "wishlist.alerts");

        // A new all-time low notifies again.
        _now = _now.AddDays(1);
        _hadesPrice = 749;
        await Refresh();
        var last = _events.All.Last(e => e.Name == "wishlist.alerts");
        Assert.Contains("\"kind\":\"newLow\"", last.Json);
        Assert.Equal([2499L, 999L, 999L, 749L], _svc.Get().Items.Single(i => i.AppId == "1145360").History.Select(p => p.Cents));
    }

    [Fact]
    public async Task Cache_survives_a_restart_and_is_dropped_for_another_account()
    {
        Enable();
        await Refresh();
        var keys = new SteamApiKeyStore(_secrets);
        var again = new WishlistService(keys, new SteamWebApiClient(new HttpClient(_handler), keys.Get), _settings, _artwork,
            new DataSourcesService(_t.Repo, _settings, _artwork, _secrets, new HttpClient(_handler)), () => _steamId, () => new Dictionary<string, string>(), _events, _file);
        Assert.Equal(3, again.Get().Count);
        _steamId = "76561197960287931";
        Assert.Equal("notLoaded", again.Get().Status);
        Assert.False(File.Exists(_file));
    }

    [Fact]
    public async Task Rejected_key_is_reported_and_backed_off()
    {
        Enable();
        _wishlistStatus = HttpStatusCode.Forbidden;
        await Refresh();
        var w = _svc.Get();
        Assert.Equal("invalidKey", w.Status);
        Assert.NotNull(w.RetryAt);
        Assert.Equal((false, "recent"), _svc.StartRefresh(manual: false, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Turning_it_off_forgets_the_wishlist()
    {
        Enable();
        await Refresh();
        _svc.Forget();
        Assert.False(File.Exists(_file));
        Assert.Equal("notLoaded", _svc.Get().Status);
    }

    [Fact]
    public async Task Store_links_are_built_only_for_wishlisted_apps()
    {
        Enable();
        await Refresh();
        Assert.Equal("https://store.steampowered.com/app/1145360/", _svc.StoreUrl("1145360")!.AbsoluteUri);
        Assert.Null(_svc.StoreUrl("730"));
        Assert.Null(_svc.StoreUrl("1145360/../../evil"));
        Assert.Null(_svc.StoreUrl(""));
    }

    // ---------- Pure steps ----------

    [Fact]
    public void Price_history_keeps_one_point_per_day_and_compacts_flat_runs()
    {
        var item = new WishlistCacheItem { AppId = "1" };
        var day = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        WishlistService.ApplyPrice(item, new SteamPrice("1", 1000, 1000, 0, "USD", "$10.00", false), day);
        WishlistService.ApplyPrice(item, new SteamPrice("1", 900, 1000, 10, "USD", "$9.00", false), day.AddHours(5)); // same day: replaced
        Assert.Equal([900L], item.History.Select(p => p.Cents));
        for (var i = 1; i <= 5; i++) WishlistService.ApplyPrice(item, new SteamPrice("1", 900, 1000, 10, "USD", "$9.00", false), day.AddDays(i));
        Assert.Equal(2, item.History.Count);                    // a flat run keeps its ends only
        Assert.Equal("2026-01-06", item.History[^1].Day);
        WishlistService.ApplyPrice(item, new SteamPrice("1", 900, 1000, 10, "EUR", "9,00€", false), day.AddDays(9));
        Assert.Single(item.History);                            // another currency: older points dropped
        WishlistService.ApplyPrice(item, new SteamPrice("1", null, null, 0, null, null, true), day.AddDays(10));
        Assert.True(item.NotSold);
        Assert.Null(item.PriceCents);
    }

    [Fact]
    public void History_is_capped()
    {
        var item = new WishlistCacheItem { AppId = "1" };
        var day = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        for (var i = 0; i < 400; i++) WishlistService.ApplyPrice(item, new SteamPrice("1", 1000 + i % 2, 1000, 0, "USD", null, false), day.AddDays(i));
        Assert.Equal(WishlistService.MaxHistory, item.History.Count);
    }

    [Fact]
    public void Hostile_cache_files_are_cleaned_on_read()
    {
        var c = new WishlistCache
        {
            Account = "0123456789abcdef",
            Country = "../",
            Items =
            [
                new() { AppId = "1", Name = "Ok‮", Currency = "usd", LowSource = "evil", Discount = 900, PriceCents = -5,
                        HeaderUrl = "https://evil.example/x.jpg", HeaderFile = "../../secrets.txt",
                        History = [new("2026-01-01", 5), new("not a day", 5), new("2026-01-02", -1)] },
                new() { AppId = "../../x" },
                new() { AppId = "1" },
            ],
        };
        var v = WishlistService.Validate(c)!;
        Assert.Equal("US", v.Country);
        var i = Assert.Single(v.Items);
        Assert.Equal("Ok", i.Name);
        Assert.Null(i.Currency);
        Assert.Null(i.LowSource);
        Assert.Equal(100, i.Discount);
        Assert.Null(i.PriceCents);
        Assert.Null(i.HeaderUrl);
        Assert.Null(i.HeaderFile);
        Assert.Single(i.History);
        Assert.Null(WishlistService.Validate(new WishlistCache { Account = "not-hex" }));
        Assert.Null(WishlistService.Validate(new WishlistCache { Account = "0123456789abcdef", Version = 2 }));
    }

    [Fact]
    public void Lowest_price_is_read_in_minor_units()
    {
        var item = new WishlistCacheItem { AppId = "1" };
        var now = DateTimeOffset.UtcNow;
        WishlistService.ApplyLow(item, new PriceQuote("itad", "EUR", [], 12.345, null, null, now), "itad", now);
        Assert.Equal(1235, item.LowCents);
        Assert.Equal("EUR", item.LowCurrency);
        WishlistService.ApplyLow(item, null, "itad", now);
        Assert.Null(item.LowCents);
        Assert.Equal(now, item.LowFetched);  // a miss is remembered too, so it isn't asked again at once
    }
}
