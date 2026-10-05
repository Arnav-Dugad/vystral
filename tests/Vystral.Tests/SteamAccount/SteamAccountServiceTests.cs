using System.Net;
using System.Text.Json.Nodes;
using Vystral.Core.Data;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.SteamAccount;

public sealed class SteamAccountServiceTests : IDisposable
{
    private const string Key = "0123456789ABCDEF0123456789ABCDEF";
    private const string SteamId = "76561197960287930";
    private readonly TestDb _t = new();
    private readonly TempDir _steam = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly FakeHandler _handler;
    private readonly SettingsService _settings;
    private readonly SteamAccountService _svc;

    private static readonly string LoginUsers = $$"""
        "users"
        {
            "{{SteamId}}"
            {
                "AccountName"		"secret_login_name"
                "PersonaName"		"Nova"
                "MostRecent"		"1"
            }
            "76561197960287931"
            {
                "AccountName"		"other_login"
                "PersonaName"		"Second"
                "MostRecent"		"0"
            }
            "123"
            {
                "PersonaName"		"Invalid id"
            }
        }
        """;

    public SteamAccountServiceTests()
    {
        _steam.Write("config/loginusers.vdf", LoginUsers);
        _handler = new FakeHandler(Respond);
        var http = new HttpClient(_handler);
        var keys = new SteamApiKeyStore(_secrets);
        var api = new SteamWebApiClient(http, keys.Get) { Delay = (_, _) => Task.CompletedTask };
        _settings = new SettingsService(_t.Repo);
        var artwork = new ArtworkService(new AppPaths(_t.Dir.Dir("data")), _t.Repo, http);
        _svc = new SteamAccountService(keys, api, _t.Repo, _settings, artwork, () => _steam.Path, NullEventSink.Instance);
        _settings.Set("steam.webApi.backgroundAchievements", JsonValue.Create(false));
    }

    public void Dispose()
    {
        _t.Dispose();
        _steam.Dispose();
    }

    private static HttpResponseMessage Respond(HttpRequestMessage req)
    {
        var path = req.RequestUri!.AbsolutePath;
        var query = req.RequestUri.Query;
        if (path.Contains("GetOwnedGames"))
            return query.Contains("BADBADBADBADBADBADBADBADBADBADBA")
                ? FakeHandler.Json(HttpStatusCode.Forbidden, "<html>")
                : FakeHandler.Json(HttpStatusCode.OK, """{"response":{"game_count":1,"games":[{"appid":620,"name":"Portal 2","playtime_forever":90,"rtime_last_played":1700000000}]}}""");
        if (path.Contains("GetSchemaForGame"))
            return FakeHandler.Json(HttpStatusCode.OK, """
                {"game":{"availableGameStats":{"achievements":[
                  {"name":"OPEN","displayName":"Open","hidden":0,"description":"Visible text","icon":"https://cdn.akamai.steamstatic.com/a.jpg","icongray":"https://cdn.akamai.steamstatic.com/ag.jpg"},
                  {"name":"SECRET_LOCKED","displayName":"Locked secret","hidden":1,"description":"Spoiler A","icon":"https://cdn.akamai.steamstatic.com/b.jpg","icongray":"https://cdn.akamai.steamstatic.com/bg.jpg"},
                  {"name":"SECRET_DONE","displayName":"Found secret","hidden":1,"description":"Spoiler B","icon":"https://cdn.akamai.steamstatic.com/c.jpg","icongray":"https://cdn.akamai.steamstatic.com/cg.jpg"}
                ]}}}
                """);
        if (path.Contains("GetPlayerAchievements"))
            return FakeHandler.Json(HttpStatusCode.OK, """
                {"playerstats":{"success":true,"achievements":[
                  {"apiname":"OPEN","achieved":1,"unlocktime":1700000000},
                  {"apiname":"SECRET_LOCKED","achieved":0,"unlocktime":0},
                  {"apiname":"SECRET_DONE","achieved":1,"unlocktime":1700000100}
                ]}}
                """);
        if (path.Contains("GetGlobalAchievementPercentagesForApp"))
            return FakeHandler.Json(HttpStatusCode.OK, """{"achievementpercentages":{"achievements":[{"name":"OPEN","percent":"55.5"},{"name":"SECRET_DONE","percent":1.2}]}}""");
        // Icon CDN: pretend it's unavailable (no image bytes in tests).
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }

    [Fact]
    public void ParseLoginUsers_reads_ids_and_display_names_but_never_login_names()
    {
        var accounts = SteamAccountService.ParseLoginUsers(LoginUsers);
        Assert.Equal(2, accounts.Count);
        Assert.Equal(new SteamAccountDto(SteamId, "Nova", true), accounts[0]);
        Assert.DoesNotContain(accounts, a => a.PersonaName.Contains("login"));
    }

    [Fact]
    public async Task Connect_with_a_rejected_key_stores_nothing()
    {
        var result = await _svc.ConnectAsync("BADBADBADBADBADBADBADBADBADBADBA", null, CancellationToken.None);
        Assert.Equal("invalidKey", result.Outcome);
        Assert.Empty(_secrets.Items);
        Assert.False(_svc.Status().Configured);
    }

