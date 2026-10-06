using System.Net;
using System.Text.Json.Nodes;
using Vystral.Core.Domain;
using Vystral.Core.Media;
using Vystral.Tests.Support;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Status;

/// <summary>Track N: the live-tile director's stored choice, keyed by the cached clip's bytes.</summary>
public sealed class LiveTileDirectorTests : IDisposable
{
    private const string Master = "https://video.akamai.steamstatic.com/store_trailers/1245620/468149/7d588828f80907ca97efdcb1e6ef72b4ce2b1d0d/1750650511/hls_264_master.m3u8?t=1654109241";

    private readonly TestDb _t = new();
    private readonly SettingsService _settings;
    private readonly Media _media = new();
    private readonly HttpClient _api;
    private readonly TrailerService _trailers;
    private readonly LiveTileService _svc;

    public LiveTileDirectorTests()
    {
        _settings = new SettingsService(_t.Repo);
        _settings.Set("dataSaver.onMetered", JsonValue.Create(false));
        _api = new HttpClient(new Media());
        _trailers = new TrailerService(_t.Repo, _settings, new NetworkCostService(), _api, () => false, "VYSTRAL-tests");
        _svc = new LiveTileService(_t.Repo, _settings, _trailers, Path.Combine(_t.Dir.Path, "live"), () => false, "VYSTRAL-tests", _media);
    }

    public void Dispose()
    {
        _svc.Dispose();
        _trailers.Dispose();
        _api.Dispose();
        _t.Dispose();
    }

    private sealed class Media : HttpMessageHandler
    {
        public byte[] Body = Mp4(4096, 1);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Body) });
    }

    private static byte[] Mp4(int length, byte fill)
    {
        var b = Enumerable.Repeat(fill, length).ToArray();
        b[0] = 0; b[1] = 0; b[2] = 0; b[3] = 0x18;
        "ftypisom"u8.CopyTo(b.AsSpan(4));
        return b;
    }

    private async Task<(string Id, string Path)> CachedClip()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "1245620", "Live Game", steamAppId: "1245620"))]);
        var id = _t.Repo.LoadSnapshot((_, _) => null).Games.Single().Id;
        _t.Repo.SetTrailer(id, "1245620", new SteamTrailer("1245620", "256889456", "Trailer", "hls", Master, null, true));
        var src = new Uri((await _svc.GetAsync(id, CancellationToken.None)).Src!);
        Assert.NotNull(await _svc.FetchAsync(src.AbsolutePath, null, CancellationToken.None));
        return (id, Path.Combine(_svc.CacheDirectory, Path.GetFileName(src.AbsolutePath).Insert(0, id + "-")));
    }

    [Fact]
    public async Task Nothing_is_directed_until_the_page_has_analysed_the_cached_clip()
    {
        var (id, _) = await CachedClip();
        var before = await _svc.GetAsync(id, CancellationToken.None);
        Assert.False(before.Directed);
        Assert.Null(before.Loop);

        Assert.True(_svc.SetLoop(id, 1.25, 2.0, 0.71));
        var after = await _svc.GetAsync(id, CancellationToken.None);
        Assert.True(after.Directed);
        Assert.Equal(new LiveLoopDto(1.25, 2.0), after.Loop);

        // "Loop the whole clip" is remembered too, so the clip isn't analysed again.
        Assert.True(_svc.SetLoop(id, null, null, 0));
        after = await _svc.GetAsync(id, CancellationToken.None);
        Assert.True(after.Directed);
        Assert.Null(after.Loop);
    }

    [Theory]
    [InlineData(-1.0, 2.0)]
    [InlineData(1.0, 0.2)]
    [InlineData(1.0, 9.0)]
    [InlineData(500.0, 2.0)]
    [InlineData(double.NaN, 2.0)]
    [InlineData(1.0, null)]
    public async Task Out_of_range_choices_are_refused(double? start, double? duration)
    {
        var (id, _) = await CachedClip();
        Assert.False(_svc.SetLoop(id, start, duration, 0.5));
        Assert.False((await _svc.GetAsync(id, CancellationToken.None)).Directed);
    }

    [Fact]
    public async Task The_choice_belongs_to_the_file_so_a_new_clip_is_analysed_afresh()
    {
        var (id, path) = await CachedClip();
        Assert.True(_svc.SetLoop(id, 0.5, 2.0, 0.4));
        var hash = _svc.FileHash(path);
        Assert.Matches("^[0-9a-f]{16}$", hash!);

        // Same URL, different bytes (Steam re-encoded it): the stored choice no longer applies.
        _svc.ClearCache();
        _media.Body = Mp4(5000, 7);
        var src = new Uri((await _svc.GetAsync(id, CancellationToken.None)).Src!);
        Assert.NotNull(await _svc.FetchAsync(src.AbsolutePath, null, CancellationToken.None));
        Assert.NotEqual(hash, _svc.FileHash(path));
        Assert.False((await _svc.GetAsync(id, CancellationToken.None)).Directed);
    }

    [Fact]
    public async Task Not_stored_without_a_cached_clip_or_while_blocked()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "1245620", "Live Game", steamAppId: "1245620"))]);
        var id = _t.Repo.LoadSnapshot((_, _) => null).Games.Single().Id;
        _t.Repo.SetTrailer(id, "1245620", new SteamTrailer("1245620", "256889456", "Trailer", "hls", Master, null, true));
        Assert.False(_svc.SetLoop(id, 1, 2, 0.5)); // nothing cached yet

        var (cached, _) = await CachedClip();
        _settings.Set("home.liveTiles", JsonValue.Create(false));
        Assert.False(_svc.SetLoop(cached, 1, 2, 0.5));
    }
}
