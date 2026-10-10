using Dapper;
using Vystral.Core.Contracts;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Xunit;
using static Vystral.Tests.Support.TestDb;

namespace Vystral.Tests.SteamAccount;

/// <summary>
/// Track C1: refunded or removed Steam games leave the library after a complete owned-games answer — and nothing
/// else ever makes them leave. Their sessions, notes, ratings and art stay, and buying again brings them back.
/// </summary>
public sealed class SteamOwnershipTests : IDisposable
{
    private readonly TestDb _t = new();
    private LibraryRepository Repo => _t.Repo;

    public void Dispose() => _t.Dispose();

    private LibrarySnapshotDto Snapshot() => Repo.LoadSnapshot((g, f) => $"art://{g}/{f}");
    private GameDto Game(string title) => Snapshot().Games.Single(g => g.Title == title);
    private InstallationDto SteamInst(string appId) =>
        Snapshot().Games.SelectMany(g => g.Installations).Single(i => i.Platform == "steam" && i.PlatformGameId == appId);

    private static OwnedSteamGame Owned(string appId, string name, int? minutes = null) => new(appId, name, minutes, null);

    /// <summary>A complete answer: the owned list and its appids.</summary>
    private OwnedSyncReport Sync(params OwnedSteamGame[] owned) => Repo.ApplyOwnedSteamGames(owned, owned.Select(o => o.AppId).ToList());

    private static readonly OwnedSteamGame Portal2 = Owned("620", "Portal 2", 300);
    private static readonly OwnedSteamGame Portal = Owned("400", "Portal", 90);
    private static readonly OwnedSteamGame Hades = Owned("1145360", "Hades", 1200);

    [Fact]
    public void A_refunded_game_leaves_the_library_after_a_complete_list()
    {
        Sync(Portal2, Portal, Hades);
        var report = Sync(Portal2, Hades); // Portal was refunded

        Assert.Equal(1, report.NoLongerOwned);
        var portal = Game("Portal");
        Assert.True(portal.NotOwned);
        Assert.True(portal.Hidden); // leaves every view like a hidden game…
        Assert.False(portal.UserHidden); // …without touching the user's own flag
        Assert.NotNull(SteamInst("400").NoLongerOwned);
        Assert.Equal("notinstalled", SteamInst("400").State);
        Assert.False(Game("Portal 2").Hidden);
        var listed = Assert.Single(Repo.NoLongerOwnedSteamGames());
        Assert.Equal(("400", "Portal"), (listed.AppId, listed.Title));
    }

    [Fact]
    public void Sessions_notes_ratings_and_art_are_kept_and_buying_again_brings_the_game_back_intact()
    {
        Sync(Portal2, Portal, Hades);
        var id = Game("Portal").Id;
        Repo.UpdateGameFlags(id, favorite: true, rating: 5, notes: "Finish the bonus maps", setNotes: true);
        Repo.SetArtwork(id, ArtworkKind.Cover, "g/cover.png", "user", isUser: true);
        var session = Repo.StartSession(id, null, DateTimeOffset.UtcNow.AddHours(-3));
        Repo.EndSession(session, DateTimeOffset.UtcNow.AddHours(-2), 3600, null);

        Sync(Portal2, Hades);
        Assert.True(Game("Portal").NotOwned);

        var again = Sync(Portal2, Portal, Hades);
        Assert.Equal(1, again.OwnedAgain);
        Assert.Equal(0, again.Added); // the same row and game, not a new one
        var portal = Game("Portal");
        Assert.Equal(id, portal.Id);
        Assert.False(portal.NotOwned);
        Assert.False(portal.Hidden);
        Assert.True(portal.Favorite);
        Assert.Equal(5, portal.UserRating);
        Assert.Equal("Finish the bonus maps", portal.Notes);
        Assert.Equal(1, portal.SessionCount);
        Assert.Equal(3600, portal.TrackedSeconds);
        Assert.NotNull(portal.Art.Cover);
        Assert.Null(SteamInst("400").NoLongerOwned);
        Assert.Empty(Repo.NoLongerOwnedSteamGames());
    }

    [Fact]
    public void A_game_the_user_hid_stays_hidden_when_bought_again()
    {
        Sync(Portal2, Portal);
        Repo.UpdateGameFlags(Game("Portal").Id, hidden: true);
        Sync(Portal2);
        Sync(Portal2, Portal);
        Assert.True(Game("Portal").UserHidden);
        Assert.True(Game("Portal").Hidden);
        Assert.False(Game("Portal").NotOwned);
    }

    [Fact]
    public void Partial_failed_or_unknown_answers_never_remove_anything()
    {
        Sync(Portal2, Portal, Hades);

        // Not known to be complete (null): e.g. game_count didn't match, or an older caller.
        var partial = Repo.ApplyOwnedSteamGames([Portal2], completeList: null);
        Assert.Equal(0, partial.NoLongerOwned);
        // An empty answer is never trusted.
        var empty = Repo.ApplyOwnedSteamGames([], completeList: []);
        Assert.Equal(0, empty.NoLongerOwned);

        Assert.All(Snapshot().Games, g => Assert.False(g.NotOwned));
        Assert.Empty(Repo.NoLongerOwnedSteamGames());
    }

