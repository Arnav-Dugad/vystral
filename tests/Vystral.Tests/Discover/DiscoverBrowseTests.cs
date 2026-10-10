using System.Net;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Discover;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Discover;

/// <summary>Track C3: the parsers behind Discover's browse shelves (fixtures shaped like Steam's and IGDB's real answers).</summary>
public sealed class DiscoverBrowseParsingTests
{
    private static string Fixture(string name) => DiscoverParsingTests.Fixture(name);

    [Fact]
    public void Featured_categories_keep_apps_only_with_validated_ids_prices_and_images()
    {
        var f = DiscoverBrowseParsers.ParseFeaturedCategories(Fixture("steam_featuredcategories.json"));
        Assert.Equal(["coming_soon", "daily_deal", "new_releases", "specials", "top_sellers"], f.Sections.Keys.Order().ToArray());

        var specials = f.Sections["specials"];
        Assert.DoesNotContain(specials, i => i.AppId == "12345"); // a package, not an app
        Assert.DoesNotContain(specials, i => i.Name == "Broken id");
        var permafrost = specials.Single(i => i.AppId == "2254990");
        Assert.Equal(new StorePrice(1999, 2499, "USD"), permafrost.Price);
        Assert.Equal(20, permafrost.DiscountPercent);
        Assert.Equal(["PC"], permafrost.Platforms);
        Assert.Single(permafrost.Images, i => i.Kind == "header" && i.Url.StartsWith("https://shared.akamai.steamstatic.com/", StringComparison.Ordinal));
        Assert.Empty(specials.Single(i => i.AppId == "1808500").Images); // a header on another host is dropped

        // The same app twice is listed once; a coming-soon 0 is "no price yet", not "free".
        Assert.Single(f.Sections["top_sellers"], i => i.AppId == "4165890");
        Assert.All(f.Sections["coming_soon"], i => Assert.Null(i.Price));
        Assert.Equal("436780", Assert.Single(f.Sections["daily_deal"]).AppId);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("\"text\"")]
    [InlineData("{\"top_sellers\":{\"items\":\"nope\"}}")]
    public void Featured_categories_tolerate_wrong_shapes(string json)
    {
        if (json.StartsWith('{')) Assert.Empty(DiscoverBrowseParsers.ParseFeaturedCategories(json).Sections["top_sellers"]);
        else Assert.Throws<DataSourceException>(() => DiscoverBrowseParsers.ParseFeaturedCategories(json));
    }

    [Fact]
    public void Featured_categories_refuse_oversized_and_unreadable_answers()
    {
        Assert.Throws<DataSourceException>(() => DiscoverBrowseParsers.ParseFeaturedCategories(new string(' ', DiscoverBrowseParsers.MaxBodyChars + 1)));
        Assert.Throws<DataSourceException>(() => DiscoverBrowseParsers.ParseFeaturedCategories("{not json"));
    }

    [Fact]
    public void Store_items_say_what_is_a_game_and_what_steam_hides()
    {
        var items = DiscoverBrowseParsers.ParseStoreItems(Fixture("steam_storeitems_featured.json")).ToDictionary(i => i.AppId);
        Assert.True(items["2254990"].Showable);
        Assert.False(items["4165890"].Showable); // hardware
        Assert.False(items["3055670"].Showable); // DLC
        Assert.False(items["5113440"].Showable); // soundtrack
        Assert.False(items["9990001"].Showable); // adult-only content descriptors
        Assert.False(items["5176690"].Showable); // not visible
        Assert.True(items["1551980"].Showable); // "some nudity" alone is shown, as on Steam

        // Hashed art, through the artwork pipeline's validation (a format pointing at another app is ignored).
        Assert.Contains(items["2254990"].Images, i => i.Kind == "cover" && i.Url.Contains("/steam/apps/2254990/145d58f9", StringComparison.Ordinal));
        Assert.Contains(items["2254990"].Images, i => i.Kind == "hero");
        Assert.Empty(items["1808500"].Images);

        // Release dates only as exact as Steam promises.
        Assert.Equal(("2026-11-01", 2026), (items["4843280"].ReleaseDate, items["4843280"].Year));
        Assert.True(items["4843280"].ComingSoon);
        Assert.Equal("2026-12", items["3627560"].ReleaseDate);
        Assert.Null(items["5332620"].ReleaseDate);
        Assert.Equal(2028, items["5332620"].Year);
        Assert.Equal([1662, 1695, 492, 4182], items["2254990"].TagIds);
        Assert.True(items["4711830"].Free);
    }

