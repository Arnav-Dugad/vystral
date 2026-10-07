using System.Diagnostics;
using System.Net;
using System.Text.Json.Nodes;
using Vystral.Core.Cloud;
using Vystral.Core.Domain;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Cloud;
using Vystral.Windows.DataSources;
using Vystral.Windows.Discover;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Discover;

/// <summary>Track U: the Discover service end to end against fixtures (no real network; nothing is launched or installed).</summary>
public sealed class DiscoverServiceTests : IDisposable
{
    private sealed class Events : IEventSink
    {
        public List<(string Name, object? Payload)> All { get; } = [];
        public void Emit(string eventName, object? payload) { lock (All) All.Add((eventName, payload)); }
        public List<DiscoverSearchDto> Results() { lock (All) return All.Where(e => e.Name == "discover.results").Select(e => (DiscoverSearchDto)e.Payload!).ToList(); }
    }

    private sealed class NoStarter : ICloudProcessStarter
    {
        public int? Start(ProcessStartInfo info) => throw new InvalidOperationException("Discover must never start anything.");
    }

    private readonly TestDb _t = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly List<HttpRequestMessage> _sent = [];
    private Func<HttpRequestMessage, HttpResponseMessage> _respond;
    private readonly HttpClient _http;
    private readonly SettingsService _settings;
    private readonly DataSourcesService _sources;
    private readonly Events _events = new();
    private CloudPlayService? _cloud;
    private readonly DiscoverService _svc;
    private readonly string _dataRoot;

    public DiscoverServiceTests()
    {
        _respond = Answer;
        _http = new HttpClient(new FakeHandler(r => { lock (_sent) _sent.Add(r); return _respond(r); }));
        _settings = new SettingsService(_t.Repo);
        _dataRoot = Path.Combine(_t.Dir.Path, "data");
        var art = new ArtworkService(new AppPaths(_dataRoot), _t.Repo, _http);
        _sources = new DataSourcesService(_t.Repo, _settings, art, _secrets, _http);
        foreach (var id in new[] { "steamgriddb", "igdb", "rawg", "itad", "cheapshark", "wikidata", "steamdeck", "awacy" })
            _sources.Transport(id).Delay = (_, _) => Task.CompletedTask;
        _svc = new DiscoverService(_t.Repo, _settings, art, _sources, () => _cloud, () => null, _events, _dataRoot, () => false);
    }

    public void Dispose()
    {
        _cloud?.Dispose();
        _http.Dispose();
        _t.Dispose();
    }

