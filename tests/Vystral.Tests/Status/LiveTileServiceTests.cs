using System.Net;
using System.Text.Json.Nodes;
using Vystral.Core.Domain;
using Vystral.Core.Media;
using Vystral.Tests.Support;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Status;

public sealed class LiveTileServiceTests : IDisposable
{
    private const string Master = "https://video.akamai.steamstatic.com/store_trailers/1245620/468149/7d588828f80907ca97efdcb1e6ef72b4ce2b1d0d/1750650511/hls_264_master.m3u8?t=1654109241";
    private const string Micro = "https://video.akamai.steamstatic.com/store_trailers/1245620/468149/7d588828f80907ca97efdcb1e6ef72b4ce2b1d0d/1750650511/microtrailer.mp4";

    private readonly TestDb _t = new();
    private readonly SettingsService _settings;
    private readonly MediaHandler _media = new();
    private readonly HttpClient _api;
    private readonly TrailerService _trailers;
    private readonly LiveTileService _svc;
    private bool _gameRunning;

    public LiveTileServiceTests()
    {
        _settings = new SettingsService(_t.Repo);
        _settings.Set("dataSaver.onMetered", JsonValue.Create(false)); // independent of this PC's network
        _api = new HttpClient(new MediaHandler { Body = """{"1245620":{"success":true,"data":{"movies":[]}}}"""u8.ToArray() });
        _trailers = new TrailerService(_t.Repo, _settings, new NetworkCostService(), _api, () => _gameRunning, "VYSTRAL-tests");
        _svc = new LiveTileService(_t.Repo, _settings, _trailers, Path.Combine(_t.Dir.Path, "live"), () => _gameRunning, "VYSTRAL-tests", _media);
    }

    public void Dispose()
    {
        _svc.Dispose();
        _trailers.Dispose();
        _api.Dispose();
        _t.Dispose();
    }

