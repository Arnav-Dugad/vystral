using System.Net;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.DataSources;

/// <summary>Track N: art packs — planning, pacing, matching, the never-overwrite rule and undo.</summary>
public sealed class ArtPackTests : IDisposable
{
    private readonly TestDb _t = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly List<Uri> _sent = [];
    private readonly HttpClient _http;
    private readonly ArtworkService _art;
    private readonly DataSourcesService _sources;
    private readonly ArtPackManifestStore _store;
    private readonly ArtPackService _svc;
    private string? _block;
    private Func<HttpRequestMessage, HttpResponseMessage>? _override;

    public ArtPackTests()
    {
        _http = new HttpClient(new FakeHandler(r =>
        {
            lock (_sent) _sent.Add(r.RequestUri!);
            return _override?.Invoke(r) ?? Respond(r);
        }));
        _art = new ArtworkService(new AppPaths(Path.Combine(_t.Dir.Path, "data")), _t.Repo, _http);
        _sources = new DataSourcesService(_t.Repo, new SettingsService(_t.Repo), _art, _secrets, _http);
        _sources.Transport("steamgriddb").Delay = (_, _) => Task.CompletedTask;
        _secrets.Items["VYSTRAL/SteamGridDB"] = "0123456789abcdef0123456789abcdef";
        _store = new ArtPackManifestStore(Path.Combine(_t.Dir.Path, "data", "artpacks"));
        _svc = new ArtPackService(_t.Repo, _art, _sources.SteamGridDb, _sources.Transport("steamgriddb"), _store, () => _block, Games,
            CancellationToken.None, new ArtPackPacer(TimeSpan.Zero)) { BlockedPoll = TimeSpan.FromMilliseconds(20) };
    }

    public void Dispose()
    {
        _http.Dispose();
        _t.Dispose();
    }

    private static readonly byte[] Png = MakePng();

