using Dapper;
using Vystral.Core.Contracts;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.Support;
using Xunit;
using static Vystral.Tests.Support.TestDb;

namespace Vystral.Tests.SteamAccount;

public sealed class OwnedGamesReconciliationTests : IDisposable
{
    private readonly TestDb _t = new();
    private LibraryRepository Repo => _t.Repo;

    public void Dispose() => _t.Dispose();

    private LibrarySnapshotDto Snapshot() => Repo.LoadSnapshot((g, f) => $"art://{g}/{f}");

    private InstallationDto SteamInst(string appId) =>
        Snapshot().Games.SelectMany(g => g.Installations).Single(i => i.Platform == "steam" && i.PlatformGameId == appId);

    private static OwnedSteamGame Owned(string appId, string name, int? minutes = null, DateTimeOffset? last = null) => new(appId, name, minutes, last);

    [Fact]
    public void Owned_but_not_installed_games_become_notinstalled_installations()
    {
        var last = DateTimeOffset.FromUnixTimeSeconds(1_700_000_000);
        var report = Repo.ApplyOwnedSteamGames([Owned("620", "Portal 2", 1234, last)]);

        Assert.Equal(new OwnedSyncReport(1, 1, 0, 0), report);
        var game = Assert.Single(Snapshot().Games);
        Assert.Equal("Portal 2", game.Title);
        var inst = Assert.Single(game.Installations);
        Assert.Equal("notinstalled", inst.State);
        Assert.Null(inst.InstallPath);
        Assert.Equal(1234, inst.ImportedPlaytimeMinutes);
        Assert.Equal(last, DateTimeOffset.Parse(inst.ImportedLastPlayed!));
        Assert.Equal("620", Repo.GetGame(game.Id)!.SteamAppId);
    }