    private static HttpResponseMessage Answer(HttpRequestMessage r)
    {
        var url = r.RequestUri!.AbsoluteUri;
        if (url.StartsWith("https://store.steampowered.com/api/storesearch/", StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, DiscoverParsingTests.Fixture("steam_storesearch_portal.json"));
        if (url.StartsWith("https://store.steampowered.com/api/appdetails", StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, DiscoverParsingTests.Fixture("steam_appdetails_620.json"));
        if (url.StartsWith(WikidataClient.Endpoint, StringComparison.Ordinal))
        {
            var body = r.Content!.ReadAsStringAsync().Result;
            return FakeHandler.Json(HttpStatusCode.OK, body.Contains("EntitySearch", StringComparison.Ordinal)
                ? DiscoverParsingTests.Fixture("wikidata_search_portal2.json")
                : Vystral.Tests.DataSources.ProviderParsingTests.Fixture("wikidata_steam_batch.json"));
        }
        if (url.StartsWith("https://store.steampowered.com/saleaction/", StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, Vystral.Tests.DataSources.ProviderParsingTests.Fixture("steam_deck_verified.json").Replace("\"appid\":1245620", "\"appid\":620"));
        return FakeHandler.Json(HttpStatusCode.NotFound, "{}");
    }

    private void Set(string key, bool value) => _settings.Set(key, JsonValue.Create(value));

    private async Task<DiscoverSearchDto> FinalAsync(string query, string channel = "page")
    {
        for (var i = 0; i < 200; i++)
        {
            var done = _events.Results().LastOrDefault(r => r.Query == query && r.Channel == channel && r.Done);
            if (done is not null) return done;
            await Task.Delay(20);
        }
        throw new TimeoutException("The search never finished.");
    }

    // ---------- gates ----------

    [Fact]
    public void Offline_mode_skips_every_source_and_sends_nothing()
    {
        Set("privacy.localOnly", true);
        var r = _svc.Search("portal", "page", 0);
        Assert.True(r.Done);
        Assert.Equal("offline", r.Reason);
        Assert.All(r.Sources, s => Assert.Equal(("skipped", "offline"), (s.State, s.Reason)));
        Assert.Empty(_sent);
        Assert.Equal("offline", _svc.Status().Reason);
    }

    [Fact]
    public void Searching_online_can_be_turned_off()
    {
        Set(DiscoverService.SearchSetting, false);
        var r = _svc.Search("portal", "page", 0);
        Assert.All(r.Sources, s => Assert.Equal("off", s.Reason));
        Assert.Empty(_sent);
    }

    [Fact]
    public void Each_source_keeps_its_own_switch_and_key()
    {
        Set("library.fetchMetadata", false);
        Set("dataSources.wikidata", false);
        var status = _svc.Status().Sources.ToDictionary(s => s.Id, s => s.Reason);
        Assert.Equal("off", status["steam"]);
        Assert.Equal("noKey", status["igdb"]);
        Assert.Equal("noKey", status["rawg"]);
        Assert.Equal("off", status["wikidata"]);

        _secrets.Items["VYSTRAL/RAWG"] = "0123456789abcdef0123456789abcdef";
        Assert.Equal("ready", _svc.Status().Sources.Single(s => s.Id == "rawg").State);
    }

    [Theory]
    [InlineData("p", null)]
    [InlineData("  portal   2 ", "portal 2")]
    [InlineData("por\u0000tal", "portal")]
    public void Queries_are_cleaned_and_need_two_letters(string input, string? expected) => Assert.Equal(expected, DiscoverService.CleanQuery(input));

    [Fact]
    public void Too_long_queries_are_refused()
    {
        Assert.Null(DiscoverService.CleanQuery(new string('a', 101)));
        Assert.Throws<BridgeException>(() => _svc.Search("x", "page", 0));
    }

    // ---------- streaming search ----------

    [Fact]
    public async Task Results_stream_in_per_source_and_merge_steam_with_wikidata()
    {
        var first = _svc.Search("portal 2", "page", 0);
        Assert.False(first.Done);
        Assert.Equal(["pending", "skipped", "skipped", "pending"], first.Sources.Select(s => s.State).ToArray());

        var final = await FinalAsync("portal 2");
        Assert.All(final.Sources.Where(s => s.Id is "steam" or "wikidata"), s => Assert.Equal("done", s.State));
        var p2 = final.Results.First(r => r.Key == "steam-620");
        Assert.Equal(["steam", "wikidata"], p2.Sources); // the same game from two sources, once
        Assert.Contains("xbox", p2.Stores); // Wikidata knows its Microsoft Store ID
        Assert.Equal(2011, p2.Year);
        Assert.Equal(1, final.Results.Count(r => r.SteamAppId == "620"));

        // The Steam request is the public store search, with the price country, and the text escaped.
        var steam = _sent.Single(s => s.RequestUri!.Host == "store.steampowered.com");
        Assert.Equal("/api/storesearch/", steam.RequestUri!.AbsolutePath);
        Assert.Contains("term=portal%202", steam.RequestUri.Query);
        Assert.Contains("cc=US", steam.RequestUri.Query);
    }

    [Fact]
    public async Task Repeated_searches_come_from_the_cache()
    {
        _svc.Search("portal 2", "page", 0);
        await FinalAsync("portal 2");
        var sent = _sent.Count;
        _svc.Search("portal 2", "bar", 0);
        var bar = await FinalAsync("portal 2", "bar");
        Assert.Equal(sent, _sent.Count);
        Assert.True(bar.Results.Count <= DiscoverService.BarResults);
    }

    [Fact]
    public async Task A_new_search_on_a_channel_cancels_the_previous_one()
    {
        var gate = new TaskCompletionSource();
        _svc.FetchOverride = async (source, query, page, ct) =>
        {
            if (query == "first") await gate.Task.WaitAsync(ct);
            return ([new DiscoverHit(source, "1", query, 2000, null, 0, source == "steam" ? new DiscoverIds(Steam: "1") : new DiscoverIds(Wikidata: "Q1"), [], [], [], [])], false);
        };
        _svc.Search("first", "page", 0);
        _svc.Search("second", "page", 0);
        await FinalAsync("second");
        gate.SetResult();
        await Task.Delay(100);
        Assert.DoesNotContain(_events.Results(), r => r.Query == "first");
    }

    [Fact]
    public async Task A_failing_source_is_reported_and_the_others_still_answer()
    {
        _respond = r => r.RequestUri!.Host == "query.wikidata.org" ? FakeHandler.Json(HttpStatusCode.TooManyRequests, "{}") : Answer(r);
        _svc.Search("portal", "page", 0);
        var final = await FinalAsync("portal");
        var wd = final.Sources.Single(s => s.Id == "wikidata");
        Assert.Equal(("failed", "rateLimited"), (wd.State, wd.Reason));
        Assert.Contains(final.Results, r => r.Key == "steam-620");
    }

    [Fact]
    public async Task Pages_after_the_first_only_ask_sources_that_page()
    {
        var asked = new List<(string Source, int Page)>();
        _secrets.Items["VYSTRAL/RAWG"] = "0123456789abcdef0123456789abcdef";
        _svc.FetchOverride = (source, query, page, _) =>
        {
            lock (asked) asked.Add((source, page));
            var hits = Enumerable.Range(0, source == "rawg" ? 20 : 3)
                .Select(i => new DiscoverHit(source, $"{source}-{page}-{i}".Replace("steam-", "").Replace("wikidata-", "Q"), $"Game {source} {page} {i}", 2000 + i, null, i,
                    source switch
                    {
                        "steam" => new DiscoverIds(Steam: $"{page}{i}"),
                        "rawg" => new DiscoverIds(Rawg: $"g-{page}-{i}"),
                        _ => new DiscoverIds(Wikidata: $"Q{page}{i}"),
                    }, [], [], [], []))
                .ToList();
            return Task.FromResult<(IReadOnlyList<DiscoverHit>, bool)>((hits, source == "rawg"));
        };
        _svc.Search("game", "page", 0);
        var p0 = await FinalAsync("game");
        Assert.True(p0.HasMore);
        _svc.Search("game", "page", 1);
        for (var i = 0; i < 100 && _events.Results().Count(r => r.Query == "game" && r.Done) < 2; i++) await Task.Delay(20);
        lock (asked) Assert.Equal([("rawg", 1)], asked.Where(a => a.Page == 1).ToArray());
        var p1 = _events.Results().Last(r => r.Query == "game" && r.Done);
        Assert.Equal(p0.Results.Count + 20, p1.Results.Count); // the next page adds to the same merged list
    }

    [Fact]
    public async Task Library_games_are_marked_in_your_library()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "620", "Portal 2", steamAppId: "620"))]);
        _svc.LibraryChanged();
        _svc.Search("portal 2", "page", 0);
        var final = await FinalAsync("portal 2");
        Assert.NotNull(final.Results[0].LibraryGameId);
        Assert.Equal("620", final.Results[0].SteamAppId);
    }

    // ---------- details, links, deals ----------

    [Fact]
    public async Task Details_combine_steam_wikidata_and_compatibility_with_official_links()
    {
        var d = await _svc.DetailsAsync("steam-620", false, CancellationToken.None);
        Assert.Equal("Portal 2", d.Title);
        Assert.Equal("2011-04-18", d.ReleaseDate);
        Assert.Equal("steam", d.DescriptionSource);
        Assert.Contains("Valve", d.Developers);
        Assert.Equal("$1.99", d.Price!.Formatted);
        Assert.Equal("US", d.Price.Country);
        Assert.Equal(95, d.Metacritic);
        Assert.Equal("verified", d.Deck?.Category);
        Assert.Contains(d.Links, l => l.Id == "steam" && l.Kind == "store");
        Assert.Contains(d.Links, l => l.Id == "wikidata");
        Assert.Contains("igdb:noKey", d.Notes);
        Assert.Equal("off", d.CloudReason);
        Assert.Null(d.LibraryGameId);
        Assert.Contains(d.Credits, c => c.Id == "steam");
        Assert.Equal("https://store.steampowered.com/app/620/", _svc.LinkUrl("steam-620", "steam"));
        Assert.Null(_svc.LinkUrl("steam-620", "evil"));

        // Cached: a second visit sends nothing.
        var sent = _sent.Count;
        await _svc.DetailsAsync("steam-620", false, CancellationToken.None);
        Assert.Equal(sent, _sent.Count);
    }

    [Fact]
    public async Task Details_in_offline_mode_without_anything_cached_explain_why()
    {
        Set("privacy.localOnly", true);
        var ex = await Assert.ThrowsAsync<BridgeException>(() => _svc.DetailsAsync("steam-620", false, CancellationToken.None));
        Assert.Equal("offline", ex.Code);
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task Invalid_keys_are_refused()
    {
        await Assert.ThrowsAsync<BridgeException>(() => _svc.DetailsAsync("steam-1;DROP", false, CancellationToken.None));
    }

    [Fact]
    public void Links_are_only_built_from_valid_ids()
    {
        var links = DiscoverService.LinksFor(new DiscoverIds(Steam: "620", GogPath: "game/portal_2", Epic: "bad slug", Microsoft: "9p3j32ctxlrz", Rawg: "portal-2", Wikidata: "Q1"));
        Assert.Equal(["steam", "gog", "microsoft", "rawg", "wikidata"], links.Select(l => l.Dto.Id).ToArray());
        Assert.Equal("https://apps.microsoft.com/detail/9P3J32CTXLRZ", links.Single(l => l.Dto.Id == "microsoft").Url);
        Assert.All(links, l => Assert.StartsWith("https://", l.Url));
    }

    [Fact]
    public async Task Image_candidates_stay_on_allow_listed_hosts()
    {
        _svc.FetchOverride = (source, query, _, _) => Task.FromResult<(IReadOnlyList<DiscoverHit>, bool)>((source == "steam"
            ? [new DiscoverHit("steam", "5", "Five", null, null, 0, new DiscoverIds(Steam: "5"), [], [], [], [new DiscoverImage("cover", "https://evil.example/x.jpg")])]
            : [], false));
        _svc.Search("five", "page", 0);
        await FinalAsync("five");
        var covers = _svc.ImageCandidates("steam-5", "cover");
        Assert.NotEmpty(covers);
        Assert.All(covers, c => Assert.StartsWith("https://shared.akamai.steamstatic.com/", c.Url));
    }

    [Fact]
    public async Task Data_saver_and_offline_stop_image_downloads()
    {
        var saver = new DiscoverService(_t.Repo, _settings, new ArtworkService(new AppPaths(_dataRoot), _t.Repo, _http), _sources, () => null, () => null, _events, _dataRoot, () => true);
        Assert.Equal((null, "dataSaver"), await saver.ImageAsync("steam-620", "cover", CancellationToken.None));
        Set("privacy.localOnly", true);
        Assert.Equal((null, "offline"), await _svc.ImageAsync("steam-620", "cover", CancellationToken.None));
        Assert.Empty(_sent);
    }

    // ---------- cloud ----------

    [Fact]
    public void Cloud_availability_uses_the_cached_catalogues_by_steam_id_and_title()
    {
        _cloud = new CloudPlayService(_t.Repo, _settings, _http, _events, Path.Combine(_t.Dir.Path, "edge"), () => new CloudEnvironment(null, false, null), new NoStarter(), null, () => null);
        Assert.Equal("off", _svc.CloudFor("Portal 2", "620").Reason);
        _settings.Set("cloud.enabled", JsonValue.Create(true));
        _settings.Set("cloud.market", JsonValue.Create("US"));
        Assert.Equal("noData", _svc.CloudFor("Portal 2", "620").Reason);

        _t.Repo.ReplaceCloudCatalog(CloudServices.GeForceNow, "US", [
            new CloudCatalogEntry(CloudServices.GeForceNow, "11111111-2222-3333-4444-555555555555", "100", "Portal 2", CloudPlayTypes.Ready, false, [new CloudStoreLink(CloudStores.Steam, "620")]),
            new CloudCatalogEntry(CloudServices.GeForceNow, "21111111-2222-3333-4444-555555555555", "101", "Hades", CloudPlayTypes.Ready, false, [new CloudStoreLink(CloudStores.Epic, "hades")]),
        ]);
        _t.Repo.ReplaceCloudCatalog(CloudServices.Xbox, "US", [
            new CloudCatalogEntry(CloudServices.Xbox, "9NBLGGH4R315", "9NBLGGH4R315", "Hades", CloudPlayTypes.Ready, false, [new CloudStoreLink(CloudStores.Xbox, "9NBLGGH4R315")]),
        ]);
        var portal = _svc.CloudFor("Portal 2", "620");
        var gfn = Assert.Single(portal.Options);
        Assert.Equal(("gfn", "store"), (gfn.Service, gfn.Match));
        // A game known only by title: never matched on GeForce NOW (verified IDs only), a likely match on Xbox.
        var hades = _svc.CloudFor("Hades", null);
        var xbox = Assert.Single(hades.Options);
        Assert.Equal(("xbox", "title"), (xbox.Service, xbox.Match));
        Assert.Equal("none", _svc.CloudFor("Unlisted Game", "999").Reason);
    }

    // ---------- watching ----------

    [Fact]
    public async Task Watching_is_a_small_local_json_list()
    {
        await Assert.ThrowsAsync<BridgeException>(() => Task.Run(() => _svc.SetWatching("steam-620", true)));
        await _svc.DetailsAsync("steam-620", false, CancellationToken.None);
        var list = _svc.SetWatching("steam-620", true);
        var item = Assert.Single(list);
        Assert.Equal(("steam-620", "Portal 2", "620", "$1.99"), (item.Key, item.Title, item.SteamAppId, item.PriceWhenAdded));
        Assert.True(File.Exists(Path.Combine(_dataRoot, "ui-state", "discover-watching.json")));
        Assert.True((await _svc.DetailsAsync("steam-620", false, CancellationToken.None)).Watching);
        Assert.Single(new DiscoverWatchStore(_dataRoot).List()); // survives a restart

        Assert.Empty(_svc.SetWatching("steam-620", false));
        Assert.False((await _svc.DetailsAsync("steam-620", false, CancellationToken.None)).Watching);
    }

    [Fact]
    public void An_unreadable_watching_list_is_set_aside_not_deleted()
    {
        var file = Path.Combine(_dataRoot, "ui-state", "discover-watching.json");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, "{ not json");
        var store = new DiscoverWatchStore(_dataRoot);
        Assert.Empty(store.List());
        Assert.Equal("{ not json", File.ReadAllText(file)); // reading never rewrites it
        store.Set(new DiscoverWatchItem("igdb-1", "Some Game", 2020, null, DateTimeOffset.UtcNow.ToString("O"), null), true);
        Assert.Single(Directory.GetFiles(Path.GetDirectoryName(file)!, "discover-watching.unreadable-*.json"));
        Assert.Single(store.List());
    }

    [Fact]
    public void Watching_entries_are_validated_and_capped()
    {
        var store = new DiscoverWatchStore(_dataRoot);
        Assert.Throws<ArgumentException>(() => store.Set(new DiscoverWatchItem("../evil", "x", null, null, "", null), true));
        for (var i = 0; i < DiscoverWatchStore.MaxItems + 5; i++)
            store.Set(new DiscoverWatchItem($"igdb-{i + 1}", $"<b>Game</b> {i}", 2020, "12x", "not a date", null), true);
        var list = store.List();
        Assert.Equal(DiscoverWatchStore.MaxItems, list.Count);
        Assert.Equal($"Game {DiscoverWatchStore.MaxItems + 4}", list[0].Title); // newest first, markup stripped
        Assert.Null(list[0].SteamAppId);
    }

    // ---------- LRU ----------

    [Fact]
    public void The_lru_cache_evicts_the_least_recent_and_expires_entries()
    {
        var now = DateTimeOffset.UtcNow;
        var lru = new LruCache<string, int>(2, TimeSpan.FromMinutes(1), () => now);
        lru.Set("a", 1);
        lru.Set("b", 2);
        Assert.True(lru.TryGet("a", out _));
        lru.Set("c", 3);
        Assert.False(lru.TryGet("b", out _));
        Assert.Equal(1, lru.Get("a"));
        now += TimeSpan.FromMinutes(2);
        Assert.False(lru.TryGet("a", out _));
    }
}