    [Fact]
    public void Store_query_reads_prices_totals_and_free_games()
    {
        var page = DiscoverBrowseParsers.ParseStoreQuery(Fixture("steam_storequery_racing.json"));
        Assert.Equal(4473, page.Total);
        var sonic = page.Items.Single(i => i.AppId == "2486820");
        Assert.Equal(2799, sonic.FinalCents);
        Assert.Equal(30, sonic.DiscountPercent);
        Assert.Equal("$27.99", sonic.PriceText);
        Assert.Equal(2025, sonic.Year);

        var free = DiscoverBrowseParsers.ParseStoreQuery(Fixture("steam_storequery_free.json"));
        Assert.Equal(6, free.Items.Count(i => i.Showable && i.Free));
    }

    [Fact]
    public void Igdb_similar_lists_are_validated_capped_and_never_include_the_game_itself()
    {
        var s = DiscoverBrowseParsers.ParseIgdbSimilar(Fixture("igdb_similar.json"));
        Assert.Equal([103281, 1020, 7346, 19560, 1942, 26758], s[11198]);
        Assert.Equal([11198, 7346], s[1942]);
        Assert.Equal(2, s.Count);
        Assert.Empty(DiscoverBrowseParsers.ParseIgdbSimilar("{}"));
    }

    [Fact]
    public void Every_genre_has_a_steam_tag_and_an_igdb_mapping()
    {
        Assert.Equal(DiscoverGenres.All.Count, DiscoverGenres.All.Select(g => g.Id).Distinct().Count());
        Assert.Equal(DiscoverGenres.All.Count, DiscoverGenres.All.Select(g => g.SteamTag).Distinct().Count());
        Assert.All(DiscoverGenres.All, g => Assert.Contains(g.IgdbField, new[] { "genres", "themes", "game_modes" }));
        Assert.Equal("Racing", DiscoverBrowseParsers.TagName(699));
        Assert.Null(DiscoverBrowseParsers.TagName(4182));
    }

    [Fact]
    public void Seeds_are_recent_games_first_then_the_most_played()
    {
        var now = new DateTimeOffset(2026, 10, 10, 12, 0, 0, TimeSpan.Zero);
        DiscoverSeedRow Row(string id, long tracked, long imported, int? daysAgo) =>
            new(id, $"Game {id}", null, "[]", tracked, imported, daysAgo is { } d ? now.AddDays(-d) : null, null);
        var seeds = DiscoverService.PickSeeds([
            Row("a", 3600 * 50, 0, 200),   // most played, long ago
            Row("b", 600, 0, 1),           // played yesterday (recent counts even when short)
            Row("c", 0, 60 * 30, 3),       // recent, by store playtime
            Row("d", 0, 60 * 20, 2),       // recent, but only the two newest count as recent
            Row("e", 1800, 0, null),       // under an hour and not recent: never a seed
            Row("f", 0, 60 * 40, 400),     // 40 h of store playtime
            Row("g", 0, 0, -30),           // a date in the future isn't "recent"
        ], now);
        Assert.Equal(["b:recent", "d:recent", "a:mostPlayed", "f:mostPlayed"], seeds.Select(s => $"{s.Row.Id}:{s.Why}").ToArray());
        Assert.Empty(DiscoverService.PickSeeds([], now));
    }
}

