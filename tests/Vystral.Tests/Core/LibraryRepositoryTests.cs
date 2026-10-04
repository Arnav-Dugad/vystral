using System.Text.Json;
using Dapper;
using Vystral.Core.Contracts;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.Support;
using Xunit;
using static Vystral.Tests.Support.TestDb;

namespace Vystral.Tests.Core;

public sealed class LibraryRepositoryTests : IDisposable
{
    private readonly TestDb _t = new();
    private LibraryRepository Repo => _t.Repo;

    public void Dispose() => _t.Dispose();

    private LibrarySnapshotDto Snapshot() => Repo.LoadSnapshot((gameId, file) => $"art://{gameId}/{file}");

    private GameDto GameByTitle(string title) => Snapshot().Games.Single(g => g.Title == title);

    private long Count(string table)
    {
        using var conn = _t.Db.Open();
        return conn.ExecuteScalar<long>($"SELECT COUNT(*) FROM {table}");
    }

    // ---------- ApplyScan ----------

    [Fact]
    public void ApplyScan_adds_games_and_installations()
    {
        var report = Repo.ApplyScan([Ok(PlatformId.Steam,
            Install(PlatformId.Steam, "1145360", "Hades™", @"d:\SteamLibrary\steamapps\common\Hades", steamAppId: "1145360", playtime: 600),
            Install(PlatformId.Steam, "504230", "Celeste", @"C:\Games\Celeste"))]);

        Assert.Equal(new ScanApplyReport(Added: 2, Updated: 0, MarkedMissing: 0, Merged: 0), report);
        var snap = Snapshot();
        Assert.Equal(2, snap.Games.Count);
        Assert.NotNull(snap.LastScan);

        var hades = snap.Games.Single(g => g.Title == "Hades");
        var inst = Assert.Single(hades.Installations);
        Assert.Equal("steam", inst.Platform);
        Assert.Equal("1145360", inst.PlatformGameId);
        Assert.Equal("installed", inst.State);
        Assert.Equal("Uri", inst.LaunchKind);
        Assert.Equal("D:", inst.Drive);
        Assert.Equal(600, inst.ImportedPlaytimeMinutes);
        Assert.False(inst.ManualLink);
        Assert.Equal("hades", hades.SortTitle);

        var domain = Repo.GetInstallation(inst.Id)!;
        Assert.Equal(new LaunchTarget(LaunchKind.Uri, "steam://rungameid/1145360"), domain.Launch);
        Assert.Equal(["1145360.exe"], domain.ProcessHints);
        Assert.Equal("1145360", Repo.GetGame(hades.Id)!.SteamAppId);
    }

    [Fact]
    public void ApplyScan_rescan_updates_without_duplicating()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha", @"C:\A"))]);
        var firstId = Snapshot().Games.Single().Id;

        var report = Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha (Renamed)", @"E:\A", playtime: 42))]);

