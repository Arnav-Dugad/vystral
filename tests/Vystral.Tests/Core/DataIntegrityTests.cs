using Dapper;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.Support;
using Xunit;

namespace Vystral.Tests.Core;

/// <summary>Regression tests for the v0.5 data-integrity audit (merge, unmerge, scans, recovery, provenance).</summary>
public sealed class DataIntegrityTests : IDisposable
{
    private readonly TestDb _t = new();

    public void Dispose() => _t.Dispose();

    private (string SteamGame, string GogGame) TwoStoreGames()
    {
        _t.Repo.ApplyScan([
            TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "570", "Dota Like", steamAppId: "570")),
            TestDb.Ok(PlatformId.Gog, TestDb.Install(PlatformId.Gog, "g570", "Dota Like Deluxe")),
        ]);
        var games = _t.Repo.LoadSnapshot((_, _) => null).Games;
        return (games.Single(g => g.Title == "Dota Like").Id, games.Single(g => g.Title == "Dota Like Deluxe").Id);
    }

    private string? SteamAppId(string gameId)
    {
        using var conn = _t.Db.Open();
        return conn.ExecuteScalar<string?>("SELECT steam_app_id FROM games WHERE id=@gameId", new { gameId });
    }

    [Fact]
    public void Merging_keeps_the_steam_app_id_moves_per_game_data_and_lets_user_art_win()
    {
        var (steam, gog) = TwoStoreGames();
        _t.Repo.SetArtwork(gog, ArtworkKind.Cover, "gog/cover-dl.jpg", "gog-local", isUser: false);
        _t.Repo.SetArtwork(steam, ArtworkKind.Cover, "steam/user.jpg", "user", isUser: true);
        using (var conn = _t.Db.Open())
        {
            conn.Execute("INSERT INTO game_field_sources(game_id, field, source, updated) VALUES (@steam, 'description', 'igdb', 'x')", new { steam });
        }

        Assert.True(_t.Repo.MergeGames(gog, steam));

        Assert.Equal("570", SteamAppId(gog));
        Assert.Equal(("steam/user.jpg", true), _t.Repo.GetArtwork(gog)["cover"]);
        using var c = _t.Db.Open();
        Assert.Equal(0, c.ExecuteScalar<int>("SELECT COUNT(*) FROM game_field_sources WHERE game_id=@steam", new { steam }));
        Assert.Equal(1, c.ExecuteScalar<int>("SELECT COUNT(*) FROM game_field_sources WHERE game_id=@gog", new { gog }));
    }

    [Fact]
    public void Unmerging_the_steam_version_clears_the_originals_app_id_and_stops_resuggesting_the_pair()
    {
        var (steam, gog) = TwoStoreGames();
        _t.Repo.MergeGames(gog, steam);
        var steamInstall = _t.Repo.LoadSnapshot((_, _) => null).Games.Single().Installations.Single(i => i.Platform == "steam").Id;

        var split = _t.Repo.UnmergeInstallation(steamInstall)!;

        Assert.Null(SteamAppId(gog));
        Assert.Equal("570", SteamAppId(split));
        Assert.Empty(_t.Repo.LoadSnapshot((_, _) => null).DuplicateSuggestions);
    }

    [Fact]
    public void A_local_scan_never_wipes_or_lowers_known_store_playtime()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "10", "Counter", steamAppId: "10", playtime: 900))]);
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "10", "Counter", steamAppId: "10", playtime: null))]);
        Assert.Equal(900, _t.Repo.LoadSnapshot((_, _) => null).Games.Single().Installations.Single().ImportedPlaytimeMinutes);

        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "10", "Counter", steamAppId: "10", playtime: 950))]);
        Assert.Equal(950, _t.Repo.LoadSnapshot((_, _) => null).Games.Single().Installations.Single().ImportedPlaytimeMinutes);
    }

    [Fact]
    public void Crash_recovery_uses_the_last_heartbeat_when_there_are_no_performance_samples()
    {
        var game = _t.Repo.AddManualGame("Heartbeat", @"C:\Games\h\h.exe", null);
        var start = DateTimeOffset.UtcNow.AddHours(-2);
        var id = _t.Repo.StartSession(game, null, start);
        _t.Repo.TouchOpenSession(id, 7200);

        Assert.Equal(1, _t.Repo.RecoverOpenSessions());

        using var conn = _t.Db.Open();
        Assert.Equal(7200, conn.ExecuteScalar<int>("SELECT duration_seconds FROM sessions WHERE id=@id", new { id }));
    }

    [Fact]
    public void Open_sessions_are_not_counted_until_they_end()
    {
        var game = _t.Repo.AddManualGame("Running", @"C:\Games\r\r.exe", null);
        var id = _t.Repo.StartSession(game, null, DateTimeOffset.UtcNow);
        Assert.Equal(0, _t.Repo.LoadSnapshot((_, _) => null).Games.Single().SessionCount);
        _t.Repo.EndSession(id, DateTimeOffset.UtcNow.AddMinutes(5), 300, null);
        Assert.Equal(1, _t.Repo.LoadSnapshot((_, _) => null).Games.Single().SessionCount);
    }

    [Fact]
    public void Steam_details_never_overwrite_a_field_another_source_filled()
    {
        var game = _t.Repo.AddManualGame("Provenance", @"C:\Games\p\p.exe", null);
        using (var conn = _t.Db.Open())
        {
            conn.Execute("UPDATE games SET description='From IGDB' WHERE id=@game", new { game });
            conn.Execute("INSERT INTO game_field_sources(game_id, field, source, updated) VALUES (@game, 'description', 'igdb', 'x')", new { game });
        }

        _t.Repo.SetMetadata(game, "Steam Store (app 1)", "From Steam", "Dev", null, null, ["Action"]);

        var g = _t.Repo.LoadSnapshot((_, _) => null).Games.Single();
        Assert.Equal("From IGDB", g.Description);
        Assert.Equal("Dev", g.Developer);
    }

    [Fact]
    public void An_unplugged_drive_keeps_owned_steam_games_missing()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "20", "Drive Game", installPath: @"Q:\SteamLibrary\common\Drive Game", steamAppId: "20"))]);
        _t.Repo.ApplyOwnedSteamGames([new OwnedSteamGame("20", "Drive Game", 10, null)]);
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam)]); // the drive is gone, so the scan doesn't see it

        Assert.Equal(0, _t.Repo.RestoreOwnedSteamMissing(_ => false));
        Assert.Equal("missing", _t.Repo.LoadSnapshot((_, _) => null).Games.Single().Installations.Single().State);

        Assert.Equal(1, _t.Repo.RestoreOwnedSteamMissing(_ => true));
        Assert.Equal("notinstalled", _t.Repo.LoadSnapshot((_, _) => null).Games.Single().Installations.Single().State);
    }

    [Fact]
    public void Removing_a_manual_game_leaves_no_orphans()
    {
        var game = _t.Repo.AddManualGame("Gone", @"C:\Games\g\g.exe", null);
        _t.Repo.SetStatus(game, "playing");
        using (var conn = _t.Db.Open())
            conn.Execute("INSERT INTO game_field_sources(game_id, field, source, updated) VALUES (@game, 'genres', 'rawg', 'x')", new { game });

        Assert.True(_t.Repo.RemoveManualGame(game));

        using var c = _t.Db.Open();
        Assert.Equal(0, c.ExecuteScalar<int>("SELECT (SELECT COUNT(*) FROM status_history) + (SELECT COUNT(*) FROM game_field_sources)"));
    }

    [Fact]
    public void Forgetting_downloaded_art_keeps_user_art_and_lets_covers_be_fetched_again()
    {
        var (steam, _) = TwoStoreGames();
        _t.Repo.SetArtwork(steam, ArtworkKind.Cover, "steam/cover.jpg", "steam-cdn", isUser: false);
        _t.Repo.SetArtwork(steam, ArtworkKind.Hero, "steam/hero.jpg", "user", isUser: true);
        Assert.Empty(_t.Repo.SteamGamesMissingCover(10));

        _t.Repo.ForgetAllDownloadedArtwork();

        Assert.Single(_t.Repo.SteamGamesMissingCover(10));
        Assert.True(_t.Repo.GetArtwork(steam)["hero"].IsUser);
    }
}
