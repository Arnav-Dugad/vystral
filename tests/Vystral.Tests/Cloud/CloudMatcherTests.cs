using Vystral.Core.Cloud;
using Xunit;

namespace Vystral.Tests.Cloud;

public sealed class CloudMatcherTests
{
    private static CloudCatalogEntry Gfn(string n, string title, params (string Store, string Id)[] links) =>
        new(CloudServices.GeForceNow, $"00000000-0000-0000-0000-{n.PadLeft(12, '0')}", n, title, CloudPlayTypes.Ready, false,
            links.Select(l => new CloudStoreLink(l.Store, l.Id)).ToList());

    private static CloudCatalogEntry Xbox(string productId, string title) =>
        new(CloudServices.Xbox, productId, productId, title, CloudPlayTypes.Ready, false, [new CloudStoreLink("xbox", productId)]);

    private static CloudLibraryGame Game(string id, string title, params (string Platform, string Pgid)[] copies) =>
        new(id, title, null, copies.Select(c => new CloudLibraryCopy(c.Platform, c.Pgid, title)).ToList());

    private static readonly Dictionary<string, string> NoPfn = [];

    [Fact]
    public void Steam_copies_match_by_app_id()
    {
        var m = CloudMatcher.Match(CloudServices.GeForceNow, [Gfn("1", "Half-Life 2", ("steam", "220"))], [Game("g1", "Half-Life 2", ("steam", "220"))], NoPfn);
        var match = Assert.Single(m);
        Assert.Equal(CloudMatchKind.StoreId, match.Kind);
        Assert.Equal("steam", match.Store);
    }

    [Fact]
    public void A_steam_copy_not_listed_by_id_is_never_matched_by_title_on_gfn()
    {
        // The catalogue only supports the Epic copy; the user's Steam copy wouldn't stream.
        var m = CloudMatcher.Match(CloudServices.GeForceNow, [Gfn("1", "Thief", ("epic", "2bc4445cab514d02a6cd0cc1ebfa5a4c"))], [Game("g1", "Thief", ("steam", "239160"))], NoPfn);
        Assert.Empty(m);
    }

    [Fact]
    public void Epic_and_ubisoft_copies_match_by_title_only_when_the_entry_lists_that_store()
    {
        var catalog = new[]
        {
            Gfn("1", "Far Cry® 3 Deluxe Edition", ("ubisoft", "599")),
            Gfn("2", "Thief", ("steam", "239160")),
        };
        var games = new[] { Game("g1", "Far Cry 3", ("ubisoft", "46")), Game("g2", "Thief", ("epic", "abc")) };
        var m = CloudMatcher.Match(CloudServices.GeForceNow, catalog, games, NoPfn);
        var fc = Assert.Single(m);
        Assert.Equal("g1", fc.GameId);
        Assert.Equal(CloudMatchKind.Title, fc.Kind);
        Assert.Equal("ubisoft", fc.Store);
    }

    [Fact]
    public void Ambiguous_titles_need_the_same_edition_or_are_skipped()
    {
        var catalog = new[]
        {
            Gfn("1", "Kingsfall", ("epic", "a1")),
            Gfn("2", "Kingsfall Deluxe Edition", ("epic", "a2")),
            Gfn("3", "Ember", ("epic", "b1")),
            Gfn("4", "Ember GOTY", ("epic", "b2")),
        };
        var games = new[] { Game("g1", "Kingsfall Deluxe Edition", ("epic", "x")), Game("g2", "Ember Deluxe Edition", ("epic", "y")) };
        var m = CloudMatcher.Match(CloudServices.GeForceNow, catalog, games, NoPfn);
        var only = Assert.Single(m);
        Assert.Equal("g1", only.GameId);
        Assert.Equal("2", only.Entry.LaunchKey);
    }

    [Fact]
    public void Xbox_copies_match_through_the_package_family_name()
    {
        var pfn = new Dictionary<string, string> { ["9NPDN9R45JX4"] = "SurpriseAttackPtyLtd.1000xResist_8k24hnfn3vvj0" };
        var games = new[] { Game("g1", "1000xRESIST (PC)", ("xbox", "SurpriseAttackPtyLtd.1000xResist_8k24hnfn3vvj0")) };
        var xbox = CloudMatcher.Match(CloudServices.Xbox, [Xbox("9NPDN9R45JX4", "1000xRESIST")], games, pfn);
        Assert.Equal(CloudMatchKind.StoreId, Assert.Single(xbox).Kind);
        // GeForce NOW's Xbox variant resolves the same way.
        var gfn = CloudMatcher.Match(CloudServices.GeForceNow, [Gfn("9", "1000xRESIST", ("xbox", "9NPDN9R45JX4"))], games, pfn);
        Assert.Equal(CloudMatchKind.StoreId, Assert.Single(gfn).Kind);
    }

    [Fact]
    public void Xbox_cloud_may_match_other_stores_by_title_but_never_games_added_by_hand()
    {
        var games = new[]
        {
            Game("g1", "Among Us", ("steam", "945360")),
            Game("g2", "Abiotic Factor", ("manual", "x")),
        };
        var m = CloudMatcher.Match(CloudServices.Xbox, [Xbox("9NG07QJNK38J", "Among Us"), Xbox("9P4NV23Q6QC2", "Abiotic Factor")], games, NoPfn);
        var only = Assert.Single(m);
        Assert.Equal("g1", only.GameId);
        Assert.Equal(CloudMatchKind.Title, only.Kind);
    }

    [Fact]
    public void Gog_ids_match_exactly_and_the_games_own_steam_id_counts()
    {
        var catalog = new[] { Gfn("1", "The Witcher 3: Wild Hunt", ("gog", "1207664643")), Gfn("2", "Portal 2", ("steam", "620")) };
        var games = new[]
        {
            Game("g1", "The Witcher 3", ("gog", "1207664643")),
            new CloudLibraryGame("g2", "Portal 2", "620", [new CloudLibraryCopy("epic", "x", "Portal 2")]),
        };
        var m = CloudMatcher.Match(CloudServices.GeForceNow, catalog, games, NoPfn);
        Assert.Equal(2, m.Count);
        Assert.All(m, x => Assert.Equal(CloudMatchKind.StoreId, x.Kind));
    }

    [Fact]
    public void Very_short_titles_are_not_matched()
    {
        var m = CloudMatcher.Match(CloudServices.Xbox, [Xbox("9NG07QJNK38J", "Go")], [Game("g1", "GO", ("steam", "1"))], NoPfn);
        Assert.Empty(m);
    }
}