    [Fact]
    public void Local_scan_does_not_mark_notinstalled_rows_missing()
    {
        Repo.ApplyOwnedSteamGames([Owned("620", "Portal 2")]);
        var report = Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "400", "Portal", steamAppId: "400"))]);

        Assert.Equal(0, report.MarkedMissing);
        Assert.Equal("notinstalled", SteamInst("620").State);
    }

    [Fact]
    public void Local_scan_flips_notinstalled_to_installed_on_the_same_row()
    {
        Repo.ApplyOwnedSteamGames([Owned("620", "Portal 2", 50)]);
        var before = SteamInst("620");

        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "620", "Portal 2", @"D:\Steam\steamapps\common\Portal 2", steamAppId: "620", playtime: 60))]);

        var after = SteamInst("620");
        Assert.Equal(before.Id, after.Id);
        Assert.Equal("installed", after.State);
        Assert.Equal(@"D:\Steam\steamapps\common\Portal 2", after.InstallPath);
        Assert.Single(Snapshot().Games);
    }

    [Fact]
    public void Owned_sync_never_downgrades_an_installed_game()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "620", "Portal 2", @"C:\P2", steamAppId: "620", playtime: 10))]);
        var report = Repo.ApplyOwnedSteamGames([Owned("620", "Portal 2", 900)]);

        Assert.Equal(new OwnedSyncReport(1, 0, 1, 0), report);
        var inst = SteamInst("620");
        Assert.Equal("installed", inst.State);
        Assert.Equal(@"C:\P2", inst.InstallPath);
        Assert.Equal(900, inst.ImportedPlaytimeMinutes);
    }

    [Fact]
    public void Owned_sync_keeps_the_larger_playtime_and_later_last_played()
    {
        var older = DateTimeOffset.FromUnixTimeSeconds(1_600_000_000);
        var newer = DateTimeOffset.FromUnixTimeSeconds(1_700_000_000);
        Repo.ApplyOwnedSteamGames([Owned("620", "Portal 2", 500, newer)]);
        Repo.ApplyOwnedSteamGames([Owned("620", "Portal 2", 100, older)]);

        var inst = SteamInst("620");
        Assert.Equal(500, inst.ImportedPlaytimeMinutes);
        Assert.Equal(newer, DateTimeOffset.Parse(inst.ImportedLastPlayed!));
    }

    [Fact]
    public void Uninstalled_owned_games_return_to_notinstalled_instead_of_missing()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "620", "Portal 2", @"C:\P2", steamAppId: "620"))]);
        Repo.ApplyOwnedSteamGames([Owned("620", "Portal 2")]);

        // Uninstalled in Steam: the local scan no longer sees it.
        var scan = Repo.ApplyScan([Ok(PlatformId.Steam)]);
        Assert.Equal(1, scan.MarkedMissing);
        Assert.Equal("missing", SteamInst("620").State);

        Assert.Equal(1, Repo.RestoreOwnedSteamMissing());
        Assert.Equal("notinstalled", SteamInst("620").State);
    }

    [Fact]
    public void Missing_rows_found_in_the_owned_list_are_restored_during_sync()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "620", "Portal 2", @"C:\P2", steamAppId: "620"))]);
        Repo.ApplyScan([Ok(PlatformId.Steam)]);

        var report = Repo.ApplyOwnedSteamGames([Owned("620", "Portal 2")]);

        Assert.Equal(1, report.Restored);
        Assert.Equal("notinstalled", SteamInst("620").State);
    }

    [Fact]
    public void Missing_games_that_are_not_owned_stay_missing()
    {
        Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "620", "Portal 2", @"C:\P2", steamAppId: "620"))]);
        Repo.ApplyScan([Ok(PlatformId.Steam)]);
        Repo.ApplyOwnedSteamGames([Owned("400", "Portal")]);

        Assert.Equal(0, Repo.RestoreOwnedSteamMissing());
        Assert.Equal("missing", SteamInst("620").State);
    }

    [Fact]
    public void Owned_games_attach_to_an_existing_game_from_another_store()
    {
        Repo.ApplyScan([Ok(PlatformId.Epic, Install(PlatformId.Epic, "Fig", "Hollow Knight"))]);
        Repo.ApplyOwnedSteamGames([Owned("367520", "Hollow Knight")]);

        var game = Assert.Single(Snapshot().Games);
        Assert.Equal(["epic", "steam"], game.Installations.Select(i => i.Platform).Order());
    }

    [Fact]
    public void Owned_sync_never_deletes_installations_or_games()
    {
        Repo.ApplyOwnedSteamGames([Owned("620", "Portal 2"), Owned("400", "Portal")]);
        Repo.ApplyOwnedSteamGames([]);
        Repo.ClearSteamWebApiCache();

        Assert.Equal(2, Snapshot().Games.Count);
        Assert.All(Snapshot().Games.SelectMany(g => g.Installations), i => Assert.Equal("notinstalled", i.State));
    }

    [Fact]
    public void Owned_sync_ignores_invalid_and_duplicate_entries()
    {
        var report = Repo.ApplyOwnedSteamGames([Owned("abc", "Bad"), Owned("620", "Portal 2"), Owned("620", "Portal 2"), Owned("1", " ")]);
        Assert.Equal(1, report.Owned);
        Assert.Single(Snapshot().Games);
    }

    [Fact]
    public void Launching_a_notinstalled_game_is_impossible_because_no_row_is_installed()
    {
        Repo.ApplyOwnedSteamGames([Owned("620", "Portal 2")]);
        var game = Snapshot().Games.Single();
        Assert.DoesNotContain(Repo.GetInstallations(game.Id), i => i.State == InstallState.Installed);
        Assert.Equal(InstallState.NotInstalled, Repo.GetSteamInstallation(game.Id)!.State);
    }

    // ---------- Achievement cache ----------

    private static SteamAchievementRow Ach(string api, bool achieved, string? iconUrl = "https://cdn/x.jpg", string? iconFile = null, int order = 0) =>
        new(api, api.ToUpperInvariant(), "desc", false, iconUrl, null, iconFile, null, achieved, null, 12.5, order);

    [Fact]
    public void SaveAchievements_keeps_cached_icon_files_while_urls_are_unchanged()
    {
        Repo.SaveAchievements("620", "76561197960287930", "ok", null, [Ach("a", false)]);
        Repo.SetAchievementIconFile("620", "a", gray: false, "g/ach/abc.jpg");
        Repo.SaveAchievements("620", "76561197960287930", "ok", null, [Ach("a", true)]);
        Assert.Equal("g/ach/abc.jpg", Repo.GetAchievements("620").Single().IconFile);

        Repo.SaveAchievements("620", "76561197960287930", "ok", null, [Ach("a", true, iconUrl: "https://cdn/new.jpg")]);
        Assert.Null(Repo.GetAchievements("620").Single().IconFile);
    }

    [Fact]
    public void A_private_result_keeps_the_previous_cache()
    {
        Repo.SaveAchievements("620", "76561197960287930", "ok", null, [Ach("a", true), Ach("b", false, order: 1)]);
        Repo.SaveAchievements("620", "76561197960287930", "private", "private", null);

        Assert.Equal(2, Repo.GetAchievements("620").Count);
        Assert.Equal("private", Repo.GetAchievementFetch("620")!.Status);
    }

    [Fact]
    public void Stale_apps_are_selected_for_background_refresh_only_when_played()
    {
        Repo.ApplyOwnedSteamGames([Owned("620", "Portal 2", 100), Owned("400", "Portal", null)]);
        const string id = "76561197960287930";
        Assert.Equal(["620"], Repo.AppsNeedingAchievementRefresh(id, DateTimeOffset.UtcNow.AddHours(-6), 10));

        Repo.SaveAchievements("620", id, "ok", null, []);
        Assert.Empty(Repo.AppsNeedingAchievementRefresh(id, DateTimeOffset.UtcNow.AddHours(-6), 10));
        // A different account always needs its own fetch.
        Assert.Equal(["620"], Repo.AppsNeedingAchievementRefresh("76561197960287931", DateTimeOffset.UtcNow.AddHours(-6), 10));
    }

    [Fact]
    public void Internal_values_are_not_exposed_as_settings_rows_with_wrong_shape()
    {
        Repo.SetInternalValue("steam.webApi.steamId", "76561197960287930");
        Assert.Equal("76561197960287930", Repo.GetInternalValue("steam.webApi.steamId"));
        Repo.SetInternalValue("steam.webApi.steamId", null);
        Assert.Null(Repo.GetInternalValue("steam.webApi.steamId"));
        using var conn = _t.Db.Open();
        Assert.Equal(0, conn.ExecuteScalar<int>("SELECT COUNT(*) FROM settings WHERE key LIKE '%apikey%' OR value LIKE '%apikey%'"));
    }
}
