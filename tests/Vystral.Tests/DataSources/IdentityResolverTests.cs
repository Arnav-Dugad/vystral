using System.Net;
using System.Text.Json.Nodes;
using Vystral.Core.Domain;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.DataSources;
using Vystral.Windows.DataSources.Identity;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.DataSources;

/// <summary>Track D4: merging evidence with confidence and conflicts, title matching, and the resolver end to end (fake network).</summary>
public sealed class IdentityMergeTests
{
    private static IdEvidence E(string kind, string value, string source, double c, string method = "exactTitleYear") => new(kind, value, source, method, c);

    [Fact]
    public void The_store_itself_is_certain_and_wins_over_any_match()
    {
        var (ids, _) = IdentityMerge.Merge([E("steam", "620", "store", 1, "native"), E("steam", "400", "wikidata", 0.85), E("steam", "400", "igdb", 0.85)]);
        var steam = Assert.Single(ids);
        Assert.Equal(("620", "native", 1.0), (steam.Value, steam.Status, steam.Confidence));
    }

    [Fact]
    public void Independent_sources_agreeing_add_up_but_the_same_source_counts_once()
    {
        var one = IdentityMerge.Merge([E("steam", "1145360", "steam", 0.7, "exactTitle")]).Ids.Single();
        Assert.Equal("suggested", one.Status);
        Assert.Equal(0.7, one.Confidence);

        var two = IdentityMerge.Merge([E("steam", "1145360", "steam", 0.7, "exactTitle"), E("steam", "1145360", "wikidata", 0.7, "exactTitle")]).Ids.Single();
        Assert.Equal("matched", two.Status);
        Assert.Equal(0.91, two.Confidence, 3);

        var same = IdentityMerge.Merge([E("steam", "1145360", "steam", 0.7, "exactTitle"), E("steam", "1145360", "steam", 0.6, "editionTitle")]).Ids.Single();
        Assert.Equal(0.7, same.Confidence);
        Assert.True(IdentityMerge.Combine([E("steam", "1", "a", 0.95), E("steam", "1", "b", 0.95), E("steam", "1", "c", 0.95)]) <= 0.99);
    }

    [Fact]
    public void Two_plausible_values_are_a_conflict_and_neither_is_used()
    {
        var (ids, candidates) = IdentityMerge.Merge([E("steam", "100", "wikidata", 0.85), E("steam", "200", "steam", 0.85)]);
        var steam = Assert.Single(ids);
        Assert.Equal("conflict", steam.Status);
        Assert.Equal(2, candidates.Count(c => c.Kind == "steam"));
    }

    [Fact]
    public void A_weak_rival_costs_some_certainty_but_no_conflict()
    {
        var steam = IdentityMerge.Merge([E("steam", "100", "wikidata", 0.95, "storeId"), E("steam", "200", "steam", 0.3, "exactTitle")]).Ids.Single();
        Assert.Equal("100", steam.Value);
        Assert.Equal("matched", steam.Status);
        Assert.Equal(0.8, steam.Confidence, 3);
    }

    [Fact]
    public void Your_choice_is_final_including_not_on_steam()
    {
        var evidence = new[] { E("steam", "100", "wikidata", 0.85), E("steam", "200", "steam", 0.85), E("igdb", "77", "igdb", 0.85) };
        var pinned = IdentityMerge.Merge(evidence, new Dictionary<string, string?> { ["steam"] = "200" }).Ids;
        Assert.Equal(("200", "pinned", 1.0), (pinned.Single(i => i.Kind == "steam").Value, pinned.Single(i => i.Kind == "steam").Status, pinned.Single(i => i.Kind == "steam").Confidence));
        var none = IdentityMerge.Merge(evidence, new Dictionary<string, string?> { ["steam"] = null }).Ids;
        Assert.DoesNotContain(none, i => i.Kind == "steam");
        Assert.Contains(none, i => i.Kind == "igdb" && i.Status == "matched");
    }

    [Fact]
    public void Malformed_values_are_ignored()
    {
        var (ids, candidates) = IdentityMerge.Merge([E("steam", "abc", "steam", 0.9), E("steam", "0123", "steam", 0.9), E("wikidata", "Q0", "wikidata", 0.9),
            E("rawg", "Bad Slug", "rawg", 0.9), E("gog", "1207664663", "gog", double.NaN), E("unknown", "1", "x", 1)]);
        Assert.Empty(ids);
        Assert.Empty(candidates);
    }

