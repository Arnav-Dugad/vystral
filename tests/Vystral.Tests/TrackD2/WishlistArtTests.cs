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

namespace Vystral.Tests.TrackD2;

/// <summary>
/// Track D2: "most games on the wishlist show no poster". Steam names newer apps' art <c>&lt;sha1&gt;/header.jpg</c>,
/// which the parser refused, and their classic <c>header.jpg</c> path answers 404. The fixtures are trimmed real
/// answers for the owner's 22 wishlisted apps (captured 2026-10-10): 15 of them have no classic header at all.
/// </summary>
public sealed class WishlistArtTests : IDisposable
{
    internal static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "TrackD2", name));

    private const string Cdn = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/";

    /// <summary>Apps whose classic header.jpg answered 404 on Steam's CDN when the fixture was captured.</summary>
    private static readonly string[] NoClassicHeader =
        ["2397320", "2487330", "2590240", "2947860", "3061930", "3080520", "3558670", "3596430", "3669870", "4096880", "4115450", "4260840", "4814120", "4824610", "5006530"];

    private static readonly string[] OwnerIds =
        ["1340720", "1757350", "2358720", "2397320", "2439280", "2487330", "2590240", "2638890", "2769570", "2947860", "3010850",
         "3061930", "3080520", "3558670", "3596430", "3669870", "4096880", "4115450", "4260840", "4814120", "4824610", "5006530"];

    // ---------- Parsing the asset index ----------

    [Fact]
    public void Hashed_asset_names_from_the_owner_wishlist_become_real_urls()
    {
        var items = SteamWebApiClient.ParseStoreItems(Fixture("storeitems_owner.json"), OwnerIds).ToDictionary(i => i.AppId);
        Assert.Equal(22, items.Count);

        // ANANTA, Bancho the Chef, Bus Simulator 27, CLUTCH… all fell back to a 404 before.
        Assert.Equal(Cdn + "4814120/3bd40cfd93dfe6e7a21d9f825fa3b82ee1c57105/header.jpg?t=1790579282", items["4814120"].HeaderUrl);
        Assert.Equal(Cdn + "3596430/4c91500b03cb5f1e293ca1d4005775b68e894dc8/header.jpg?t=1780438904", items["3596430"].HeaderUrl);
        Assert.Equal(Cdn + "2397320/da4a57428bac72569d83afcd0b7f5878c97a17f5/header.jpg?t=1791538474", items["2397320"].HeaderUrl);
        Assert.Equal(Cdn + "3061930/26691256a0032fe27b2cd378db0ea07656ab9f1c/header.jpg?t=1791303589", items["3061930"].HeaderUrl);
        foreach (var id in NoClassicHeader)
        {
            Assert.Matches(@"/[0-9a-f]{40}/header\.jpg\?t=\d+\z", items[id].HeaderUrl);
            Assert.Equal(items[id].HeaderUrl, items[id].Art.Header);
            Assert.NotNull(items[id].Art.Capsule);
            Assert.NotNull(items[id].Art.HeroCapsule);
        }

        // Black Myth: Wukong still uses classic names; they keep working.
        Assert.Equal(Cdn + "2358720/header.jpg?t=1760601605", items["2358720"].HeaderUrl);
        Assert.Equal(Cdn + "2358720/library_600x900.jpg?t=1760601605", items["2358720"].Art.Cover);

        // Every app has a portrait cover except one Steam lists without a library capsule (its hero capsule stands in).
        Assert.Equal(["5006530"], items.Values.Where(i => i.Art.Cover is null).Select(i => i.AppId));
        Assert.Equal(Cdn + "5006530/077f481c3539ad25e8463e0333d61c2fb6045078/hero_capsule.jpg?t=1788763575", items["5006530"].Art.HeroCapsule);
        Assert.All(items.Values, i => Assert.All(new[] { i.Art.Header, i.Art.Capsule, i.Art.Cover, i.Art.HeroCapsule, i.Art.Hero }.OfType<string>(),
            u => Assert.StartsWith(Cdn + i.AppId + "/", u)));
    }

    [Theory]
    [InlineData("steam/apps/10/${FILENAME}", "0123456789abcdef0123456789abcdef01234567/header.jpg", true)]
    [InlineData("steam/apps/10/${FILENAME}?t=99", "header.jpg", true)]
    [InlineData("steam/apps/10/0123456789abcdef0123456789abcdef01234567/${FILENAME}", "header.jpg", true)]
    [InlineData("steam/apps/10/${FILENAME}", "0123456789ABCDEF0123456789abcdef01234567/header.jpg", false)] // upper-case hash
    [InlineData("steam/apps/10/${FILENAME}", "0123456789abcdef/header.jpg", false)]                       // short hash
    [InlineData("steam/apps/10/${FILENAME}", "../11/header.jpg", false)]
    [InlineData("steam/apps/10/${FILENAME}", "a/b/header.jpg", false)]
    [InlineData("steam/apps/10/${FILENAME}", "header.exe", false)]
    [InlineData("steam/apps/10/${FILENAME}", "header.jpg?x=1", false)]
    [InlineData("steam/apps/11/${FILENAME}", "header.jpg", false)]                                       // another app's folder
    [InlineData("steam/apps/10/${FILENAME}?t=1&u=2", "header.jpg", false)]
    [InlineData("https://evil.example/${FILENAME}", "header.jpg", false)]
    public void Asset_names_must_be_steam_shaped(string format, string file, bool ok)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(new Dictionary<string, string> { ["asset_url_format"] = format, ["header"] = file }));
        var url = SteamWebApiClient.AssetUrl("10", doc.RootElement, "header");
        if (ok) Assert.StartsWith(Cdn + "10/", url);
        else Assert.Null(url);
        // The header always has a URL (the classic path), never one outside the app's folder.
        Assert.StartsWith(Cdn + "10/", SteamWebApiClient.HeaderUrl("10", doc.RootElement));
    }

    [Fact]
    public void Candidates_try_every_variant_best_first()
    {
        var items = SteamWebApiClient.ParseStoreItems(Fixture("storeitems_owner.json"), ["4814120"]);
        var cache = new WishlistCacheItem { AppId = "4814120" };
        WishlistService.ApplyStoreInfo(cache, items[0], DateTimeOffset.UtcNow);
        Assert.Equal(
        [
            Cdn + "4814120/3bd40cfd93dfe6e7a21d9f825fa3b82ee1c57105/header.jpg?t=1790579282",
            Cdn + "4814120/f794174f36d0eacd07cd99061f22c909fb71c2c9/capsule_616x353.jpg?t=1790579282",
            Cdn + "4814120/header.jpg",
            cache.HeroUrl!,
        ], WishlistService.HeaderCandidates(cache));
        var covers = WishlistService.CoverCandidates(cache);
        Assert.Equal(3, covers.Count);
        Assert.Equal(Cdn + "4814120/c484d108cad190bb3535c15d4641dff5bde1ee80/library_capsule.jpg?t=1790579282", covers[0]); // a new file name too
        Assert.Matches(@"/4814120/[0-9a-f]{40}/hero_capsule\.jpg\?t=1790579282\z", covers[1]);
        Assert.Equal(Cdn + "4814120/library_600x900.jpg", covers[2]);
        Assert.Equal(WishlistService.ArtVersion, cache.ArtVersion);
        Assert.Equal("date_full", cache.ReleaseDisplay);

        // A cache file from an older version has none of this: it is read again, and its art is retried.
        var old = new WishlistCacheItem { AppId = "4814120", HeaderUrl = Cdn + "4814120/header.jpg", ArtTriedAt = DateTimeOffset.UtcNow };
        WishlistService.ApplyStoreInfo(old, items[0], DateTimeOffset.UtcNow);
        Assert.Null(old.ArtTriedAt);
    }

    // ---------- appdetails header_image ----------

    [Fact]
    public void Appdetails_header_image_is_read_from_the_owner_fixture()
    {
        var json = Fixture("appdetails_owner.json");
        Assert.Equal(Cdn + "4814120/3bd40cfd93dfe6e7a21d9f825fa3b82ee1c57105/header.jpg?t=1790579282", SteamStoreDataClient.ParseHeaderImage(json, "4814120"));
        Assert.Equal(Cdn + "3596430/4c91500b03cb5f1e293ca1d4005775b68e894dc8/header.jpg?t=1780438904", SteamStoreDataClient.ParseHeaderImage(json, "3596430"));
        Assert.Null(SteamStoreDataClient.ParseHeaderImage(json, "620")); // not in the answer
    }

    [Theory]
    [InlineData("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg", true)]
    [InlineData("https://cdn.akamai.steamstatic.com/steam/apps/10/header.jpg?t=123", true)]
    [InlineData("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/10/0123456789abcdef0123456789abcdef01234567/header.jpg?t=1", true)]
    [InlineData("http://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg", false)]
    [InlineData("https://evil.example/store_item_assets/steam/apps/10/header.jpg", false)]
    [InlineData("https://x.shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg", false)]
    [InlineData("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/11/header.jpg", false)]
    [InlineData("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/../11/header.jpg", false)]
    [InlineData("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg?t=1&redirect=x", false)]
    [InlineData("https://shared.akamai.steamstatic.com:8443/store_item_assets/steam/apps/10/header.jpg", false)]
    [InlineData("https://user@shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg", false)]
    [InlineData("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.svg", false)]
    public void Appdetails_art_urls_are_steam_cdn_only(string url, bool ok)
    {
        var json = JsonSerializer.Serialize(new Dictionary<string, object> { ["10"] = new { success = true, data = new { steam_appid = 10, header_image = url } } });
        Assert.Equal(ok, SteamStoreDataClient.ParseHeaderImage(json, "10") is not null);
    }

    [Fact]
    public void Appdetails_for_another_app_or_a_failure_is_ignored()
    {
        Assert.Null(SteamStoreDataClient.ParseHeaderImage("""{"10":{"success":true,"data":{"steam_appid":11,"header_image":"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg"}}}""", "10"));
        Assert.Null(SteamStoreDataClient.ParseHeaderImage("""{"10":{"success":false}}""", "10"));
        Assert.Null(SteamStoreDataClient.ParseHeaderImage("[]", "10"));
    }

    // ---------- The whole refresh, offline ----------

    private const string Key = "0123456789ABCDEF0123456789ABCDEF";
    private const string SteamId = "76561197960287930";
    private const string Hash2 = "1111111111111111111111111111111111111111";
    private static readonly byte[] BigJpeg = [0xFF, 0xD8, 0xFF, 0xE0, .. Enumerable.Repeat((byte)7, 9000)];
    private static readonly byte[] TinyJpeg = [0xFF, 0xD8, 0xFF, 0xE0, .. Enumerable.Repeat((byte)7, 3000)];

    private readonly TestDb _t = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly SettingsService _settings;
    private readonly FakeHandler _handler;
    private readonly WishlistService _svc;

    public WishlistArtTests()
    {
        _handler = new FakeHandler(Respond);
        var http = new HttpClient(_handler);
        var keys = new SteamApiKeyStore(_secrets);
        var api = new SteamWebApiClient(http, keys.Get) { Delay = (_, _) => Task.CompletedTask };
        _settings = new SettingsService(_t.Repo);
        var artwork = new ArtworkService(new AppPaths(_t.Dir.Dir("data")), _t.Repo, http);
        var sources = new DataSourcesService(_t.Repo, _settings, artwork, _secrets, http);
        sources.Transport("steamdeck").Delay = (_, _) => Task.CompletedTask;
        sources.Transport("steamgriddb").Delay = (_, _) => Task.CompletedTask;
        _svc = new WishlistService(keys, api, _settings, artwork, sources, () => SteamId, () => new Dictionary<string, string>(), new NullSink(),
            Path.Combine(_t.Dir.Dir("data"), "cache", "wishlist.json"));
        _secrets.Write(SteamApiKeyStore.Target, Key);
        _settings.Set(WishlistService.SettingKey, JsonValue.Create(true));
    }

    public void Dispose() => _t.Dispose();

    private sealed class NullSink : IEventSink { public void Emit(string eventName, object? payload) { } }

    private static HttpResponseMessage Image(byte[] bytes) => new(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) { Headers = { ContentType = new("image/jpeg") } } };

    /// <summary>
    /// ANANTA (4814120) and the Witcher 3 add-on (5006530) are served like Steam serves them now: hashed names load,
    /// classic names are 404. App 900001 has no loadable art at all but appdetails names a header; app 900002 has
    /// nothing anywhere on Steam, but SteamGridDB has a grid; app 900003 only answers with Steam's tiny grey cover.
    /// </summary>
    private HttpResponseMessage Respond(HttpRequestMessage req)
    {
        var uri = req.RequestUri!;
        var path = uri.AbsolutePath;
        if (uri.Host == "shared.akamai.steamstatic.com")
        {
            if (path.Contains($"/900001/{Hash2}/header.jpg")) return Image(BigJpeg);
            if (path.EndsWith("/900003/library_600x900.jpg")) return Image(TinyJpeg);
            if (path.Contains("/4814120/") || path.Contains("/5006530/"))
                return System.Text.RegularExpressions.Regex.IsMatch(path, "/[0-9a-f]{40}/") ? Image(BigJpeg) : new HttpResponseMessage(HttpStatusCode.NotFound);
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }
        if (uri.Host == "cdn2.steamgriddb.com") return Image(BigJpeg);
        if (uri.Host == "www.steamgriddb.com" && path.EndsWith("/games/steam/900002"))
            return FakeHandler.Json(HttpStatusCode.OK, """{"success":true,"data":{"id":4242,"name":"Grid Only"}}""");
        if (uri.Host == "www.steamgriddb.com" && path.Contains("/grids/game/4242"))
            return FakeHandler.Json(HttpStatusCode.OK, """{"success":true,"data":[{"id":1,"url":"https://cdn2.steamgriddb.com/grid/a.png","thumb":"https://cdn2.steamgriddb.com/thumb/a.jpg","width":600,"height":900,"style":"alternate","nsfw":false,"humor":false,"epilepsy":false}]}""");
        if (uri.Host == "www.steamgriddb.com") return FakeHandler.Json(HttpStatusCode.NotFound, "{}");
        if (path.Contains("GetWishlist"))
            return FakeHandler.Json(HttpStatusCode.OK, """{"response":{"items":[{"appid":4814120,"priority":1},{"appid":5006530,"priority":2},{"appid":900001,"priority":3},{"appid":900002,"priority":4},{"appid":900003,"priority":5}]}}""");
        if (path.Contains("IStoreBrowseService"))
        {
            var owner = Fixture("storeitems_owner.json");
            var extra = """
                {"id":900001,"success":1,"name":"Store Header Only","appid":900001,"release":{"is_coming_soon":true,"custom_release_date_message":"Q1 2027","coming_soon_display":"text_tba"},"assets":{"asset_url_format":"steam/apps/900001/${FILENAME}?t=1","header":"2222222222222222222222222222222222222222/header.jpg"}},
                {"id":900002,"success":1,"name":"Grid Only","appid":900002,"release":{"is_coming_soon":true,"custom_release_date_message":"Coming soon","coming_soon_display":"text_comingsoon"}},
                {"id":900003,"success":1,"name":"Grey Cover","appid":900003,"release":{"steam_release_date":1700000000}},
                """;
            return FakeHandler.Json(HttpStatusCode.OK, owner.Replace("""{"response":{"store_items":[""", """{"response":{"store_items":[""" + extra, StringComparison.Ordinal));
        }
        if (uri.Host == "store.steampowered.com" && path == "/api/appdetails" && uri.Query.Contains("filters=basic"))
            return uri.Query.Contains("appids=900001")
                ? FakeHandler.Json(HttpStatusCode.OK, """{"900001":{"success":true,"data":{"steam_appid":900001,"header_image":"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/900001/""" + Hash2 + """/header.jpg?t=5"}}}""")
                : FakeHandler.Json(HttpStatusCode.OK, """{"900002":{"success":false}}""");
        if (uri.Host == "store.steampowered.com" && path == "/api/appdetails") return FakeHandler.Json(HttpStatusCode.OK, "{}");
        return FakeHandler.Json(HttpStatusCode.NotFound, "");
    }

    private Task Refresh() => _svc.RefreshAsync(SteamId, TestContext.Current.CancellationToken);

    [Fact]
    public async Task Every_wishlisted_game_gets_a_poster_through_the_fallback_chain()
    {
        _secrets.Write(DataSourceKeyStore.Target(KeyedProvider.SteamGridDb), "0123456789abcdef0123456789abcdef");
        await Refresh();
        var items = _svc.Get().Items.ToDictionary(i => i.AppId);

        Assert.NotNull(items["4814120"].Header);   // ANANTA: the hashed header
        Assert.NotNull(items["4814120"].Cover);    //         and the hashed 600×900 cover
        Assert.NotNull(items["5006530"].Header);
        Assert.NotNull(items["5006530"].Cover);    // no library capsule: the hero capsule
        Assert.NotNull(items["900001"].Header);    // appdetails' header_image
        Assert.Null(items["900001"].Cover);
        Assert.NotNull(items["900002"].Cover);     // SteamGridDB (the user's key)
        Assert.Null(items["900003"].Cover);        // Steam's grey stand-in is never kept as a cover
        Assert.All(items.Values.Select(i => i.Header).Concat(items.Values.Select(i => i.Cover)).OfType<string>(),
            u => Assert.StartsWith("https://art.vystral.example/_thumbs/wishlist/", u));

        // Release precision travels with the item.
        Assert.Equal(("day", "2027-01-15", null), (items["4814120"].ReleasePrecision, items["4814120"].ReleaseFrom, items["4814120"].ReleaseLabel));
        Assert.Equal(("quarter", "2027-01-01", "2027-03-31", "Q1 2027"),
            (items["900001"].ReleasePrecision, items["900001"].ReleaseFrom, items["900001"].ReleaseTo, items["900001"].ReleaseLabel));
        Assert.Equal(("tba", "Coming soon"), (items["900002"].ReleasePrecision, items["900002"].ReleaseLabel));

        // Only Steam, SteamGridDB and their CDNs (and CheapShark, the default lowest-price source) were asked; the
        // classic 404 paths were tried only after the hashed ones.
        Assert.All(_handler.Requests, u => Assert.Contains(u.Host, new[]
            { "api.steampowered.com", "store.steampowered.com", "shared.akamai.steamstatic.com", "www.steamgriddb.com", "cdn2.steamgriddb.com", "www.cheapshark.com" }));
        var ananta = _handler.Requests.Where(u => u.AbsolutePath.Contains("/4814120/")).Select(u => u.AbsolutePath).ToList();
        Assert.Matches("/[0-9a-f]{40}/header.jpg", ananta[0]);
        Assert.DoesNotContain(ananta, p => p.EndsWith("/4814120/header.jpg")); // the hashed header loaded first

        // A second refresh at once asks for nothing new: art that landed is cached; misses wait a day.
        var before = _handler.Requests.Count(u => u.Host.Contains("steamstatic") || u.Host.Contains("steamgriddb") || u.Query.Contains("filters=basic"));
        await Refresh();
        Assert.Equal(before, _handler.Requests.Count(u => u.Host.Contains("steamstatic") || u.Host.Contains("steamgriddb") || u.Query.Contains("filters=basic")));
    }

    [Fact]
    public async Task Without_a_steamgriddb_key_steamgriddb_is_never_asked()
    {
        await Refresh();
        Assert.DoesNotContain(_handler.Requests, u => u.Host.Contains("steamgriddb"));
        Assert.Null(_svc.Get().Items.Single(i => i.AppId == "900002").Cover);
    }

    [Fact]
    public void Hostile_art_fields_in_the_cache_file_are_dropped()
    {
        var c = new WishlistCache
        {
            Account = "0123456789abcdef",
            Items =
            [
                new()
                {
                    AppId = "10", CoverUrl = Cdn + "11/library_600x900.jpg", CapsuleUrl = "https://evil.example/x.jpg", HeroUrl = Cdn + "10/../11/x.jpg",
                    HeroCapsuleUrl = Cdn + "10/" + new string('a', 40) + "/hero_capsule.jpg", CoverFile = "_thumbs/wishlist/..\\..\\x.jpg",
                    ReleaseDisplay = "<script>", ArtVersion = 99,
                },
            ],
        };
        var i = Assert.Single(WishlistService.Validate(c)!.Items);
        Assert.Null(i.CoverUrl);
        Assert.Null(i.CapsuleUrl);
        Assert.Null(i.HeroUrl);
        Assert.NotNull(i.HeroCapsuleUrl);
        Assert.Null(i.CoverFile);
        Assert.Null(i.ReleaseDisplay);
        Assert.Equal(WishlistService.ArtVersion, i.ArtVersion);
    }

    [Fact]
    public void New_fields_reach_the_bridge_in_camel_case()
    {
        var dto = new WishlistItemDto("1", "A", 0, null, null, true, "2027", false, null, null, 0, null, null, false, null, null, null, null, [], null, null, null)
        { Cover = "https://art.vystral.example/_thumbs/wishlist/a.jpg", ReleasePrecision = "year", ReleaseFrom = "2027-01-01", ReleaseTo = "2027-12-31", ReleaseLabel = "2027" };
        var json = JsonSerializer.Serialize(dto, BridgeDispatcher.Json);
        Assert.Contains("\"cover\":\"https://art.vystral.example/_thumbs/wishlist/a.jpg\"", json);
        Assert.Contains("\"releasePrecision\":\"year\"", json);
        Assert.Contains("\"releaseFrom\":\"2027-01-01\"", json);
        Assert.Contains("\"releaseLabel\":\"2027\"", json);
    }
}