    private sealed class MediaHandler : HttpMessageHandler
    {
        public int Calls;
        public Uri? LastUri;
        public HttpStatusCode Status = HttpStatusCode.OK;
        public byte[] Body = Mp4(4096);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            LastUri = request.RequestUri;
            return Task.FromResult(new HttpResponseMessage(Status) { Content = new ByteArrayContent(Body) });
        }
    }

    private static byte[] Mp4(int length)
    {
        var b = new byte[length];
        b[3] = 0x18;
        "ftypisom"u8.CopyTo(b.AsSpan(4));
        return b;
    }

    private string SteamGameWithTrailer(string? url = Master)
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "1245620", "Live Game", steamAppId: "1245620"))]);
        var id = _t.Repo.LoadSnapshot((_, _) => null).Games.Single().Id;
        _t.Repo.SetTrailer(id, "1245620", url is null ? null : new SteamTrailer("1245620", "256889456", "Trailer", "hls", url, null, true));
        return id;
    }

    // ---------- pure helpers ----------

    [Fact]
    public void Micro_trailer_sits_beside_the_hls_master()
    {
        var uri = SteamMicroTrailers.Resolve(new SteamTrailer("1245620", "1", null, "hls", Master, null, true));
        Assert.Equal(Micro, uri!.AbsoluteUri);
    }

    [Theory]
    [InlineData("mp4", "https://cdn.akamai.steamstatic.com/steam/apps/1/movie_max.mp4")]
    [InlineData("hls", "https://evil.example/store_trailers/1245620/1/hls_264_master.m3u8")]
    [InlineData("hls", "https://video.akamai.steamstatic.com/store_trailers/999/1/hls_264_master.m3u8")]
    [InlineData("hls", "http://video.akamai.steamstatic.com/store_trailers/1245620/1/hls_264_master.m3u8")]
    public void No_micro_trailer_for_legacy_or_foreign_trailers(string format, string url)
    {
        Assert.Null(SteamMicroTrailers.Resolve(new SteamTrailer("1245620", "1", null, format, url, null, true)));
        Assert.Null(SteamMicroTrailers.Resolve(null));
    }

    [Fact]
    public void Cache_key_is_short_stable_and_changes_with_the_trailer()
    {
        var a = SteamMicroTrailers.CacheKey(new Uri(Micro));
        Assert.Matches("^[0-9a-f]{16}$", a);
        Assert.Equal(a, SteamMicroTrailers.CacheKey(new Uri(Micro)));
        Assert.NotEqual(a, SteamMicroTrailers.CacheKey(new Uri(Micro.Replace("1750650511", "1750650512"))));
    }

    [Fact]
    public void Mp4_sniffing()
    {
        Assert.True(SteamMicroTrailers.LooksLikeMp4(Mp4(16)));
        Assert.False(SteamMicroTrailers.LooksLikeMp4("<html><body>nope</body></html>"u8));
        Assert.False(SteamMicroTrailers.LooksLikeMp4([0, 0, 0]));
    }

    [Theory]
    [InlineData("/live/0123456789abcdef0123456789abcdef/0123456789abcdef.mp4", true)]
    [InlineData("/live/0123456789abcdef0123456789abcdef/0123456789abcdef.webm", false)]
    [InlineData("/live/0123456789abcdef0123456789abcdef/../../etc.mp4", false)]
    [InlineData("/live/0123456789ABCDEF0123456789abcdef/0123456789abcdef.mp4", false)]
    [InlineData("/trailer/0123456789abcdef0123456789abcdef/0123456789abcdef.mp4", false)]
    public void Proxy_paths_parse_strictly(string path, bool ok)
    {
        Assert.Equal(ok, LiveTileService.ParseProxyPath(path) is not null);
    }

    [Fact]
    public void Ranges_slice_the_cached_file()
    {
        var body = Enumerable.Range(0, 100).Select(i => (byte)i).ToArray();
        var whole = LiveTileService.Slice(body, null);
        Assert.Equal(200, whole.Status);
        Assert.Equal(100, whole.Body.Length);
        var part = LiveTileService.Slice(body, "bytes=10-19");
        Assert.Equal(206, part.Status);
        Assert.Equal(Enumerable.Range(10, 10).Select(i => (byte)i), part.Body);
        Assert.Equal("bytes 10-19/100", part.ContentRange);
        var tail = LiveTileService.Slice(body, "bytes=90-");
        Assert.Equal("bytes 90-99/100", tail.ContentRange);
        Assert.Equal(200, LiveTileService.Slice(body, "bytes=500-").Status);
    }

    // ---------- bridge answers ----------

    [Fact]
    public async Task Describes_a_proxied_micro_trailer()
    {
        var id = SteamGameWithTrailer();
        var dto = await _svc.GetAsync(id, CancellationToken.None);
        Assert.Null(dto.Reason);
        Assert.Matches($"^https://media\\.vystral\\.example/live/{id}/[0-9a-f]{{16}}\\.mp4$", dto.Src!);
        Assert.Equal(0, _media.Calls); // describing never downloads
    }

    [Fact]
    public async Task Setting_off_or_a_running_game_blocks_everything()
    {
        var id = SteamGameWithTrailer();
        _settings.Set("home.liveTiles", JsonValue.Create(false));
        Assert.Equal("off", (await _svc.GetAsync(id, CancellationToken.None)).Reason);
        _settings.Set("home.liveTiles", JsonValue.Create(true));
        _gameRunning = true;
        Assert.Equal("gameRunning", (await _svc.GetAsync(id, CancellationToken.None)).Reason);
        var src = new Uri($"https://media.vystral.example/live/{id}/{SteamMicroTrailers.CacheKey(new Uri(Micro))}.mp4");
        Assert.Null(await _svc.FetchAsync(src.AbsolutePath, null, CancellationToken.None));
        Assert.Equal(0, _media.Calls);
    }

    [Fact]
    public async Task No_trailer_means_no_live_tile()
    {
        var id = SteamGameWithTrailer(url: null);
        Assert.Equal("none", (await _svc.GetAsync(id, CancellationToken.None)).Reason);
    }

    [Fact]
    public async Task Downloads_once_then_serves_from_cache_even_offline()
    {
        var id = SteamGameWithTrailer();
        var src = new Uri((await _svc.GetAsync(id, CancellationToken.None)).Src!);
        var first = await _svc.FetchAsync(src.AbsolutePath, null, CancellationToken.None);
        Assert.NotNull(first);
        Assert.Equal("video/mp4", first.ContentType);
        Assert.Equal(Micro, _media.LastUri!.AbsoluteUri);
        Assert.Equal(1, _media.Calls);

        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        Assert.Null((await _svc.GetAsync(id, CancellationToken.None)).Reason); // cached: still fine offline
        var again = await _svc.FetchAsync(src.AbsolutePath, "bytes=0-99", CancellationToken.None);
        Assert.Equal(206, again!.Status);
        Assert.Equal(1, _media.Calls);
        Assert.True(_svc.CacheBytes() > 0);
        Assert.True(_svc.ClearCache() > 0);
        Assert.Equal(0, _svc.CacheBytes());
    }

    [Fact]
    public async Task Offline_or_data_saver_never_download()
    {
        var id = SteamGameWithTrailer();
        var src = new Uri((await _svc.GetAsync(id, CancellationToken.None)).Src!);
        _settings.Set("dataSaver.enabled", JsonValue.Create(true));
        Assert.Equal("dataSaver", (await _svc.GetAsync(id, CancellationToken.None)).Reason);
        Assert.Null(await _svc.FetchAsync(src.AbsolutePath, null, CancellationToken.None));
        _settings.Set("dataSaver.enabled", JsonValue.Create(false));
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        Assert.Equal("offline", (await _svc.GetAsync(id, CancellationToken.None)).Reason);
        Assert.Null(await _svc.FetchAsync(src.AbsolutePath, null, CancellationToken.None));
        Assert.Equal(0, _media.Calls);
    }

    [Fact]
    public async Task Refuses_wrong_keys_non_mp4_bodies_and_oversized_files()
    {
        var id = SteamGameWithTrailer();
        Assert.Null(await _svc.FetchAsync($"/live/{id}/0000000000000000.mp4", null, CancellationToken.None));
        Assert.Equal(0, _media.Calls);

        var path = new Uri((await _svc.GetAsync(id, CancellationToken.None)).Src!).AbsolutePath;
        _media.Body = "<html>not a video</html>"u8.ToArray();
        Assert.Null(await _svc.FetchAsync(path, null, CancellationToken.None));
        _media.Body = Mp4(SteamMicroTrailers.MaxBytes + 1);
        Assert.Null(await _svc.FetchAsync(path, null, CancellationToken.None));
        _media.Body = Mp4(64);
        _media.Status = HttpStatusCode.Found;
        Assert.Null(await _svc.FetchAsync(path, null, CancellationToken.None));
        Assert.Equal(0, _svc.CacheBytes());
    }

    [Fact]
    public void Eviction_keeps_the_newest_files_within_budget()
    {
        var dir = _svc.CacheDirectory;
        for (var i = 0; i < 5; i++)
        {
            var f = Path.Combine(dir, $"{i:x32}-{i:x16}.mp4");
            File.WriteAllBytes(f, new byte[1000]);
            File.SetLastWriteTimeUtc(f, DateTime.UtcNow.AddMinutes(i));
        }
        _svc.Evict(budget: 2500);
        var left = Directory.GetFiles(dir, "*.mp4").Select(Path.GetFileName).Order().ToArray();
        Assert.Equal([$"{3:x32}-{3:x16}.mp4", $"{4:x32}-{4:x16}.mp4"], left);
    }

    [Fact]
    public void Eviction_drops_older_copies_of_the_same_game()
    {
        var dir = _svc.CacheDirectory;
        var game = new string('a', 32);
        var old = Path.Combine(dir, $"{game}-{new string('1', 16)}.mp4");
        var current = Path.Combine(dir, $"{game}-{new string('2', 16)}.mp4");
        File.WriteAllBytes(old, new byte[10]);
        File.WriteAllBytes(current, new byte[10]);
        _svc.Evict(game, current);
        Assert.False(File.Exists(old));
        Assert.True(File.Exists(current));
    }
}