        Assert.Equal(new ScanApplyReport(0, 1, 0, 0), report);
        var game = Assert.Single(Snapshot().Games);
        Assert.Equal(firstId, game.Id);
        var inst = Assert.Single(game.Installations);
        Assert.Equal("Alpha (Renamed)", inst.Title);
        Assert.Equal("E:", inst.Drive);
        Assert.Equal(42, inst.ImportedPlaytimeMinutes);
        Assert.Equal(1, Count("installations"));
    }

    [Fact]
    public void ApplyScan_ignores_duplicate_ids_within_one_result()
    {
        var report = Repo.ApplyScan([Ok(PlatformId.Steam,
            Install(PlatformId.Steam, "1", "Alpha"), Install(PlatformId.Steam, "1", "Alpha again"))]);
        Assert.Equal(1, report.Added);
        Assert.Equal(1, Count("installations"));
    }

    [Fact]
    public void Game_missing_from_successful_scan_is_marked_missing_and_kept()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha"), Install(PlatformId.Steam, "2", "Beta"))]);
        var beta = GameByTitle("Beta");
        Repo.UpdateGameFlags(beta.Id, favorite: true, notes: "keep my notes", setNotes: true);

        var report = Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha"))]);

        Assert.Equal(1, report.MarkedMissing);
        beta = GameByTitle("Beta");
        Assert.Equal("missing", Assert.Single(beta.Installations).State);
        Assert.True(beta.Favorite);
        Assert.Equal("keep my notes", beta.Notes);
        Assert.Equal("installed", GameByTitle("Alpha").Installations.Single().State);

        // A second scan without it doesn't count it again.
        Assert.Equal(0, Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha"))]).MarkedMissing);

        // When it comes back it is installed again, on the same game.
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha"), Install(PlatformId.Steam, "2", "Beta"))]);
        Assert.Equal("installed", GameByTitle("Beta").Installations.Single().State);
        Assert.Equal(beta.Id, GameByTitle("Beta").Id);
    }

    [Fact]
    public void Successful_empty_scan_marks_everything_from_that_platform_missing_only()
    {
        Repo.ApplyScan([
            Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha")),
            Ok(PlatformId.Epic, Install(PlatformId.Epic, "e1", "Gamma")),
        ]);

        var report = Repo.ApplyScan([Ok(PlatformId.Steam)]);

        Assert.Equal(1, report.MarkedMissing);
        Assert.Equal("missing", GameByTitle("Alpha").Installations.Single().State);
        Assert.Equal("installed", GameByTitle("Gamma").Installations.Single().State);
    }

    [Fact]
    public void Failed_scan_changes_nothing()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha"), Install(PlatformId.Steam, "2", "Beta"))]);
        var before = Snapshot().Games.SelectMany(g => g.Installations).OrderBy(i => i.Id).ToList();

        var report = Repo.ApplyScan([Failed(PlatformId.Steam)]);

        Assert.Equal(new ScanApplyReport(0, 0, 0, 0), report);
        var after = Snapshot().Games.SelectMany(g => g.Installations).OrderBy(i => i.Id).ToList();
        Assert.Equal(before, after);
        Assert.All(after, i => Assert.Equal("installed", i.State));
    }

    [Fact]
    public void Failed_scan_with_stale_installations_list_is_still_ignored()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha"))]);
        var failed = new Vystral.Core.Integrations.AdapterScanResult(PlatformId.Steam, false,
            [Install(PlatformId.Steam, "99", "Should Not Appear")], "partial read");

        Repo.ApplyScan([failed]);

        Assert.Equal(["Alpha"], Snapshot().Games.Select(g => g.Title).ToArray());
    }

    [Fact]
    public void Cross_store_same_title_merges_into_one_game()
    {
        var report = Repo.ApplyScan([
            Ok(PlatformId.Steam, Install(PlatformId.Steam, "1145360", "Hades", steamAppId: "1145360")),
            Ok(PlatformId.Epic, Install(PlatformId.Epic, "Min", "HADES™")),
        ]);

        Assert.Equal(1, report.Added);
        Assert.Equal(1, report.Merged);
        var game = Assert.Single(Snapshot().Games);
        Assert.Equal(["epic", "steam"], game.Installations.Select(i => i.Platform).Order().ToArray());
    }

    [Fact]
    public void Cross_store_merge_also_works_across_separate_scans()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Celeste"))]);
        var report = Repo.ApplyScan([Ok(PlatformId.Gog, Install(PlatformId.Gog, "g1", "Celeste"))]);
        Assert.Equal(new ScanApplyReport(0, 0, 0, 1), report);
        Assert.Equal(2, Assert.Single(Snapshot().Games).Installations.Count);
    }

    [Fact]
    public void Shared_steam_appid_merges_and_backfills_game_appid()
    {
        Repo.ApplyScan([Ok(PlatformId.Epic, Install(PlatformId.Epic, "e", "Some Epic Name"))]);
        var gameId = Snapshot().Games.Single().Id;
        Assert.Null(Repo.GetGame(gameId)!.SteamAppId);

        // A later scan reports the appid for the existing installation: the game learns it.
        Repo.ApplyScan([Ok(PlatformId.Epic, Install(PlatformId.Epic, "e", "Some Epic Name", steamAppId: "555"))]);
        Assert.Equal("555", Repo.GetGame(gameId)!.SteamAppId);

        var report = Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "555", "Steam Name", steamAppId: "555"))]);
        Assert.Equal(1, report.Merged);
        Assert.Single(Snapshot().Games);
    }

    [Fact]
    public void Same_platform_same_title_creates_separate_games()
    {
        var report = Repo.ApplyScan([Ok(PlatformId.Steam,
            Install(PlatformId.Steam, "2280", "Doom"), Install(PlatformId.Steam, "379720", "DOOM"))]);
        Assert.Equal(2, report.Added);
        Assert.Equal(0, report.Merged);
        Assert.Equal(2, Snapshot().Games.Count);
    }

    [Fact]
    public void Different_editions_stay_separate_and_appear_as_suggestions_until_dismissed()
    {
        Repo.ApplyScan([
            Ok(PlatformId.Steam, Install(PlatformId.Steam, "489830", "The Elder Scrolls V: Skyrim Special Edition")),
            Ok(PlatformId.Gog, Install(PlatformId.Gog, "sk", "The Elder Scrolls V: Skyrim")),
        ]);

        var snap = Snapshot();
        Assert.Equal(2, snap.Games.Count);
        var s = Assert.Single(snap.DuplicateSuggestions);
        Assert.Equal(snap.Games.Select(g => g.Id).Order(), new[] { s.GameIdA, s.GameIdB }.Order());

        Repo.DismissDuplicate(s.GameIdB, s.GameIdA); // order must not matter
        Assert.Empty(Snapshot().DuplicateSuggestions);
    }

    [Fact]
    public void Display_title_is_cleaned_of_trademark_glyphs()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "  Halo™   Infinite® "))]);
        var g = Snapshot().Games.Single();
        Assert.Equal("Halo Infinite", g.Title);
        Assert.Equal("Halo Infinite", g.Installations.Single().Title);
    }

    // ---------- Snapshot ----------

    [Fact]
    public void LoadSnapshot_on_empty_database()
    {
        var snap = Snapshot();
        Assert.Empty(snap.Games);
        Assert.Empty(snap.Collections);
        Assert.Empty(snap.DuplicateSuggestions);
        Assert.Null(snap.LastScan);
    }

    [Fact]
    public void LoadSnapshot_maps_artwork_through_the_callback()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha"))]);
        var id = Snapshot().Games.Single().Id;
        Repo.SetArtwork(id, ArtworkKind.Cover, $"{id}/cover.jpg", "steam-local", isUser: false);
        Repo.SetArtwork(id, ArtworkKind.Logo, $"{id}/logo.png", "steam-cdn", isUser: false);

        var calls = new List<(string, string)>();
        var snap = Repo.LoadSnapshot((g, f) => { calls.Add((g, f)); return $"https://art/{f}"; });

        var art = snap.Games.Single().Art;
        Assert.Equal($"https://art/{id}/cover.jpg", art.Cover);
        Assert.Equal($"https://art/{id}/logo.png", art.Logo);
        Assert.Null(art.Hero);
        Assert.Null(art.Header);
        Assert.Null(art.Icon);
        Assert.Equal(2, calls.Count);
        Assert.All(calls, c => Assert.Equal(id, c.Item1));
    }

    [Fact]
    public void User_artwork_is_not_overwritten_by_automatic_artwork()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha"))]);
        var id = Snapshot().Games.Single().Id;
        Repo.SetArtwork(id, ArtworkKind.Cover, "user.png", "user", isUser: true);
        Repo.SetArtwork(id, ArtworkKind.Cover, "auto.jpg", "steam-cdn", isUser: false);
        Assert.Equal(("user.png", true), Repo.GetArtwork(id)["cover"]);

        Repo.SetArtwork(id, ArtworkKind.Cover, "user2.png", "user", isUser: true);
        Assert.Equal(("user2.png", true), Repo.GetArtwork(id)["cover"]);
    }

    [Fact]
    public void LoadSnapshot_reports_collections_with_member_counts()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam,
            Install(PlatformId.Steam, "1", "Alpha"), Install(PlatformId.Steam, "2", "Beta"), Install(PlatformId.Steam, "3", "Gamma"))]);
        var games = Snapshot().Games.ToDictionary(g => g.Title, g => g.Id);

        var rpg = Repo.CreateCollection("RPGs", "sword", null);
        var empty = Repo.CreateCollection("Empty", null, "{\"installed\":true}");
        Repo.SetCollectionMembership(rpg, games["Alpha"], true);
        Repo.SetCollectionMembership(rpg, games["Beta"], true);
        Repo.SetCollectionMembership(rpg, games["Beta"], true); // idempotent
        Repo.SetCollectionMembership(rpg, "00000000000000000000000000000000", true); // unknown game ignored

        var snap = Snapshot();
        Assert.Equal(["RPGs", "Empty"], snap.Collections.Select(c => c.Name).ToArray()); // by sort order
        var rpgDto = snap.Collections.Single(c => c.Id == rpg);
        Assert.Equal(2, rpgDto.Count);
        Assert.Equal("sword", rpgDto.Icon);
        Assert.Equal(0, snap.Collections.Single(c => c.Id == empty).Count);
        Assert.Equal("{\"installed\":true}", snap.Collections.Single(c => c.Id == empty).Rule);
        Assert.Equal([rpg], snap.Games.Single(g => g.Title == "Alpha").Collections);
        Assert.Empty(snap.Games.Single(g => g.Title == "Gamma").Collections);

        Repo.SetCollectionMembership(rpg, games["Alpha"], false);
        Assert.Equal(1, Snapshot().Collections.Single(c => c.Id == rpg).Count);

        Assert.True(Repo.RenameCollection(rpg, "Role-playing"));
        Assert.True(Repo.DeleteCollection(rpg));
        Assert.False(Repo.DeleteCollection(rpg));
        Assert.Equal(0, Count("collection_games")); // cascade
    }

    [Fact]
    public void LoadSnapshot_aggregates_tracked_sessions_only()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha"))]);
        var id = Snapshot().Games.Single().Id;
        var t0 = new DateTimeOffset(2025, 1, 1, 10, 0, 0, TimeSpan.Zero);
        Repo.EndSession(Repo.StartSession(id, null, t0), t0.AddMinutes(30), 1800, null);
        Repo.EndSession(Repo.StartSession(id, null, t0.AddDays(1)), t0.AddDays(1).AddMinutes(10), 600, null);
        using (var conn = _t.Db.Open())
            conn.Execute("INSERT INTO sessions(id, game_id, start, duration_seconds, source, end) VALUES ('imp', @id, '2030-01-01', 99999, 'imported', '2030-01-01')", new { id });

        var g = Snapshot().Games.Single();
        Assert.Equal(2400, g.TrackedSeconds);
        Assert.Equal(2, g.SessionCount);
        Assert.Equal(t0.AddDays(1).ToString("O"), g.LastTrackedPlay);
    }

    // ---------- User edits ----------

    [Fact]
    public void UpdateGameFlags_sets_and_clears_values()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha"))]);
        var id = Snapshot().Games.Single().Id;

        Assert.True(Repo.UpdateGameFlags(id, favorite: true, hidden: true, rating: 4, notes: "great", setNotes: true));
        var g = Repo.GetGame(id)!;
        Assert.True(g.Favorite);
        Assert.True(g.Hidden);
        Assert.Equal(4, g.UserRating);
        Assert.Equal("great", g.Notes);

        // Unspecified fields are left alone.
        Assert.True(Repo.UpdateGameFlags(id, hidden: false));
        g = Repo.GetGame(id)!;
        Assert.True(g.Favorite);
        Assert.False(g.Hidden);
        Assert.Equal(4, g.UserRating);
        Assert.Equal("great", g.Notes);

        Assert.True(Repo.UpdateGameFlags(id, clearRating: true, notes: null, setNotes: true));
        g = Repo.GetGame(id)!;
        Assert.Null(g.UserRating);
        Assert.Null(g.Notes);

        Assert.False(Repo.UpdateGameFlags("00000000000000000000000000000000", favorite: true));
    }

    [Fact]
    public void SetPreferredInstallation_rejects_installation_of_another_game()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha"), Install(PlatformId.Steam, "2", "Beta"))]);
        var alpha = GameByTitle("Alpha");
        var beta = GameByTitle("Beta");

        Assert.False(Repo.SetPreferredInstallation(alpha.Id, beta.Installations[0].Id));
        Assert.Null(Repo.GetGame(alpha.Id)!.PreferredInstallationId);

        Assert.True(Repo.SetPreferredInstallation(alpha.Id, alpha.Installations[0].Id));
        Assert.Equal(alpha.Installations[0].Id, Repo.GetGame(alpha.Id)!.PreferredInstallationId);

        Assert.True(Repo.SetPreferredInstallation(alpha.Id, null));
        Assert.Null(Repo.GetGame(alpha.Id)!.PreferredInstallationId);

        Assert.False(Repo.SetPreferredInstallation(alpha.Id, "nope"));
    }

    [Fact]
    public void SetUserLaunchArgs_round_trips()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha"))]);
        var inst = Snapshot().Games.Single().Installations.Single();
        Assert.True(Repo.SetUserLaunchArgs(inst.Id, "-novid -high"));
        Assert.Equal("-novid -high", Repo.GetUserLaunchArgs(inst.Id));
        Assert.Equal("-novid -high", Snapshot().Games.Single().Installations.Single().UserLaunchArgs);
        Assert.False(Repo.SetUserLaunchArgs("missing", "x"));
    }

    [Fact]
    public void MergeGames_moves_installations_sessions_collections_and_user_data_then_deletes_source()
    {
        Repo.ApplyScan([
            Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha")),
            Ok(PlatformId.Epic, Install(PlatformId.Epic, "e", "Alpha Remix")),
        ]);
        var target = GameByTitle("Alpha").Id;
        var source = GameByTitle("Alpha Remix").Id;
        var col = Repo.CreateCollection("Faves", null, null);
        Repo.SetCollectionMembership(col, source, true);
        Repo.UpdateGameFlags(source, favorite: true, rating: 5, notes: "from source", setNotes: true);
        Repo.SetArtwork(source, ArtworkKind.Hero, "src-hero.jpg", "steam-cdn", false);
        var session = Repo.StartSession(source, null, DateTimeOffset.UtcNow.AddHours(-1));
        Repo.EndSession(session, DateTimeOffset.UtcNow, 3600, null);

        Assert.True(Repo.MergeGames(target, source));

        Assert.Null(Repo.GetGame(source));
        var merged = Snapshot().Games.Single();
        Assert.Equal(target, merged.Id);
        Assert.Equal(2, merged.Installations.Count);
        Assert.Contains(merged.Installations, i => i.Platform == "epic" && i.ManualLink);
        Assert.True(merged.Favorite);
        Assert.Equal(5, merged.UserRating);
        Assert.Equal("from source", merged.Notes);
        Assert.Equal([col], merged.Collections);
        Assert.Equal(3600, merged.TrackedSeconds);
        Assert.Equal(target, Assert.Single(Repo.ListSessions(target, 10)).GameId);
        Assert.Equal("src-hero.jpg", Repo.GetArtwork(target)["hero"].File);
        Assert.Contains(Repo.RecentAudit(5), a => a.Action == "library.merge");

        // A later scan keeps them together (installation identity wins).
        Repo.ApplyScan([Ok(PlatformId.Epic, Install(PlatformId.Epic, "e", "Alpha Remix"))]);
        Assert.Single(Snapshot().Games);
    }

    [Fact]
    public void MergeGames_keeps_target_values_when_both_have_them()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "A"), Install(PlatformId.Steam, "2", "B"))]);
        var a = GameByTitle("A").Id;
        var b = GameByTitle("B").Id;
        Repo.UpdateGameFlags(a, rating: 2, notes: "target notes", setNotes: true);
        Repo.UpdateGameFlags(b, rating: 5, notes: "source notes", setNotes: true);

        Assert.True(Repo.MergeGames(a, b));
        var g = Repo.GetGame(a)!;
        Assert.Equal(2, g.UserRating);
        Assert.Equal("target notes", g.Notes);
    }

    [Fact]
    public void MergeGames_rejects_self_merge_and_unknown_games()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "A"))]);
        var a = Snapshot().Games.Single().Id;
        Assert.False(Repo.MergeGames(a, a));
        Assert.False(Repo.MergeGames(a, "00000000000000000000000000000000"));
        Assert.False(Repo.MergeGames("00000000000000000000000000000000", a));
        Assert.NotNull(Repo.GetGame(a));
    }

    [Fact]
    public void UnmergeInstallation_refuses_the_only_installation()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Solo"))]);
        var inst = Snapshot().Games.Single().Installations.Single();
        Assert.Null(Repo.UnmergeInstallation(inst.Id));
        Assert.Null(Repo.UnmergeInstallation("missing"));
        Assert.Single(Snapshot().Games);
    }

    [Fact]
    public void UnmergeInstallation_splits_and_pins_and_survives_rescan()
    {
        Repo.ApplyScan([
            Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Hades")),
            Ok(PlatformId.Epic, Install(PlatformId.Epic, "Min", "Hades")),
        ]);
        var game = Snapshot().Games.Single();
        var epic = game.Installations.Single(i => i.Platform == "epic");
        Repo.SetPreferredInstallation(game.Id, epic.Id);
        var session = Repo.StartSession(game.Id, epic.Id, DateTimeOffset.UtcNow);
        Repo.EndSession(session, DateTimeOffset.UtcNow, 60, null);

        var newId = Repo.UnmergeInstallation(epic.Id);

        Assert.NotNull(newId);
        Assert.NotEqual(game.Id, newId);
        var snap = Snapshot();
        Assert.Equal(2, snap.Games.Count);
        var split = snap.Games.Single(g => g.Id == newId);
        Assert.Equal("Hades", split.Title);
        Assert.True(Assert.Single(split.Installations).ManualLink);
        Assert.Equal("steam", Assert.Single(snap.Games.Single(g => g.Id == game.Id).Installations).Platform);
        Assert.Null(Repo.GetGame(game.Id)!.PreferredInstallationId);
        Assert.Equal(newId, Assert.Single(Repo.ListSessions(null, 10)).GameId);

        Repo.ApplyScan([
            Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Hades")),
            Ok(PlatformId.Epic, Install(PlatformId.Epic, "Min", "Hades")),
        ]);
        Assert.Equal(2, Snapshot().Games.Count);
    }

    [Fact]
    public void AddManualGame_creates_executable_installation()
    {
        var id = Repo.AddManualGame("My Indie™ Game", @"C:\Games\Indie\indie.exe", "-windowed");

        var game = Repo.GetGame(id)!;
        Assert.Equal("My Indie Game", game.Title);
        var inst = Assert.Single(Repo.GetInstallations(id));
        Assert.Equal(PlatformId.Manual, inst.Platform);
        Assert.Equal(InstallState.Installed, inst.State);
        Assert.True(inst.ManualLink);
        Assert.Equal(new LaunchTarget(LaunchKind.Executable, @"C:\Games\Indie\indie.exe", "-windowed", @"C:\Games\Indie"), inst.Launch);
        Assert.Equal(@"C:\Games\Indie", inst.InstallPath);
        Assert.Equal(["indie.exe"], inst.ProcessHints);
        Assert.Equal(inst.Id, Repo.GetInstallationsByPlatformId(PlatformId.Manual, inst.PlatformGameId)!.Id);
    }

    [Fact]
    public void Manual_games_are_not_marked_missing_by_store_scans()
    {
        var id = Repo.AddManualGame("Manual", @"C:\Games\m\m.exe", null);
        Repo.ApplyScan([Ok(PlatformId.Steam)]);
        Assert.Equal(InstallState.Installed, Repo.GetInstallations(id).Single().State);
    }

    [Fact]
    public void RemoveManualGame_deletes_manual_game_and_its_history()
    {
        var id = Repo.AddManualGame("Manual", @"C:\Games\m\m.exe", null);
        var col = Repo.CreateCollection("C", null, null);
        Repo.SetCollectionMembership(col, id, true);
        var s = Repo.StartSession(id, null, DateTimeOffset.UtcNow);
        Repo.AddPerfSamples(s, [new PerfSampleDto(0, 1, 2, 3, 4, 5)]);
        Repo.EndSession(s, DateTimeOffset.UtcNow, 10, null);

        Assert.True(Repo.RemoveManualGame(id));

        Assert.Null(Repo.GetGame(id));
        Assert.Empty(Repo.GetInstallations(id));
        Assert.Equal(0, Count("sessions"));
        Assert.Equal(0, Count("perf_samples"));
        Assert.Equal(0, Count("collection_games"));
        Assert.False(Repo.RemoveManualGame(id));
    }

    [Fact]
    public void RemoveManualGame_refuses_store_games_and_mixed_games()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Store Game"))]);
        var store = Snapshot().Games.Single().Id;
        Assert.False(Repo.RemoveManualGame(store));
        Assert.NotNull(Repo.GetGame(store));

        var manual = Repo.AddManualGame("Manual", @"C:\Games\m\m.exe", null);
        Repo.MergeGames(manual, store);
        Assert.False(Repo.RemoveManualGame(manual));
        Assert.Equal(2, Repo.GetInstallations(manual).Count);
    }

    // ---------- Metadata ----------

    [Fact]
    public void SetMetadata_updates_fields_and_removes_game_from_needing_metadata()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "Alpha", steamAppId: "1"), Install(PlatformId.Steam, "2", "Beta"))]);
        var alpha = GameByTitle("Alpha").Id;
        Assert.Equal(2, Repo.GamesNeedingMetadata(10).Count);

        Repo.SetMetadata(alpha, "Steam Store (app 1)", "desc", "Dev", "Pub", "1 Jan, 2020", ["Action", "Indie"]);
        var g = Repo.GetGame(alpha)!;
        Assert.Equal(("desc", "Dev", "Pub", "1 Jan, 2020"), (g.Description, g.Developer, g.Publisher, g.ReleaseDate));
        Assert.Equal(["Action", "Indie"], g.Genres);
        Assert.Equal("Steam Store (app 1)", g.MetadataSource);

        // Null/empty inputs never wipe existing values.
        Repo.SetMetadata(alpha, "again", null, null, null, null, []);
        g = Repo.GetGame(alpha)!;
        Assert.Equal("desc", g.Description);
        Assert.Equal(["Action", "Indie"], g.Genres);

        var remaining = Assert.Single(Repo.GamesNeedingMetadata(10));
        Assert.Equal("Beta", remaining.Title);
        Repo.MarkMetadataAttempted(remaining.GameId);
        Assert.Empty(Repo.GamesNeedingMetadata(10));
    }

    // ---------- Sessions ----------

    [Fact]
    public void Sessions_start_end_and_list()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "1", "A"), Install(PlatformId.Steam, "2", "B"))]);
        var a = GameByTitle("A");
        var b = GameByTitle("B");
        var t0 = new DateTimeOffset(2025, 3, 1, 12, 0, 0, TimeSpan.Zero);

        var s1 = Repo.StartSession(a.Id, a.Installations[0].Id, t0);
        Assert.Empty(Repo.ListSessions(null, 10)); // open sessions are not listed

        Repo.EndSession(s1, t0.AddMinutes(5), 300, "{\"samples\":3}");
        var s2 = Repo.StartSession(a.Id, null, t0.AddDays(1));
        Repo.EndSession(s2, t0.AddDays(1).AddMinutes(1), 60, null);
        var s3 = Repo.StartSession(b.Id, null, t0.AddDays(2));
        Repo.EndSession(s3, t0.AddDays(2).AddMinutes(1), 60, null);

        var all = Repo.ListSessions(null, 10);
        Assert.Equal([s3, s2, s1], all.Select(s => s.Id).ToArray()); // newest first
        var first = all.Single(s => s.Id == s1);
        Assert.Equal(new SessionDto(s1, a.Id, a.Installations[0].Id, t0.ToString("O"), t0.AddMinutes(5).ToString("O"), 300, "tracked", "{\"samples\":3}"), first);

        Assert.Equal([s2, s1], Repo.ListSessions(a.Id, 10).Select(s => s.Id).ToArray());
        Assert.Equal([s3], Repo.ListSessions(null, 1).Select(s => s.Id).ToArray());
    }

    [Fact]
    public void Perf_samples_are_stored_ordered_and_replaced_by_offset()
    {
        var id = Repo.AddManualGame("G", @"C:\g\g.exe", null);
        var s = Repo.StartSession(id, null, DateTimeOffset.UtcNow);
        Repo.AddPerfSamples(s, [
            new PerfSampleDto(2000, 50, null, 1024, 8000, 60),
            new PerfSampleDto(0, 10, 20, null, null, null),
            new PerfSampleDto(1000, 30, 40, 512, 7000, null),
        ]);
        Repo.AddPerfSamples(s, [new PerfSampleDto(1000, 99, 98, 97, 96, 95)]);

        var samples = Repo.GetPerfSamples(s);
        Assert.Equal([0, 1000, 2000], samples.Select(x => x.T).ToArray());
        Assert.Equal(new PerfSampleDto(0, 10, 20, null, null, null), samples[0]);
        Assert.Equal(new PerfSampleDto(1000, 99, 98, 97, 96, 95), samples[1]);
        Assert.Equal(new PerfSampleDto(2000, 50, null, 1024, 8000, 60), samples[2]);
        Assert.Empty(Repo.GetPerfSamples("other"));
    }

    [Fact]
    public void RecoverOpenSessions_closes_sessions_left_open_by_a_crash()
    {
        var id = Repo.AddManualGame("G", @"C:\g\g.exe", null);
        var withSamples = Repo.StartSession(id, null, DateTimeOffset.UtcNow.AddHours(-2));
        Repo.AddPerfSamples(withSamples, [new PerfSampleDto(0, 1, 1, 1, 1, 1), new PerfSampleDto(90_500, 1, 1, 1, 1, 1)]);
        var noSamples = Repo.StartSession(id, null, DateTimeOffset.UtcNow.AddHours(-1));
        var closed = Repo.StartSession(id, null, DateTimeOffset.UtcNow.AddHours(-3));
        Repo.EndSession(closed, DateTimeOffset.UtcNow, 1234, null);

        Assert.Equal(2, Repo.RecoverOpenSessions());
        Assert.Equal(0, Repo.RecoverOpenSessions());

        var sessions = Repo.ListSessions(id, 10).ToDictionary(s => s.Id);
        Assert.Equal(3, sessions.Count);
        Assert.Equal(90, sessions[withSamples].DurationSeconds);
        Assert.Equal(0, sessions[noSamples].DurationSeconds);
        Assert.Equal(1234, sessions[closed].DurationSeconds);
        Assert.All(sessions.Values, s => Assert.NotNull(s.End));
        Assert.Equal(90, (DateTimeOffset.Parse(sessions[withSamples].End!) - DateTimeOffset.Parse(sessions[withSamples].Start)).TotalSeconds, 0.5);
    }

    [Fact]
    public void DeleteTrackedHistory_removes_sessions_and_samples_but_not_games()
    {
        var id = Repo.AddManualGame("G", @"C:\g\g.exe", null);
        for (var i = 0; i < 3; i++)
        {
            var s = Repo.StartSession(id, null, DateTimeOffset.UtcNow.AddHours(-i));
            Repo.AddPerfSamples(s, [new PerfSampleDto(0, 1, 1, 1, 1, 1)]);
            Repo.EndSession(s, DateTimeOffset.UtcNow, 10, null);
        }

        Assert.Equal(3, Repo.DeleteTrackedHistory());

        Assert.Equal(0, Count("sessions"));
        Assert.Equal(0, Count("perf_samples"));
        Assert.NotNull(Repo.GetGame(id));
        Assert.Equal(("journal.deleteAll", "3 sessions"), Repo.RecentAudit(1).Select(a => (a.Action, a.Detail)).Single());
        Assert.Equal(0, Repo.DeleteTrackedHistory());
    }

    // ---------- Settings, audit, media folders ----------

    [Fact]
    public void Settings_get_set_and_overwrite()
    {
        Assert.Empty(Repo.GetSettings());
        Repo.SetSetting("a", "true");
        Repo.SetSetting("b", "\"x\"");
        Repo.SetSetting("a", "false");
        var s = Repo.GetSettings();
        Assert.Equal(2, s.Count);
        Assert.Equal("false", s["a"]);
        Assert.Equal("\"x\"", s["b"]);
    }

    [Fact]
    public void ApplyScan_records_last_scan_time_as_json_string()
    {
        var before = DateTimeOffset.UtcNow.AddSeconds(-1);
        Repo.ApplyScan([Ok(PlatformId.Steam)]);
        var raw = Repo.GetSettings()["library.lastScan"];
        var parsed = DateTimeOffset.Parse(JsonSerializer.Deserialize<string>(raw)!);
        Assert.InRange(parsed, before, DateTimeOffset.UtcNow.AddSeconds(1));
    }

    [Fact]
    public void Audit_log_returns_newest_first()
    {
        Repo.Audit("one", null);
        Repo.Audit("two", "detail");
        var recent = Repo.RecentAudit(10);
        Assert.Equal(["two", "one"], recent.Select(r => r.Action).ToArray());
        Assert.Equal("detail", recent[0].Detail);
        Assert.Single(Repo.RecentAudit(1));
    }

    [Fact]
    public void Media_folders_add_dedupe_and_remove()
    {
        Repo.AddMediaFolder(@"D:\Captures");
        Repo.AddMediaFolder(@"D:\Captures");
        Repo.AddMediaFolder(@"E:\Clips");
        var folders = Repo.GetMediaFolders();
        Assert.Equal([@"D:\Captures", @"E:\Clips"], folders.Select(f => f.Path).ToArray());
        Assert.True(Repo.RemoveMediaFolder(folders[0].Id));
        Assert.False(Repo.RemoveMediaFolder(folders[0].Id));
        Assert.Equal([@"E:\Clips"], Repo.GetMediaFolders().Select(f => f.Path).ToArray());
    }

    [Fact]
    public void NewId_is_32_lowercase_hex_and_unique()
    {
        var ids = Enumerable.Range(0, 100).Select(_ => LibraryRepository.NewId()).ToList();
        Assert.All(ids, id => Assert.Matches("^[0-9a-f]{32}$", id));
        Assert.Equal(100, ids.Distinct().Count());
    }
}
