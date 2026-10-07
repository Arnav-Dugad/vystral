using Vystral.Windows.Discover;
using Xunit;

namespace Vystral.Tests.Discover;

/// <summary>Track U: merging answers from several sources must never fuse two different games.</summary>
public sealed class DiscoverMergeTests
{
    private static DiscoverHit Hit(string source, string id, string title, int? year = null, DiscoverIds? ids = null, int rank = 0,
        string[]? stores = null, string kind = "game") =>
        new(source, id, title, year, year is null ? null : $"{year}-01-01", rank, ids ?? IdsFor(source, id), stores ?? [], [], [], [], null, 0, kind);

    private static DiscoverIds IdsFor(string source, string id) => source switch
    {
        "steam" => new DiscoverIds(Steam: id),
        "igdb" => new DiscoverIds(Igdb: long.Parse(id)),
        "rawg" => new DiscoverIds(Rawg: id),
        _ => new DiscoverIds(Wikidata: id),
    };

    private static List<DiscoverEntry> Merge(string query, params DiscoverHit[] hits) => DiscoverMerger.Merge(hits, query, DiscoverLibraryIndex.Empty);

    [Fact]
    public void A_shared_steam_app_id_links_igdb_and_steam()
    {
        var r = Merge("portal 2",
            Hit("steam", "620", "Portal 2"),
            Hit("igdb", "72", "Portal 2", 2011, new DiscoverIds(Steam: "620", Igdb: 72, IgdbSlug: "portal-2")));
        var one = Assert.Single(r);
        Assert.Equal("steam-620", one.Key);
        Assert.Equal(["steam", "igdb"], one.Sources);
        Assert.Equal(2011, one.Year); // the year comes from the source that knows it
        Assert.Equal("Portal 2", one.Title);
    }

    [Fact]
    public void Wikidata_glues_groups_that_only_it_can_connect()
    {
        // IGDB didn't list the Steam ID; Wikidata knows both the Steam ID and the IGDB slug.
        var r = Merge("portal 2",
            Hit("steam", "620", "Portal 2"),
            Hit("igdb", "72", "Portal 2 (Original)", 2011, new DiscoverIds(Igdb: 72, IgdbSlug: "portal-2")),
            Hit("wikidata", "Q279446", "Portal 2", 2011, new DiscoverIds(Steam: "620", IgdbSlug: "portal-2", Wikidata: "Q279446", Microsoft: "bt2b17v20d1p")));
        var one = Assert.Single(r);
        Assert.Equal(["steam", "igdb", "wikidata"], one.Sources);
        Assert.Equal("Q279446", one.Ids.Wikidata);
        Assert.Contains("xbox", one.Stores); // the Microsoft Store ID says where else it's sold
    }

    [Fact]
    public void Title_and_year_merge_across_sources_when_years_agree()
    {
        var r = Merge("hollow knight",
            Hit("igdb", "1", "Hollow Knight", 2017),
            Hit("rawg", "hollow-knight", "Hollow Knight", 2017));
        Assert.Single(r);
    }

    [Fact]
    public void Remakes_with_the_same_title_stay_apart_when_years_differ()
    {
        var r = Merge("doom",
            Hit("igdb", "1", "DOOM", 1993),
            Hit("igdb", "2", "DOOM", 2016),
            Hit("rawg", "doom", "Doom", 1993),
            Hit("rawg", "doom-2016", "DOOM", 2016));
        Assert.Equal(2, r.Count);
        Assert.All(r, g => Assert.Equal(2, g.Sources.Count));
        Assert.Contains(r, g => g.Year == 1993 && g.Ids.Rawg == "doom");
        Assert.Contains(r, g => g.Year == 2016 && g.Ids.Rawg == "doom-2016");
    }

    [Fact]
    public void An_unknown_year_merges_only_when_the_title_is_unambiguous()
    {
        // One IGDB "Celeste": the yearless Steam hit joins it.
        Assert.Single(Merge("celeste", Hit("steam", "504230", "Celeste"), Hit("igdb", "9", "Celeste", 2018)));
        // Two IGDB "Doom"s: a yearless Steam "DOOM" can't be placed, so it stays on its own.
        var r = Merge("doom", Hit("steam", "379720", "DOOM"), Hit("igdb", "1", "Doom", 1993), Hit("igdb", "2", "Doom", 2016));
        Assert.Equal(3, r.Count);
    }

