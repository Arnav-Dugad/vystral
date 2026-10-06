using System.Text.Json.Nodes;
using Vystral.Core.Media;
using Xunit;

namespace Vystral.Tests.Status;

public sealed class SteamTrailerTests
{
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "Status", name));

    private static string Movies(string appId, JsonArray movies) =>
        new JsonObject { [appId] = new JsonObject { ["success"] = true, ["data"] = new JsonObject { ["movies"] = movies } } }.ToJsonString();

    private const string Folder = "https://video.akamai.steamstatic.com/store_trailers/1903340/876247/5c4709c3a98d932003a6b85bd5e4bfcd6a777e7a/1748581603/";
    private static readonly SteamTrailer Hls = new("1903340", "257129803", "Launch Trailer", "hls", Folder + "hls_264_master.m3u8?t=1745478082", null, true);
    private static readonly SteamTrailer Mp4 = new("620", "81614", "Launch trailer", "mp4", "https://cdn.akamai.steamstatic.com/steam/apps/81614/movie_max.mp4?t=1452903069", null, true);

    // ---------- Selection ----------

    [Fact]
    public void Real_hls_only_payload_picks_the_first_highlighted_movie()
    {
        var t = SteamTrailers.Select("1903340", Fixture("appdetails-1903340-hls.json"));
        Assert.NotNull(t);
        Assert.Equal("hls", t.Format);
        Assert.Equal("257129803", t.MovieId);
        Assert.Equal("Launch Trailer", t.Name);
        Assert.True(t.Highlight);
        Assert.Equal(Hls.Url, t.Url);
        Assert.StartsWith("https://shared.akamai.steamstatic.com/", t.Thumbnail);
    }

    [Fact]
    public void Legacy_payload_prefers_the_highlighted_movie_and_max_mp4()
    {
        var t = SteamTrailers.Select("620", Fixture("appdetails-legacy.json"));
        Assert.NotNull(t);
        Assert.Equal("mp4", t.Format);
        Assert.Equal("81614", t.MovieId);
        Assert.Equal(Mp4.Url, t.Url);
    }

    [Fact]
    public void Hls_is_preferred_over_legacy_files_in_the_same_movie()
    {
        var json = Movies("1903340", [new JsonObject
        {
            ["id"] = 1, ["highlight"] = true, ["hls_h264"] = Hls.Url,
            ["mp4"] = new JsonObject { ["max"] = "https://cdn.akamai.steamstatic.com/steam/apps/1/movie_max.mp4" },
        }]);
        Assert.Equal("hls", SteamTrailers.Select("1903340", json)!.Format);
    }

    [Fact]
    public void Webm_is_used_when_no_mp4_exists()
    {
        var json = Movies("620", [new JsonObject { ["id"] = 2, ["webm"] = new JsonObject { ["480"] = "https://cdn.akamai.steamstatic.com/steam/apps/2/movie480.webm" } }]);
        var t = SteamTrailers.Select("620", json);
        Assert.Equal("webm", t!.Format);
        Assert.False(t.Highlight);
    }

    [Theory]
    [InlineData("https://evil.example/store_trailers/1903340/1/2/3/hls_264_master.m3u8")]           // not a Steam host
    [InlineData("http://video.akamai.steamstatic.com/store_trailers/1903340/1/hls_264_master.m3u8")] // not HTTPS
    [InlineData("https://video.akamai.steamstatic.com/store_trailers/999/1/hls_264_master.m3u8")]   // different appid
    [InlineData("https://video.akamai.steamstatic.com/other/1903340/1/hls_264_master.m3u8")]        // wrong folder
    [InlineData("https://video.akamai.steamstatic.com/store_trailers/1903340/1/dash_av1.mpd")]      // not the HLS master
    [InlineData("https://video.akamai.steamstatic.com:8443/store_trailers/1903340/1/hls_264_master.m3u8")]
    [InlineData("https://user@video.akamai.steamstatic.com/store_trailers/1903340/1/hls_264_master.m3u8")]
    public void Unsafe_or_foreign_hls_urls_are_ignored(string url)
    {
        Assert.Null(SteamTrailers.Select("1903340", Movies("1903340", [new JsonObject { ["id"] = 3, ["highlight"] = true, ["hls_h264"] = url }])));
    }

    [Theory]
    [InlineData("""{"1903340":{"success":false}}""")]
    [InlineData("""{"1903340":{"success":true,"data":{"name":"No movies"}}}""")]
    [InlineData("""{"1903340":{"success":true,"data":{"movies":[]}}}""")]
    [InlineData("""{"1903340":{"success":true,"data":{"movies":[{"id":"abc","hls_h264":"x"}]}}}""")]
    [InlineData("""{"42":{"success":true,"data":{"movies":[]}}}""")]
    // Malformed answers of the wrong shape: never an exception (it used to stop the enrichment run).
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("\"text\"")]
    [InlineData("""{"1903340":null}""")]
    [InlineData("""{"1903340":{"success":true,"data":[]}}""")]
    [InlineData("""{"1903340":{"success":true,"data":{"movies":[null,1,"x",{"id":null}]}}}""")]
    public void Payloads_without_a_usable_movie_return_null(string json) => Assert.Null(SteamTrailers.Select("1903340", json));

    [Fact]
    public void Invalid_appid_never_parses() => Assert.Null(SteamTrailers.Select("../1", "{}"));

    // ---------- Proxy allow-listing ----------

    [Fact]
    public void Master_maps_to_the_stored_url_with_its_query()
    {
        Assert.Equal(Hls.Url, SteamTrailers.ResolveUpstream(Hls, "hls_264_master.m3u8")!.AbsoluteUri);
    }

    [Theory]
    [InlineData("hls_264_1_video.m3u8")]
    [InlineData("hls_264_4_audio.m3u8")]
    [InlineData("dash_h264/init-stream1.m4s")]
    [InlineData("dash_h264/chunk-stream1-00001.m4s")]
    [InlineData("dash_h264/chunk-stream4-00046.m4s")]
    public void Playlists_and_segments_in_the_trailer_folder_are_allowed(string relative)
    {
        Assert.Equal(Folder + relative, SteamTrailers.ResolveUpstream(Hls, relative)!.AbsoluteUri);
    }

    [Theory]
    [InlineData("")]
    [InlineData("video")]
    [InlineData("dash_av1.mpd")]
    [InlineData("dash_h264.mpd")]
    [InlineData("../hls_264_master.m3u8")]
    [InlineData("dash_h264/../../x.m4s")]
    [InlineData("dash_h264%2F..%2Fx.m4s")]
    [InlineData("https://evil.example/x.m4s")]
    [InlineData("//evil.example/hls_264_master.m3u8")]
    [InlineData("dash_thumbnails/thumbnails-00001.avif")]
    [InlineData("dash_h264/chunk-stream1-00001.m4s?x=1")]
    [InlineData("HLS_264_MASTER.M3U8")]
    public void Anything_else_is_refused(string relative) => Assert.Null(SteamTrailers.ResolveUpstream(Hls, relative));

    [Fact]
    public void Tampered_stored_urls_are_refused_at_request_time()
    {
        Assert.Null(SteamTrailers.ResolveUpstream(Hls with { Url = "https://evil.example/store_trailers/1903340/a/hls_264_master.m3u8" }, "hls_264_master.m3u8"));
        Assert.Null(SteamTrailers.ResolveUpstream(Hls with { SteamAppId = "1" }, "hls_264_1_video.m3u8"));
        Assert.Null(SteamTrailers.ResolveUpstream(Mp4 with { Url = "https://evil.example/movie_max.mp4" }, "video"));
        Assert.Null(SteamTrailers.ResolveUpstream(Hls with { Format = "dash" }, "hls_264_master.m3u8"));
    }

    [Fact]
    public void Single_file_trailers_only_expose_the_video_entry()
    {
        Assert.Equal(Mp4.Url, SteamTrailers.ResolveUpstream(Mp4, "video")!.AbsoluteUri);
        Assert.Null(SteamTrailers.ResolveUpstream(Mp4, "hls_264_master.m3u8"));
        Assert.Null(SteamTrailers.ResolveUpstream(Mp4, "movie_max.mp4"));
    }

    [Fact]
    public void Content_types_come_from_the_path_not_upstream()
    {
        Assert.Equal("application/vnd.apple.mpegurl", SteamTrailers.ContentTypeFor(Hls, "hls_264_master.m3u8"));
        Assert.Equal("video/mp4", SteamTrailers.ContentTypeFor(Hls, "dash_h264/init-stream4.m4s"));
        Assert.Equal("video/mp4", SteamTrailers.ContentTypeFor(Mp4, "video"));
        Assert.Equal("video/webm", SteamTrailers.ContentTypeFor(Mp4 with { Format = "webm" }, "video"));
    }
}
