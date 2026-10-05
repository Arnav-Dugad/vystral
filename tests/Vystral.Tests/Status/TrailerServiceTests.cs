using System.Text.Json.Nodes;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Media;
using Vystral.Tests.Support;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Status;

public sealed class TrailerServiceTests : IDisposable
{
    private readonly TestDb _t = new();
    private readonly SettingsService _settings;
    private readonly CountingHandler _handler = new();
    private readonly HttpClient _http;
    private bool _gameRunning;
    private readonly TrailerService _svc;

    public TrailerServiceTests()
    {
        _settings = new SettingsService(_t.Repo);
        _settings.Set("dataSaver.onMetered", JsonValue.Create(false)); // keep tests independent of this PC's network
        _http = new HttpClient(_handler);
        _svc = new TrailerService(_t.Repo, _settings, new NetworkCostService(), _http, () => _gameRunning, "VYSTRAL-tests");
    }

    public void Dispose()
    {
        _svc.Dispose();
        _http.Dispose();
        _t.Dispose();
    }

    private sealed class CountingHandler : HttpMessageHandler
    {
        public int Calls;
        public string Body = """{"620":{"success":true,"data":{"movies":[]}}}""";
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new StringContent(Body) });
        }
    }

    private string SteamGame(string appId = "620")
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, appId, "Trailer Game", steamAppId: appId))]);
        return _t.Repo.LoadSnapshot((_, _) => null).Games.Single().Id;
    }

    [Theory]
    [InlineData("/trailer/0123456789abcdef0123456789abcdef/hls_264_master.m3u8", "hls_264_master.m3u8")]
    [InlineData("/trailer/0123456789abcdef0123456789abcdef/dash_h264/chunk-stream1-00001.m4s", "dash_h264/chunk-stream1-00001.m4s")]
    [InlineData("/trailer/0123456789abcdef0123456789abcdef/video", "video")]
    public void Proxy_paths_parse(string path, string relative)
    {
        Assert.Equal(("0123456789abcdef0123456789abcdef", relative), TrailerService.ParseProxyPath(path));
    }

    [Theory]
    [InlineData("/trailer/0123456789ABCDEF0123456789abcdef/video")]
    [InlineData("/trailer/123/video")]
    [InlineData("/trailer/0123456789abcdef0123456789abcdef/")]
    [InlineData("/trailer/0123456789abcdef0123456789abcdef/a%2Fb")]
    [InlineData("/f/0123456789abcdef0123456789abcdef/video")]
    public void Bad_proxy_paths_are_rejected(string path) => Assert.Null(TrailerService.ParseProxyPath(path));

    [Theory]
    [InlineData(null, null, null)]
    [InlineData("bytes=0-", 0L, 4L * 1024 * 1024 - 1)]
    [InlineData("bytes=100-199", 100L, 199L)]
    [InlineData("bytes=10-99999999", 10L, 10L + 4 * 1024 * 1024 - 1)]
    [InlineData("bytes=-500", null, null)]
    [InlineData("bytes=0-1,5-9", null, null)]
    [InlineData("bytes=9-1", null, null)]
    [InlineData("items=0-1", null, null)]
    public void Ranges_are_clamped_to_one_chunk(string? header, long? start, long? end)
    {
        var r = TrailerService.ClampRange(header, TrailerService.MaxRangeChunk);
        Assert.Equal(start is null ? null : (start.Value, end!.Value), r);
    }

    [Fact]
    public async Task Games_without_a_steam_appid_have_no_trailer_and_cause_no_traffic()
    {
        var id = _t.Repo.AddManualGame("Manual", @"C:\Games\m\m.exe", null);
        var dto = await _svc.GetAsync(id, CancellationToken.None);
        Assert.False(dto.Available);
        Assert.Equal("noSteamApp", dto.Reason);
        Assert.Equal(0, _handler.Calls);
    }

    [Fact]
    public async Task Offline_mode_and_data_saver_block_lookups_and_the_proxy()
    {
        var id = SteamGame();
        _t.Repo.SetTrailer(id, "620", new SteamTrailer("620", "1", "T", "mp4", "https://cdn.akamai.steamstatic.com/steam/apps/1/movie_max.mp4", null, true));

        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        Assert.Equal("offline", (await _svc.GetAsync(id, CancellationToken.None)).Reason);
        Assert.Null(await _svc.FetchAsync($"/trailer/{id}/video", null, CancellationToken.None));

        _settings.Set("privacy.localOnly", JsonValue.Create(false));
        _settings.Set("dataSaver.enabled", JsonValue.Create(true));
        Assert.True(_svc.DataSaverActive);
        Assert.Equal("dataSaver", (await _svc.GetAsync(id, CancellationToken.None)).Reason);
        Assert.Null(await _svc.FetchAsync($"/trailer/{id}/video", null, CancellationToken.None));

        _settings.Set("dataSaver.enabled", JsonValue.Create(false));
        _gameRunning = true;
        Assert.Equal("gameRunning", (await _svc.GetAsync(id, CancellationToken.None)).Reason);
        Assert.Equal(0, _handler.Calls);
    }

    [Fact]
    public async Task A_fresh_lookup_is_stored_and_described_with_a_proxy_url()
    {
        var id = SteamGame("1903340");
        _handler.Body = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "Status", "appdetails-1903340-hls.json"));
        var dto = await _svc.GetAsync(id, CancellationToken.None);
        Assert.True(dto.Available);
        Assert.Equal("hls", dto.Kind);
        Assert.Equal($"https://media.vystral.example/trailer/{id}/hls_264_master.m3u8", dto.Src);
        Assert.Equal("Launch Trailer", dto.Name);
        Assert.Equal(1, _handler.Calls);

        // Cached: a second visit doesn't ask Steam again.
        await _svc.GetAsync(id, CancellationToken.None);
        Assert.Equal(1, _handler.Calls);
    }

    [Fact]
    public async Task No_usable_movie_is_remembered_as_none()
    {
        var id = SteamGame();
        var dto = await _svc.GetAsync(id, CancellationToken.None);
        Assert.Equal("none", dto.Reason);
        Assert.Null(_t.Repo.GetTrailer(id)!.Value.Trailer);
    }

    [Fact]
    public async Task Lookups_respect_the_game_details_setting()
    {
        var id = SteamGame();
        _settings.Set("library.fetchMetadata", JsonValue.Create(false));
        Assert.Equal("lookupsOff", (await _svc.GetAsync(id, CancellationToken.None)).Reason);
        Assert.Equal(0, _handler.Calls);
    }

    [Fact]
    public async Task Proxy_refuses_files_outside_the_allow_list_without_traffic()
    {
        var id = SteamGame("1903340");
        _t.Repo.SetTrailer(id, "1903340", SteamTrailers.Select("1903340",
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "Status", "appdetails-1903340-hls.json"))));
        Assert.Null(await _svc.FetchAsync($"/trailer/{id}/dash_av1.mpd", null, CancellationToken.None));
        Assert.Null(await _svc.FetchAsync($"/trailer/{id}/video", null, CancellationToken.None));
        Assert.Null(await _svc.FetchAsync($"/trailer/{LibraryRepository.NewId()}/hls_264_master.m3u8", null, CancellationToken.None));
        Assert.Equal(0, _handler.Calls);
    }

    [Fact]
    public void Data_saver_and_trailer_settings_have_safe_defaults()
    {
        var fresh = new SettingsService(_t.Repo).GetAll();
        Assert.False(fresh["dataSaver.enabled"]!.GetValue<bool>());
        Assert.True(fresh["trailers.autoplay"]!.GetValue<bool>());
        Assert.Equal("Invalid value for 'trailers.autoplay'.", _settings.Set("trailers.autoplay", JsonValue.Create("yes")));
    }

    [Theory]
    [InlineData("Unrestricted", false, false, false, false)]
    [InlineData("Unknown", false, false, false, false)]
    [InlineData("Fixed", false, false, false, true)]
    [InlineData("Variable", false, false, false, true)]
    [InlineData("Unrestricted", true, false, false, true)]
    [InlineData("Unrestricted", false, true, false, true)]
    [InlineData("Unrestricted", false, false, true, true)]
    public void Metered_follows_windows_cost_rules(string type, bool roaming, bool over, bool approaching, bool metered) =>
        Assert.Equal(metered, NetworkCostService.IsMetered(type, roaming, over, approaching));
}