    [Fact]
    public void Two_hits_from_one_source_never_merge_by_title()
    {
        var r = Merge("tetris", Hit("steam", "1", "Tetris"), Hit("steam", "2", "Tetris"));
        Assert.Equal(2, r.Count);
    }

    [Fact]
    public void Conflicting_ids_never_merge_even_with_identical_titles()
    {
        var r = Merge("portal",
            Hit("steam", "400", "Portal"),
            Hit("igdb", "71", "Portal", 2007, new DiscoverIds(Steam: "9999", Igdb: 71)));
        Assert.Equal(2, r.Count);
    }

    [Fact]
    public void Edition_words_keep_editions_apart()
    {
        var r = Merge("skyrim",
            Hit("igdb", "1", "The Elder Scrolls V: Skyrim", 2011),
            Hit("rawg", "skyrim-se", "The Elder Scrolls V: Skyrim Special Edition", 2011));
        Assert.Equal(2, r.Count);
    }

    [Fact]
    public void Library_games_come_first_and_are_marked()
    {
        var library = DiscoverLibraryIndex.Build([
            new DiscoverLibraryGame("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Portal", "400", 2007),
            new DiscoverLibraryGame("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Hades", null, 2020),
        ]);
        var r = DiscoverMerger.Merge([
            Hit("steam", "620", "Portal 2", rank: 0),
            Hit("steam", "400", "Portal", rank: 1),
            Hit("igdb", "5", "Hades", 2020),
            Hit("igdb", "6", "Hades II", 2025),
        ], "portal", library);
        Assert.Equal("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", r[0].LibraryGameId);
        Assert.Equal("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", r[1].LibraryGameId);
        Assert.All(r.Skip(2), g => Assert.Null(g.LibraryGameId));
    }

    [Fact]
    public void A_library_title_match_needs_agreeing_ids_and_years()
    {
        var library = DiscoverLibraryIndex.Build([
            new DiscoverLibraryGame("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Doom", null, 1993),
            new DiscoverLibraryGame("cccccccccccccccccccccccccccccccc", "Prey", "480490", 2017),
        ]);
        var r = DiscoverMerger.Merge([
            Hit("igdb", "2", "DOOM", 2016),
            Hit("igdb", "3", "Prey", 2006, new DiscoverIds(Steam: "3970", Igdb: 3)),
        ], "doom", library);
        Assert.All(r, g => Assert.Null(g.LibraryGameId)); // 2016 isn't 1993; Prey 2006 has another Steam app ID
    }

    [Fact]
    public void Relevance_puts_exact_and_prefix_matches_first_and_extras_last()
    {
        var r = Merge("portal",
            Hit("steam", "1", "Bridge Constructor Portal", rank: 0),
            Hit("steam", "2", "Portal Soundtrack", rank: 1, kind: "extra"),
            Hit("steam", "400", "Portal", rank: 2),
            Hit("steam", "620", "Portal 2", rank: 3));
        Assert.Equal(["steam-400", "steam-620", "steam-1", "steam-2"], r.Select(g => g.Key).ToArray());
    }

    [Fact]
    public void Keys_prefer_the_steam_app_id_then_igdb_rawg_and_wikidata()
    {
        Assert.Equal("igdb-5", Merge("x", Hit("igdb", "5", "X", 2000)).Single().Key);
        Assert.Equal("rawg-x", Merge("x", Hit("rawg", "x", "X", 2000)).Single().Key);
        Assert.Equal("wd-Q1", Merge("x", Hit("wikidata", "Q1", "X", 2000)).Single().Key);
        Assert.Equal("steam-7", Merge("x", Hit("wikidata", "Q1", "X", 2000, new DiscoverIds(Steam: "7", Wikidata: "Q1"))).Single().Key);
    }

    [Fact]
    public void Results_are_capped()
    {
        var hits = Enumerable.Range(1, 400).Select(i => Hit("steam", i.ToString(), $"Game {i}", rank: i)).ToArray();
        Assert.Equal(DiscoverMerger.MaxResults, Merge("game", hits).Count);
    }

    [Fact]
    public void Simple_folds_case_accents_symbols_and_roman_numerals()
    {
        Assert.Equal("pokemon legends z a", DiscoverMerger.Simple("Pokémon™ Legends: Z-A"));
        Assert.Equal("final fantasy 7", DiscoverMerger.Simple("FINAL FANTASY VII"));
    }
}
