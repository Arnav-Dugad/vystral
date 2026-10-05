using Vystral.Core.Domain;
using Vystral.Windows.DataSources;
using Xunit;

namespace Vystral.Tests.DataSources;

/// <summary>
/// Parsing of every provider's answers. Files under Fixtures/DataSources were captured from the
/// live keyless endpoints on 2026-10-05; keyed providers (SteamGridDB, IGDB, RAWG, IsThereAnyDeal)
/// use inline samples shaped after their documentation, since no developer key was used.
/// </summary>
public sealed class ProviderParsingTests
{
    internal static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "DataSources", name));

    // ---------- SteamGridDB ----------

    private const string SgdbGrids = """
        {"success":true,"data":[
          {"id":101,"score":12,"style":"alternate","width":600,"height":900,"nsfw":false,"humor":false,"epilepsy":false,"mime":"image/png",
           "url":"https://cdn2.steamgriddb.com/grid/abc.png","thumb":"https://cdn2.steamgriddb.com/thumb/abc.jpg","author":{"name":"Artist","steam64":"1","avatar":"x"}},
          {"id":102,"score":3,"style":"no_logo","width":600,"height":900,"nsfw":true,"url":"https://cdn2.steamgriddb.com/grid/nsfw.png","thumb":"https://cdn2.steamgriddb.com/thumb/nsfw.jpg"},
          {"id":103,"style":"material","width":600,"height":900,"url":"http://cdn2.steamgriddb.com/grid/plain-http.png"},
          {"id":104,"style":"<script>","width":600,"height":900,"url":"https://evil.example/grid.png"},
          {"id":105,"style":["blurred"],"width":99999999,"height":-5,"url":"https://cdn2.steamgriddb.com/grid/def.webp","thumb":"https://evil.example/t.jpg","author":{"name":"<b>Bold</b>"}}
        ]}
        """;

    [Fact]
    public void SteamGridDb_images_keep_only_safe_https_art_from_its_cdn()
    {
        var images = SteamGridDbClient.ParseImages(SgdbGrids);
        Assert.Equal([101L, 105L], images.Select(i => i.Id).ToArray());
        var a = images[0];
        Assert.Equal("https://cdn2.steamgriddb.com/grid/abc.png", a.Url);
        Assert.Equal("https://cdn2.steamgriddb.com/thumb/abc.jpg", a.Thumb);
        Assert.Equal("alternate", a.Style);
        Assert.Equal("Artist", a.Author);
        var b = images[1];
        Assert.Equal("blurred", b.Style);
        Assert.Equal(20000, b.Width);
        Assert.Equal(0, b.Height);
        Assert.Equal(b.Url, b.Thumb); // an off-site thumbnail falls back to the full image on the CDN
        Assert.Equal("Bold", b.Author); // markup stripped
    }

    [Theory]
    [InlineData("""{"success":false,"errors":["Authentication Required"]}""")]
    [InlineData("""not json""")]
    [InlineData("""[]""")]
    public void SteamGridDb_rejects_unreadable_answers(string json) =>
        Assert.Equal(DataSourceOutcome.Malformed, Assert.Throws<DataSourceException>(() => SteamGridDbClient.ParseImages(json)).Outcome);

    [Fact]
    public void SteamGridDb_image_path_filters_styles_and_excludes_unsafe_art()
    {
        var path = SteamGridDbClient.BuildImagePath(ArtworkKind.Cover, 17830, new SgdbFilter(["alternate", "bogus", "no_logo"], false, 0));
        Assert.StartsWith("grids/game/17830?", path);
        Assert.Contains("dimensions=600x900,342x482,660x930", path);
        Assert.Contains("styles=alternate,no_logo", path);
        Assert.Contains("types=static", path);
        Assert.DoesNotContain("animated", path);
        Assert.Contains("nsfw=false&humor=false&epilepsy=false", path);
        Assert.Contains("types=static,animated", SteamGridDbClient.BuildImagePath(ArtworkKind.Hero, 1, new SgdbFilter([], true, 2)));
        Assert.StartsWith("logos/game/1?", SteamGridDbClient.BuildImagePath(ArtworkKind.Logo, 1, new SgdbFilter(["official"], false, 0)));
        Assert.Contains("mimes=image/png&", SteamGridDbClient.BuildImagePath(ArtworkKind.Icon, 1, new SgdbFilter([], false, 0)));
        Assert.Throws<ArgumentException>(() => SteamGridDbClient.BuildImagePath(ArtworkKind.Header, 1, new SgdbFilter([], false, 0)));
    }

    [Fact]
    public void SteamGridDb_search_and_exact_pick()
    {
        var games = SteamGridDbClient.ParseGames("""
            {"success":true,"data":[{"id":1,"name":"Portal 2","release_date":1303171200,"types":["steam"],"verified":true},
              {"id":2,"name":"Portal 2: The Final Hours"},{"id":0,"name":"broken"},{"id":3}]}
            """);
        Assert.Equal(2, games.Count);
        Assert.Equal(2011, games[0].ReleaseYear);
        Assert.Equal(1, SteamGridDbClient.PickExact("Portal 2™", games)!.Id);
        Assert.Null(SteamGridDbClient.PickExact("Portal", games));
        Assert.Null(SteamGridDbClient.PickExact("Portal 2", [new SgdbGame(1, "Portal 2", null), new SgdbGame(9, "PORTAL 2", null)])); // ambiguous
    }

    // ---------- IGDB ----------

    [Fact]
    public void Igdb_token_is_validated_and_clamped()
    {
        var (token, life) = IgdbClient.ParseToken("""{"access_token":"abcdef0123456789abcdef","expires_in":5587808,"token_type":"bearer"}""");
        Assert.Equal("abcdef0123456789abcdef", token);
        Assert.Equal(TimeSpan.FromSeconds(5587808), life);
        Assert.Throws<DataSourceException>(() => IgdbClient.ParseToken("""{"access_token":"has spaces in it!","expires_in":10}"""));
        Assert.Throws<DataSourceException>(() => IgdbClient.ParseToken("""{"status":400,"message":"invalid client"}"""));
    }

    [Fact]
    public void Igdb_external_game_requires_the_exact_appid_and_one_game()
    {
        Assert.Equal(72L, IgdbClient.ParseExternalGame("""[{"id":9,"game":72,"uid":"620"}]""", "620"));
        Assert.Null(IgdbClient.ParseExternalGame("""[{"id":9,"game":72,"uid":"6200"}]""", "620"));
        Assert.Null(IgdbClient.ParseExternalGame("""[{"game":72,"uid":"620"},{"game":73,"uid":"620"}]""", "620"));
        Assert.Null(IgdbClient.ParseExternalGame("""{"message":"nope"}""", "620"));
    }

    [Fact]
    public void Igdb_game_maps_companies_ratings_and_lists()
    {
        var g = IgdbClient.ParseGame("""
            [{"id":72,"name":"Portal 2","slug":"portal-2","url":"https://www.igdb.com/games/portal-2","summary":"<p>Sequel &amp; more</p>",
              "first_release_date":1303171200,"genres":[{"id":1,"name":"Puzzle"},{"id":2,"name":"Shooter"}],"themes":[{"name":"Science fiction"}],
              "game_modes":[{"name":"Single player"},{"name":"Co-operative"}],"aggregated_rating":95.123,"aggregated_rating_count":12,
              "total_rating":140,"total_rating_count":-4,
              "involved_companies":[{"company":{"name":"Valve"},"developer":true,"publisher":true},{"company":{"name":"EA"},"developer":false,"publisher":true}],
              "franchises":[{"name":"Portal"}],"collections":[{"name":"Portal"}],"similar_games":[{"name":"The Talos Principle"},{"name":"Q.U.B.E."}]}]
            """)!;
        Assert.Equal("Sequel & more", g.Summary);
        Assert.Equal("2011-04-19", g.ReleaseDate);
        Assert.Equal(["Valve"], g.Developers);
        Assert.Equal(["Valve", "EA"], g.Publishers);
        Assert.Equal(95.1, g.AggregatedRating);
        Assert.Null(g.TotalRating); // out of range
        Assert.Equal(0, g.TotalRatingCount);
        Assert.Equal(["The Talos Principle", "Q.U.B.E."], g.Similar);
        Assert.Equal("https://www.igdb.com/games/portal-2", g.Url);
        Assert.Null(IgdbClient.ParseGame("[]"));
    }

    [Fact]
    public void Igdb_time_to_beat_is_seconds_and_rejects_nonsense()
    {
        var t = IgdbClient.ParseTimeToBeat("""[{"id":1,"game_id":72,"hastily":28800,"normally":36000,"completely":-1,"count":250}]""")!;
        Assert.Equal(28800, t.HastilySeconds);
        Assert.Null(t.CompletelySeconds);
        Assert.Equal(250, t.Count);
        Assert.Null(IgdbClient.ParseTimeToBeat("""[{"game_id":72,"count":3}]"""));
        Assert.Null(IgdbClient.ParseTimeToBeat("[]"));
    }

    [Fact]
    public void Igdb_search_text_cannot_break_out_of_the_query() =>
        Assert.Equal("Portal 2 fields *", IgdbClient.EscapeApicalypse("Portal 2\"; fields *;\\"));

    // ---------- RAWG ----------

    [Fact]
    public void Rawg_game_ignores_metacritic_and_validates_fields()
    {
        var g = RawgClient.ParseGame("""
            {"id":4200,"slug":"portal-2","name":"Portal 2","description_raw":"Raw text","released":"2011-04-18","metacritic":95,
             "rating":4.61,"ratings_count":5000,"playtime":11,"genres":[{"name":"Puzzle"}],"developers":[{"name":"Valve Software"}],
             "publishers":[{"name":"Valve"}],"esrb_rating":{"name":"Everyone 10+"}}
            """)!;
        Assert.Equal("https://rawg.io/games/portal-2", g.Url);
        Assert.Equal(2011, g.ReleaseYear);
        Assert.Equal(4.61, g.Rating);
        Assert.Equal(11, g.AveragePlaytimeHours);
        Assert.Equal("Everyone 10+", g.Esrb);
        Assert.DoesNotContain(typeof(RawgGame).GetProperties(), p => p.Name.Contains("Metacritic", StringComparison.OrdinalIgnoreCase));
        Assert.Null(RawgClient.ParseGame("""{"id":1,"slug":"../etc","name":"x"}"""));
        Assert.Null(RawgClient.ParseGame("""{"id":1,"slug":"ok","name":"x","released":"tomorrow"}""")!.Released);
    }

    [Fact]
    public void Rawg_store_link_must_name_the_exact_steam_app()
    {
        const string stores = """
            {"results":[{"id":1,"game_id":4200,"store_id":1,"url":"https://store.steampowered.com/app/620/Portal_2/"},
            {"id":2,"store_id":3,"url":"https://store.playstation.com/x"}]}
            """;
        Assert.True(RawgClient.ParseStoresHasSteamApp(stores, "620"));
        Assert.False(RawgClient.ParseStoresHasSteamApp(stores, "62"));
        Assert.False(RawgClient.ParseStoresHasSteamApp("""{"results":[{"store_id":1,"url":"https://evil.example/app/620/"}]}""", "620"));
    }

    // ---------- CheapShark (live fixtures) ----------

    [Fact]
    public void CheapShark_lookup_store_list_and_deals_from_live_answers()
    {
        Assert.Equal("36", CheapSharkClient.ParseLookup(Fixture("cheapshark_lookup_620.json"), "620"));
        Assert.Null(CheapSharkClient.ParseLookup(Fixture("cheapshark_lookup_620.json"), "400"));
        var stores = CheapSharkClient.ParseStores(Fixture("cheapshark_stores.json"));
        Assert.Equal("Steam", stores["1"]);
        var q = CheapSharkClient.ParseGame(Fixture("cheapshark_game.json"), stores, DateTimeOffset.UnixEpoch)!;
        Assert.Equal("USD", q.Currency);
        Assert.Equal(3.69, q.HistoricalLow);
        Assert.NotNull(q.HistoricalLowAt);
        Assert.True(q.Offers.Count > 3);
        Assert.Equal(q.Offers.Min(o => o.Price), q.Offers[0].Price);
        Assert.All(q.Offers, o => Assert.StartsWith("https://www.cheapshark.com/redirect?dealID=", o.Url));
        Assert.Contains(q.Offers, o => o.Shop == "Steam" && o.Cut == 75);
    }

    [Fact]
    public void CheapShark_drops_malformed_deals()
    {
        var q = CheapSharkClient.ParseGame("""
            {"deals":[{"storeID":"1","dealID":"x y","price":"1"},{"storeID":"1","dealID":"abcdefgh12","price":"-3"},
            {"storeID":"99","dealID":"abcdefgh12","price":"2.50","retailPrice":"10"}]}
            """, new Dictionary<string, string>(), DateTimeOffset.UnixEpoch)!;
        var o = Assert.Single(q.Offers);
        Assert.Equal("Unknown store", o.Shop);
        Assert.Equal(75, o.Cut);
        Assert.Null(CheapSharkClient.ParseGame("""{"deals":[]}""", new Dictionary<string, string>(), DateTimeOffset.UnixEpoch));
    }

    // ---------- IsThereAnyDeal ----------

    [Fact]
    public void Itad_prices_keep_links_unchanged_and_one_currency()
    {
        const string id = "018d937f-21e1-728e-86d7-9acb3c59f2bb";
        Assert.Equal((id, "portal-2"), IsThereAnyDealClient.ParseLookup($$$"""{"found":true,"game":{"id":"{{{id}}}","slug":"portal-2","title":"Portal 2","type":"game","mature":false}}"""));
        Assert.Null(IsThereAnyDealClient.ParseLookup("""{"found":false}"""));
        Assert.Null(IsThereAnyDealClient.ParseLookup("""{"found":true,"game":{"id":"not-a-guid"}}"""));
        var q = IsThereAnyDealClient.ParsePrices($$$"""
            [{"id":"{{{id}}}","historyLow":{"all":{"amount":0.99,"amountInt":99,"currency":"EUR"}},"deals":[
              {"shop":{"id":61,"name":"Steam"},"price":{"amount":1.99,"amountInt":199,"currency":"EUR"},"regular":{"amount":9.99,"currency":"EUR"},"cut":80,
               "url":"https://itad.link/abc123/?ref=itad"},
              {"shop":{"id":35,"name":"GOG"},"price":{"amount":2.5,"currency":"USD"},"url":"https://itad.link/def/"},
              {"shop":{"id":1,"name":"Bad"},"price":{"amount":1,"currency":"EUR"},"url":"http://insecure.example/"}]}]
            """, id, "portal-2", DateTimeOffset.UnixEpoch)!;
        Assert.Equal("EUR", q.Currency);
        var offer = Assert.Single(q.Offers);
        Assert.Equal("https://itad.link/abc123/?ref=itad", offer.Url); // affiliate tag kept, as ITAD requires
        Assert.Equal(80, offer.Cut);
        Assert.Equal(0.99, q.HistoricalLow);
        Assert.Equal("https://isthereanydeal.com/game/portal-2/info/", q.ProviderUrl);
    }

    // ---------- Steam store (live fixtures) ----------

    [Fact]
    public void Steam_deck_reports_from_live_answers()
    {
        var verified = SteamStoreDataClient.ParseDeck(Fixture("steam_deck_verified.json"), "1245620")!;
        Assert.Equal("verified", verified.Category);
        Assert.Contains(verified.Tests, t => t.Kind == "pass" && t.Text.Contains("legible", StringComparison.Ordinal));
        var unsupported = SteamStoreDataClient.ParseDeck(Fixture("steam_deck_unsupported.json"), "1172470")!;
        Assert.Equal("unsupported", unsupported.Category);
        Assert.Equal("fail", Assert.Single(unsupported.Tests).Kind);
        Assert.Null(SteamStoreDataClient.ParseDeck(Fixture("steam_deck_verified.json"), "620")); // wrong app
        Assert.Null(SteamStoreDataClient.ParseDeck("""{"success":1,"results":[]}""", "1"));
    }

    [Theory]
    [InlineData("#SteamDeckVerified_TestResult_InterfaceTextIsLegible", "Interface text is legible on Steam Deck")]
    [InlineData("#SteamDeckVerified_TestResult_SomeNewThingIsFine", "Some new thing is fine")]
    [InlineData("<img src=x>", null)]
    [InlineData("#Other_TestResult_X", null)]
    public void Steam_deck_tokens_become_plain_english(string token, string? expected) =>
        Assert.Equal(expected, SteamStoreDataClient.DeckText(token));

    [Fact]
    public void Steam_prices_from_live_answer()
    {
        var prices = SteamStoreDataClient.ParsePrices(Fixture("steam_prices.json"), ["620", "1245620", "3527290", "440", "999999999"]);
        var elden = prices.Single(p => p.AppId == "1245620");
        Assert.Equal("USD", elden.Currency);
        Assert.True(elden.FinalCents > 0);
        Assert.True(prices.Single(p => p.AppId == "440").NotSold);       // free to play
        Assert.True(prices.Single(p => p.AppId == "999999999").NotSold); // unknown app
    }

    // ---------- AreWeAntiCheatYet (live fixture) ----------

    [Fact]
    public void AntiCheat_dataset_parses_store_ids_and_status()
    {
        var rows = AntiCheatClient.Parse(Fixture("awacy_subset.json"));
        Assert.True(rows.Count >= 50);
        var apex = rows.Single(r => r.Store == "steam" && r.StoreId == "1172470");
        Assert.Equal("Denied", apex.Status);
        Assert.Contains("Easy Anti-Cheat", apex.AntiCheats);
        Assert.True(DataSourcesService.ToAntiCheat(apex).Kernel);
        Assert.Empty(AntiCheatClient.Parse("""[{"name":"X","status":"Hacked","storeIds":{"steam":"1"}},{"name":"Y","status":"Broken","storeIds":{"steam":"abc"}}]"""));
        Assert.Throws<DataSourceException>(() => AntiCheatClient.Parse("""{"not":"a list"}"""));
    }
}
