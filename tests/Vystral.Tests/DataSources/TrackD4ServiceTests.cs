using System.Net;
using System.Text.Json.Nodes;
using Vystral.Core.Domain;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.DataSources;

/// <summary>Track D4: the trailer fallback order and labels, and the free-games list (cache, offline, validation).</summary>
public sealed class TrackD4ServiceTests : IDisposable
{
    private readonly TestDb _t = new();
    private readonly List<Uri> _sent = [];
    private readonly HttpClient _http;
    private readonly SettingsService _settings;
    private readonly DataSourcesService _sources;
    private readonly TrailerService _trailers;
    private readonly FreebiesService _freebies;
    private string _steamDetails = """{"1145360":{"success":true,"data":{"movies":[]}}}""";
    private HttpStatusCode _gamerPowerStatus = HttpStatusCode.OK;

    public TrackD4ServiceTests()
    {
        _http = new HttpClient(new FakeHandler(Respond));
        _settings = new SettingsService(_t.Repo);
        _settings.Set("dataSaver.onMetered", JsonValue.Create(false));
        var art = new ArtworkService(new AppPaths(Path.Combine(_t.Dir.Path, "data")), _t.Repo, _http);
        _sources = new DataSourcesService(_t.Repo, _settings, art, new FakeSecretStore(), _http);
        foreach (var id in new[] { "gamerpower", "epicfree" }) _sources.Transport(id).Delay = (_, _) => Task.CompletedTask;
        _trailers = new TrailerService(_t.Repo, _settings, new NetworkCostService(), _http, () => false, "VYSTRAL-tests");
        _freebies = new FreebiesService(_t.Repo, _settings, _sources, art);
    }

    public void Dispose()
    {
        _trailers.Dispose();
        _http.Dispose();
        _t.Dispose();
    }

    private HttpResponseMessage Respond(HttpRequestMessage r)
    {
        lock (_sent) _sent.Add(r.RequestUri!);
        var host = r.RequestUri!.Host;
        if (host == "store.steampowered.com") return FakeHandler.Json(HttpStatusCode.OK, _steamDetails);
        if (host == "www.gamerpower.com")
            return _gamerPowerStatus == HttpStatusCode.OK ? FakeHandler.Json(HttpStatusCode.OK, TrackD4ParsingTests.Fixture("gamerpower_giveaways.json")) : FakeHandler.Json(_gamerPowerStatus, "oops");
        if (host == "store-site-backend-static.ak.epicgames.com") return FakeHandler.Json(HttpStatusCode.OK, TrackD4ParsingTests.Fixture("epic_free_games.json"));
        return FakeHandler.Json(HttpStatusCode.NotFound, "{}");
    }

