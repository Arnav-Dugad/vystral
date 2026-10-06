using System.Net;
using System.Text.Json.Nodes;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.TrackP;

public sealed class FriendsActivityTests : IDisposable
{
    private const string Key = "0123456789ABCDEF0123456789ABCDEF";
    private const string SteamId = "76561197960287930";
    private static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, (byte)'J', (byte)'F', (byte)'I', (byte)'F', 0, 1, 1, 0, 0, 1];

    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "TrackP", name));

    // ---------- Parsing ----------

    [Fact]
    public void Friend_list_keeps_valid_unique_friends_only()
    {
        var list = SteamWebApiClient.ParseFriendList(Fixture("friendlist.json"));
        Assert.Equal(["76561197960287931", "76561197960287932", "76561197960287934", "76561197960287935", "76561197960287936", "76561197960287937"],
            list.Select(f => f.SteamId));
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1500000000), list[0].FriendSince);
        Assert.Null(list[1].FriendSince);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"friendslist":{}}""")]
    [InlineData("""{"friendslist":{"friends":"x"}}""")]
    public void No_friends_is_an_empty_list(string json) => Assert.Empty(SteamWebApiClient.ParseFriendList(json));

    [Fact]
    public void Unreadable_friend_list_is_malformed() =>
        Assert.Equal(SteamApiOutcome.Malformed, Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParseFriendList("<html>")).Outcome);

    [Fact]
    public void Status_401_means_a_private_friends_list_and_403_with_a_key_hint_means_a_bad_key()
    {
        var p = Assert.Throws<SteamApiException>(() => SteamWebApiClient.ThrowForFriendListStatus(HttpStatusCode.Unauthorized, ""));
        Assert.Equal(SteamApiOutcome.PrivateProfile, p.Outcome);
        Assert.Contains("Friends List", p.Message);
        Assert.Contains("Only your own setting matters", p.Message);
        Assert.Equal(SteamApiOutcome.InvalidKey, Assert.Throws<SteamApiException>(() =>
            SteamWebApiClient.ThrowForFriendListStatus(HttpStatusCode.Forbidden, "<html>Forbidden. Please verify your <pre>key=</pre></html>")).Outcome);
        Assert.Equal(SteamApiOutcome.PrivateProfile, Assert.Throws<SteamApiException>(() =>
            SteamWebApiClient.ThrowForFriendListStatus(HttpStatusCode.Forbidden, "<html>Forbidden</html>")).Outcome);
        SteamWebApiClient.ThrowForFriendListStatus(HttpStatusCode.OK, "");
    }

    [Fact]
    public void Summaries_are_validated_cleaned_and_clipped()
    {
        var s = SteamWebApiClient.ParsePlayerSummaries(Fixture("summaries.json"));
        Assert.Equal(6, s.Count); // "bad" SteamID dropped
        var nova = s[0];
        Assert.Equal("Nova Star", nova.PersonaName);                 // bidi override and bell removed
        Assert.Equal(1, nova.PersonaState);
        Assert.Equal("620", nova.GameAppId);
        Assert.Equal("Portal 2", nova.GameName);
        Assert.Equal("https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg", nova.AvatarUrl);
        Assert.True(nova.PublicProfile);
        Assert.Null(s[1].AvatarUrl);                                  // not Steam's CDN
        Assert.Null(s[2].AvatarUrl);                                  // not HTTPS
        Assert.Equal("Steam friend", s[2].PersonaName);               // empty name
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1699990000), s[2].LastLogoff);
        Assert.Null(s[3].GameAppId);                                  // 64-bit mod/shortcut id
        Assert.Equal("Custom Mod", s[3].GameName);
        Assert.Equal("A non-Steam game", s[4].GameName);
        Assert.Equal(0, s[5].PersonaState);                           // out-of-range state
    }

    [Fact]
    public void Summaries_without_a_response_are_malformed() =>
        Assert.Equal(SteamApiOutcome.Malformed, Assert.Throws<SteamApiException>(() => SteamWebApiClient.ParsePlayerSummaries("{}")).Outcome);

    [Theory]
    [InlineData("https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg", true)]
    [InlineData("https://avatars.akamai.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb.jpg", true)]
    [InlineData("https://steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/fe/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg", true)]
    [InlineData("https://avatars.steamstatic.com/../etc/passwd", false)]
    [InlineData("https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg?x=1", false)]
    [InlineData("https://avatars.steamstatic.com:8443/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg", false)]
    [InlineData("https://user:pw@avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg", false)]
    [InlineData("https://avatars.steamstatic.com.evil.example/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg", false)]
    [InlineData("https://avatars.steamstatic.com/logo.png", false)]
    [InlineData("javascript:alert(1)", false)]
    public void Avatar_urls_are_restricted_to_Steams_avatar_cdn(string url, bool ok) =>
        Assert.Equal(ok, SteamWebApiClient.SafeAvatarUrl(url) is not null);

    [Fact]
    public void Clean_text_never_splits_an_emoji()
    {
        Assert.Equal("ab…", SteamWebApiClient.CleanText("ab😀cd", 3));
        Assert.Null(SteamWebApiClient.CleanText("\u0007‮", 10));
    }

    [Fact]
    public void Online_friends_are_ordered_playing_first_and_recent_ones_only_fill_an_empty_list()
    {
        var now = DateTimeOffset.FromUnixTimeSeconds(1700003600);
        var all = SteamWebApiClient.ParsePlayerSummaries(Fixture("summaries.json"));
        var (online, recent) = FriendsActivityService.Select(all, now);
        Assert.Equal(["Nova Star", "Modder", "Shortcut", "Quill"], online.Select(o => o.PersonaName));
        Assert.Empty(recent);
        var offline = all.Where(a => a.PersonaState == 0).ToList();
        var (none, seen) = FriendsActivityService.Select(offline, now);
        Assert.Empty(none);
        Assert.Equal(["Steam friend"], seen.Select(o => o.PersonaName)); // the one with a last log-off in the last 48 h
    }

    [Fact]
    public void Backoff_grows_and_caps()
    {
        Assert.Equal(TimeSpan.FromMinutes(2), FriendsActivityService.Backoff(SteamApiOutcome.Unavailable, 1));
        Assert.Equal(TimeSpan.FromMinutes(8), FriendsActivityService.Backoff(SteamApiOutcome.Unavailable, 3));
        Assert.Equal(TimeSpan.FromMinutes(30), FriendsActivityService.Backoff(SteamApiOutcome.Unavailable, 12));
        Assert.Equal(TimeSpan.FromMinutes(10), FriendsActivityService.Backoff(SteamApiOutcome.PrivateProfile, 1));
        Assert.Equal(TimeSpan.FromMinutes(30), FriendsActivityService.Backoff(SteamApiOutcome.InvalidKey, 1));
    }

    [Fact]
    public void Opaque_keys_are_stable_and_hide_the_steam_id()
    {
        var k = FriendsActivityService.OpaqueKey("76561197960287931");
        Assert.Equal(k, FriendsActivityService.OpaqueKey("76561197960287931"));
        Assert.Matches("^[0-9a-f]{16}$", k);
        Assert.DoesNotContain("7656119", k);
        Assert.Equal("play", FriendsActivityService.StateName(6));
        Assert.Equal("offline", FriendsActivityService.StateName(9));
    }

    // ---------- Service ----------

    private readonly TestDb _t = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly SettingsService _settings;
    private readonly ArtworkService _artwork;
    private readonly FakeHandler _handler;
    private readonly FriendsActivityService _svc;
    private DateTimeOffset _now = DateTimeOffset.FromUnixTimeSeconds(1700003600);
    private HttpStatusCode _friendStatus = HttpStatusCode.OK;
    private bool _gameRunning;
    private bool _dataSaver;

    public FriendsActivityTests()
    {
        _handler = new FakeHandler(Respond);
        var http = new HttpClient(_handler);
        var keys = new SteamApiKeyStore(_secrets);
        var api = new SteamWebApiClient(http, keys.Get) { Delay = (_, _) => Task.CompletedTask };
        _settings = new SettingsService(_t.Repo);
        _artwork = new ArtworkService(new AppPaths(_t.Dir.Dir("data")), _t.Repo, http) { SkipDownloads = () => _dataSaver };
        _svc = new FriendsActivityService(keys, api, _settings, _artwork, () => SteamId, () => new Dictionary<string, string> { ["620"] = new('c', 32) })
        {
            IsGameActive = () => _gameRunning,
            Now = () => _now,
        };
    }

    public void Dispose() => _t.Dispose();

    private HttpResponseMessage Respond(HttpRequestMessage req)
    {
        var path = req.RequestUri!.AbsolutePath;
        if (req.RequestUri.Host == "avatars.steamstatic.com")
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Jpeg) { Headers = { ContentType = new("image/jpeg") } } };
        if (path.Contains("GetFriendList"))
            return _friendStatus == HttpStatusCode.OK ? FakeHandler.Json(HttpStatusCode.OK, Fixture("friendlist.json")) : FakeHandler.Json(_friendStatus, "");
        if (path.Contains("GetPlayerSummaries")) return FakeHandler.Json(HttpStatusCode.OK, Fixture("summaries.json"));
        return FakeHandler.Json(HttpStatusCode.NotFound, "");
    }

    private void Enable()
    {
        _secrets.Write(SteamApiKeyStore.Target, Key);
        _settings.Set(FriendsActivityService.SettingKey, JsonValue.Create(true));
    }

    private int Calls(string endpoint) => _handler.Requests.Count(r => r.AbsolutePath.Contains(endpoint));

    [Fact]
    public async Task Off_by_default_and_needs_a_key()
    {
        Assert.False(_settings.GetBool(FriendsActivityService.SettingKey));
        Assert.Equal("off", (await _svc.GetAsync(false, TestContext.Current.CancellationToken)).Status);
        _settings.Set(FriendsActivityService.SettingKey, JsonValue.Create(true));
        Assert.Equal("notConnected", (await _svc.GetAsync(false, TestContext.Current.CancellationToken)).Status);
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public async Task Offline_mode_never_contacts_Steam()
    {
        Enable();
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        Assert.Equal("offline", (await _svc.GetAsync(true, TestContext.Current.CancellationToken)).Status);
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public async Task Reads_friends_maps_library_games_caches_avatars_and_rate_limits_itself()
    {
        Enable();
        var r = await _svc.GetAsync(false, TestContext.Current.CancellationToken);
        Assert.Equal("ok", r.Status);
        Assert.Equal(6, r.FriendCount);
        Assert.Equal(4, r.Friends.Count);
        var nova = r.Friends.Single(f => f.Name == "Nova Star");
        Assert.Equal(new string('c', 32), nova.GameId);
        Assert.Equal("online", nova.State);
        Assert.StartsWith("https://art.vystral.example/_avatars/", nova.Avatar);
        Assert.Null(r.Friends.Single(f => f.Name == "Quill").Avatar);
        Assert.DoesNotContain(r.Friends, f => f.Key.Contains("7656119"));
        Assert.All(_handler.Requests.Where(u => u.Host != "avatars.steamstatic.com"), u => Assert.Equal("api.steampowered.com", u.Host));
        Assert.Contains(_handler.Requests, u => u.Query.Contains("relationship=friend"));

        // Within the minimum interval nothing is asked again; later only the summaries are (the list is kept 15 min).
        _now += TimeSpan.FromSeconds(30);
        await _svc.GetAsync(false, TestContext.Current.CancellationToken);
        Assert.Equal(1, Calls("GetPlayerSummaries"));
        _now += FriendsActivityService.MinInterval;
        await _svc.GetAsync(false, TestContext.Current.CancellationToken);
        Assert.Equal(2, Calls("GetPlayerSummaries"));
        Assert.Equal(1, Calls("GetFriendList"));
        Assert.Equal(1, _handler.Requests.Count(u => u.Host == "avatars.steamstatic.com")); // cached on disk
    }

    [Fact]
    public async Task Private_friends_list_is_explained_and_backed_off()
    {
        Enable();
        _friendStatus = HttpStatusCode.Unauthorized;
        var r = await _svc.GetAsync(false, TestContext.Current.CancellationToken);
        Assert.Equal("private", r.Status);
        Assert.Contains("Friends List", r.Message);
        Assert.NotNull(r.RetryAt);
        _now += TimeSpan.FromMinutes(5);
        Assert.Equal("private", (await _svc.GetAsync(false, TestContext.Current.CancellationToken)).Status);
        Assert.Equal(1, Calls("GetFriendList"));
        // The user fixed it and pressed "Try again".
        _friendStatus = HttpStatusCode.OK;
        Assert.Equal("ok", (await _svc.GetAsync(true, TestContext.Current.CancellationToken)).Status);
    }

    [Fact]
    public async Task Game_running_and_data_saver_keep_the_last_results_without_asking()
    {
        Enable();
        await _svc.GetAsync(false, TestContext.Current.CancellationToken);
        var before = _handler.Requests.Count;
        _now += TimeSpan.FromMinutes(10);
        _gameRunning = true;
        var r = await _svc.GetAsync(false, TestContext.Current.CancellationToken);
        Assert.True(r.Stale);
        Assert.Equal(4, r.Friends.Count);
        _gameRunning = false;
        _dataSaver = true;
        Assert.True((await _svc.GetAsync(false, TestContext.Current.CancellationToken)).Stale);
        Assert.Equal(before, _handler.Requests.Count);
        // Asking explicitly still works under Data saver, without avatar downloads.
        var forced = await _svc.GetAsync(true, TestContext.Current.CancellationToken);
        Assert.False(forced.Stale);
        Assert.Equal(before + 1, _handler.Requests.Count);
    }

    [Fact]
    public async Task Turning_the_setting_off_forgets_everything()
    {
        Enable();
        await _svc.GetAsync(false, TestContext.Current.CancellationToken);
        _settings.Set(FriendsActivityService.SettingKey, JsonValue.Create(false));
        Assert.Equal("off", (await _svc.GetAsync(false, TestContext.Current.CancellationToken)).Status);
        _settings.Set(FriendsActivityService.SettingKey, JsonValue.Create(true));
        await _svc.GetAsync(false, TestContext.Current.CancellationToken);
        Assert.Equal(2, Calls("GetFriendList"));
    }
}
