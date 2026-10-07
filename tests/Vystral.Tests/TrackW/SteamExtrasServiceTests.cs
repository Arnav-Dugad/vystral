using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.TrackW;

public sealed class SteamExtrasServiceTests : IDisposable
{
    private const string Key = "0123456789ABCDEF0123456789ABCDEF";
    private const string SteamId = "76561197960287930";
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48];
    private static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, (byte)'J', (byte)'F', (byte)'I', (byte)'F', 0, 1, 1, 0, 0, 1];

    private readonly TestDb _t = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly SettingsService _settings;
    private readonly ArtworkService _artwork;
    private readonly FakeHandler _handler;
    private readonly SteamWebApiClient _api;
    private readonly SteamApiKeyStore _keys;
    private readonly Events _events = new();
    private readonly string _data;
    private DateTimeOffset _now = new(2026, 3, 10, 12, 0, 0, TimeSpan.Zero);
    private bool _dataSaver;
    private bool _gameRunning;
    private bool _recentRateLimited;

    private sealed class Events : IEventSink
    {
        public List<string> Names { get; } = [];
        public void Emit(string eventName, object? payload) { lock (Names) Names.Add(eventName); }
    }

    public SteamExtrasServiceTests()
    {
        _handler = new FakeHandler(Respond);
        var http = new HttpClient(_handler);
        _keys = new SteamApiKeyStore(_secrets);
        _api = new SteamWebApiClient(http, _keys.Get) { Delay = (_, _) => Task.CompletedTask };
        _settings = new SettingsService(_t.Repo);
        _data = _t.Dir.Dir("data");
        _artwork = new ArtworkService(new AppPaths(_data), _t.Repo, http) { SkipDownloads = () => _dataSaver };
    }

    public void Dispose() => _t.Dispose();

    private HttpResponseMessage Respond(HttpRequestMessage req)
    {
        var uri = req.RequestUri!;
        var path = uri.AbsolutePath;
        if (uri.Host == "avatars.steamstatic.com")
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Jpeg) { Headers = { ContentType = new("image/jpeg") } } };
        if (uri.Host == "clan.akamai.steamstatic.com")
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Png) { Headers = { ContentType = new("image/png") } } };
        if (path.Contains("GetFriendList"))
            return FakeHandler.Json(HttpStatusCode.OK, File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "TrackP", "friendlist.json")));
        if (path.Contains("GetPlayerSummaries"))
            return FakeHandler.Json(HttpStatusCode.OK, File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "TrackP", "summaries.json")));
        if (path.Contains("GetRecentlyPlayedGames"))
        {
            if (_recentRateLimited) return new HttpResponseMessage(HttpStatusCode.TooManyRequests);
            // One friend is private; the others played Portal 2 for different lengths.
            var id = System.Web.HttpUtility.ParseQueryString(uri.Query)["steamid"]!;
            return FakeHandler.Json(HttpStatusCode.OK, id.EndsWith('1') ? """{"response":{}}"""
                : """{"response":{"total_count":1,"games":[{"appid":620,"playtime_2weeks":""" + (id[^1] - '0') * 10 + ""","playtime_forever":999}]}}""");
        }
        if (path.Contains("GetNewsForApp"))
            return FakeHandler.Json(HttpStatusCode.OK, SteamExtrasParsingTests.Fixture("news.json"));
        return FakeHandler.Json(HttpStatusCode.NotFound, "");
    }

    // ---------- Friends' recent games ----------

    private FriendsHistoryService Friends() => new(_keys, _api, _settings, _artwork, () => SteamId, _events, Path.Combine(_data, "cache", "friends-recent.json"))
    {
        IsGameActive = () => _gameRunning,
        Now = () => _now,
        Delay = (_, _) => Task.CompletedTask,
    };

    [Fact]
    public void Friends_history_is_off_by_default_and_never_asks_then()
    {
        var svc = Friends();
        Assert.Equal("off", svc.ForApp("620", TestContext.Current.CancellationToken).Status);
        _settings.Set(FriendsHistoryService.SettingKey, JsonValue.Create(true));
        Assert.Equal("notConnected", svc.ForApp("620", TestContext.Current.CancellationToken).Status);
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public async Task Friends_history_reads_public_friends_spaced_and_caches_the_round()
    {
        _secrets.Write(SteamApiKeyStore.Target, Key);
        _settings.Set(FriendsHistoryService.SettingKey, JsonValue.Create(true));
        var svc = Friends();
        var pauses = 0;
        svc.Delay = (d, _) => { if (d == FriendsHistoryService.FriendSpacing) pauses++; return Task.CompletedTask; };
        await svc.RoundAsync(SteamId, TestContext.Current.CancellationToken);

        var r = svc.ForApp("620", TestContext.Current.CancellationToken);
        Assert.Equal("ok", r.Status);
        Assert.NotEmpty(r.Friends);
        Assert.Equal(r.Friends.OrderByDescending(f => f.MinutesTwoWeeks).Select(f => f.Key), r.Friends.Select(f => f.Key)); // most played first
        Assert.Equal(r.Friends.Sum(f => f.MinutesTwoWeeks), r.TotalMinutes);
        Assert.DoesNotContain(r.Friends, f => f.Key.Contains("7656119"));
        Assert.Equal(r.Checked, pauses);                                      // a pause after every friend
        Assert.Empty(svc.ForApp("1145360", TestContext.Current.CancellationToken).Friends);
        var file = File.ReadAllText(Path.Combine(_data, "cache", "friends-recent.json"));
        Assert.DoesNotContain("7656119", file);                               // no SteamIDs on disk

        // Within four hours a game page doesn't start another round.
        var before = _handler.Requests.Count;
        _now += TimeSpan.FromHours(1);
        Assert.False(svc.ForApp("620", TestContext.Current.CancellationToken).Refreshing);
        Assert.Equal(before, _handler.Requests.Count);

        svc.Forget();
        Assert.False(File.Exists(Path.Combine(_data, "cache", "friends-recent.json")));
    }

    [Fact]
    public async Task Friends_history_keeps_partial_results_when_Steam_asks_to_slow_down()
    {
        _secrets.Write(SteamApiKeyStore.Target, Key);
        _settings.Set(FriendsHistoryService.SettingKey, JsonValue.Create(true));
        var svc = Friends();
        _recentRateLimited = true;
        await svc.RoundAsync(SteamId, TestContext.Current.CancellationToken);
        Assert.Equal("rateLimited", svc.ForApp("620", TestContext.Current.CancellationToken).Status);
    }

    [Fact]
    public void Offline_mode_never_starts_a_friends_round()
    {
        _secrets.Write(SteamApiKeyStore.Target, Key);
        _settings.Set(FriendsHistoryService.SettingKey, JsonValue.Create(true));
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        Assert.Equal("offline", Friends().ForApp("620", TestContext.Current.CancellationToken).Status);
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public void Friends_cache_is_validated_on_read()
    {
        var c = FriendsHistoryService.Validate(new FriendsHistoryCache
        {
            Account = "0123456789abcdef",
            Checked = 99999,
            Friends =
            [
                new() { Key = "0123456789abcdef", Name = "A‮", AvatarFile = "../../x.jpg", Games = new() { ["620"] = 30, ["x"] = 5, ["730"] = 999999 } },
                new() { Key = "76561197960287930", Name = "SteamID as key" },
            ],
        })!;
        var f = Assert.Single(c.Friends);
        Assert.Equal("A", f.Name);
        Assert.Null(f.AvatarFile);
        Assert.Equal(["620"], f.Games.Keys);
        Assert.Equal(FriendsHistoryService.MaxFriendsPerRound, c.Checked);
        Assert.True(FriendsHistoryService.IsAvatarFile("_avatars\\0123456789ab.jpg"));
        Assert.False(FriendsHistoryService.IsAvatarFile("_avatars/../0123456789ab.jpg"));
    }

    // ---------- Achievement guide ----------

    private string SteamGame(string appId, string title)
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, appId, title, steamAppId: appId))]);
        return _t.Repo.SteamAppToGame()[appId];
    }

    private static AchievementDto A(string api, bool achieved, double? pct, bool hidden = false) =>
        new(api, $"Name {api}", hidden && !achieved ? null : $"Desc {api}", hidden, achieved, null, pct, null);

    [Fact]
    public void Next_up_is_locked_achievements_easiest_first()
    {
        var all = new[] { A("a", true, 90), A("b", false, 12), A("c", false, null), A("d", false, 64.5, hidden: true), A("e", false, 64.5), A("f", false, 0.4) };
        Assert.Equal(["d", "e", "b", "f", "c"], AchievementGuideService.NextUp(all).Select(a => a.ApiName));
        Assert.Equal(2, AchievementGuideService.NextUp(all, 2).Count);
    }

    [Fact]
    public void Goals_are_pinned_validated_revealed_and_read_from_the_cache()
    {
        var gameId = SteamGame("620", "Portal 2");
        _t.Repo.SaveAchievements("620", SteamId, "ok", null,
        [
            new SteamAchievementRow("SECRET", "Secret one", "Find the cake", true, null, null, null, null, false, null, 33.3, 0),
            new SteamAchievementRow("EASY", "Easy one", "Walk", false, null, null, null, null, true, DateTimeOffset.FromUnixTimeSeconds(1700000000), 90, 1),
        ]);
        var file = Path.Combine(_data, "ui-state", "achievement-goals.json");
        var guide = new AchievementGuideService(_t.Repo, _artwork, file);

        Assert.Null(guide.Goal(gameId));
        Assert.False(guide.SetGoal(gameId, "NOT_THERE", _now));
        Assert.False(guide.SetGoal(new string('9', 32), "SECRET", _now)); // unknown game
        Assert.True(guide.SetGoal(gameId, "SECRET", _now));
        var goal = guide.Goal(gameId)!;
        Assert.Equal("Secret one", goal.Name);
        Assert.Null(goal.Description);                 // still hidden on the Play button
        Assert.Equal("Find the cake", guide.Reveal(gameId, "SECRET"));

        var built = guide.Build(gameId, new AchievementsDto("ok", null, null,
            [A("SECRET", false, 33.3, hidden: true), A("EASY", true, 90)], 1, 2));
        Assert.Equal("SECRET", built.Goal!.ApiName);
        Assert.Equal(1, built.HiddenLocked);
        Assert.Equal(["SECRET"], built.Next.Select(n => n.ApiName));
        Assert.Null(built.Next[0].Description);

        // A tampered goals file is ignored entry by entry.
        File.WriteAllText(file, """{"version":1,"goals":{"../../x":{"apiName":"SECRET"},"%%GAME%%":{"apiName":"bad\nname"}}}""".Replace("%%GAME%%", gameId));
        Assert.Null(guide.GoalFor(gameId));
        Assert.True(guide.SetGoal(gameId, null, _now));
    }

    // ---------- News ----------

    private SteamNewsService News() => new(_api, _settings, _artwork, Path.Combine(_data, "cache", "news")) { IsGameActive = () => _gameRunning, Now = () => _now };

    [Fact]
    public async Task News_is_fetched_sanitized_cached_and_linked_natively()
    {
        var svc = News();
        var n = await svc.GetAsync("620", false, TestContext.Current.CancellationToken);
        Assert.Equal("ok", n.Status);
        Assert.Equal(2, n.Posts.Count);
        var patch = n.Posts[0];
        Assert.True(patch.Patch);
        Assert.Equal(["h", "p", "li", "li", "img"], patch.Blocks.Select(b => b.Kind));
        Assert.Null(patch.Blocks[4].Image);           // images wait until the post is opened
        Assert.Equal(1, patch.Images);
        var summer = n.Posts[1];
        Assert.False(summer.Patch);
        Assert.DoesNotContain(summer.Blocks, b => b.Kind == "img"); // evil.example image dropped
        Assert.DoesNotContain("alert", string.Concat(summer.Blocks.SelectMany(b => b.Spans).Select(s => s.Text)));
        Assert.DoesNotContain(_handler.Requests, u => u.Query.Contains("key="));   // public API, no key

        // Cached for six hours.
        await svc.GetAsync("620", false, TestContext.Current.CancellationToken);
        Assert.Single(_handler.Requests, u => u.AbsolutePath.Contains("GetNewsForApp"));

        var withImages = await svc.LoadImagesAsync("620", patch.Gid, false, TestContext.Current.CancellationToken);
        Assert.StartsWith("https://art.vystral.example/_thumbs/news/", withImages.Posts[0].Blocks[4].Image);
        Assert.Contains(_handler.Requests, u => u.Host == "clan.akamai.steamstatic.com");

        Assert.Equal($"https://store.steampowered.com/news/app/620/view/{patch.Gid}", svc.PostUrl("620", patch.Gid)!.AbsoluteUri);
        Assert.Null(svc.PostUrl("620", "123"));
        Assert.Null(svc.PostUrl("440", patch.Gid));
    }

    [Fact]
    public async Task News_respects_offline_mode_data_saver_games_and_the_switch()
    {
        var svc = News();
        _settings.Set(SteamNewsService.SettingKey, JsonValue.Create(false));
        Assert.Equal("off", (await svc.GetAsync("620", false, TestContext.Current.CancellationToken)).Status);
        _settings.Set(SteamNewsService.SettingKey, JsonValue.Create(true));
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        Assert.Equal("offline", (await svc.GetAsync("620", false, TestContext.Current.CancellationToken)).Status);
        _settings.Set("privacy.localOnly", JsonValue.Create(false));
        _gameRunning = true;
        Assert.Equal("unavailable", (await svc.GetAsync("620", false, TestContext.Current.CancellationToken)).Status);
        Assert.Empty(_handler.Requests);
        _gameRunning = false;
        Assert.Equal("notSteam", (await svc.GetAsync(null, false, TestContext.Current.CancellationToken)).Status);

        var n = await svc.GetAsync("620", false, TestContext.Current.CancellationToken);
        _dataSaver = true;
        var still = await svc.LoadImagesAsync("620", n.Posts[0].Gid, force: false, TestContext.Current.CancellationToken);
        Assert.Equal(0, still.Posts[0].ImagesLoaded);
        Assert.DoesNotContain(_handler.Requests, u => u.Host == "clan.akamai.steamstatic.com");
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        _now += TimeSpan.FromDays(1);
        var stale = await svc.GetAsync("620", true, TestContext.Current.CancellationToken);
        Assert.True(stale.Stale);
        Assert.Equal(2, stale.Posts.Count);
    }

    [Fact]
    public void Tampered_news_cache_is_cleaned()
    {
        var f = SteamNewsService.Validate(new NewsCacheFile
        {
            AppId = "620",
            Posts =
            [
                new()
                {
                    Gid = "1", Title = "T‮", Tags = ["patchnotes", "<b>"],
                    Blocks = [new NewsBlock("script", [new NewsSpan("x")]), new NewsBlock("img", [], "https://evil.example/a.png"), new NewsBlock("p", [new NewsSpan("ok\u0007")])],
                    ImageFiles = new() { ["https://evil.example/a.png"] = "../../../x" },
                },
                new() { Gid = "../1" },
            ],
        }, "620")!;
        var p = Assert.Single(f.Posts);
        Assert.Equal("T", p.Title);
        Assert.Equal(["patchnotes"], p.Tags);
        Assert.Equal(["p"], p.Blocks.Select(b => b.Kind));
        Assert.Equal("ok", p.Blocks[0].Spans[0].Text);
        Assert.Empty(p.ImageFiles);
        Assert.Null(SteamNewsService.Validate(new NewsCacheFile { AppId = "440" }, "620"));
    }

    [Theory]
    [InlineData("Patch 1.2.3", true)]
    [InlineData("Hotfix for the weekend", true)]
    [InlineData("v2.0 is here", true)]
    [InlineData("Summer sale event", false)]
    public void Patch_posts_are_recognised(string title, bool patch) => Assert.Equal(patch, SteamNewsService.IsPatch(title, []));

    // ---------- Notifications and activation ----------

    [Fact]
    public void Wishlist_alerts_notify_once_and_open_the_wishlist()
    {
        var on = new HashSet<string> { NotificationPolicy.Enabled, NotificationPolicy.Wishlist };
        var policy = new NotificationPolicy(k => on.Contains(k), _ => null);
        using var one = JsonDocument.Parse("""{"items":[{"kind":"released","appId":"1086940","name":"Baldur's Gate 3","price":"$59.99"}]}""");
        var n = Assert.Single(policy.Evaluate("wishlist.alerts", one.RootElement, foreground: false));
        Assert.Equal("Baldur's Gate 3 is out now", n.Title);
        Assert.NotNull(ActivationUri.Build(n.RouteJson));
        Assert.Contains("wishlist", ActivationUri.Build(n.RouteJson));
        Assert.Empty(policy.Evaluate("wishlist.alerts", one.RootElement, foreground: false)); // once

        using var low = JsonDocument.Parse("""{"items":[{"kind":"newLow","appId":"1145360","name":"Hades","price":"$7.49"},{"kind":"evil","appId":"1","name":"x"},{"kind":"atLow","appId":"../1","name":"y"}]}""");
        var l = Assert.Single(policy.Evaluate("wishlist.alerts", low.RootElement, foreground: false));
        Assert.Equal("Hades: lowest price ever", l.Title);
        Assert.Contains("$7.49", l.Body);

        on.Remove(NotificationPolicy.Wishlist);
        using var other = JsonDocument.Parse("""{"items":[{"kind":"released","appId":"2","name":"Other"}]}""");
        Assert.Empty(policy.Evaluate("wishlist.alerts", other.RootElement, foreground: false));
    }

    [Fact]
    public void Wishlist_route_accepts_no_parameters()
    {
        Assert.NotNull(ActivationUri.RouteFromUri("vystral://open?route=wishlist"));
        Assert.Null(ActivationUri.RouteFromUri("vystral://open?route=wishlist&id=" + new string('a', 32)));
    }

    [Fact]
    public void Track_w_settings_have_safe_defaults()
    {
        Assert.False(_settings.GetBool("wishlist.sync"));
        Assert.False(_settings.GetBool("friends.gameHistory"));
        Assert.True(_settings.GetBool("news.patchNotes"));
        Assert.True(_settings.GetBool("notifications.wishlist"));
        Assert.NotNull(_settings.Set("wishlist.sync", JsonValue.Create("yes")));
    }
}