    private string XboxGame()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Xbox, TestDb.Install(PlatformId.Xbox, "Studio.Game", "Tidebreaker"))]);
        return _t.Repo.LoadSnapshot((_, _) => null).Games.Single().Id;
    }

    // ---------- Trailers ----------

    [Fact]
    public async Task A_game_without_steam_gets_rawgs_mp4_through_the_proxy_labelled_rawg()
    {
        var gameId = XboxGame();
        var seen = new List<bool>();
        _trailers.AlternativeLookup = (id, network, _) =>
        {
            seen.Add(network);
            return Task.FromResult<ExternalTrailer?>(new ExternalTrailer("rawg", "file", "https://media.rawg.io/media/movies/abc/clip.mp4", null, "Launch trailer"));
        };
        var dto = await _trailers.GetAsync(gameId, CancellationToken.None);
        Assert.True(dto.Available);
        Assert.Equal(("file", "RAWG", null), (dto.Kind, dto.Source, dto.Via));
        Assert.Equal($"https://media.vystral.example/trailer/{gameId}/video", dto.Src);
        Assert.Equal([true], seen);
        Assert.Empty(_sent); // no Steam app: Steam isn't asked
    }

    [Fact]
    public async Task Youtube_trailers_need_the_setting_and_are_never_fetched_by_vystral()
    {
        var gameId = XboxGame();
        _trailers.AlternativeLookup = (_, _, _) => Task.FromResult<ExternalTrailer?>(new ExternalTrailer("igdb", "youtube", null, "nBT2SP21f3Q", "Reveal Trailer"));
        var off = await _trailers.GetAsync(gameId, CancellationToken.None);
        Assert.Equal((false, "youtubeOff", "IGDB"), (off.Available, off.Reason, off.Source));
        _settings.Set(TrailerService.YouTubeSetting, JsonValue.Create(true));
        var on = await _trailers.GetAsync(gameId, CancellationToken.None);
        Assert.Equal((true, "youtube", "https://www.youtube-nocookie.com/embed/nBT2SP21f3Q"), (on.Available, on.Kind, on.Src));
        Assert.Null(await _trailers.FetchAsync($"/trailer/{gameId}/video", null, CancellationToken.None));
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        Assert.Equal("offline", (await _trailers.GetAsync(gameId, CancellationToken.None)).Reason);
    }

    [Fact]
    public async Task A_matched_steam_app_brings_steams_trailer_labelled_as_matched()
    {
        var gameId = XboxGame();
        _steamDetails = """
            {"1145360":{"success":true,"data":{"movies":[{"id":256801252,"name":"Hades Launch","highlight":true,
              "hls_h264":"https://video.akamai.steamstatic.com/store_trailers/1145360/256801252/abc/123/hls_264_master.m3u8"}]}}}
            """;
        _trailers.SteamAppFor = id => id == gameId ? ("1145360", "matched") : null;
        var called = false;
        _trailers.AlternativeLookup = (_, _, _) => { called = true; return Task.FromResult<ExternalTrailer?>(null); };
        var dto = await _trailers.GetAsync(gameId, CancellationToken.None);
        Assert.Equal((true, "hls", "Steam", "matched"), (dto.Available, dto.Kind, dto.Source, dto.Via));
        Assert.False(called); // Steam had one: no other source is asked

        // The match is corrected to another app: the saved trailer isn't this game's any more.
        _steamDetails = """{"755800":{"success":true,"data":{"movies":[]}}}""";
        _trailers.SteamAppFor = id => id == gameId ? ("755800", "pinned") : null;
        var after = await _trailers.GetAsync(gameId, CancellationToken.None);
        Assert.Equal((false, "none", "pinned"), (after.Available, after.Reason, after.Via));
        Assert.True(called);
    }

    // ---------- Free games ----------

    [Fact]
    public async Task Freebies_are_off_by_default_and_merge_both_sources_when_on()
    {
        var off = await _freebies.GetAsync(false, CancellationToken.None);
        Assert.Equal("off", off.Reason);
        Assert.Empty(_sent);

        _settings.Set("dataSources.gamerpower", JsonValue.Create(true));
        _settings.Set("dataSources.epicFreeGames", JsonValue.Create(true));
        var on = await _freebies.GetAsync(false, CancellationToken.None);
        Assert.Null(on.Reason);
        Assert.Contains(on.Items, i => i.Source == "epic" && i.Title == "Out of Sight");
        Assert.Contains(on.Items, i => i.Source == "gamerpower" && i.Title == "Fireside Feelings");
        Assert.All(on.Sources, s => Assert.NotNull(s.FetchedAt));
        // Free-to-claim games come before loot and betas; nothing the page gets holds a URL.
        Assert.DoesNotContain("https://", System.Text.Json.JsonSerializer.Serialize(on.Items.Select(i => i with { Image = null })));
        Assert.Equal("https://www.gamerpower.com/fireside-feelings-steam-giveaway", _freebies.Find("gp-3810")!.Url);
        Assert.Null(_freebies.Find("gp-999999"));
        Assert.Null(_freebies.Find("../../etc"));

        // Cached for three hours: a second look asks nobody.
        var before = _sent.Count;
        await _freebies.GetAsync(false, CancellationToken.None);
        Assert.Equal(before, _sent.Count);
    }

    [Fact]
    public async Task A_failed_refresh_keeps_the_saved_list_marked_stale_and_offline_sends_nothing()
    {
        _settings.Set("dataSources.gamerpower", JsonValue.Create(true));
        await _freebies.GetAsync(false, CancellationToken.None);
        _gamerPowerStatus = HttpStatusCode.InternalServerError;
        var failed = await _freebies.GetAsync(true, CancellationToken.None);
        var gp = failed.Sources.Single(s => s.Id == "gamerpower");
        Assert.True(gp.Stale);
        Assert.NotNull(gp.Error);
        Assert.NotEmpty(failed.Items);

        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        var before = _sent.Count;
        var offline = await _freebies.GetAsync(true, CancellationToken.None);
        Assert.Equal(before, _sent.Count);
        Assert.NotEmpty(offline.Items);
    }

    [Fact]
    public void Freebie_validation_rejects_foreign_links_and_cleans_fields()
    {
        var good = new Freebie("gp-1", "gamerpower", "<b>Game</b>", "weird", ["PC"], "nonsense", "later", "$1", "2026-10-10T00:00:00", "garbage", null,
            "https://evil.example/img.jpg", "https://www.gamerpower.com/x");
        var v = FreebiesService.Validate(good)!;
        Assert.Equal(("Game", "other", "loot", "now", null, null), (v.Title, v.Store, v.Kind, v.Status, v.EndsAt, v.ImageUrl));
        Assert.Null(FreebiesService.Validate(good with { Url = "https://evil.example/x" }));
        Assert.Null(FreebiesService.Validate(good with { Source = "epic" }));
        Assert.Null(FreebiesService.Validate(good with { Id = "gp-1; DROP" }));
        Assert.Empty(FreebiesService.Read("{not json"));
    }

    [Fact]
    public void Same_game_from_both_sources_is_listed_once_free_now_first()
    {
        Freebie F(string id, string source, string title, string status, string kind = "game", string? ends = null) =>
            new(id, source, title, "epic", [], kind, status, null, null, ends, null, null, "https://www.gamerpower.com/x");
        var list = FreebiesService.Dedupe([
            F("epic-0123456789abcdef", "epic", "Out of Sight", "now", ends: "2026-10-15T15:00:00Z"),
            F("gp-1", "gamerpower", "Out of Sight", "now"),
            F("gp-2", "gamerpower", "Some Loot", "now", "loot"),
            F("epic-fedcba9876543210", "epic", "Bad Cheese", "upcoming"),
        ]);
        Assert.Equal(["epic-0123456789abcdef", "gp-2", "epic-fedcba9876543210"], list.Select(f => f.Id));
    }
}