    [Fact]
    public void A_private_profile_or_failure_never_reaches_the_library()
    {
        // GetOwnedGames says {"response":{}} for a private profile: that is an error, not an empty list.
        var ex = Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseOwnedGamesList("""{"response":{}}"""));
        Assert.Equal(SteamApiOutcome.PrivateProfile, ex.Outcome);
        Assert.Equal(SteamApiOutcome.Malformed, Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseOwnedGamesList("<html>")).Outcome);
    }

    [Fact]
    public void The_first_list_for_an_account_marks_nothing()
    {
        // Rows from before (e.g. another account, or a cleared cache): no previous list to compare with.
        Repo.ApplyOwnedSteamGames([Portal2, Portal]);
        Repo.ClearSteamWebApiCache();

        var report = Sync(Portal2);

        Assert.Equal(0, report.NoLongerOwned);
        Assert.False(Game("Portal").NotOwned);
        // The next complete list compares with this one.
        Assert.Equal(1, Sync(Portal2).NoLongerOwned);
        Assert.True(Game("Portal").NotOwned);
    }

    [Fact]
    public void Installed_games_stay_whatever_the_list_says()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "400", "Portal", @"C:\Steam\Portal", steamAppId: "400"))]);
        Sync(Portal2, Portal);
        var report = Sync(Portal2);

        Assert.Equal(0, report.NoLongerOwned);
        Assert.Equal("installed", SteamInst("400").State);
        Assert.Null(SteamInst("400").NoLongerOwned);
        Assert.False(Game("Portal").Hidden);
    }

    [Fact]
    public void Installing_a_no_longer_owned_game_brings_it_back()
    {
        Sync(Portal2, Portal);
        Sync(Portal2);
        Assert.True(Game("Portal").NotOwned);

        // Installed again (bought again, or played through Family Sharing): an installed copy is in the library.
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "400", "Portal", @"C:\Steam\Portal", steamAppId: "400"))]);
        Assert.False(Game("Portal").NotOwned);
        Assert.False(Game("Portal").Hidden);
        Assert.Null(SteamInst("400").NoLongerOwned);

        // Uninstalled again later: missing (Steam doesn't list it), not "no longer owned" from a stale date.
        Repo.ApplyScan([Ok(PlatformId.Steam)]);
        Assert.Equal("missing", SteamInst("400").State);
        Assert.Null(SteamInst("400").NoLongerOwned);
    }

    [Fact]
    public void Family_sharing_games_are_never_touched()
    {
        // Borrowed games are never in the owner's list: installed ones stay installed, uninstalled ones stay missing.
        Repo.ApplyScan([Ok(PlatformId.Steam,
            Install(PlatformId.Steam, "730", "Borrowed Installed", @"C:\Steam\A", steamAppId: "730"),
            Install(PlatformId.Steam, "570", "Borrowed Gone", @"C:\Steam\B", steamAppId: "570"))]);
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "730", "Borrowed Installed", @"C:\Steam\A", steamAppId: "730"))]);
        Sync(Portal2);
        var report = Sync(Portal2);

        Assert.Equal(0, report.NoLongerOwned);
        Assert.Equal("installed", SteamInst("730").State);
        Assert.Equal("missing", SteamInst("570").State);
        Assert.All(Snapshot().Games, g => Assert.False(g.NotOwned));
    }

    [Fact]
    public void Played_free_games_listed_by_include_played_free_games_stay_owned()
    {
        var freeGame = Owned("440", "Team Fortress 2", 50);
        Sync(Portal2, freeGame);
        var report = Sync(Portal2, freeGame);
        Assert.Equal(0, report.NoLongerOwned);
        Assert.False(Game("Team Fortress 2").NotOwned);
    }

    [Fact]
    public void Entries_Steam_sent_without_a_name_still_count_as_owned()
    {
        Sync(Portal2, Portal);
        // Steam listed 400 but without a usable name: it isn't imported, yet it is still owned.
        var report = Repo.ApplyOwnedSteamGames([Portal2], ["620", "400"]);
        Assert.Equal(0, report.NoLongerOwned);
        Assert.False(Game("Portal").NotOwned);
    }

    [Fact]
    public void A_game_merged_with_another_store_stays_in_the_library()
    {
        Repo.ApplyScan([Ok(PlatformId.Epic, Install(PlatformId.Epic, "Fig", "Hollow Knight"))]);
        Sync(Portal2, Owned("367520", "Hollow Knight"));
        Sync(Portal2);

        var hk = Game("Hollow Knight");
        Assert.False(hk.NotOwned);
        Assert.False(hk.Hidden);
        Assert.NotNull(hk.Installations.Single(i => i.Platform == "steam").NoLongerOwned);
        Assert.Null(hk.Installations.Single(i => i.Platform == "epic").NoLongerOwned);
    }

    [Fact]
    public void Manually_linked_copies_are_left_alone()
    {
        Sync(Portal2, Portal);
        using (var conn = _t.Db.Open()) conn.Execute("UPDATE installations SET manual_link=1 WHERE platform_game_id='400'");
        Assert.Equal(0, Sync(Portal2).NoLongerOwned);
        Assert.False(Game("Portal").NotOwned);
    }

    [Fact]
    public void A_missing_copy_Steam_listed_last_time_counts_as_refunded()
    {
        // Installed, then uninstalled and refunded before the next sync.
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "400", "Portal", @"C:\Steam\Portal", steamAppId: "400"))]);
        Sync(Portal2, Portal);
        Repo.ApplyScan([Ok(PlatformId.Steam)]);
        Assert.Equal("missing", SteamInst("400").State);

        Assert.Equal(1, Sync(Portal2).NoLongerOwned);
        Assert.Equal("notinstalled", SteamInst("400").State);
        Assert.True(Game("Portal").NotOwned);
    }

    [Fact]
    public void An_implausibly_large_drop_is_ignored()
    {
        var many = Enumerable.Range(1, 40).Select(i => Owned((1000 + i).ToString(), $"Game {i}")).ToArray();
        Sync(many);
        // Steam suddenly lists 5 of 40: a hiccup on Steam's side, not 35 refunds.
        var report = Sync(many.Take(5).ToArray());
        Assert.Equal(0, report.NoLongerOwned);
        Assert.All(Snapshot().Games, g => Assert.False(g.NotOwned));
        Assert.Contains(Repo.RecentAudit(5), a => a.Action == "steam.ownedSync.dropIgnored");
    }

    [Fact]
    public void A_few_refunds_in_a_big_library_are_applied()
    {
        var many = Enumerable.Range(1, 60).Select(i => Owned((1000 + i).ToString(), $"Game {i}")).ToArray();
        Sync(many);
        Assert.Equal(3, Sync(many.Skip(3).ToArray()).NoLongerOwned);
    }

    [Fact]
    public void Migration_9_upgrades_a_version_8_database_keeping_every_installation_owned()
    {
        using var dir = new TempDir();
        var db = new Database(Path.Combine(dir.Path, "v8.db"));
        using (var conn = db.Open())
        {
            conn.Execute("CREATE TABLE schema_version (version INTEGER NOT NULL, applied TEXT NOT NULL, name TEXT NOT NULL);");
            foreach (var (version, name, sql) in Migrations.All.Where(m => m.Version <= 8))
            {
                conn.Execute(sql);
                conn.Execute("INSERT INTO schema_version VALUES (@version, '2026-01-01', @name)", new { version, name });
            }
            conn.Execute("INSERT INTO games(id, title, sort_title, added, updated) VALUES ('g1', 'Portal', 'portal', '2026-01-01', '2026-01-01')");
            conn.Execute("""
                INSERT INTO installations(id, game_id, platform, platform_game_id, title, state, launch_kind, launch_value, size_bytes, first_seen, last_seen)
                VALUES ('i1', 'g1', 'steam', '400', 'Portal', 'notinstalled', 'Uri', 'steam://rungameid/400', NULL, '2026-01-01', '2026-01-01')
                """);
        }

        Assert.Equal(8, db.Migrate());
        var game = new LibraryRepository(db).LoadSnapshot((g, f) => f).Games.Single();
        Assert.False(game.NotOwned);
        Assert.False(game.Hidden);
        var inst = game.Installations.Single();
        Assert.Null(inst.NoLongerOwned);
        Assert.Null(inst.LastPlayedSource);
        Assert.Null(inst.Version);
        TestDb.ReleasePool(db);
    }

    // ---------- Parsing: what "complete" means ----------

    [Fact]
    public void ParseOwnedGamesList_is_complete_only_when_every_counted_game_came_back()
    {
        var whole = SteamWebApiClient.ParseOwnedGamesList("""
            {"response":{"game_count":3,"games":[
              {"appid":620,"name":"Portal 2","playtime_forever":10},
              {"appid":440,"name":"Team Fortress 2","playtime_forever":5},
              {"appid":999,"playtime_forever":0}
            ]}}
            """);
        Assert.True(whole.Complete);
        Assert.Equal(2, whole.Games.Count); // the nameless entry isn't imported…
        Assert.Contains("999", whole.ListedAppIds); // …but it is owned

        var cut = SteamWebApiClient.ParseOwnedGamesList("""{"response":{"game_count":3,"games":[{"appid":620,"name":"Portal 2"}]}}""");
        Assert.False(cut.Complete);

        var none = SteamWebApiClient.ParseOwnedGamesList("""{"response":{"game_count":0}}""");
        Assert.False(none.Complete);
        Assert.Empty(none.Games);
    }
}
