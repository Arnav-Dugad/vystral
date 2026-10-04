using Vystral.Core.Domain;
using Vystral.Core.Matching;
using Xunit;

namespace Vystral.Tests.Core;

public sealed class DuplicateMatcherTests
{
    private static DiscoveredInstallation Found(PlatformId platform, string id, string title, string? steamAppId = null) => new()
    {
        Platform = platform,
        PlatformGameId = id,
        Title = title,
        SteamAppId = steamAppId,
        Launch = new LaunchTarget(LaunchKind.Uri, "steam://rungameid/1"),
    };

    private static MatchCandidate Candidate(string gameId, string title, string? steamAppId,
        params (PlatformId, string)[] installations) => new(gameId, title, steamAppId, installations);

    [Fact]
    public void Existing_installation_identity_wins_over_everything()
    {
        var matcher = new DuplicateMatcher([
            Candidate("g1", "Hades", "1145360", (PlatformId.Steam, "1145360")),
            Candidate("g2", "Totally Different", null, (PlatformId.Epic, "Min")),
        ]);

        // Title and appid both point at g1, but the Epic installation identity is already g2's.
        var decision = matcher.Match(Found(PlatformId.Epic, "Min", "Hades", "1145360"));
        Assert.Equal(new MatchDecision("g2", MatchReason.SameInstallation), decision);

        Assert.Equal(new MatchDecision("g1", MatchReason.SameInstallation),
            matcher.Match(Found(PlatformId.Steam, "1145360", "Renamed Title")));
    }

    [Fact]
    public void Installation_identity_is_platform_scoped()
    {
        var matcher = new DuplicateMatcher([Candidate("g1", "Alpha", null, (PlatformId.Steam, "42"))]);
        // Same id string on a different platform is not the same installation.
        Assert.Equal(new MatchDecision(null, MatchReason.None), matcher.Match(Found(PlatformId.Gog, "42", "Beta")));
    }

    [Fact]
    public void Shared_steam_appid_merges_across_platforms_even_with_different_titles()
    {
        var matcher = new DuplicateMatcher([Candidate("g1", "Hades", "1145360", (PlatformId.Steam, "1145360"))]);
        var decision = matcher.Match(Found(PlatformId.Xbox, "SupergiantGames.Hades", "HADES (Windows Store Version)", "1145360"));
        Assert.Equal(new MatchDecision("g1", MatchReason.SharedSteamAppId), decision);
    }

    [Fact]
    public void Shared_steam_appid_does_not_merge_two_items_from_the_same_platform()
    {
        var matcher = new DuplicateMatcher([Candidate("g1", "Alpha", "100", (PlatformId.Steam, "100"))]);
        var decision = matcher.Match(Found(PlatformId.Steam, "200", "Beta", "100"));
        Assert.Equal(new MatchDecision(null, MatchReason.None), decision);
    }

    [Fact]
    public void Exact_normalized_title_merges_across_different_platforms()
    {
        var matcher = new DuplicateMatcher([Candidate("g1", "The Witcher® 3: Wild Hunt", null, (PlatformId.Steam, "292030"))]);
        var decision = matcher.Match(Found(PlatformId.Gog, "1207664663", "Witcher 3: Wild Hunt"));
        Assert.Equal(new MatchDecision("g1", MatchReason.ExactTitle), decision);
    }

    [Fact]
    public void Platform_qualifier_does_not_prevent_title_merge()
    {
        var matcher = new DuplicateMatcher([Candidate("g1", "Forza Horizon 5", null, (PlatformId.Steam, "1551360"))]);
        var decision = matcher.Match(Found(PlatformId.Xbox, "Microsoft.SunriseBaseGame", "Forza Horizon 5 (PC)"));
        Assert.Equal(new MatchDecision("g1", MatchReason.ExactTitle), decision);
    }

    [Fact]
    public void Same_platform_same_title_does_not_merge()
    {
        var matcher = new DuplicateMatcher([Candidate("g1", "Doom", null, (PlatformId.Steam, "2280"))]);
        var decision = matcher.Match(Found(PlatformId.Steam, "379720", "DOOM"));
        Assert.Equal(new MatchDecision(null, MatchReason.None), decision);
    }

    [Fact]
    public void Title_match_picks_a_game_that_does_not_already_have_that_platform()
    {
        var matcher = new DuplicateMatcher([
            Candidate("g1", "Doom", null, (PlatformId.Epic, "a")),
            Candidate("g2", "Doom", null, (PlatformId.Steam, "b")),
        ]);
        Assert.Equal(new MatchDecision("g2", MatchReason.ExactTitle), matcher.Match(Found(PlatformId.Epic, "c", "Doom")));
        Assert.Equal(new MatchDecision("g1", MatchReason.ExactTitle), matcher.Match(Found(PlatformId.Steam, "d", "Doom")));
    }

