using System.Text.Json;
using Vystral.Windows.Integrations;
using Xunit;

namespace Vystral.Tests.TrackW;

public sealed class SteamExtrasParsingTests
{
    internal static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "TrackW", name));

    // ---------- Wishlist ----------

    [Fact]
    public void Wishlist_keeps_valid_unique_appids_with_priority_and_date()
    {
        var list = SteamWebApiClient.ParseWishlist(Fixture("wishlist.json"));
        Assert.Equal(["1145360", "620", "2050650", "1086940"], list.Select(w => w.AppId));
        Assert.Equal(1, list[0].Priority);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1693526400), list[0].Added);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1700000000), list[1].Added); // numeric strings accepted
        Assert.Equal(0, list[2].Priority);                                           // negative priority clamped
        Assert.Null(list[2].Added);                                                  // absurd date dropped
        Assert.Null(list[3].Added);
    }

    [Theory]
    [InlineData("""{"response":{}}""")]
    [InlineData("""{"response":{"items":"x"}}""")]
    [InlineData("""{"response":{"items":[]}}""")]
    public void Empty_or_private_wishlists_are_an_empty_list(string json) => Assert.Empty(SteamWebApiClient.ParseWishlist(json));

    [Theory]
    [InlineData("<html>")]
    [InlineData("[]")]
    [InlineData("""{"items":[]}""")]
    [InlineData("""{"response":[]}""")]
    public void Unreadable_wishlists_are_malformed(string json) =>
        Assert.Equal(SteamApiOutcome.Malformed, Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseWishlist(json)).Outcome);

    [Fact]
    public void Wishlist_is_capped()
    {
        var json = JsonSerializer.Serialize(new { response = new { items = Enumerable.Range(1, SteamWebApiClient.MaxWishlist + 50).Select(i => new { appid = i }) } });
        Assert.Equal(SteamWebApiClient.MaxWishlist, SteamWebApiClient.ParseWishlist(json).Count);
    }

    [Fact]
    public void Deeply_nested_input_is_rejected_not_crashing()
    {
        var json = """{"response":{"items":""" + new string('[', 200) + new string(']', 200) + "}}";
        Assert.Equal(SteamApiOutcome.Malformed, Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseWishlist(json)).Outcome);
    }

    // ---------- Store items ----------

    [Fact]
    public void Store_items_are_matched_to_requested_apps_cleaned_and_validated()
    {
        var items = SteamWebApiClient.ParseStoreItems(Fixture("storeitems.json"), ["1145360", "2050650", "1086940", "620", "730"]);
        Assert.Equal(["1145360", "2050650", "1086940", "620"], items.Select(i => i.AppId)); // unrequested, failed and duplicate entries dropped

        var hades = items[0];
        Assert.Equal("Hades", hades.Name);
        Assert.False(hades.ComingSoon);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1600300800), hades.ReleaseDate);
        Assert.Equal(1249, hades.FinalCents);
        Assert.Equal(2499, hades.OriginalCents);
        Assert.Equal(50, hades.DiscountPercent);
        Assert.Equal("$12.49", hades.FormattedPrice);
        Assert.Equal("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1145360/header.jpg?t=1700000000", hades.HeaderUrl);

        var re4 = items[1];
        Assert.Equal("Resident Evil 4", re4.Name);         // bidi override and bell removed
        Assert.True(re4.ComingSoon);
        Assert.Null(re4.ReleaseDate);                       // only a quarter is known: no fake day
        Assert.Equal("Q1 2026", re4.ReleaseText);
        Assert.Equal("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2050650/header.jpg", re4.HeaderUrl); // another app's asset folder refused

        var bg3 = items[2];
        Assert.Equal("Coming soon™", bg3.ReleaseText);
        Assert.Null(bg3.FinalCents);                        // not a number
        Assert.Equal(100, bg3.DiscountPercent);             // clamped
        Assert.Equal("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg", bg3.HeaderUrl); // path traversal refused

        var portal = items[3];
        Assert.True(portal.IsFree);
        Assert.Equal("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/0123456789abcdef0123456789abcdef01234567/header_alt.jpg?t=1", portal.HeaderUrl);
    }

    [Fact]
    public void Store_items_without_a_response_are_malformed() =>
        Assert.Equal(SteamApiOutcome.Malformed, Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseStoreItems("{}", ["1"])).Outcome);

    // ---------- Recently played ----------

    [Fact]
    public void Recently_played_keeps_games_played_in_the_last_two_weeks()
    {
        var games = SteamWebApiClient.ParseRecentlyPlayed(Fixture("recentlyplayed.json"))!;
        Assert.Equal(["620", "1145360", "730"], games.Select(g => g.AppId)); // no playtime, duplicate and id-less entries dropped
        Assert.Equal(185, games[0].MinutesTwoWeeks);
        Assert.Equal(30, games[1].MinutesForever);   // never below the two-week figure
        Assert.Equal(20160, games[2].MinutesTwoWeeks); // clamped to two weeks of minutes
    }

    [Fact]
    public void Recently_played_without_total_count_means_a_private_profile()
    {
        Assert.Null(SteamWebApiClient.ParseRecentlyPlayed("""{"response":{}}"""));
        Assert.Empty(SteamWebApiClient.ParseRecentlyPlayed("""{"response":{"total_count":0}}""")!);
        Assert.Equal(SteamApiOutcome.Malformed, Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseRecentlyPlayed("nope")).Outcome);
    }

    // ---------- News ----------

    [Fact]
    public void News_items_are_validated_and_decoded()
    {
        var news = SteamWebApiClient.ParseNews(Fixture("news.json"), "620");
        Assert.Equal(["5124585837391111111", "5124585837392222222"], news.Select(n => n.Gid));
        Assert.Equal("Patch 1.2.3 & balance changes", news[0].Title);
        Assert.Equal(["patchnotes"], news[0].Tags);
        Assert.Equal(["mod_reviewed"], news[1].Tags);            // tag-shaped values only
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1700000000), news[0].Date);
        Assert.Contains("[h2]", news[0].Contents);              // still raw: sanitized separately
    }

    [Fact]
    public void News_contents_are_capped_before_sanitizing()
    {
        var huge = new string('a', SteamWebApiClient.MaxNewsBytes + 5000);
        var json = JsonSerializer.Serialize(new { appnews = new { newsitems = new[] { new { gid = "1", title = "t", contents = huge, date = 1700000000 } } } });
        Assert.Equal(SteamWebApiClient.MaxNewsBytes, SteamWebApiClient.ParseNews(json, "1").Single().Contents.Length);
    }

    [Fact]
    public void News_without_appnews_is_malformed() =>
        Assert.Equal(SteamApiOutcome.Malformed, Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseNews("""{"news":{}}""", "1")).Outcome);
}