    [Fact]
    public async Task Connect_rejects_malformed_keys_before_any_request()
    {
        await Assert.ThrowsAsync<BridgeException>(() => _svc.ConnectAsync("hello", null, CancellationToken.None));
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public async Task Connect_stores_the_key_imports_owned_games_and_never_exposes_the_key()
    {
        var result = await _svc.ConnectAsync(Key.ToLowerInvariant(), SteamId, CancellationToken.None);

        Assert.Equal("ok", result.Outcome);
        Assert.Equal(Key, _secrets.Items[SteamApiKeyStore.Target]);
        var status = _svc.Status();
        Assert.True(status.Configured);
        Assert.Equal("••••CDEF", status.KeyMasked);
        Assert.Equal(SteamId, status.SteamId);
        Assert.Equal(1, status.OwnedCount);
        Assert.DoesNotContain(Key, System.Text.Json.JsonSerializer.Serialize(status), StringComparison.OrdinalIgnoreCase);
        foreach (var (_, value) in _t.Repo.GetSettings()) Assert.DoesNotContain(Key, value, StringComparison.OrdinalIgnoreCase);

        var game = _t.Repo.LoadSnapshot((g, f) => f).Games.Single();
        Assert.Equal("notinstalled", game.Installations.Single().State);
    }

    [Fact]
    public async Task Hidden_achievements_keep_their_description_until_unlocked()
    {
        await _svc.ConnectAsync(Key, SteamId, CancellationToken.None);
        var gameId = _t.Repo.LoadSnapshot((g, f) => f).Games.Single().Id;

        var dto = await _svc.GetAchievementsAsync(gameId, CancellationToken.None);

        Assert.Equal("ok", dto.Status);
        Assert.Equal((2, 3), (dto.Unlocked, dto.Total));
        var locked = dto.Achievements.Single(a => a.ApiName == "SECRET_LOCKED");
        Assert.True(locked.Hidden);
        Assert.Null(locked.Description);
        Assert.Equal("Spoiler B", dto.Achievements.Single(a => a.ApiName == "SECRET_DONE").Description);
        Assert.Equal(55.5, dto.Achievements.Single(a => a.ApiName == "OPEN").GlobalPercent);
        Assert.All(dto.Achievements, a => Assert.Null(a.Icon)); // CDN unavailable → no icon, never a remote URL
    }

    [Fact]
    public async Task Achievements_are_fetched_at_most_once_per_six_hours()
    {
        await _svc.ConnectAsync(Key, SteamId, CancellationToken.None);
        var gameId = _t.Repo.LoadSnapshot((g, f) => f).Games.Single().Id;
        await _svc.GetAchievementsAsync(gameId, CancellationToken.None);
        var apiCalls = _handler.Requests.Count(u => u.Host == SteamWebApiClient.Host);

        await _svc.GetAchievementsAsync(gameId, CancellationToken.None);

        Assert.Equal(apiCalls, _handler.Requests.Count(u => u.Host == SteamWebApiClient.Host));
    }

    [Fact]
    public async Task Local_only_mode_blocks_all_steam_requests()
    {
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        await Assert.ThrowsAsync<BridgeException>(() => _svc.ConnectAsync(Key, SteamId, CancellationToken.None));
        _secrets.Items[SteamApiKeyStore.Target] = Key;
        await Assert.ThrowsAsync<BridgeException>(() => _svc.SyncAsync(CancellationToken.None));
        _t.Repo.ApplyOwnedSteamGames([new OwnedSteamGame("620", "Portal 2", 1, null)]);
        var gameId = _t.Repo.LoadSnapshot((g, f) => f).Games.Single().Id;
        Assert.Equal("localOnly", (await _svc.GetAchievementsAsync(gameId, CancellationToken.None)).Status);
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public async Task Non_steam_games_report_notSteam_and_disconnected_reports_notConnected()
    {
        var gameId = _t.Repo.AddManualGame("Thing", @"C:\Games\Thing\thing.exe", null);
        Assert.Equal("notSteam", (await _svc.GetAchievementsAsync(gameId, CancellationToken.None)).Status);

        _t.Repo.ApplyOwnedSteamGames([new OwnedSteamGame("620", "Portal 2", 1, null)]);
        var steamGame = _t.Repo.LoadSnapshot((g, f) => f).Games.Single(g => g.Title == "Portal 2").Id;
        Assert.Equal("notConnected", (await _svc.GetAchievementsAsync(steamGame, CancellationToken.None)).Status);
    }

    [Fact]
    public async Task Disconnect_removes_the_key_and_cache_but_keeps_games()
    {
        await _svc.ConnectAsync(Key, SteamId, CancellationToken.None);
        _svc.Disconnect();
        Assert.Empty(_secrets.Items);
        Assert.Equal(0, _svc.Status().OwnedCount);
        Assert.Single(_t.Repo.LoadSnapshot((g, f) => f).Games);
    }

    [Fact]
    public void SelectAccount_only_accepts_accounts_seen_on_this_pc()
    {
        Assert.Throws<BridgeException>(() => _svc.SelectAccount("76561197960299999"));
        _svc.SelectAccount("76561197960287931");
        Assert.Equal("76561197960287931", _svc.Status().SteamId);
    }
}
