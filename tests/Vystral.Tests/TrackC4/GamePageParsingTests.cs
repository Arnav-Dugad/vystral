using Vystral.Windows.DataSources;
using Vystral.Windows.GamePage;
using Vystral.Windows.Integrations;
using Xunit;

namespace Vystral.Tests.TrackC4;

/// <summary>Track C4: parsers for Steam reviews, store facts, community tags and IGDB series (real captured answers plus hostile edits).</summary>
public sealed class GamePageParsingTests
{
    internal static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "TrackC4", name));

    // ---------- Reviews ----------

    [Fact]
    public void Review_summary_is_read_from_query_summary()
    {
        var all = SteamStoreInsightsClient.ParseReviewSummary(Fixture("reviews-all.json"))!;
        Assert.Equal(9, all.Score);
        Assert.Equal("Overwhelmingly Positive", all.Label);
        Assert.Equal(462044, all.Positive);
        Assert.Equal(468106, all.Total);
        var recent = SteamStoreInsightsClient.ParseReviewSummary(Fixture("reviews-recent.json"))!;
        Assert.Equal(2239, recent.Total);
    }

    [Theory]
    [InlineData("""{"success":2,"query_summary":{"total_reviews":5,"total_positive":3}}""")]
    [InlineData("""{"success":1}""")]
    [InlineData("""{"success":1,"query_summary":{"total_reviews":5,"total_positive":9}}""")]
    [InlineData("""{"success":1,"query_summary":{"total_reviews":-1,"total_positive":0}}""")]
    [InlineData("""[]""")]
    public void Unusable_review_answers_are_null(string json) => Assert.Null(SteamStoreInsightsClient.ParseReviewSummary(json));

    [Fact]
    public void Review_labels_with_markup_or_control_characters_are_replaced()
    {
        var s = SteamStoreInsightsClient.ParseReviewSummary("""{"success":1,"query_summary":{"review_score":42,"review_score_desc":"Great {x}","total_positive":3,"total_reviews":4}}""")!;
        Assert.Equal("4 user reviews", s.Label);
        Assert.Equal(0, s.Score); // out-of-range bucket
        var none = SteamStoreInsightsClient.ParseReviewSummary("""{"success":1,"query_summary":{"total_positive":0,"total_reviews":0}}""")!;
        Assert.Equal("No user reviews", none.Label);
    }

    [Theory]
    [InlineData(900, 1000, 95, 100, "up", 5.0)]
    [InlineData(900, 1000, 80, 100, "down", -10.0)]
    [InlineData(900, 1000, 91, 100, "steady", 1.0)]
    public void Trend_compares_recent_with_all_time(long allPos, long allTotal, long recentPos, long recentTotal, string trend, double points)
    {
        var (t, p) = StoreInsightsService.Trend(new ReviewSummary(8, "Very Positive", allPos, allTotal), new ReviewSummary(8, "x", recentPos, recentTotal));
        Assert.Equal(trend, t);
        Assert.Equal(points, p);
    }

    [Fact]
    public void No_trend_with_too_few_reviews()
    {
        Assert.Equal((null, null), StoreInsightsService.Trend(new ReviewSummary(8, "x", 900, 1000), new ReviewSummary(0, "3 user reviews", 0, 3)));
        Assert.Equal((null, null), StoreInsightsService.Trend(new ReviewSummary(0, "x", 5, 6), new ReviewSummary(0, "x", 5, 6)));
        Assert.Equal((null, null), StoreInsightsService.Trend(new ReviewSummary(8, "x", 900, 1000), null));
    }

    // ---------- Store facts ----------

    [Fact]
    public void Store_facts_read_price_metacritic_and_release()
    {
        var f = SteamStoreInsightsClient.ParseStoreFacts(Fixture("storefacts.json"), "620")!;
        Assert.True(f.Found);
        Assert.Equal(819, f.FinalCents);
        Assert.Equal("GBP", f.Currency);
        Assert.Equal("£8.19", f.Formatted);
        Assert.Equal(95, f.Metacritic);
        Assert.Equal("18 Apr, 2011", f.ReleaseText);
        Assert.False(f.ComingSoon);
    }

    [Fact]
    public void Store_facts_reject_unknown_apps_and_bad_values()
    {
        Assert.Null(SteamStoreInsightsClient.ParseStoreFacts(Fixture("storefacts.json"), "440")); // a different app than asked
        Assert.False(SteamStoreInsightsClient.ParseStoreFacts("""{"620":{"success":false}}""", "620")!.Found);
        var bad = SteamStoreInsightsClient.ParseStoreFacts("""{"620":{"success":true,"data":{"price_overview":{"currency":"gbp","final":-5},"metacritic":{"score":400}}}}""", "620")!;
        Assert.Null(bad.FinalCents);
        Assert.Null(bad.Currency);
        Assert.Null(bad.Metacritic);
    }

    // ---------- Community tags ----------

    [Fact]
    public void Store_tags_keep_requested_apps_strongest_first()
    {
        var list = SteamWebApiClient.ParseStoreTags(Fixture("storetags.json"), ["620", "440"]);
        Assert.Equal(["620", "440"], list.Select(t => t.AppId));
        Assert.Equal(20, list[0].Tags.Count);
        Assert.Equal(new SteamAppTag(4182, 604), list[0].Tags[0]);
        Assert.True(list[0].Tags.Zip(list[0].Tags.Skip(1)).All(p => p.First.Weight >= p.Second.Weight));
        Assert.Equal(113, list[1].Tags[0].Id); // Free to Play leads Team Fortress 2
        Assert.Single(SteamWebApiClient.ParseStoreTags(Fixture("storetags.json"), ["440"]));
    }

    [Fact]
    public void Hostile_store_tags_are_cleaned()
    {
        var json = """
            {"response":{"store_items":[
              {"appid":620,"success":1,"tags":[{"tagid":0,"weight":5},{"tagid":"19","weight":"400"},{"tagid":19,"weight":900},{"tagid":7,"weight":-3},{"weight":1}]},
              {"appid":620,"tags":[{"tagid":1,"weight":1}]},
              {"appid":999,"success":1,"tags":[{"tagid":1,"weight":1}]},
              {"appid":440,"success":42,"tags":[{"tagid":1,"weight":1}]}
            ]}}
            """;
        var list = SteamWebApiClient.ParseStoreTags(json, ["620", "440"]);
        var only = Assert.Single(list);
        Assert.Equal([new SteamAppTag(19, 400), new SteamAppTag(7, 0)], only.Tags); // first 19 wins; negative weight floored
        Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseStoreTags("<html>", ["620"]));
        Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseStoreTags("[]", ["620"]));
    }

    [Fact]
    public void Tag_list_names_are_validated()
    {
        var list = SteamWebApiClient.ParseTagList(Fixture("taglist.json"));
        Assert.Equal("711684454", list.Version);
        Assert.Equal("Strategy", list.Names[9]); // the later duplicate doesn't replace it
        Assert.Equal("Action", list.Names[19]);
        Assert.Equal("BadName", list.Names[5]); // bidi override and bell removed
        Assert.False(list.Names.ContainsKey(77));
        Assert.DoesNotContain(list.Names.Keys, k => k <= 0);
        Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseTagList("""{"response":{}}"""));
    }

    [Fact]
    public void Cached_tags_from_disk_are_revalidated()
    {
        var apps = SteamTagsService.ValidateApps(new()
        {
            ["620"] = new AppTagsEntry { Tags = [[19, 5], [19, 6], [-1, 3], [4, 2, 1], [8, 2_000_000]] },
            ["../x"] = new AppTagsEntry(),
            ["0123"] = new AppTagsEntry(),
        });
        Assert.Equal(["620"], apps.Keys);
        Assert.Equal([19], apps["620"].Tags.Select(t => t[0]));
        var names = SteamTagsService.ValidateNames(new() { ["en"] = new TagNamesEntry { Names = new() { [1] = "Ok", [-2] = "No", [3] = "‮" }, Version = "../.." } });
        Assert.Equal([1], names["en"].Names.Keys);
        Assert.Null(names["en"].Version);
    }

    // ---------- IGDB series ----------

    [Fact]
    public void Series_of_a_game_prefers_its_collection()
    {
        var g = IgdbClient.ParseSeriesOf(Fixture("igdb-series-of.json"))!;
        Assert.Equal(new IgdbGroup(87, "Portal", "series"), g);
        var f = IgdbClient.ParseSeriesOf("""[{"id":1,"franchises":[{"id":5,"name":"Mario"}]}]""")!;
        Assert.Equal(new IgdbGroup(5, "Mario", "franchise"), f);
        Assert.Null(IgdbClient.ParseSeriesOf("""[{"id":1}]"""));
        Assert.Null(IgdbClient.ParseSeriesOf("""[]"""));
    }

    [Fact]
    public void Series_games_are_validated_and_ordered_by_release()
    {
        var games = IgdbClient.ParseSeriesGames(Fixture("igdb-series-games.json"));
        Assert.Equal(["Portal", "Portal 2", "Portal Stories: Mel", "Portal Remastered", "Far future", "Portal: Upcoming"], games.Select(g => g.Name));
        Assert.Equal("400", games[0].SteamAppId);
        Assert.Equal("co1x7d", games[0].CoverId);
        Assert.Equal(2007, games[0].Year);
        Assert.Equal("2011-04-19", games[1].Date);
        Assert.Null(games[2].SteamAppId); // "317400x" isn't an app id
        Assert.Null(games[2].CoverId);    // "../evil" isn't an image id
        Assert.Equal(4, games[2].GameType);
        Assert.Null(games[4].Date);       // beyond 2100 is treated as unknown
        Assert.Null(games[5].Year);
    }

    [Theory]
    [InlineData(0, "main")]
    [InlineData(4, "expansion")]
    [InlineData(8, "remake")]
    [InlineData(9, "remaster")]
    [InlineData(10, "expanded")]
    [InlineData(99, "main")]
    public void Series_game_types_have_names(int type, string name) => Assert.Equal(name, FranchiseService.TypeName(type));

    [Fact]
    public void Cached_series_from_disk_are_revalidated()
    {
        var groups = FranchiseService.ValidateGroups(new()
        {
            ["series:87"] = new FranchiseGroupEntry
            {
                Name = "Portal\u0007",
                Games = [new IgdbSeriesGame(71, "Portal", "2007-10-10", 1999, 0, "400", "co1x7d"), new IgdbSeriesGame(72, "Bad", "2011-04-19", 2011, 0, "../620", null),
                    new IgdbSeriesGame(73, "Bad cover", null, null, 0, null, "../x"), new IgdbSeriesGame(74, "Bad date", "yesterday", null, 0, null, null)],
            },
            ["series:../1"] = new FranchiseGroupEntry { Name = "x" },
            ["other:1"] = new FranchiseGroupEntry { Name = "x" },
        });
        var g = Assert.Single(groups).Value;
        Assert.Equal("Portal", g.Name);
        var only = Assert.Single(g.Games);
        Assert.Equal(2007, only.Year); // recomputed from the date
        Assert.Equal("https://images.igdb.com/igdb/image/upload/t_cover_big/co1x7d.jpg", IgdbClient.CoverUrl("co1x7d"));
        Assert.Null(IgdbClient.CoverUrl("../co1"));
    }

    [Fact]
    public void Price_history_keeps_one_point_a_day_and_restarts_on_a_new_currency()
    {
        var day1 = new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero);
        var e = new StoreFactsCacheEntry { Facts = new StoreFacts("620", true, 999, 999, 0, "USD", "$9.99", null, null, false) };
        StoreInsightsService.Record(e, day1);
        e.Facts = e.Facts with { FinalCents = 499 };
        StoreInsightsService.Record(e, day1.AddHours(5));
        Assert.Equal([new Vystral.Windows.Services.WishlistPointDto("2026-03-01", 499)], e.History);
        StoreInsightsService.Record(e, day1.AddDays(1));
        Assert.Equal(2, e.History.Count);
        e.Facts = e.Facts with { Currency = "EUR", FinalCents = 899 };
        StoreInsightsService.Record(e, day1.AddDays(2));
        Assert.Equal([new Vystral.Windows.Services.WishlistPointDto("2026-03-03", 899)], e.History);
        e.Facts = e.Facts with { FinalCents = null };
        StoreInsightsService.Record(e, day1.AddDays(3)); // not sold: nothing recorded
        Assert.Single(e.History);
    }
}