    private static byte[] MakePng()
    {
        var png = new byte[8000];
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49 }.CopyTo(png, 0);
        return png;
    }

    /// <summary>A small SteamGridDB: Steam app 620 and the title "Lone Title" exist; every list holds one image per style.</summary>
    private static HttpResponseMessage Respond(HttpRequestMessage r)
    {
        var path = r.RequestUri!.AbsolutePath;
        if (r.RequestUri.Host == "cdn2.steamgriddb.com")
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Png) { Headers = { ContentType = new("image/png") } } };
        if (path.StartsWith("/api/v2/games/steam/620"))
            return FakeHandler.Json(HttpStatusCode.OK, """{"success":true,"data":{"id":17830,"name":"Portal 2"}}""");
        if (path.StartsWith("/api/v2/games/steam/"))
            return FakeHandler.Json(HttpStatusCode.NotFound, """{"success":false}""");
        if (path.StartsWith("/api/v2/search/autocomplete/"))
            return FakeHandler.Json(HttpStatusCode.OK, Uri.UnescapeDataString(path).EndsWith("Lone Title")
                ? """{"success":true,"data":[{"id":900,"name":"Lone Title"},{"id":901,"name":"Lone Title 2"}]}"""
                : """{"success":true,"data":[{"id":902,"name":"Something Else"}]}""");
        var gameId = path.Split('/')[^1];
        var style = System.Web.HttpUtility.ParseQueryString(r.RequestUri.Query)["styles"] ?? "any";
        return FakeHandler.Json(HttpStatusCode.OK, $$$"""
            {"success":true,"data":[
              {"id":{{{gameId}}}1,"style":"{{{style}}}","width":600,"height":900,"score":3,"mime":"image/png",
               "url":"https://cdn2.steamgriddb.com/grid/{{{gameId}}}-{{{style}}}.png","thumb":"https://cdn2.steamgriddb.com/thumb/{{{gameId}}}-{{{style}}}.png","author":{"name":"Artist"}}]}
            """);
    }

    private string AddGame(PlatformId platform, string id, string title, string? steamAppId = null)
    {
        _t.Repo.ApplyScan([TestDb.Ok(platform, TestDb.Install(platform, id, title, steamAppId: steamAppId))]);
        return _t.Repo.LoadSnapshot((_, _) => null).Games.Single(g => g.Title == title).Id;
    }

    private IReadOnlyList<ArtPackGame> Games() =>
        _t.Repo.LoadSnapshot((_, _) => null).Games.Select(g => new ArtPackGame(g.Id, g.Title, g.Hidden, g.Installations.Any(i => i.State == "installed"),
            g.Favorite, g.LastTrackedPlay, g.Installations.Select(i => i.Platform.ToLowerInvariant()).ToList(), g.Collections)).ToList();

    private static ArtPackRequest Request(string preset = "alternate", bool replace = false, string scope = "all", params ArtworkKind[] kinds) =>
        new(ArtPackPresets.Find(preset)!, kinds.Length > 0 ? kinds : [ArtworkKind.Cover, ArtworkKind.Hero, ArtworkKind.Logo], ArtPackScope.Parse(scope)!, replace);

    // ---------- Planning (pure) ----------

    private static ArtPackGame G(string id, bool fav = false, string? played = null, bool hidden = false, bool installed = true, string platform = "steam",
        string[]? collections = null) => new(id, "Game " + id, hidden, installed, fav, played, [platform], collections ?? []);

    [Fact]
    public void Plan_orders_favourites_then_recent_play_and_respects_scope()
    {
        var games = new[]
        {
            G("a", played: "2024-01-01"), G("b", fav: true), G("c", played: "2025-06-01"), G("d", hidden: true),
            G("e", installed: false, platform: "epic", collections: ["c1"]),
        };
        var plan = ArtPackPlanner.Plan(games, [], Request("blurred"));
        // Blurred has no logo style: only covers and heroes are planned; hidden games never are.
        Assert.Equal(["b", "c", "a", "e"], plan.Sample);
        Assert.Equal(8, plan.Slots.Count);
        Assert.DoesNotContain(plan.Slots, s => s.Kind == ArtworkKind.Logo);
        Assert.Equal(4, plan.Games);

        Assert.Equal(["b", "c", "a"], ArtPackPlanner.Plan(games, [], Request("blurred", scope: "installed")).Sample);
        Assert.Equal(["e"], ArtPackPlanner.Plan(games, [], Request("blurred", scope: "platform:epic")).Sample);
        Assert.Equal(["e"], ArtPackPlanner.Plan(games, [], Request("blurred", scope: "collection:c1")).Sample);
    }

    [Fact]
    public void Plan_never_touches_hand_picked_art_unless_asked_but_replaces_earlier_packs()
    {
        var games = new[] { G("a"), G("b") };
        ArtworkRow[] art =
        [
            new("a", "cover", "a/cover-user.png", "steamgriddb", true),  // picked in the art picker
            new("a", "hero", "a/hero-user.png", "user", true),           // picked from a file
            new("b", "cover", "b/cover-pack.png", LibraryRepository.ArtPackSource, true), // an earlier pack
            new("b", "hero", "b/hero.jpg", "steam-cdn", false),
        ];
        var plan = ArtPackPlanner.Plan(games, art, Request("material"));
        Assert.Equal(2, plan.KeptHandPicked);
        Assert.Equal([new ArtPackSlot("b", ArtworkKind.Cover), new ArtPackSlot("b", ArtworkKind.Hero)], plan.Slots);
        Assert.Equal(["b"], plan.Sample);

        var replace = ArtPackPlanner.Plan(games, art, Request("material", replace: true));
        Assert.Equal(0, replace.KeptHandPicked);
        Assert.Equal(4, replace.Slots.Count);
    }

    [Fact]
    public void Sample_is_at_most_eight_games()
    {
        var games = Enumerable.Range(0, 30).Select(i => G($"g{i:00}")).ToList();
        var plan = ArtPackPlanner.Plan(games, [], Request("official", kinds: ArtworkKind.Logo));
        Assert.Equal(8, plan.Sample.Count);
        Assert.Equal(30, plan.Slots.Count);
    }

    [Theory]
    [InlineData("all", true)]
    [InlineData("installed", true)]
    [InlineData("platform:steam", true)]
    [InlineData("platform:battlenet", true)]
    [InlineData("platform:Steam", false)]
    [InlineData("platform:nintendo", false)]
    [InlineData("collection:0123456789abcdef0123456789abcdef", true)]
    [InlineData("collection:../x", false)]
    [InlineData("everything", false)]
    [InlineData(null, false)]
    public void Scopes_parse_strictly(string? scope, bool ok) => Assert.Equal(ok, ArtPackScope.Parse(scope) is not null);

    [Fact]
    public void Presets_only_use_styles_SteamGridDB_offers_for_each_slot()
    {
        foreach (var p in ArtPackPresets.All)
            foreach (var (kind, styles) in p.Styles)
                Assert.All(styles, s => Assert.Contains(s, SteamGridDbClient.Styles[kind]));
    }

    [Fact]
    public void Picks_the_best_rated_static_image_and_portrait_covers_only()
    {
        SgdbImage I(long id, int score, int w = 600, int h = 900, string mime = "image/png", string url = "https://cdn2.steamgriddb.com/grid/x.png") =>
            new(id, url, url, w, h, null, mime, null, score);
        var pick = ArtPackPlanner.PickImage([I(1, 5), I(2, 9, w: 920, h: 430), I(3, 8, mime: "image/gif"), I(4, 7), I(5, 7)], ArtworkKind.Cover);
        Assert.Equal(4, pick!.Id); // 2 is landscape, 3 animated; 4 and 5 tie → the older one
        Assert.Equal(2, ArtPackPlanner.PickImage([I(1, 5), I(2, 9, w: 920, h: 430)], ArtworkKind.Hero)!.Id);
        Assert.Null(ArtPackPlanner.PickImage([], ArtworkKind.Logo));
    }

    // ---------- Matching confidence ----------

    [Fact]
    public void Matching_uses_the_steam_app_first_then_only_an_exact_unique_title()
    {
        var steam = new SgdbGame(1, "Portal 2", 2011);
        Assert.Equal((steam, "steam"), ArtPackPlanner.Match(steam, "Portal 2", null));
        var exact = ArtPackPlanner.Match(null, "Hades", [new(2, "Hades", 2020), new(3, "Hades II", 2024)]);
        Assert.Equal((2L, "title"), (exact.Game!.Id, exact.By));
        Assert.Equal("title", ArtPackPlanner.Match(null, "HADES™", [new(2, "Hades", 2020)]).By); // normalized, still exact
        Assert.Null(ArtPackPlanner.Match(null, "Hades", [new(3, "Hades II", 2024)]).Game);         // close is not enough
        Assert.Null(ArtPackPlanner.Match(null, "Hades", [new(2, "Hades", 2020), new(4, "Hades", 2018)]).Game); // ambiguous
        Assert.Null(ArtPackPlanner.Match(null, "Hades", []).Game);
    }

    // ---------- Pacing ----------

    [Fact]
    public async Task Pacer_spaces_operations_and_honours_a_requested_pause()
    {
        var now = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var waits = new List<TimeSpan>();
        var pacer = new ArtPackPacer(TimeSpan.FromMilliseconds(500), () => now, (d, _) => { waits.Add(d); now += d; return Task.CompletedTask; });
        await pacer.WaitAsync(CancellationToken.None);
        await pacer.WaitAsync(CancellationToken.None);
        await pacer.WaitAsync(CancellationToken.None);
        Assert.Equal([TimeSpan.FromMilliseconds(500), TimeSpan.FromMilliseconds(500)], waits);
        now += TimeSpan.FromSeconds(3); // idle time isn't banked into a burst
        await pacer.WaitAsync(CancellationToken.None);
        Assert.Equal(2, waits.Count);
        pacer.Defer(TimeSpan.FromSeconds(30));
        await pacer.WaitAsync(CancellationToken.None);
        Assert.Equal(TimeSpan.FromSeconds(30), waits[^1]);
    }

    [Fact]
    public void Estimate_counts_a_lookup_per_game_and_two_steps_per_slot()
    {
        Assert.Equal(13, ArtPackPlanner.EstimateSeconds(10, 10, TimeSpan.FromMilliseconds(400), TimeSpan.FromMilliseconds(500)));
    }

    // ---------- Repository: never overwrite, undo only what is still ours ----------

    [Fact]
    public void Repository_keeps_hand_picked_art_and_restores_only_its_own_files()
    {
        var game = AddGame(PlatformId.Steam, "620", "Portal 2", "620");
        _t.Repo.SetArtwork(game, ArtworkKind.Cover, "g/cover-user.png", "steamgriddb", isUser: true);
        _t.Repo.SetArtwork(game, ArtworkKind.Hero, "g/hero.jpg", "steam-cdn", isUser: false);

        var (written, previous) = _t.Repo.ApplyPackArtwork(game, ArtworkKind.Cover, "g/cover-pack.png", replaceHandPicked: false);
        Assert.False(written);
        Assert.Equal("g/cover-user.png", previous!.File);
        Assert.Equal("g/cover-user.png", _t.Repo.GetArtworkRow(game, ArtworkKind.Cover)!.File);

        (written, previous) = _t.Repo.ApplyPackArtwork(game, ArtworkKind.Hero, "g/hero-pack.png", replaceHandPicked: false);
        Assert.True(written);
        Assert.Equal(new ArtworkRow(game, "hero", "g/hero.jpg", "steam-cdn", false), previous);
        // Pack art is protected from scans like a pick…
        _t.Repo.SetArtwork(game, ArtworkKind.Hero, "g/hero-new.jpg", "steam-cdn", isUser: false);
        Assert.Equal("g/hero-pack.png", _t.Repo.GetArtworkRow(game, ArtworkKind.Hero)!.File);
        // …but is not counted as one.
        Assert.False(LibraryRepository.IsHandPicked(_t.Repo.GetArtworkRow(game, ArtworkKind.Hero)));

        // Restoring puts the store art back, exactly as it was.
        Assert.True(_t.Repo.RestorePackArtwork(game, ArtworkKind.Hero, "g/hero-pack.png", previous));
        Assert.Equal(new ArtworkRow(game, "hero", "g/hero.jpg", "steam-cdn", false), _t.Repo.GetArtworkRow(game, ArtworkKind.Hero));

        // A slot changed since (here: picked by hand) is left alone.
        _t.Repo.ApplyPackArtwork(game, ArtworkKind.Logo, "g/logo-pack.png", false);
        _t.Repo.SetArtwork(game, ArtworkKind.Logo, "g/logo-user.png", "user", isUser: true);
        Assert.False(_t.Repo.RestorePackArtwork(game, ArtworkKind.Logo, "g/logo-pack.png", null));
        Assert.Equal("g/logo-user.png", _t.Repo.GetArtworkRow(game, ArtworkKind.Logo)!.File);

        // With "replace my picks", hand-picked art is replaced, and restoring brings the pick back.
        (written, previous) = _t.Repo.ApplyPackArtwork(game, ArtworkKind.Cover, "g/cover-pack.png", replaceHandPicked: true);
        Assert.True(written);
        Assert.True(_t.Repo.RestorePackArtwork(game, ArtworkKind.Cover, "g/cover-pack.png", previous));
        Assert.Equal(new ArtworkRow(game, "cover", "g/cover-user.png", "steamgriddb", true), _t.Repo.GetArtworkRow(game, ArtworkKind.Cover));
    }

    // ---------- The job, end to end ----------

    private async Task<ArtPackJobDto> RunToEnd(ArtPackRequest request)
    {
        var start = _svc.Start(request);
        await _svc.Running!.WaitAsync(TimeSpan.FromSeconds(20));
        return _svc.CurrentJob()!;
    }

    [Fact]
    public async Task Applies_a_pack_keeps_picks_records_everything_and_undoes_it()
    {
        var portal = AddGame(PlatformId.Steam, "620", "Portal 2", "620");
        var lone = AddGame(PlatformId.Gog, "lone", "Lone Title");
        var other = AddGame(PlatformId.Epic, "other", "No Match Here");
        _t.Repo.SetArtwork(portal, ArtworkKind.Cover, "p/cover-user.png", "steamgriddb", isUser: true);
        _t.Repo.SetArtwork(portal, ArtworkKind.Hero, "p/hero.jpg", "steam-cdn", isUser: false);
        Directory.CreateDirectory(Path.Combine(_t.Dir.Path, "data", "cache", "art", "p"));
        File.WriteAllBytes(Path.Combine(_t.Dir.Path, "data", "cache", "art", "p", "hero.jpg"), Png);
        var changed = 0;
        _svc.OnArtChanged = () => Interlocked.Increment(ref changed);
        var progress = new List<ArtPackJobDto>();
        _svc.OnProgress = p => { lock (progress) progress.Add(p); };

        var job = await RunToEnd(Request("alternate", kinds: [ArtworkKind.Cover, ArtworkKind.Hero]));
        Assert.Equal("done", job.State);
        Assert.Equal(5, job.Total);          // portal hero, lone cover+hero, other cover+hero (portal's cover is a pick)
        Assert.Equal(3, job.Applied);
        Assert.Equal(2, job.NoMatch);        // "No Match Here" has no confident match
        Assert.Equal(job.Total, job.Done);
        Assert.True(changed > 0);
        Assert.Contains(progress, p => p.State == "done");

        Assert.Equal("p/cover-user.png", _t.Repo.GetArtworkRow(portal, ArtworkKind.Cover)!.File);
        Assert.Equal(LibraryRepository.ArtPackSource, _t.Repo.GetArtworkRow(portal, ArtworkKind.Hero)!.Source);
        Assert.Equal(LibraryRepository.ArtPackSource, _t.Repo.GetArtworkRow(lone, ArtworkKind.Cover)!.Source);
        Assert.Null(_t.Repo.GetArtworkRow(other, ArtworkKind.Cover));
        // Only the "alternate" style was asked for, matched by Steam app ID for Portal and by exact title otherwise.
        Assert.Contains(_sent, u => u.AbsolutePath.EndsWith("/heroes/game/17830") && u.Query.Contains("styles=alternate"));
        Assert.Contains(_sent, u => u.AbsolutePath.EndsWith("/grids/game/900"));
        Assert.Equal("Alternate", _sources.UserArt(lone).Single(u => u.Kind == "cover").Pack);

        // The record lists what was replaced; files it may put back survive clearing the art cache.
        var run = Assert.Single(_svc.Runs());
        Assert.Equal(3, run.Replaced);
        Assert.True(run.CanRestore);
        Assert.Contains("p/hero.jpg", _svc.ReferencedFiles());

        var loneHeroFromFirstPack = _t.Repo.GetArtworkRow(lone, ArtworkKind.Hero)!.File;

        // A second run is cheap: matches are cached.
        var before = _sent.Count(u => u.AbsolutePath.Contains("/games/steam/") || u.AbsolutePath.Contains("/search/"));
        await RunToEnd(Request("material", kinds: [ArtworkKind.Hero]));
        Assert.Equal(before, _sent.Count(u => u.AbsolutePath.Contains("/games/steam/") || u.AbsolutePath.Contains("/search/")));

        // Undo the newer run: back to the first pack's heroes.
        var runs = _svc.Runs();
        Assert.Equal(2, runs.Count);
        var restoredNewer = _svc.Restore(runs[0].Id);
        Assert.Equal(2, restoredNewer.Restored);
        Assert.Equal(loneHeroFromFirstPack, _t.Repo.GetArtworkRow(lone, ArtworkKind.Hero)!.File);

        // Undo the first run: store art and empty slots come back; the pick was never touched.
        var restored = _svc.Restore(runs[1].Id);
        Assert.Equal(3, restored.Restored);
        Assert.Equal(new ArtworkRow(portal, "hero", "p/hero.jpg", "steam-cdn", false), _t.Repo.GetArtworkRow(portal, ArtworkKind.Hero));
        Assert.Null(_t.Repo.GetArtworkRow(lone, ArtworkKind.Cover));
        Assert.Equal("p/cover-user.png", _t.Repo.GetArtworkRow(portal, ArtworkKind.Cover)!.File);
        Assert.DoesNotContain(_svc.Runs(), r => r.CanRestore);
        Assert.Equal(0, _svc.Restore(runs[1].Id).Restored); // restoring twice changes nothing
    }

    [Fact]
    public async Task Waits_while_blocked_can_be_paused_and_cancelled()
    {
        AddGame(PlatformId.Steam, "620", "Portal 2", "620");
        AddGame(PlatformId.Gog, "lone", "Lone Title");
        _block = "gameRunning";
        var job = _svc.Start(Request("blurred"));
        await WaitFor(() => _svc.CurrentJob()!.State == "waiting" && _svc.CurrentJob()!.Reason == "gameRunning");
        Assert.Equal(0, _svc.CurrentJob()!.Done);
        Assert.DoesNotContain(_sent, u => u.Host == "cdn2.steamgriddb.com");

        _svc.Pause();
        _block = null;
        await WaitFor(() => _svc.CurrentJob()!.State == "paused");
        Assert.Throws<DataSourceException>(() => _svc.Start(Request("material"))); // one job at a time
        _svc.Cancel();
        await _svc.Running!.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("cancelled", _svc.CurrentJob()!.State);
        Assert.Equal(0, _svc.CurrentJob()!.Applied);
    }

    [Fact]
    public async Task Rate_limits_make_the_job_wait_instead_of_failing()
    {
        AddGame(PlatformId.Steam, "620", "Portal 2", "620");
        _override = _ => new HttpResponseMessage(HttpStatusCode.TooManyRequests) { Headers = { RetryAfter = new(TimeSpan.FromSeconds(30)) }, Content = new StringContent("") };
        _svc.Start(Request("blurred"));
        await WaitFor(() => _svc.CurrentJob()!.Reason == "rateLimited");
        Assert.Equal("waiting", _svc.CurrentJob()!.State);
        Assert.NotNull(_svc.CurrentJob()!.ResumeAt);
        var calls = _sent.Count;
        await Task.Delay(150);
        Assert.Equal(calls, _sent.Count); // nothing is sent while SteamGridDB asked for a pause
        _svc.Cancel();
        await _svc.Running!.WaitAsync(TimeSpan.FromSeconds(10));
    }

    [Fact]
    public void Refuses_to_start_without_a_key_offline_or_with_data_saver()
    {
        AddGame(PlatformId.Steam, "620", "Portal 2", "620");
        foreach (var (block, outcome) in new[] { ("notConfigured", DataSourceOutcome.NotConfigured), ("offline", DataSourceOutcome.Offline), ("dataSaver", DataSourceOutcome.Disabled) })
        {
            _block = block;
            Assert.Equal(outcome, Assert.Throws<DataSourceException>(() => _svc.Start(Request())).Outcome);
        }
        Assert.Empty(_sent);
        _block = null;
        var status = _svc.Status();
        Assert.True(status.Configured);
        Assert.Equal(6, status.Presets.Count);
    }

    [Fact]
    public async Task Sample_previews_the_image_a_pack_would_use()
    {
        var portal = AddGame(PlatformId.Steam, "620", "Portal 2", "620");
        var none = AddGame(PlatformId.Epic, "x", "No Match Here");
        var s = await _svc.SampleAsync(portal, ArtPackPresets.Find("white")!, ArtworkKind.Logo, CancellationToken.None);
        Assert.StartsWith("https://art.vystral.example/_thumbs/sgdb/", s.Thumb);
        Assert.Equal("steam", s.MatchedBy);
        Assert.Equal("noMatch", (await _svc.SampleAsync(none, ArtPackPresets.Find("white")!, ArtworkKind.Logo, CancellationToken.None)).Reason);
        Assert.Equal("noArt", (await _svc.SampleAsync(portal, ArtPackPresets.Find("white")!, ArtworkKind.Hero, CancellationToken.None)).Reason);
        Assert.Null(_t.Repo.GetArtworkRow(portal, ArtworkKind.Logo)); // previews never change anything
    }

    // ---------- The undo record ----------

    [Fact]
    public void Manifest_survives_a_torn_line_rejects_unsafe_entries_and_keeps_ten_runs()
    {
        var id = ArtPackManifestStore.NewId();
        _store.Save(new ArtPackManifest(id, "alternate", "Alternate", "all", ["cover"], false, "2026-01-01T00:00:00.0000000+00:00", null, "running", null));
        _store.Append(id, new ArtPackEntry("0123456789abcdef0123456789abcdef", "cover", "g/cover-pack.png", null));
        _store.Append(id, new ArtPackEntry("0123456789abcdef0123456789abcdef", "cover", "..\\..\\evil.png", null));
        _store.Append(id, new ArtPackEntry("0123456789abcdef0123456789abcdef", "header", "g/x.png", null));
        File.AppendAllText(Path.Combine(_store.Directory, id + ".jsonl"), "{\"gameId\":\"012");
        Assert.Single(_store.Entries(id));
        Assert.Null(_store.Load("../" + id));
        Assert.Equal("interrupted", _svc.Runs().Single().State); // "running" on disk but no job: VYSTRAL closed mid-run

        for (var i = 0; i < 12; i++)
            _store.Save(new ArtPackManifest(ArtPackManifestStore.NewId(), "white", "White logo", "all", ["logo"], false, $"2026-02-{i + 1:00}T00:00:00.0000000+00:00", null, "done", null));
        _store.Prune();
        Assert.Equal(ArtPackManifestStore.Keep, _store.List().Count);
        Assert.Null(_store.Load(id)); // the oldest went first
    }

    private static async Task WaitFor(Func<bool> condition)
    {
        var until = DateTime.UtcNow + TimeSpan.FromSeconds(10);
        while (!condition())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException("Condition not met in time.");
            await Task.Delay(10);
        }
    }
}
