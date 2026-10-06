using System.Diagnostics;
using System.Net;
using System.Text.Json.Nodes;
using Dapper;
using Vystral.Core.Cloud;
using Vystral.Core.Domain;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Cloud;
using Vystral.Windows.DataSources;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Cloud;

/// <summary>The cloud service end to end against fixtures and a recording process starter (nothing is ever launched).</summary>
public sealed class CloudPlayServiceTests : IDisposable
{
    private sealed class RecordingStarter : ICloudProcessStarter
    {
        public List<ProcessStartInfo> Started { get; } = [];
        public int? Start(ProcessStartInfo info) { Started.Add(info); return 4242; }
    }

    private sealed class FakeProcesses : IProcessSnapshotSource
    {
        public List<ProcessEntry> Now { get; set; } = [];
        public IReadOnlyList<ProcessEntry> Take() => Now;
    }

    private sealed class Events : IEventSink
    {
        public List<string> Names { get; } = [];
        public void Emit(string eventName, object? payload) { lock (Names) Names.Add(eventName); }
    }

    private readonly TestDb _t = new();
    private readonly SettingsService _settings;
    private readonly List<HttpRequestMessage> _sent = [];
    private readonly List<string> _bodies = [];
    private Func<HttpRequestMessage, HttpResponseMessage> _respond;
    private readonly HttpClient _http;
    private readonly RecordingStarter _starter = new();
    private readonly FakeProcesses _procs = new();
    private readonly Events _events = new();
    private CloudEnvironment _env = new(null, false, @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe");
    private DateTimeOffset _now = new(2026, 10, 6, 18, 0, 0, TimeSpan.Zero);
    private readonly CloudPlayService _svc;

    public CloudPlayServiceTests()
    {
        _settings = new SettingsService(_t.Repo);
        _respond = Answer;
        _http = new HttpClient(new FakeHandler(r =>
        {
            lock (_sent)
            {
                _sent.Add(r);
                _bodies.Add(r.Content?.ReadAsStringAsync().Result ?? "");
            }
            return _respond(r);
        }));
        _svc = new CloudPlayService(_t.Repo, _settings, _http, _events, Path.Combine(_t.Dir.Path, "cloud-edge"), () => _env, _starter, _procs, () => null)
        {
            Clock = () => _now,
            TimeZone = TimeZoneInfo.Utc,
            WindowsRegion = () => "GB",
        };
        _svc.NoDelaysForTests();
    }

    public void Dispose()
    {
        _svc.Dispose();
        _http.Dispose();
        _t.Dispose();
    }

    private static HttpResponseMessage Answer(HttpRequestMessage r)
    {
        var url = r.RequestUri!.AbsoluteUri;
        if (url.StartsWith(GfnCatalogClient.Endpoint, StringComparison.Ordinal))
        {
            var body = r.Content!.ReadAsStringAsync().Result;
            return FakeHandler.Json(HttpStatusCode.OK, CloudParsingTests.Fixture(body.Contains("after:\"\"") ? "gfn_page1.json" : "gfn_page_last.json"));
        }
        if (url.StartsWith("https://catalog.gamepass.com/sigls/v2", StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, CloudParsingTests.Fixture("xbox_sigl_allcloud.json"));
        if (url.StartsWith("https://displaycatalog.mp.microsoft.com/", StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, CloudParsingTests.Fixture("xbox_displaycatalog.json"));
        if (url == GfnStatusClient.SummaryUrl) return FakeHandler.Json(HttpStatusCode.OK, CloudParsingTests.Fixture("gfn_status_summary.json"));
        return FakeHandler.Json(HttpStatusCode.NotFound, "{}");
    }

    private void Enable() => Assert.Null(_settings.Set("cloud.enabled", JsonValue.Create(true)));

    private string AddGame(PlatformId platform, string id, string title)
    {
        _t.Repo.ApplyScan([TestDb.Ok(platform, TestDb.Install(platform, id, title, steamAppId: platform == PlatformId.Steam ? id : null))]);
        return _t.Repo.LoadSnapshot((_, _) => null).Games.Single(g => g.Title == title).Id;
    }

    [Fact]
    public async Task Off_by_default_sends_nothing_and_shows_nothing()
    {
        Assert.False(_svc.Enabled);
        var hl2 = AddGame(PlatformId.Steam, "220", "Half-Life 2");
        Assert.Empty(_svc.Map());
        Assert.Equal("off", _svc.ForGame(hl2).Reason);
        var ex = await Assert.ThrowsAsync<DataSourceException>(() => _svc.RefreshAsync(manual: true, CancellationToken.None));
        Assert.Equal(DataSourceOutcome.Disabled, ex.Outcome);
        Assert.Throws<BridgeException>(() => _svc.Launch(hl2, "gfn"));
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task Offline_mode_blocks_refreshes()
    {
        Enable();
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        var ex = await Assert.ThrowsAsync<DataSourceException>(() => _svc.RefreshAsync(manual: true, CancellationToken.None));
        Assert.Equal(DataSourceOutcome.Offline, ex.Outcome);
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task Refresh_uses_the_windows_region_caches_and_matches_the_library()
    {
        Enable();
        var hl2 = AddGame(PlatformId.Steam, "220", "Half-Life 2");
        var among = AddGame(PlatformId.Xbox, "Innersloth.AmongUs_fw5x688tam7rm", "Among Us");
        var status = await _svc.RefreshAsync(manual: true, CancellationToken.None);

        Assert.Equal("GB", status.Market);
        Assert.Equal("windows", status.MarketSource);
        var gfnCalls = _sent.Where(r => r.RequestUri!.Host == "api-prod.nvidia.com").ToList();
        Assert.Equal(2, gfnCalls.Count); // two pages, by cursor
        Assert.All(gfnCalls, r => Assert.Equal("text/plain", r.Content!.Headers.ContentType!.MediaType));
        Assert.Contains("country:\"GB\"", _bodies[_sent.IndexOf(gfnCalls[0])]);
        Assert.Contains(_sent, r => r.RequestUri!.AbsoluteUri.Contains("market=GB"));

        var gfn = status.Services.Single(s => s.Service == "gfn");
        Assert.Equal("ok", gfn.State);
        Assert.Equal(11, gfn.Count);
        Assert.NotNull(gfn.NextRefreshAt);

        var map = _svc.Map();
        Assert.Equal("gfn", Assert.Single(map[hl2]).Service);
        Assert.Equal("store", map[hl2][0].Match);
        Assert.Equal("xbox", Assert.Single(map[among]).Service);

        var options = _svc.ForGame(hl2).Options;
        var o = Assert.Single(options);
        Assert.Equal("GeForce NOW · Ready to play", o.Headline);
        Assert.Equal(CloudSurfaces.Edge, o.Surface);

        // At most daily per market: a second refresh sends nothing.
        var before = _sent.Count;
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        Assert.Equal(before, _sent.Count);

        // A different market may refresh straight away.
        _settings.Set("cloud.market", JsonValue.Create("US"));
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        Assert.True(_sent.Count > before);
        Assert.Equal("setting", _svc.Status().MarketSource);
    }

    [Fact]
    public async Task Server_errors_keep_the_last_good_copy_and_back_off()
    {
        Enable();
        _settings.Set("cloud.xbox", JsonValue.Create(false));
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        Assert.Equal(11, _t.Repo.CloudCatalogCount("gfn", "GB"));

        // Let the day pass, then fail.
        using (var conn = _t.Db.Open())
            conn.Execute("UPDATE settings SET value=@v WHERE key='cloud.gfn.lastOk'", new { v = System.Text.Json.JsonSerializer.Serialize($"GB|{DateTimeOffset.UtcNow.AddDays(-2):O}") });
        _respond = _ => FakeHandler.Json(HttpStatusCode.ServiceUnavailable, "oops");
        var status = await _svc.RefreshAsync(manual: true, CancellationToken.None);
        var gfn = status.Services.Single(s => s.Service == "gfn");
        Assert.Equal("stale", gfn.State);
        Assert.NotNull(gfn.Error);
        Assert.Equal(11, _t.Repo.CloudCatalogCount("gfn", "GB"));
        Assert.NotNull(_svc.NextAllowed("gfn", "GB")); // backing off
        var calls = _sent.Count;
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        Assert.Equal(calls, _sent.Count);
        Assert.Equal(TimeSpan.FromHours(1), CloudPlayService.Backoff(1));
        Assert.Equal(TimeSpan.FromHours(8), CloudPlayService.Backoff(4));
        Assert.Equal(TimeSpan.FromHours(24), CloudPlayService.Backoff(12));
    }

    [Fact]
    public async Task Too_many_requests_pause_the_lane()
    {
        Enable();
        _settings.Set("cloud.xbox", JsonValue.Create(false));
        _respond = _ => new HttpResponseMessage(HttpStatusCode.TooManyRequests) { Headers = { RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromMinutes(10)) }, Content = new StringContent("") };
        var status = await _svc.RefreshAsync(manual: true, CancellationToken.None);
        Assert.Equal("error", status.Services.Single(s => s.Service == "gfn").State);
        Assert.Single(_sent);
    }

    [Fact]
    public async Task Launch_builds_the_plan_records_a_cloud_session_and_im_done_saves_it()
    {
        Enable();
        var hl2 = AddGame(PlatformId.Steam, "220", "Half-Life 2");
        await _svc.RefreshAsync(manual: true, CancellationToken.None);

        var result = _svc.Launch(hl2, "gfn");
        Assert.Equal(CloudSurfaces.Edge, result.Surface);
        var psi = Assert.Single(_starter.Started);
        Assert.False(psi.UseShellExecute);
        Assert.StartsWith("--app=https://play.geforcenow.com/games?game-id=e5bd86f0-3f67-4bec-a505-d1315f3c0d50", psi.ArgumentList[0]);
        Assert.Equal($"--user-data-dir={Path.Combine(_t.Dir.Path, "cloud-edge")}", psi.ArgumentList[1]);
        Assert.True(Directory.Exists(Path.Combine(_t.Dir.Path, "cloud-edge")));
        Assert.Equal("running", _svc.ActiveDto()!.State);
        Assert.True(_svc.SessionActive);

        _procs.Now = [new ProcessEntry(4242, 1, 1, "msedge.exe", 0, 0)];
        _now = _now.AddMinutes(45);
        _svc.TickForTests(_now);
        Assert.True(_svc.EndActive(_now));
        Assert.Null(_svc.ActiveDto());

        var session = Assert.Single(_t.Repo.ListSessions(hl2, 10));
        Assert.Equal(SessionSources.CloudGfn, session.Source);
        Assert.Null(session.InstallationId);
        Assert.Equal(45 * 60, session.DurationSeconds);
        Assert.Contains("library.changed", _events.Names);
        // Cloud time counts as time VYSTRAL saw you play, and in the meter.
        Assert.Equal(45 * 60, _t.Repo.LoadSnapshot((_, _) => null).Games.Single(g => g.Id == hl2).TrackedSeconds);
        _settings.Set("cloud.gfnPlan", JsonValue.Create("performance"));
        var meter = _svc.MeterDto();
        Assert.Equal(45 * 60, meter.UsedSeconds);
        Assert.Equal(100 * 3600L, meter.LimitSeconds);
        Assert.Equal("ok", meter.Level);
    }

    [Fact]
    public async Task Very_short_cloud_sessions_are_not_saved()
    {
        Enable();
        var hl2 = AddGame(PlatformId.Steam, "220", "Half-Life 2");
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        _svc.Launch(hl2, "gfn");
        _now = _now.AddSeconds(20);
        _svc.EndActive(_now);
        Assert.Empty(_t.Repo.ListSessions(hl2, 10));
    }

    [Fact]
    public async Task Gfn_app_launch_waits_for_the_stream_and_xbox_has_no_meter()
    {
        Enable();
        _env = _env with { GfnAppPath = @"C:\Users\me\AppData\Local\NVIDIA Corporation\GeForceNOW\CEF\GeForceNOW.exe", XboxApp = true };
        var hl2 = AddGame(PlatformId.Steam, "220", "Half-Life 2");
        var among = AddGame(PlatformId.Xbox, "Innersloth.AmongUs_fw5x688tam7rm", "Among Us");
        await _svc.RefreshAsync(manual: true, CancellationToken.None);

        Assert.Equal(CloudSurfaces.GfnApp, _svc.Launch(hl2, "gfn").Surface);
        Assert.Equal(["--url-route=#?cmsId=100885011&launchSource=External&shortName=game_gfn_pc&parentGameId="], _starter.Started[^1].ArgumentList);
        Assert.Equal("waiting", _svc.ActiveDto()!.State);
        Assert.False(_svc.SessionActive);
        Assert.Empty(_t.Repo.ListSessions(hl2, 10)); // nothing recorded before the stream starts

        var x = _svc.Launch(among, "xbox"); // replaces the waiting GeForce NOW launch
        Assert.Equal(CloudSurfaces.XboxApp, x.Surface);
        Assert.True(_starter.Started[^1].UseShellExecute);
        Assert.Equal("msxbox://game/?productId=9NG07QJNK38J", _starter.Started[^1].FileName);
        Assert.Equal("xbox", _svc.ActiveDto()!.Service);
        Assert.Null(_svc.ActiveDto()!.SessionLimitSeconds);
    }

    [Fact]
    public async Task Games_not_in_the_catalogue_cant_be_launched()
    {
        Enable();
        var other = AddGame(PlatformId.Steam, "999999", "Nowhere");
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        Assert.Equal("notFound", Assert.Throws<BridgeException>(() => _svc.Launch(other, "gfn")).Code);
        Assert.Equal("none", _svc.ForGame(other).Reason);
        Assert.Empty(_starter.Started);
    }

    [Fact]
    public async Task Service_status_is_cached()
    {
        Enable();
        var a = await _svc.ServiceStatusAsync(CancellationToken.None);
        var b = await _svc.ServiceStatusAsync(CancellationToken.None);
        Assert.Equal("maintenance", a.Indicator);
        Assert.Same(a, b);
        Assert.Single(_sent);
    }

    [Fact]
    public void The_cloud_client_sends_a_plain_user_agent_and_keeps_no_cookies()
    {
        using var http = CloudPlayService.CreateHttpClient("0.6.0");
        Assert.Equal("VYSTRAL/0.6.0", http.DefaultRequestHeaders.UserAgent.ToString());
        var handlerField = typeof(HttpMessageInvoker).GetField("_handler", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
        var handler = Assert.IsType<SocketsHttpHandler>(handlerField!.GetValue(http));
        Assert.False(handler.UseCookies);
        Assert.False(handler.AllowAutoRedirect);
    }

    [Fact]
    public void Migration_7_creates_the_cloud_tables()
    {
        using var conn = _t.Db.Open();
        Assert.Equal(1, conn.ExecuteScalar<int>("SELECT COUNT(*) FROM sqlite_master WHERE name='cloud_catalog'"));
        Assert.Equal(1, conn.ExecuteScalar<int>("SELECT COUNT(*) FROM sqlite_master WHERE name='cloud_products'"));
    }
}