/// <summary>Track C3: browse shelves end to end against fixtures (no real network).</summary>
public sealed class DiscoverBrowseServiceTests : IDisposable
{
    private readonly TestDb _t = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly List<string> _sent = [];
    private Func<HttpRequestMessage, HttpResponseMessage>? _override;
    private readonly HttpClient _http;
    private readonly SettingsService _settings;
    private readonly DataSourcesService _sources;
    private readonly DiscoverService _svc;

    private sealed class NoEvents : IEventSink
    {
        public void Emit(string eventName, object? payload) { }
    }

    public DiscoverBrowseServiceTests()
    {
        _http = new HttpClient(new FakeHandler(r =>
        {
            lock (_sent) _sent.Add(r.RequestUri!.AbsoluteUri);
            return _override?.Invoke(r) ?? Answer(r);
        }));
        _settings = new SettingsService(_t.Repo);
        var dataRoot = Path.Combine(_t.Dir.Path, "data");
        var art = new ArtworkService(new AppPaths(dataRoot), _t.Repo, _http);
        _sources = new DataSourcesService(_t.Repo, _settings, art, _secrets, _http);
        foreach (var id in new[] { "steamgriddb", "igdb", "rawg", "itad", "cheapshark", "wikidata", "steamdeck", "awacy" })
            _sources.Transport(id).Delay = (_, _) => Task.CompletedTask;
        _svc = new DiscoverService(_t.Repo, _settings, art, _sources, () => null, () => null, new NoEvents(), dataRoot, () => false);
    }

    public void Dispose()
    {
        _http.Dispose();
        _t.Dispose();
    }

