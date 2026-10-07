using Vystral.Windows.DataSources;
using Vystral.Windows.Discover;
using Xunit;

namespace Vystral.Tests.Discover;

/// <summary>
/// Track U: every Discover answer is untrusted. Steam store search, Steam appdetails and Wikidata fixtures were captured
/// from the live keyless endpoints on 2026-10-07 (appdetails trimmed); IGDB and RAWG use inline samples shaped after
/// their documentation, since no developer key was used.
/// </summary>
public sealed class DiscoverParsingTests
{
    internal static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "Discover", name));

    // ---------- Steam store search ----------

    [Fact]
    public void Steam_store_search_reads_apps_prices_and_platforms()
    {
        var hits = DiscoverParsers.ParseSteamSearch(Fixture("steam_storesearch_portal.json"));
        Assert.True(hits.Count >= 5);
        var portal2 = hits[0];
        Assert.Equal("steam", portal2.Source);
        Assert.Equal("620", portal2.SourceId);
        Assert.Equal("Portal 2", portal2.Title);
        Assert.Equal("620", portal2.Ids.Steam);
        Assert.Equal(["steam"], portal2.Stores);
        Assert.Equal(["PC", "Linux"], portal2.Platforms);
        Assert.Equal(new StorePrice(199, 999, "USD"), portal2.Price);
        Assert.Null(portal2.Year); // store search doesn't say
        Assert.Equal(0, portal2.Rank);
        // Images are only ever on Steam's own CDN, built from the validated app ID.
        Assert.All(portal2.Images, i => Assert.StartsWith("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/", i.Url));
        Assert.Contains(portal2.Images, i => i.Kind == "cover");
        Assert.Equal(hits.Select(h => h.SourceId).Distinct().Count(), hits.Count);
    }

    [Fact]
    public void Steam_store_search_skips_anything_malformed_or_unsafe()
    {
        const string json = """
            {"total":6,"items":[
              {"type":"app","name":"Fine","id":10},
              {"type":"sub","name":"A package","id":11},
              {"type":"app","name":"Bad id","id":"10; DROP"},
              {"type":"app","name":"<b>Bold</b> Title","id":"12","price":{"currency":"usd","final":-5}},
              {"type":"app","id":13},
              {"type":"app","name":"Fine again","id":10},
              {"type":"app","name":"Original Soundtrack","id":14},
              "not an object"
            ]}
            """;
        var hits = DiscoverParsers.ParseSteamSearch(json);
        Assert.Equal(["10", "12", "14"], hits.Select(h => h.SourceId).ToArray());
        Assert.Equal("Bold Title", hits[1].Title); // markup stripped
        Assert.Null(hits[1].Price); // lower-case currency and a negative price are refused
        Assert.Equal("extra", hits[2].Kind);
        Assert.Equal("game", hits[0].Kind);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"items":"nope"}""")]
    [InlineData("[]")]
    public void Steam_store_search_never_throws_on_odd_shapes_except_invalid_json(string json)
    {
        if (json == "not json") Assert.Throws<DataSourceException>(() => DiscoverParsers.ParseSteamSearch(json));
        else Assert.Empty(DiscoverParsers.ParseSteamSearch(json));
    }

    // ---------- Steam appdetails ----------

    [Fact]
    public void Steam_details_read_the_page_facts()
    {
        var d = DiscoverParsers.ParseSteamDetails("620", Fixture("steam_appdetails_620.json"));
        Assert.NotNull(d);
        Assert.Equal("Portal 2", d.Name);
        Assert.Equal("game", d.Type);
        Assert.Equal("2011-04-18", d.ReleaseDate);
        Assert.Equal(2011, d.Year);
        Assert.Contains("Valve", d.Developers);
        Assert.Contains("Action", d.Genres);
        Assert.Equal(95, d.Metacritic);
        Assert.NotNull(d.Price);
        Assert.Equal("USD", d.Price!.Currency);
        Assert.Equal(80, d.Price.DiscountPercent);
        Assert.Equal("$1.99", d.Price.Formatted);
        Assert.StartsWith("https://shared.akamai.steamstatic.com/", d.HeaderImage);
        Assert.False(string.IsNullOrEmpty(d.Description));
    }

    [Fact]
    public void Steam_details_refuse_an_answer_about_another_app()
    {
        const string json = """{"620":{"success":true,"data":{"name":"Something else","steam_appid":999}}}""";
        Assert.Null(DiscoverParsers.ParseSteamDetails("620", json));
        Assert.Null(DiscoverParsers.ParseSteamDetails("620", """{"620":{"success":false}}"""));
        Assert.Null(DiscoverParsers.ParseSteamDetails("620", """{"621":{"success":true,"data":{"name":"x"}}}"""));
    }

    [Fact]
    public void Steam_details_keep_free_and_coming_soon_honest_and_drop_off_site_images()
    {
        const string json = """
            {"7":{"success":true,"data":{"name":"Freebie","steam_appid":7,"is_free":true,"release_date":{"coming_soon":true,"date":"Q1 2027"},
              "header_image":"https://evil.example/header.jpg","background_raw":"http://store.akamai.steamstatic.com/images/x.jpg"}}}
            """;
        var d = DiscoverParsers.ParseSteamDetails("7", json)!;
        Assert.True(d.Free);
        Assert.True(d.ComingSoon);
        Assert.Null(d.ReleaseDate);
        Assert.Equal(2027, d.Year);
        Assert.True(d.Price!.Free);
        Assert.Null(d.HeaderImage);
        Assert.Null(d.Background); // plain HTTP refused
    }

    [Theory]
    [InlineData("Apr 18, 2011", "2011-04-18", 2011)]
    [InlineData("18 Apr, 2011", "2011-04-18", 2011)]
    [InlineData("Q1 2027", null, 2027)]
    [InlineData("Coming soon", null, null)]
    [InlineData("", null, null)]
    [InlineData("Dec 1, 1800", null, null)]
    public void Steam_dates_are_read_in_their_common_shapes(string text, string? date, int? year)
    {
        Assert.Equal((date, year), DiscoverParsers.SteamDate(text));
    }

    // ---------- IGDB ----------

    private const string IgdbSearch = """
        [
          {"id":72,"name":"Portal 2","slug":"portal-2","first_release_date":1303084800,"cover":{"id":1,"image_id":"co1rs4"},
           "platforms":[{"id":6,"name":"PC (Microsoft Windows)","abbreviation":"PC"},{"id":9,"name":"PlayStation 3"}],
           "genres":[{"id":5,"name":"Shooter"},{"id":9,"name":"Puzzle"}],
           "external_games":[{"id":1,"uid":"620","external_game_source":1},{"id":2,"uid":"1207658693","external_game_source":5},{"id":3,"uid":"9p3j32ctxlrz","external_game_source":11},{"id":4,"uid":"<script>","external_game_source":1}],
           "total_rating_count":3200,"game_type":0},
          {"id":73,"name":"Portal 2 - Soundtrack","first_release_date":"bad","game_type":{"id":1}},
          {"id":-4,"name":"Negative"},
          {"id":74,"slug":"Bad Slug!","name":"Portal Stories: Mel","cover":{"image_id":"../../etc"},"category":0},
          "oops"
        ]
        """;

    [Fact]
    public void Igdb_search_reads_ids_stores_images_and_skips_bad_values()
    {
        var hits = DiscoverParsers.ParseIgdbSearch(IgdbSearch, rankOffset: 20);
        Assert.Equal(["72", "73", "74"], hits.Select(h => h.SourceId).ToArray());
        var p2 = hits[0];
        Assert.Equal(2011, p2.Year);
        Assert.Equal("2011-04-18", p2.ReleaseDate);
        Assert.Equal(20, p2.Rank);
        Assert.Equal("620", p2.Ids.Steam);
        Assert.Equal(72, p2.Ids.Igdb);
        Assert.Equal("portal-2", p2.Ids.IgdbSlug);
        Assert.Equal("1207658693", p2.Ids.GogId);
        Assert.Equal("9p3j32ctxlrz", p2.Ids.Microsoft);
        Assert.Equal(["steam", "gog", "xbox"], p2.Stores);
        Assert.Equal(["PC", "PlayStation 3"], p2.Platforms);
        Assert.Equal(["Shooter", "Puzzle"], p2.Genres);
        Assert.Equal("https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1rs4.jpg", Assert.Single(p2.Images).Url);
        Assert.Equal(3200, p2.Popularity);
        Assert.Equal("game", p2.Kind);
        Assert.Equal("extra", hits[1].Kind); // a DLC game type
        Assert.Null(hits[1].Year);
        Assert.Null(hits[2].Ids.IgdbSlug); // malformed slug dropped
        Assert.Empty(hits[2].Images); // path-like image id refused
    }

    [Fact]
    public void Igdb_game_reads_studios_artwork_and_rating()
    {
        const string json = """
            [{"id":72,"name":"Portal 2","slug":"portal-2","summary":"<p>Think with portals.</p>","first_release_date":1303084800,
              "artworks":[{"image_id":"ar5kd"}],"involved_companies":[{"company":{"name":"Valve"},"developer":true,"publisher":true},{"company":{"name":"EA"},"publisher":true}],
              "total_rating":93.456,"total_rating_count":3200}]
            """;
        var g = DiscoverParsers.ParseIgdbGame(json)!;
        Assert.Equal("Think with portals.", g.Summary);
        Assert.Equal(["Valve"], g.Developers);
        Assert.Equal(["Valve", "EA"], g.Publishers);
        Assert.Equal(93.5, g.Rating);
        Assert.Contains(g.Images, i => i is { Kind: "hero", Url: "https://images.igdb.com/igdb/image/upload/t_1080p/ar5kd.jpg" });
        Assert.Null(DiscoverParsers.ParseIgdbGame("[]"));
        Assert.Null(DiscoverParsers.ParseIgdbGame("""{"message":"x"}"""));
    }

    // ---------- RAWG ----------

    private const string RawgSearch = """
        {"count":3,"results":[
          {"id":4200,"slug":"portal-2","name":"Portal 2","released":"2011-04-18","background_image":"https://media.rawg.io/media/games/2ba/portal2.jpg",
           "platforms":[{"platform":{"id":4,"name":"PC","slug":"pc"}},{"platform":{"name":"Xbox 360"}}],
           "stores":[{"store":{"id":1,"slug":"steam"}},{"store":{"id":3,"slug":"playstation-store"}},{"store":{"id":7,"slug":"xbox360"}}],
           "genres":[{"name":"Puzzle"}],"added":15000},
          {"id":1,"slug":"../etc","name":"Traversal"},
          {"id":2,"slug":"portal-reloaded","name":"Portal Reloaded","released":"not a date","background_image":"https://evil.example/x.jpg"}
        ]}
        """;

    [Fact]
    public void Rawg_search_reads_stores_platforms_and_safe_images_only()
    {
        var hits = DiscoverParsers.ParseRawgSearch(RawgSearch);
        Assert.Equal(["portal-2", "portal-reloaded"], hits.Select(h => h.SourceId).ToArray());
        var p2 = hits[0];
        Assert.Equal("portal-2", p2.Ids.Rawg);
        Assert.Equal(2011, p2.Year);
        Assert.Equal(["steam", "xbox"], p2.Stores);
        Assert.Equal(["PC", "Xbox 360"], p2.Platforms);
        Assert.Equal("background", Assert.Single(p2.Images).Kind);
        Assert.Empty(hits[1].Images);
        Assert.Null(hits[1].Year);
    }

    // ---------- Wikidata ----------

    [Fact]
    public void Wikidata_search_reads_items_dates_and_store_ids()
    {
        var hits = DiscoverParsers.ParseWikidataSearch(Fixture("wikidata_search_portal2.json"));
        var p2 = hits[0];
        Assert.Equal("Q279446", p2.SourceId);
        Assert.Equal("Portal 2", p2.Title);
        Assert.Equal(2011, p2.Year);
        Assert.Equal("620", p2.Ids.Steam);
        Assert.Equal("portal-2", p2.Ids.IgdbSlug);
        Assert.Equal("portal-2", p2.Ids.Rawg);
        Assert.Equal("bt2b17v20d1p", p2.Ids.Microsoft);
        Assert.Equal("Q279446", p2.Ids.Wikidata);
        Assert.Equal(["steam", "xbox"], p2.Stores);
    }

    [Fact]
    public void Wikidata_search_drops_unlabelled_items_and_bad_ids()
    {
        const string json = """
            {"results":{"bindings":[
              {"item":{"type":"uri","value":"http://www.wikidata.org/entity/Q1"}},
              {"item":{"type":"uri","value":"http://evil.example/entity/Q2"},"lbl":{"value":"Evil"}},
              {"item":{"type":"uri","value":"http://www.wikidata.org/entity/Q3"},"lbl":{"value":"Good"},"v_steam":{"value":"12a"},"v_epic":{"value":"ok-slug"},"released":{"value":"+1999-01-01T00:00:00Z"}}
            ]}}
            """;
        var hits = DiscoverParsers.ParseWikidataSearch(json);
        var only = Assert.Single(hits);
        Assert.Equal("Q3", only.SourceId);
        Assert.Null(only.Ids.Steam);
        Assert.Equal("ok-slug", only.Ids.Epic);
        Assert.Equal(1999, only.Year);
        Assert.Throws<DataSourceException>(() => DiscoverParsers.ParseWikidataSearch("""{"head":{}}"""));
    }

    [Fact]
    public void Wikidata_item_reads_labels_and_ignores_unlabelled_values()
    {
        const string json = """
            {"results":{"bindings":[{"item":{"value":"http://www.wikidata.org/entity/Q279446"},"lbl":{"value":"Portal 2"},"desc":{"value":"2011 puzzle-platform video game"},
              "released":{"value":"2011-04-18T00:00:00Z"},"genres":{"value":"puzzle video game|Q999|first-person shooter"},"developers":{"value":"Valve"},
              "publishers":{"value":"Valve|Electronic Arts"},"platforms":{"value":"Microsoft Windows|PlayStation 3"},"v_steam":{"value":"620"}}]}}
            """;
        var item = DiscoverParsers.ParseWikidataItem(json, "Q279446")!;
        Assert.Equal("2011 puzzle-platform video game", item.Description);
        Assert.Equal(["puzzle video game", "first-person shooter"], item.Genres);
        Assert.Equal(["Valve", "Electronic Arts"], item.Publishers);
        Assert.Equal("620", item.Ids.Steam);
        Assert.Equal("2011-04-18", item.ReleaseDate);
    }

    [Fact]
    public void Wikidata_queries_never_carry_raw_quotes_or_braces_from_the_search_text()
    {
        var q = WikidataClient.BuildDiscoverSearch("portal\" } ; DROP { \\ <x>\n2")!;
        Assert.Contains("mwapi:search \"portal  ; DROP   x2\"", q);
        Assert.Null(WikidataClient.BuildDiscoverSearch(" \"\" "));
        Assert.Null(WikidataClient.BuildDiscoverItem("Q12; DROP"));
        Assert.Contains("VALUES ?item { wd:Q279446 }", WikidataClient.BuildDiscoverItem("Q279446"));
    }

    [Fact]
    public void Image_hosts_are_an_allow_list()
    {
        Assert.NotNull(DiscoverParsers.SafeImage("https://images.igdb.com/igdb/image/upload/t_1080p/abc.jpg"));
        Assert.NotNull(DiscoverParsers.SafeImage("https://media.rawg.io/media/games/x.jpg"));
        Assert.Null(DiscoverParsers.SafeImage("https://images.igdb.com.evil.example/x.jpg"));
        Assert.Null(DiscoverParsers.SafeImage("http://media.rawg.io/x.jpg"));
        Assert.Null(DiscoverParsers.SafeImage("https://user:pw@media.rawg.io/x.jpg"));
    }

    [Theory]
    [InlineData("steam-620", true)]
    [InlineData("igdb-72", true)]
    [InlineData("rawg-portal-2", true)]
    [InlineData("wd-Q279446", true)]
    [InlineData("steam-", false)]
    [InlineData("steam-62a", false)]
    [InlineData("rawg-../x", false)]
    [InlineData("rawg-Portal", false)]
    [InlineData("wd-279446", false)]
    [InlineData("gog-123", false)]
    [InlineData("steam-620\n", false)]
    public void Keys_have_strict_shapes(string key, bool ok) => Assert.Equal(ok, DiscoverKeys.IsKey(key));

    [Fact]
    public void Trailer_stand_in_ids_look_like_game_ids_and_are_stable()
    {
        var a = DiscoverKeys.TrailerId("620");
        Assert.Matches("^[0-9a-f]{32}$", a);
        Assert.Equal(a, DiscoverKeys.TrailerId("620"));
        Assert.NotEqual(a, DiscoverKeys.TrailerId("400"));
    }
}
