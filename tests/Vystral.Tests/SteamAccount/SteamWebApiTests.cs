using System.Net;
using System.Text;
using Vystral.Windows.Integrations;
using Vystral.Windows.Launch;
using Xunit;

namespace Vystral.Tests.SteamAccount;

/// <summary>Answers requests from a lookup; never touches the network.</summary>
public sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
{
    public List<Uri> Requests { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        lock (Requests) Requests.Add(request.RequestUri!);
        return Task.FromResult(respond(request));
    }

    public static HttpResponseMessage Json(HttpStatusCode status, string body) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
}

public sealed class SteamWebApiTests
{
    private const string Key = "0123456789ABCDEF0123456789ABCDEF";
    private const string SteamId = "76561197960287930";

    // ---------- Owned games ----------

    [Fact]
    public void ParseOwnedGames_maps_playtime_and_last_played()
    {
        var games = SteamWebApiClient.ParseOwnedGames("""
            {"response":{"game_count":3,"games":[
              {"appid":620,"name":"Portal 2","playtime_forever":1234,"rtime_last_played":1700000000},
              {"appid":400,"name":"Portal","playtime_forever":0,"rtime_last_played":0},
              {"appid":0,"name":"Bad"},
              {"appid":10,"name":""}
            ]}}
            """);
        Assert.Equal(2, games.Count);
        Assert.Equal(("620", "Portal 2", (int?)1234), (games[0].AppId, games[0].Name, games[0].PlaytimeMinutes));
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1700000000), games[0].LastPlayed);
        Assert.Null(games[1].PlaytimeMinutes);
        Assert.Null(games[1].LastPlayed);
    }

    [Fact]
    public void ParseOwnedGames_reports_a_private_profile_when_game_count_is_absent()
    {
        var ex = Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseOwnedGames("""{"response":{}}"""));
        Assert.Equal(SteamApiOutcome.PrivateProfile, ex.Outcome);
    }

    [Fact]
    public void ParseOwnedGames_reports_malformed_answers()
    {
        Assert.Equal(SteamApiOutcome.Malformed, Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseOwnedGames("<html>")).Outcome);
        Assert.Equal(SteamApiOutcome.Malformed, Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseOwnedGames("{}")).Outcome);
    }

    // ---------- Achievements ----------

    [Fact]
    public void ParsePlayerAchievements_reads_unlocks()
    {
        var list = SteamWebApiClient.ParsePlayerAchievements(HttpStatusCode.OK, """
            {"playerstats":{"steamID":"76561197960287930","gameName":"X","success":true,"achievements":[
              {"apiname":"ACH_WIN","achieved":1,"unlocktime":1700000000},
              {"apiname":"ACH_LOSE","achieved":0,"unlocktime":0}
            ]}}
            """);
        Assert.Equal(2, list.Count);
        Assert.True(list[0].Achieved);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1700000000), list[0].UnlockTime);
        Assert.False(list[1].Achieved);
        Assert.Null(list[1].UnlockTime);
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden, """{"playerstats":{"error":"Profile is not public","success":false}}""", SteamApiOutcome.PrivateProfile)]
    [InlineData(HttpStatusCode.BadRequest, """{"playerstats":{"error":"Requested app has no stats","success":false}}""", SteamApiOutcome.NoStats)]
    [InlineData(HttpStatusCode.Forbidden, "<html><body>Forbidden</body></html>", SteamApiOutcome.InvalidKey)]
    [InlineData(HttpStatusCode.Unauthorized, "", SteamApiOutcome.InvalidKey)]
    [InlineData(HttpStatusCode.BadGateway, "", SteamApiOutcome.Unavailable)]
    public void ParsePlayerAchievements_classifies_failures(HttpStatusCode status, string body, SteamApiOutcome outcome) =>
        Assert.Equal(outcome, Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParsePlayerAchievements(status, body)).Outcome);

    [Fact]
    public void ParseSchema_reads_hidden_flags_and_missing_descriptions()
    {
        var schema = SteamWebApiClient.ParseSchema("""
            {"game":{"gameName":"X","availableGameStats":{"achievements":[
              {"name":"ACH_WIN","defaultvalue":0,"displayName":"Winner","hidden":0,"description":"Win a game","icon":"https://steamcdn-a.akamaihd.net/a.jpg","icongray":"https://steamcdn-a.akamaihd.net/b.jpg"},
              {"name":"ACH_SECRET","defaultvalue":0,"displayName":"The Twist","hidden":1,"icon":"https://cdn.akamai.steamstatic.com/c.jpg","icongray":"https://cdn.akamai.steamstatic.com/d.jpg"},
              {"name":"","displayName":"Nameless"}
            ]}}}
            """);
        Assert.Equal(2, schema.Count);
        Assert.False(schema[0].Hidden);
        Assert.Equal("Win a game", schema[0].Description);
        Assert.True(schema[1].Hidden);
        Assert.Null(schema[1].Description);
    }

    [Fact]
    public void ParseSchema_returns_empty_for_games_without_achievements() =>
        Assert.Empty(SteamWebApiClient.ParseSchema("""{"game":{"gameName":"X","gameVersion":"1"}}"""));

    [Fact]
    public void ParseGlobalPercentages_accepts_numbers_and_numeric_strings()
    {
        var p = SteamWebApiClient.ParseGlobalPercentages("""
            {"achievementpercentages":{"achievements":[
              {"name":"A","percent":42.1234},
              {"name":"B","percent":"1.5"},
              {"name":"C","percent":"oops"},
              {"name":"D","percent":150}
            ]}}
            """);
        Assert.Equal(42.12, p["A"]);
        Assert.Equal(1.5, p["B"]);
        Assert.False(p.ContainsKey("C"));
        Assert.False(p.ContainsKey("D"));
        Assert.Empty(SteamWebApiClient.ParseGlobalPercentages("not json"));
    }

    [Fact]
    public void Merge_combines_schema_progress_and_rarity_in_schema_order()
    {
        var rows = SteamWebApiClient.Merge(
            [new SchemaAchievement("B", "Bee", "b", false, "https://steamcdn-a.akamaihd.net/b.jpg", "http://evil.example/b.jpg"),
             new SchemaAchievement("A", "Ay", null, true, null, null)],
            [new PlayerAchievement("A", true, DateTimeOffset.FromUnixTimeSeconds(5)), new PlayerAchievement("Z", false, null)],
            new Dictionary<string, double> { ["B"] = 3.2 });

        Assert.Equal(["B", "A", "Z"], rows.Select(r => r.ApiName));
        Assert.False(rows[0].Achieved);
        Assert.Equal(3.2, rows[0].GlobalPercent);
        Assert.Equal("https://steamcdn-a.akamaihd.net/b.jpg", rows[0].IconUrl);
        Assert.Null(rows[0].IconGrayUrl); // not HTTPS on a Steam CDN
        Assert.True(rows[1].Achieved);
        Assert.True(rows[1].Hidden);
        Assert.Equal([0, 1, 2], rows.Select(r => r.SortOrder));
    }

    [Theory]
    [InlineData("https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/620/a.jpg", true)]
    [InlineData("https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/620/a.jpg", true)]
    [InlineData("http://steamcdn-a.akamaihd.net/a.jpg", false)]
    [InlineData("https://steamstatic.com.evil.example/a.jpg", false)]
    [InlineData("https://evil.example/a.jpg", false)]
    [InlineData("https://cdn.akamai.steamstatic.com:8443/a.jpg", false)]
    [InlineData("file:///C:/a.jpg", false)]
    public void SafeIconUrl_only_allows_https_steam_cdns(string url, bool ok) =>
        Assert.Equal(ok, SteamWebApiClient.SafeIconUrl(url) is not null);

    // ---------- Transport ----------

    private static SteamWebApiClient Client(FakeHandler handler, string? key = Key) =>
        new(new HttpClient(handler), () => key) { Delay = (_, _) => Task.CompletedTask };

    [Fact]
    public async Task GetOwnedGames_maps_401_to_invalid_key_and_uses_https_api_host()
    {
        var handler = new FakeHandler(_ => FakeHandler.Json(HttpStatusCode.Unauthorized, "<html>"));
        var ex = await Assert.ThrowsAsync<SteamApiException>(() => Client(handler).GetOwnedGamesAsync(SteamId, CancellationToken.None));
        Assert.Equal(SteamApiOutcome.InvalidKey, ex.Outcome);
        var uri = Assert.Single(handler.Requests);
        Assert.Equal(("https", "api.steampowered.com"), (uri.Scheme, uri.Host));
        Assert.DoesNotContain(Key, ex.Message);
    }

    [Fact]
    public async Task A_429_blocks_further_requests_until_retry_after()
    {
        var handler = new FakeHandler(_ =>
        {
            var r = FakeHandler.Json(HttpStatusCode.TooManyRequests, "");
            r.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromMinutes(5));
            return r;
        });
        var client = Client(handler);
        Assert.Equal(SteamApiOutcome.RateLimited, (await Assert.ThrowsAsync<SteamApiException>(() => client.GetOwnedGamesAsync(SteamId, CancellationToken.None))).Outcome);
        Assert.Equal(SteamApiOutcome.RateLimited, (await Assert.ThrowsAsync<SteamApiException>(() => client.GetGlobalPercentagesAsync("620", CancellationToken.None))).Outcome);
        Assert.Single(handler.Requests); // the second call never left the PC
    }

    [Fact]
    public async Task Requests_are_spaced_at_least_one_second_apart()
    {
        var waits = new List<TimeSpan>();
        var handler = new FakeHandler(_ => FakeHandler.Json(HttpStatusCode.OK, """{"achievementpercentages":{"achievements":[]}}"""));
        var client = new SteamWebApiClient(new HttpClient(handler), () => Key) { Delay = (d, _) => { waits.Add(d); return Task.CompletedTask; } };
        await client.GetGlobalPercentagesAsync("620", CancellationToken.None);
        await client.GetGlobalPercentagesAsync("620", CancellationToken.None);
        Assert.Single(waits);
        Assert.True(waits[0] > TimeSpan.FromMilliseconds(900));
    }

    [Fact]
    public async Task Calls_without_a_key_fail_before_any_request()
    {
        var handler = new FakeHandler(_ => throw new InvalidOperationException("no network in tests"));
        var ex = await Assert.ThrowsAsync<SteamApiException>(() => Client(handler, key: null).GetPlayerAchievementsAsync(SteamId, "620", CancellationToken.None));
        Assert.Equal(SteamApiOutcome.InvalidKey, ex.Outcome);
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData("620; DROP")]
    [InlineData("../620")]
    [InlineData("")]
    public async Task Invalid_appids_are_rejected(string appId)
    {
        var handler = new FakeHandler(_ => FakeHandler.Json(HttpStatusCode.OK, "{}"));
        await Assert.ThrowsAsync<ArgumentException>(() => Client(handler).GetSchemaAsync(appId, CancellationToken.None));
        Assert.Empty(handler.Requests);
    }

    // ---------- Store actions ----------

    [Theory]
    [InlineData(StoreAction.Install, "620", "steam://install/620")]
    [InlineData(StoreAction.Uninstall, "1145360", "steam://uninstall/1145360")]
    public void StoreActions_builds_only_steam_install_and_uninstall_links(StoreAction action, string appId, string expected) =>
        Assert.Equal(expected, StoreActions.Steam(action, appId)!.OriginalString);

    [Theory]
    [InlineData("620/../../run")]
    [InlineData("620 -silent")]
    [InlineData("620?x=1")]
    [InlineData("abc")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("12345678901")]
    [InlineData("６２０")] // full-width digits
    public void StoreActions_refuses_anything_but_plain_appids(string? appId)
    {
        Assert.Null(StoreActions.Steam(StoreAction.Install, appId));
        Assert.Null(StoreActions.Steam(StoreAction.Uninstall, appId));
    }

    [Theory]
    [InlineData("steam://rungameid/620")]
    [InlineData("steam://install/620/extra")]
    [InlineData("steam://nav/games")]
    [InlineData("https://store.steampowered.com/install/620")]
    public void ValidateStoreAction_rejects_other_links(string uri) =>
        Assert.False(LaunchValidator.ValidateStoreAction(Vystral.Core.Domain.PlatformId.Steam, new Uri(uri)).Ok);

    [Fact]
    public void ValidateStoreAction_uses_the_per_platform_scheme_allow_list() =>
        Assert.False(LaunchValidator.ValidateStoreAction(Vystral.Core.Domain.PlatformId.Epic, new Uri("steam://install/620")).Ok);
}