    [Theory]
    [InlineData("Hades", 2020, "exactTitleYear", 0.85)]
    [InlineData("Hades", null, "exactTitle", 0.7)]
    [InlineData("HADES™", 2021, "exactTitleYear", 0.85)]
    public void Title_matches_need_a_unique_exact_title_and_an_agreeing_year(string title, int? year, string method, double conf)
    {
        var hits = new[] { ("Hades II", (int?)2025), ("Hades", (int?)2020), ("Hades Original Soundtrack", (int?)2020) };
        var pick = IdentityMerge.PickByTitle(title, year, hits, h => h.Item1, h => h.Item2);
        Assert.NotNull(pick);
        Assert.Equal(1, pick.Value.Index);
        Assert.Equal((method, conf), (pick.Value.Method, pick.Value.Confidence));
    }

    [Fact]
    public void Title_matches_refuse_other_years_and_ambiguity_and_discount_other_editions()
    {
        var remake = new[] { ("Resident Evil 4", (int?)2005), ("Resident Evil 4", (int?)2023) };
        Assert.Null(IdentityMerge.PickByTitle("Resident Evil 4", null, remake, h => h.Item1, h => h.Item2));
        Assert.Equal(1, IdentityMerge.PickByTitle("Resident Evil 4", 2023, remake, h => h.Item1, h => h.Item2)!.Value.Index);
        Assert.Null(IdentityMerge.PickByTitle("Hades", 2010, new[] { ("Hades", (int?)2020) }, h => h.Item1, h => h.Item2));
        var edition = IdentityMerge.PickByTitle("Control", 2019, new[] { ("Control Ultimate Edition", (int?)2020) }, h => h.Item1, h => h.Item2);
        Assert.Equal(("editionTitle", 0.75), (edition!.Value.Method, edition.Value.Confidence));
        Assert.Null(IdentityMerge.PickByTitle("Portal", null, new[] { ("Portal 2", (int?)2011) }, h => h.Item1, h => h.Item2));
    }

    [Fact]
    public void Cached_entries_can_never_claim_native_or_chosen()
    {
        var entry = IdentityResolverService.ReadEntry("""
            {"v":1,"titleKey":"hades","evidence":[
              {"kind":"steam","value":"1145360","source":"store","method":"native","confidence":1},
              {"kind":"steam","value":"1145360","source":"pin","method":"chosen","confidence":1},
              {"kind":"steam","value":"1145360","source":"steam","method":"exactTitleYear","confidence":0.99},
              {"kind":"steam","value":"1145360","source":"wikidata","method":"exactTitleYear","confidence":0.85,"name":"<b>Hades</b>","year":3000}],
             "asked":["wikidata","evil"],"steamUsed":"x"}
            """);
        Assert.NotNull(entry);
        var only = Assert.Single(entry.Evidence);
        Assert.Equal(("wikidata", "Hades", (int?)null), (only.Source, only.Name, only.Year));
        Assert.Equal(["wikidata"], entry.Asked);
        Assert.Null(entry.SteamUsed);
        Assert.Null(IdentityResolverService.ReadEntry("not json"));
        Assert.Null(IdentityResolverService.ReadPins("""{"steam":"abc"}"""));
        Assert.Equal(new Dictionary<string, string?> { ["steam"] = null }, IdentityResolverService.ReadPins("""{"steam":null,"evil":"1"}"""));
    }
}

public sealed class IdentityResolverServiceTests : IDisposable
{
    private readonly TestDb _t = new();
    private readonly List<Uri> _sent = [];
    private readonly HttpClient _http;
    private readonly SettingsService _settings;
    private readonly DataSourcesService _sources;
    private readonly IdentityResolverService _svc;
    private string _wikidataAnswer = Wikidata("Q1", "Hades", "2020-09-17", "1145360");
    private string _appDetailsYear = "Sep 17, 2020";

    public IdentityResolverServiceTests()
    {
        _http = new HttpClient(new FakeHandler(Respond));
        _settings = new SettingsService(_t.Repo);
        _settings.Set("dataSaver.onMetered", JsonValue.Create(false));
        var art = new ArtworkService(new AppPaths(Path.Combine(_t.Dir.Path, "data")), _t.Repo, _http);
        _sources = new DataSourcesService(_t.Repo, _settings, art, new FakeSecretStore(), _http);
        foreach (var id in new[] { "wikidata", "steamdeck", "gogcatalog", "igdb", "rawg" }) _sources.Transport(id).Delay = (_, _) => Task.CompletedTask;
        _svc = new IdentityResolverService(_t.Repo, _settings, _sources, _sources.GogCatalog);
    }