    private static HttpResponseMessage Answer(HttpRequestMessage r)
    {
        var url = Uri.UnescapeDataString(r.RequestUri!.AbsoluteUri);
        if (url.StartsWith("https://store.steampowered.com/api/featuredcategories/", StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, DiscoverParsingTests.Fixture("steam_featuredcategories.json"));
        if (url.StartsWith("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/", StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, url.Contains("1293830", StringComparison.Ordinal)
                ? """{"response":{"store_items":[{"appid":1293830,"name":"Forza Horizon 4","type":0,"visible":true,"tagids":[4182,699,1695,3859]}]}}"""
                : DiscoverParsingTests.Fixture("steam_storeitems_featured.json"));
        if (url.StartsWith("https://api.steampowered.com/IStoreQueryService/Query/v1/", StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, DiscoverParsingTests.Fixture(url.Contains("only_free_items", StringComparison.Ordinal)
                ? "steam_storequery_free.json" : "steam_storequery_racing.json"));
        if (r.RequestUri!.Host == "id.twitch.tv")
            return FakeHandler.Json(HttpStatusCode.OK, """{"access_token":"tok0123456789abcdef","expires_in":5000000}""");
        if (r.RequestUri.Host == "api.igdb.com")
        {
            var body = r.Content!.ReadAsStringAsync().Result;
            if (r.RequestUri.AbsolutePath.EndsWith("/external_games", StringComparison.Ordinal))
                return FakeHandler.Json(HttpStatusCode.OK, """[{"id":9,"game":11198,"uid":"1293830"}]""");
            return FakeHandler.Json(HttpStatusCode.OK, body.StartsWith("fields similar_games", StringComparison.Ordinal)
                ? DiscoverParsingTests.Fixture("igdb_similar.json") : DiscoverParsingTests.Fixture("igdb_games_similar.json"));
        }
        return FakeHandler.Json(HttpStatusCode.NotFound, "{}");
    }

    private int Sent(string prefix) { lock (_sent) return _sent.Count(u => u.StartsWith(prefix, StringComparison.Ordinal)); }

    private void Set(string key, bool value) => _settings.Set(key, System.Text.Json.Nodes.JsonValue.Create(value));

    private void OwnForza(int minutes = 60 * 120) =>
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "1293830", "Forza Horizon 4", steamAppId: "1293830", playtime: minutes))]);

    // ---------- Steam store shelves ----------

    [Fact]
    public async Task Store_shelves_are_off_until_turned_on_and_then_ask_nothing()
    {
        var off = await _svc.FeaturedAsync(false, CancellationToken.None);
        Assert.Equal("off", off.State);
        Assert.Empty(off.Shelves);
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task Store_shelves_show_only_games_anyone_can_see_and_mark_your_own()
    {
        Set(DiscoverService.StoreShelvesSetting, true);
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "620", "Portal 2", steamAppId: "620"))]);
        _svc.LibraryChanged();
        var d = await _svc.FeaturedAsync(false, CancellationToken.None);
        Assert.Equal("ready", d.State);
        Assert.False(d.Stale);
        var byId = d.Shelves.ToDictionary(s => s.Id);
        Assert.Equal(["trending", "specials", "newReleases", "comingSoon", "free"], d.Shelves.Select(s => s.Id).ToArray());

        var trending = byId["trending"].Items;
        Assert.DoesNotContain(trending, r => r.Title == "Steam Frame"); // hardware
        Assert.DoesNotContain(trending, r => r.Title.Contains("Hallowed Concepts", StringComparison.Ordinal)); // DLC
        Assert.NotNull(trending.Single(r => r.SteamAppId == "620").LibraryGameId);
        Assert.Equal("Trending on Steam", byId["trending"].Title);

        Assert.Equal("436780", byId["specials"].Items[0].SteamAppId); // the daily deal leads
        Assert.DoesNotContain(byId["specials"].Items, r => r.SteamAppId == "2781620"); // DLC

        var fresh = byId["newReleases"].Items;
        Assert.DoesNotContain(fresh, r => r.Title == "Unrated Island");
        Assert.DoesNotContain(fresh, r => r.Title == "Bar Keeper"); // not visible
        Assert.DoesNotContain(fresh, r => r.Title.Contains("Soundtrack", StringComparison.Ordinal));
        Assert.True(fresh.Single(r => r.Title == "Evenin' Shift").Free);

        var soon = byId["comingSoon"].Items;
        Assert.All(soon, r => Assert.True(r.ComingSoon));
        Assert.Equal("2026-12", soon.Single(r => r.SteamAppId == "3627560").ReleaseDate);

        var free = byId["free"].Items;
        Assert.Equal(6, free.Count);
        Assert.All(free, r => Assert.True(r.Free));
        Assert.DoesNotContain(free, r => r.Title == "Unrated Free Thing");
    }

    [Fact]
    public async Task Store_shelves_are_cached_rate_limited_and_kept_when_steam_fails()
    {
        Set(DiscoverService.StoreShelvesSetting, true);
        await _svc.FeaturedAsync(false, CancellationToken.None);
        var first = _sent.Count;
        Assert.Equal(1, Sent("https://store.steampowered.com/api/featuredcategories/"));

        // Fresh copy: no request; a manual refresh right away is not sent either.
        await _svc.FeaturedAsync(false, CancellationToken.None);
        await _svc.FeaturedAsync(true, CancellationToken.None);
        Assert.Equal(first, _sent.Count);

        // Later, Steam fails: the last good copy stays, marked stale, and VYSTRAL backs off.
        _svc.Now = () => DateTimeOffset.UtcNow.AddHours(4);
        _override = _ => FakeHandler.Json(HttpStatusCode.Forbidden, "{}");
        var failed = await _svc.FeaturedAsync(false, CancellationToken.None);
        Assert.Equal("ready", failed.State);
        Assert.True(failed.Stale);
        Assert.Equal("rateLimited", failed.Reason);
        Assert.NotEmpty(failed.Shelves);
        var afterFail = _sent.Count;
        await _svc.FeaturedAsync(true, CancellationToken.None);
        Assert.Equal(afterFail, _sent.Count); // backing off
    }

    [Fact]
    public async Task Offline_mode_shows_saved_shelves_and_sends_nothing()
    {
        Set(DiscoverService.StoreShelvesSetting, true);
        Set("privacy.localOnly", true);
        var none = await _svc.FeaturedAsync(true, CancellationToken.None);
        Assert.Equal("offline", none.State);
        Assert.Empty(none.Shelves);
        Assert.Empty(_sent);

        Set("privacy.localOnly", false);
        await _svc.FeaturedAsync(false, CancellationToken.None);
        Set("privacy.localOnly", true);
        var count = _sent.Count;
        var saved = await _svc.FeaturedAsync(true, CancellationToken.None);
        Assert.Equal("offline", saved.State);
        Assert.True(saved.Stale);
        Assert.NotEmpty(saved.Shelves);
        Assert.Equal(count, _sent.Count);
    }

    [Fact]
    public async Task A_tampered_cache_is_ignored_item_by_item()
    {
        Set(DiscoverService.StoreShelvesSetting, true);
        _t.Repo.SetProviderCache("discover-featured", "US", """
            {"shelves":[{"id":"trending","items":[
              {"appId":"1;rm","title":"Bad","platforms":[],"genres":[],"images":[]},
              {"appId":"10","title":"Counter-Strike","platforms":["PC"],"genres":[],"images":[{"kind":"cover","url":"https://evil.example.com/a.jpg"}]},
              {"appId":"20","title":"Team Fortress Classic","platforms":[],"genres":[],"images":[],"price":{"finalCents":5,"initialCents":1,"currency":"usd"}},
              {"appId":"30","title":"Day of Defeat","platforms":[],"genres":[],"images":[]}]},
              {"id":"made-up","items":[]}]}
            """, TimeSpan.FromHours(1));
        var d = await _svc.FeaturedAsync(false, CancellationToken.None);
        var shelf = Assert.Single(d.Shelves);
        Assert.Equal(["10", "20", "30"], shelf.Items.Select(i => i.SteamAppId).ToArray());
        Assert.Null(shelf.Items[1].Price);
        Assert.Empty(_sent);
        Assert.DoesNotContain(_svc.ImageCandidates("steam-10", "cover"), i => i.Url.Contains("evil", StringComparison.Ordinal));
    }

    // ---------- Because you played ----------

    [Fact]
    public async Task Because_you_played_needs_a_played_game_and_a_source()
    {
        Assert.Equal("noSeeds", (await _svc.SimilarAsync(false, CancellationToken.None)).State);
        OwnForza();
        Assert.Equal("noSource", (await _svc.SimilarAsync(false, CancellationToken.None)).State);
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task Because_you_played_uses_igdb_and_leaves_out_what_you_own()
    {
        _secrets.Items["VYSTRAL/IGDB"] = "abcdefghijklmnopqrstuvwxyz0123\nzyxwvutsrqponmlkjihgfedcba9876";
        OwnForza();
        // You also own The Witcher 3 (by Steam app ID) and The Crew 2 (by title only, on another store).
        _t.Repo.ApplyScan([
            TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "1293830", "Forza Horizon 4", steamAppId: "1293830", playtime: 7200),
                TestDb.Install(PlatformId.Steam, "292030", "The Witcher 3: Wild Hunt", steamAppId: "292030")),
            TestDb.Ok(PlatformId.Epic, TestDb.Install(PlatformId.Epic, "crew2", "The Crew 2")),
        ]);
        _svc.LibraryChanged();
        var d = await _svc.SimilarAsync(false, CancellationToken.None);
        Assert.Equal("ready", d.State);
        Assert.Equal("igdb", d.Source);
        var shelf = Assert.Single(d.Shelves);
        Assert.Equal("Because you played Forza Horizon 4", shelf.Title);
        Assert.Equal("mostPlayed", shelf.Seed!.Why);
        Assert.Equal(["Forza Horizon 5", "Grand Theft Auto V", "The Legend of Zelda: Breath of the Wild"], shelf.Items.Select(i => i.Title).ToArray());
        Assert.Equal("steam-1551360", shelf.Items[0].Key);

        // Cached for a week: asking again sends nothing.
        var count = _sent.Count;
        await _svc.SimilarAsync(false, CancellationToken.None);
        Assert.Equal(count, _sent.Count);

        // A game you buy later disappears from the shelf without asking IGDB again.
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam,
            TestDb.Install(PlatformId.Steam, "1293830", "Forza Horizon 4", steamAppId: "1293830", playtime: 7200),
            TestDb.Install(PlatformId.Steam, "292030", "The Witcher 3: Wild Hunt", steamAppId: "292030"),
            TestDb.Install(PlatformId.Steam, "1551360", "Forza Horizon 5", steamAppId: "1551360"))]);
        _svc.LibraryChanged();
        var later = await _svc.SimilarAsync(false, CancellationToken.None);
        Assert.Equal(count, _sent.Count);
        // Two suggestions are left: too few for a row, so the shelf steps aside.
        Assert.DoesNotContain(later.Shelves.SelectMany(s => s.Items), i => i.Title == "Forza Horizon 5");
        Assert.Empty(later.Shelves);
    }

    [Fact]
    public async Task Without_igdb_because_you_played_uses_steam_tags_when_the_store_shelves_are_on()
    {
        OwnForza();
        Set(DiscoverService.StoreShelvesSetting, true);
        var d = await _svc.SimilarAsync(false, CancellationToken.None);
        Assert.Equal("steam", d.Source);
        var shelf = Assert.Single(d.Shelves);
        Assert.StartsWith("Shares Steam tags", shelf.Reason, StringComparison.Ordinal);
        Assert.DoesNotContain(shelf.Items, i => i.Title == "Forza Horizon 4"); // the seed itself
        Assert.Contains(shelf.Items, i => i.Title == "Forza Horizon 5");
        Assert.Equal(0, Sent("https://api.igdb.com/"));
    }

    [Fact]
    public async Task Because_you_played_is_off_with_searching_online_and_offline_sends_nothing()
    {
        _secrets.Items["VYSTRAL/IGDB"] = "abcdefghijklmnopqrstuvwxyz0123\nzyxwvutsrqponmlkjihgfedcba9876";
        OwnForza();
        Set(DiscoverService.SearchSetting, false);
        Assert.Equal("off", (await _svc.SimilarAsync(false, CancellationToken.None)).State);
        Set(DiscoverService.SearchSetting, true);
        Set("privacy.localOnly", true);
        Assert.Equal("offline", (await _svc.SimilarAsync(false, CancellationToken.None)).State);
        Assert.Empty(_sent);
    }

    // ---------- genres ----------

    [Fact]
    public async Task Genre_pages_come_from_steam_tags_and_reject_unknown_genres()
    {
        await Assert.ThrowsAsync<BridgeException>(() => _svc.GenreAsync("../etc", 0, CancellationToken.None));
        Assert.Equal("noSource", (await _svc.GenreAsync("racing", 0, CancellationToken.None)).State);

        Set(DiscoverService.StoreShelvesSetting, true);
        var page = await _svc.GenreAsync("racing", 0, CancellationToken.None);
        Assert.Equal("ready", page.State);
        Assert.Equal("Racing", page.Label);
        Assert.True(page.HasMore);
        Assert.Equal("$27.99", page.Results.Single(r => r.SteamAppId == "2486820").PriceText);
        Assert.Contains("tagids%22%3A%5B699%5D", _sent.Last(), StringComparison.Ordinal);

        var count = _sent.Count;
        await _svc.GenreAsync("racing", 0, CancellationToken.None);
        Assert.Equal(count, _sent.Count); // cached
    }
}
