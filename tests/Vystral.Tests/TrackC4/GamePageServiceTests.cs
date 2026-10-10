using System.Net;
using System.Text.Json.Nodes;
using Vystral.Core.Domain;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.GamePage;
using Vystral.Windows.Integrations;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.TrackC4;

/// <summary>Track C4: the game-page services against a fake network: gates, caching, stale fallbacks and library matching.</summary>
public sealed class GamePageServiceTests : IDisposable
{
    private readonly TestDb _t = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly SettingsService _settings;
    private readonly FakeHandler _handler;
    private readonly HttpClient _http;
    private readonly string _cache;
    private DateTimeOffset _now = new(2026, 3, 10, 12, 0, 0, TimeSpan.Zero);
    private bool _gameRunning;
    private bool _steamDown;
    private readonly List<string> _events = [];

    private sealed class Sink(List<string> names) : IEventSink
    {
        public void Emit(string eventName, object? payload) { lock (names) names.Add(eventName); }
    }

    public GamePageServiceTests()
    {
        _handler = new FakeHandler(Respond);
        _http = new HttpClient(_handler);
        _settings = new SettingsService(_t.Repo);
        _cache = _t.Dir.Dir("cache");
    }

    public void Dispose() => _t.Dispose();

    private HttpResponseMessage Respond(HttpRequestMessage req)
    {
        var uri = req.RequestUri!;
        if (_steamDown && uri.Host.EndsWith("steampowered.com", StringComparison.Ordinal)) return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
        if (uri.AbsolutePath.StartsWith("/appreviews/", StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, GamePageParsingTests.Fixture(uri.Query.Contains("date_range_type=include") ? "reviews-recent.json" : "reviews-all.json"));
        if (uri.AbsolutePath == "/api/appdetails") return FakeHandler.Json(HttpStatusCode.OK, GamePageParsingTests.Fixture("storefacts.json"));
        if (uri.AbsolutePath.Contains("GetTagList")) return FakeHandler.Json(HttpStatusCode.OK, GamePageParsingTests.Fixture("taglist.json"));
        if (uri.AbsolutePath.Contains("IStoreBrowseService/GetItems")) return FakeHandler.Json(HttpStatusCode.OK, GamePageParsingTests.Fixture("storetags.json"));
        if (uri.Host == "id.twitch.tv") return FakeHandler.Json(HttpStatusCode.OK, """{"access_token":"abcdefghij0123456789","expires_in":3600}""");
        if (uri.Host == "api.igdb.com")
        {
            var body = req.Content!.ReadAsStringAsync().Result;
            if (uri.AbsolutePath.EndsWith("/external_games", StringComparison.Ordinal)) return FakeHandler.Json(HttpStatusCode.OK, """[{"id":9,"game":72,"uid":"620"}]""");
            if (body.Contains("collections.name")) return FakeHandler.Json(HttpStatusCode.OK, GamePageParsingTests.Fixture("igdb-series-of.json"));
            if (body.Contains("collections = (87)")) return FakeHandler.Json(HttpStatusCode.OK, GamePageParsingTests.Fixture("igdb-series-games.json"));
            return FakeHandler.Json(HttpStatusCode.OK, "[]");
        }
        return FakeHandler.Json(HttpStatusCode.NotFound, "");
    }

    private int Requests(string part) { lock (_handler.Requests) return _handler.Requests.Count(u => u.AbsoluteUri.Contains(part, StringComparison.Ordinal)); }

    private void Set(string key, bool value) => _settings.Set(key, JsonValue.Create(value));

    private StoreInsightsService Insights()
    {
        var transport = new ProviderTransport(_http, "steamdeck", "Steam", TimeSpan.Zero) { Delay = (_, _) => Task.CompletedTask };
        return new StoreInsightsService(new SteamStoreInsightsClient(transport), _settings, () => "GB", _cache) { Now = () => _now, IsGameActive = () => _gameRunning };
    }

    // ---------- Reviews ----------

    [Fact]
    public async Task Reviews_compare_all_time_with_the_last_30_days_and_are_cached_for_a_day()
    {
        var svc = Insights();
        var r = await svc.GetReviewsAsync("620", false, default);
        Assert.Equal("ok", r.Status);
        Assert.Equal(468106, r.AllTime!.Total);
        Assert.Equal(98.7, r.AllTime.Percent);
        Assert.Equal(2239, r.Recent!.Total);
        Assert.Equal("steady", r.Trend);
        Assert.Equal(2, Requests("/appreviews/620"));
        await svc.GetReviewsAsync("620", false, default);
        Assert.Equal(2, Requests("/appreviews/620")); // cached
        // A fresh service reads the same JSON cache from disk.
        Assert.Equal("ok", (await Insights().GetReviewsAsync("620", false, default)).Status);
        Assert.Equal(2, Requests("/appreviews/620"));
    }

    [Fact]
    public async Task Reviews_respect_the_settings_offline_and_running_games()
    {
        Set("dataSources.steamReviews", false);
        Assert.Equal("off", (await Insights().GetReviewsAsync("620", false, default)).Status);
        Set("dataSources.steamReviews", true);
        Set("library.fetchMetadata", false);
        Assert.Equal("off", (await Insights().GetReviewsAsync("620", false, default)).Status);
        Set("library.fetchMetadata", true);
        Assert.Equal("notSteam", (await Insights().GetReviewsAsync(null, false, default)).Status);
        Assert.Equal("notSteam", (await Insights().GetReviewsAsync("../620", false, default)).Status);
        _gameRunning = true;
        Assert.Equal("gameRunning", (await Insights().GetReviewsAsync("620", false, default)).Status);
        _gameRunning = false;
        Set("privacy.localOnly", true);
        Assert.Equal("offline", (await Insights().GetReviewsAsync("620", false, default)).Status);
        Assert.Equal(0, Requests("/appreviews/"));
    }

    [Fact]
    public async Task A_failed_refresh_keeps_the_saved_reviews_marked_stale()
    {
        var svc = Insights();
        await svc.GetReviewsAsync("620", false, default);
        _now = _now.AddDays(2);
        _steamDown = true;
        var r = await svc.GetReviewsAsync("620", false, default);
        Assert.Equal("unavailable", r.Status);
        Assert.True(r.Stale);
        Assert.Equal(468106, r.AllTime!.Total);
    }

    // ---------- Store facts ----------

    [Fact]
    public async Task Store_facts_record_a_price_history_per_country()
    {
        var svc = Insights();
        var f = await svc.GetFactsAsync("620", false, default);
        Assert.Equal("ok", f.Status);
        Assert.Equal("GB", f.Country);
        Assert.Equal(819, f.PriceCents);
        Assert.Equal(95, f.Metacritic);
        Assert.Single(f.History);
        _now = _now.AddDays(2);
        f = await svc.GetFactsAsync("620", false, default);
        Assert.Equal(2, f.History.Count);
        Assert.Contains("cc=GB", _handler.Requests.First(u => u.AbsolutePath == "/api/appdetails").Query);
        Set("dataSources.storePrices", false);
        Assert.Equal("off", (await svc.GetFactsAsync("620", false, default)).Status);
    }

    // ---------- Tags ----------

    private SteamTagsService Tags(IReadOnlyDictionary<string, string> library)
    {
        var api = new SteamWebApiClient(_http, () => null) { Delay = (_, _) => Task.CompletedTask };
        return new SteamTagsService(api, _settings, () => library, new Sink(_events), _cache) { Now = () => _now, IsGameActive = () => _gameRunning };
    }

    [Fact]
    public async Task Game_tags_have_names_and_need_no_key()
    {
        var svc = Tags(new Dictionary<string, string>());
        var t = await svc.ForAppAsync("620", false, default);
        Assert.Equal("ok", t.Status);
        Assert.Equal("Platformer", t.Tags[0].Name); // 4182 is not in the trimmed name list, so the strongest named tag leads
        Assert.All(t.Tags, x => Assert.False(string.IsNullOrEmpty(x.Name)));
        Assert.Equal(1, Requests("GetTagList"));
        await svc.ForAppAsync("620", false, default);
        Assert.Equal(1, Requests("IStoreBrowseService"));
        Assert.DoesNotContain(_handler.Requests, u => u.Query.Contains("key=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Library_tags_fill_in_the_background_and_turning_off_forgets_them()
    {
        var a = new string('a', 32);
        var b = new string('b', 32);
        var svc = Tags(new Dictionary<string, string> { ["620"] = a, ["440"] = b });
        Assert.Equal(0, svc.Library().Covered);
        Assert.True(svc.StartRefresh(default));
        for (var i = 0; i < 200 && svc.Library().Refreshing; i++) await Task.Delay(10);
        var lib = svc.Library();
        Assert.Equal(2, lib.Covered);
        Assert.Equal(2, lib.SteamGames);
        Assert.NotEmpty(lib.Games[a]);
        Assert.Contains(lib.Tags, x => x.Name == "Action" && x.Count == 2);
        Assert.Contains("tags.changed", _events);
        Assert.False(svc.StartRefresh(default)); // nothing due (and within the cooldown)
        svc.Forget();
        Assert.Equal(0, svc.Library().Covered);
        Set("dataSources.steamTags", false);
        Assert.Equal("off", svc.Library().Status);
        Assert.False(svc.StartRefresh(default));
    }

    // ---------- Franchise ----------

    private FranchiseService Franchise()
    {
        Assert.True(new DataSourceKeyStore(_secrets).SetTwitch("abcdefghijklmnopqrstuvwxyz0123", "zyxwvutsrqponmlkjihgfedcba9876"));
        var art = new ArtworkService(new AppPaths(_t.Dir.Dir("data")), _t.Repo, _http);
        var sources = new DataSourcesService(_t.Repo, _settings, art, _secrets, _http);
        sources.Transport("igdb").Delay = (_, _) => Task.CompletedTask;
        return new FranchiseService(sources, _t.Repo, art, _settings, _cache) { Now = () => _now, IsGameActive = () => _gameRunning };
    }

    [Fact]
    public async Task Franchise_lights_up_owned_games_by_steam_app_or_title()
    {
        _t.Repo.ApplyScan([
            TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "620", "Portal 2", steamAppId: "620")),
            TestDb.Ok(PlatformId.Gog, TestDb.Install(PlatformId.Gog, "1207665503", "Portal")),
        ]);
        var portal2 = _t.Repo.SteamAppToGame()["620"];
        var svc = Franchise();
        var f = await svc.ForLibraryGameAsync(portal2, false, default);
        Assert.Equal("ok", f.Status);
        Assert.Equal("Portal", f.Name);
        Assert.Equal("series", f.Kind);
        Assert.Equal(2, f.Owned);
        Assert.True(f.Entries.Single(e => e.Name == "Portal 2").Current);
        Assert.Equal(portal2, f.Entries.Single(e => e.Name == "Portal 2").GameId);
        Assert.NotNull(f.Entries.Single(e => e.Name == "Portal").GameId); // matched by title (GOG copy)
        Assert.Equal("steam-400", f.Entries.Single(e => e.Name == "Portal").DiscoverKey);
        Assert.Equal("igdb-555", f.Entries.Single(e => e.Name == "Portal Stories: Mel").DiscoverKey);
        Assert.Equal("expansion", f.Entries.Single(e => e.Name == "Portal Stories: Mel").Type);

        // Cached: a Discover page for the same game asks IGDB nothing new.
        var before = Requests("api.igdb.com");
        var d = await svc.ForDiscoverAsync("igdb-72", null, false, default);
        Assert.Equal("ok", d.Status);
        Assert.Equal(before, Requests("api.igdb.com"));
    }

    [Fact]
    public async Task Franchise_says_why_it_cant_ask()
    {
        var svc = Franchise();
        Set("privacy.localOnly", true);
        Assert.Equal("offline", (await svc.ForDiscoverAsync("igdb-72", null, false, default)).Status);
        Set("privacy.localOnly", false);
        Set("dataSources.enrichment", false);
        Assert.Equal("off", (await svc.ForDiscoverAsync("igdb-72", null, false, default)).Status);
        Set("dataSources.enrichment", true);
        Assert.Equal("notMatched", (await svc.ForDiscoverAsync("rawg-some-game", null, false, default)).Status);
        Assert.Equal(0, Requests("api.igdb.com"));
        new DataSourceKeyStore(_secrets).Clear(KeyedProvider.Igdb);
        Assert.Equal("noKey", (await svc.ForDiscoverAsync("igdb-72", null, false, default)).Status);
    }
}