    public void Dispose()
    {
        _http.Dispose();
        _t.Dispose();
    }

    private static string Wikidata(string qid, string label, string date, string? steam) =>
        "{\"results\":{\"bindings\":[{\"item\":{\"value\":\"http://www.wikidata.org/entity/" + qid + "\"},\"lbl\":{\"value\":\"" + label +
        "\"},\"released\":{\"value\":\"" + date + "T00:00:00Z\"}" + (steam is null ? "" : ",\"v_steam\":{\"value\":\"" + steam + "\"}") + "}]}}";

    private HttpResponseMessage Respond(HttpRequestMessage r)
    {
        lock (_sent) _sent.Add(r.RequestUri!);
        var url = r.RequestUri!.AbsoluteUri;
        if (r.RequestUri.Host == "query.wikidata.org") return FakeHandler.Json(HttpStatusCode.OK, _wikidataAnswer);
        if (url.Contains("/api/storesearch/", StringComparison.Ordinal)) return FakeHandler.Json(HttpStatusCode.OK, TrackD4ParsingTests.Fixture("steam_storesearch_hades.json"));
        if (url.Contains("/api/appdetails", StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK,
                "{\"1145360\":{\"success\":true,\"data\":{\"type\":\"game\",\"name\":\"Hades\",\"steam_appid\":1145360,\"release_date\":{\"coming_soon\":false,\"date\":\"" + _appDetailsYear + "\"}}}}");
        return FakeHandler.Json(HttpStatusCode.NotFound, "{}");
    }

    private string XboxGame(string title = "Hades", string? release = "2020-09-17")
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Xbox, TestDb.Install(PlatformId.Xbox, "SupergiantGames.Hades", title))]);
        var id = _t.Repo.LoadSnapshot((_, _) => null).Games.Single(g => g.Title == title).Id;
        if (release is not null)
            _t.Repo.ApplyEnrichedFields(id, "igdb", "1", "exact-title", 0.9, new Vystral.Core.Data.EnrichedFields(null, null, null, release, []));
        return id;
    }

    [Fact]
    public async Task An_xbox_game_gets_its_steam_app_when_wikidata_and_steam_agree()
    {
        var gameId = XboxGame();
        Assert.Null(_svc.SteamAppFor(gameId));
        var dto = await _svc.GetAsync(gameId, allowNetwork: true, refresh: false, CancellationToken.None);
        Assert.Equal("matched", dto.Status);
        Assert.NotNull(dto.Steam);
        Assert.Equal("1145360", dto.Steam.Value);
        Assert.True(dto.Steam.Used);
        Assert.True(dto.Steam.Confidence >= 0.95);
        Assert.Contains(dto.Steam.Evidence, e => e.Source == "wikidata" && e.Method == "exactTitleYear");
        Assert.Contains(dto.Steam.Evidence, e => e.Source == "steam" && e.Method == "exactTitleYear");
        Assert.Contains(dto.Ids, i => i.Kind == "wikidata" && i.Value == "Q1");
        Assert.Equal(["wikidata", "steam"], dto.Asked);
        var app = _svc.SteamAppFor(gameId);
        Assert.Equal(("1145360", false, "matched"), (app!.AppId, app.Native, app.Status));
        Assert.Equal(gameId, _svc.MatchedSteamApps()["1145360"]);

        // Cached: a second visit asks nobody.
        var before = _sent.Count;
        await _svc.GetAsync(gameId, allowNetwork: true, refresh: false, CancellationToken.None);
        Assert.Equal(before, _sent.Count);
    }

    [Fact]
    public async Task Disagreeing_sources_are_a_conflict_until_you_choose()
    {
        _wikidataAnswer = Wikidata("Q2", "Hades", "2020-09-17", "755800");
        var gameId = XboxGame();
        var dto = await _svc.GetAsync(gameId, true, false, CancellationToken.None);
        Assert.Equal("conflict", dto.Status);
        Assert.False(dto.Steam!.Used);
        Assert.Null(_svc.SteamAppFor(gameId));
        Assert.Equal(2, dto.SteamCandidates.Count);

        var pinned = _svc.Pin(gameId, "steam", "1145360");
        Assert.Equal("pinned", pinned.Status);
        Assert.Equal(("1145360", "pinned"), (_svc.SteamAppFor(gameId)!.AppId, _svc.SteamAppFor(gameId)!.Status));

        var none = _svc.Pin(gameId, "steam", null);
        Assert.Equal("notOnSteam", none.Status);
        Assert.Null(_svc.SteamAppFor(gameId));
        Assert.Empty(_svc.MatchedSteamApps());

        var back = _svc.Unpin(gameId, "steam");
        Assert.Equal("conflict", back.Status);
        Assert.Throws<DataSourceException>(() => _svc.Pin(gameId, "steam", "not-an-id"));
    }

    [Fact]
    public async Task A_different_year_on_steam_means_a_different_game()
    {
        _wikidataAnswer = """{"results":{"bindings":[]}}""";
        _appDetailsYear = "Mar 1, 2004";
        var gameId = XboxGame();
        var dto = await _svc.GetAsync(gameId, true, false, CancellationToken.None);
        Assert.Equal("none", dto.Status);
        Assert.Null(dto.Steam);
    }

    [Fact]
    public async Task Without_a_year_a_single_source_is_only_a_suggestion()
    {
        _wikidataAnswer = """{"results":{"bindings":[]}}""";
        var gameId = XboxGame(release: null);
        var dto = await _svc.GetAsync(gameId, true, false, CancellationToken.None);
        Assert.Equal("suggested", dto.Status);
        Assert.False(dto.Steam!.Used);
        Assert.Equal("medium", dto.Steam.Level);
        Assert.Null(_svc.SteamAppFor(gameId));
    }

    [Fact]
    public async Task Offline_mode_matching_off_and_running_games_send_nothing()
    {
        var gameId = XboxGame();
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        Assert.Equal("offline", (await _svc.GetAsync(gameId, true, false, CancellationToken.None)).Reason);
        _settings.Set("privacy.localOnly", JsonValue.Create(false));
        _settings.Set(IdentityResolverService.SettingKey, JsonValue.Create(false));
        Assert.Equal("off", (await _svc.GetAsync(gameId, true, false, CancellationToken.None)).Reason);
        _settings.Set(IdentityResolverService.SettingKey, JsonValue.Create(true));
        _svc.IsGameActive = () => true;
        Assert.Equal("gameRunning", (await _svc.GetAsync(gameId, true, false, CancellationToken.None)).Reason);
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task With_every_source_off_nothing_is_asked_or_remembered()
    {
        var gameId = XboxGame();
        _settings.Set("dataSources.wikidata", JsonValue.Create(false));
        _settings.Set("library.fetchMetadata", JsonValue.Create(false));
        var dto = await _svc.GetAsync(gameId, true, false, CancellationToken.None);
        Assert.Equal("notChecked", dto.Status);
        Assert.Empty(_sent);
        Assert.Null(_t.Repo.GetProviderCache(IdentityResolverService.CacheProvider, gameId));
        // Turning a source on looks the game up straight away.
        _settings.Set("dataSources.wikidata", JsonValue.Create(true));
        Assert.Equal(["wikidata"], (await _svc.GetAsync(gameId, true, false, CancellationToken.None)).Asked);
    }

    [Fact]
    public async Task Turning_matching_off_stops_using_matches_but_keeps_your_choices()
    {
        var gameId = XboxGame();
        await _svc.GetAsync(gameId, true, false, CancellationToken.None);
        Assert.NotNull(_svc.SteamAppFor(gameId));
        _settings.Set(IdentityResolverService.SettingKey, JsonValue.Create(false));
        _svc.Invalidate(gameId);
        Assert.Null(_svc.SteamAppFor(gameId));
        _svc.Pin(gameId, "steam", "1145360");
        Assert.Equal("pinned", _svc.SteamAppFor(gameId)!.Status);
    }

    [Fact]
    public void A_steam_game_is_native_and_cant_be_pinned_to_another_app()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "620", "Portal 2", steamAppId: "620"))]);
        var id = _t.Repo.LoadSnapshot((_, _) => null).Games.Single().Id;
        Assert.Equal(("620", true), (_svc.SteamAppFor(id)!.AppId, _svc.SteamAppFor(id)!.Native));
        Assert.Throws<DataSourceException>(() => _svc.Pin(id, "steam", "400"));
    }
}