    [Fact]
    public void Different_editions_do_not_merge_but_produce_a_suggestion()
    {
        var matcher = new DuplicateMatcher([Candidate("g1", "Skyrim Special Edition", null, (PlatformId.Steam, "489830"))]);
        var found = Found(PlatformId.Gog, "skyrim", "Skyrim");
        Assert.Equal(new MatchDecision(null, MatchReason.None), matcher.Match(found));

        matcher.Add(Candidate("g2", "Skyrim", null, (PlatformId.Gog, "skyrim")));
        var suggestion = Assert.Single(matcher.Suggestions());
        Assert.Equal(("g1", "g2"), (suggestion.GameIdA, suggestion.GameIdB));
        Assert.Contains("skyrim", suggestion.Explanation);
    }

    [Fact]
    public void Remaster_is_neither_merged_nor_suggested()
    {
        var matcher = new DuplicateMatcher([
            Candidate("g1", "Dark Souls", null, (PlatformId.Steam, "1")),
            Candidate("g2", "Dark Souls Remastered", null, (PlatformId.Epic, "2")),
        ]);
        Assert.Equal(MatchReason.None, matcher.Match(Found(PlatformId.Epic, "3", "Dark Souls Remastered: Special")).Reason);
        Assert.Empty(matcher.Suggestions());
    }

    [Fact]
    public void Suggestions_enumerate_every_pair_once_and_ignore_repeated_candidates()
    {
        var matcher = new DuplicateMatcher([
            Candidate("a", "Fallout 4", null),
            Candidate("b", "Fallout 4 GOTY", null),
            Candidate("c", "Fallout 4 (PC)", null),
            Candidate("a", "Fallout 4", null),
            Candidate("x", "Unrelated", null),
        ]);
        var pairs = matcher.Suggestions().Select(s => (s.GameIdA, s.GameIdB)).ToList();
        Assert.Equal(3, pairs.Count);
        Assert.Contains(("a", "b"), pairs);
        Assert.Contains(("a", "c"), pairs);
        Assert.Contains(("b", "c"), pairs);
    }

    [Fact]
    public void No_candidates_means_no_match_and_no_suggestions()
    {
        var matcher = new DuplicateMatcher([]);
        Assert.Equal(new MatchDecision(null, MatchReason.None), matcher.Match(Found(PlatformId.Steam, "1", "Anything", "1")));
        Assert.Empty(matcher.Suggestions());
    }

    [Fact]
    public void Titles_that_normalize_to_nothing_never_match_by_title()
    {
        var matcher = new DuplicateMatcher([Candidate("g1", "™", null, (PlatformId.Steam, "1"))]);
        Assert.Equal(MatchReason.None, matcher.Match(Found(PlatformId.Epic, "e", "®")).Reason);
        Assert.Empty(matcher.Suggestions());
    }

    [Fact]
    public void Register_records_installation_identity()
    {
        var matcher = new DuplicateMatcher([Candidate("g1", "Alpha", null)]);
        matcher.Register("g1", PlatformId.Epic, "EpicAlpha");
        Assert.Equal(new MatchDecision("g1", MatchReason.SameInstallation), matcher.Match(Found(PlatformId.Epic, "EpicAlpha", "Whatever")));
    }

    [Fact]
    public void Register_marks_the_platform_as_used_so_same_store_titles_stay_separate()
    {
        var matcher = new DuplicateMatcher([Candidate("g1", "Alpha", null)]);
        Assert.Equal(MatchReason.ExactTitle, matcher.Match(Found(PlatformId.Epic, "e2", "Alpha")).Reason);

        matcher.Register("g1", PlatformId.Epic, "e1");
        Assert.Equal(MatchReason.None, matcher.Match(Found(PlatformId.Epic, "e2", "Alpha")).Reason);
        Assert.Equal(MatchReason.ExactTitle, matcher.Match(Found(PlatformId.Gog, "g", "Alpha")).Reason);
    }

    [Fact]
    public void Register_with_steam_appid_enables_appid_matching()
    {
        var matcher = new DuplicateMatcher([Candidate("g1", "Alpha", null)]);
        Assert.Equal(MatchReason.None, matcher.Match(Found(PlatformId.Epic, "e", "Totally Other", "777")).Reason);

        matcher.Register("g1", PlatformId.Steam, "777", steamAppId: "777");
        Assert.Equal(new MatchDecision("g1", MatchReason.SharedSteamAppId), matcher.Match(Found(PlatformId.Epic, "e", "Totally Other", "777")));
    }

    [Fact]
    public void Register_moves_an_installation_to_a_new_game()
    {
        var matcher = new DuplicateMatcher([Candidate("g1", "Alpha", null, (PlatformId.Steam, "1"))]);
        matcher.Register("g2", PlatformId.Steam, "1");
        Assert.Equal("g2", matcher.Match(Found(PlatformId.Steam, "1", "Alpha")).GameId);
    }

    [Fact]
    public void Added_candidates_participate_in_matching()
    {
        var matcher = new DuplicateMatcher([]);
        matcher.Add(Candidate("g9", "Celeste", "504230", (PlatformId.Steam, "504230")));
        Assert.Equal(new MatchDecision("g9", MatchReason.SharedSteamAppId), matcher.Match(Found(PlatformId.Epic, "x", "Celeste!", "504230")));
        Assert.Equal(new MatchDecision("g9", MatchReason.ExactTitle), matcher.Match(Found(PlatformId.Gog, "y", "CELESTE")));
    }
}

