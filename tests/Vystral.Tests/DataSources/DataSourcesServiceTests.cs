using System.Net;
using System.Text.Json.Nodes;
using Dapper;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.DataSources;

public sealed class DataSourcesServiceTests : IDisposable
{
    private readonly TestDb _t = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly List<HttpRequestMessage> _sent = [];
    private Func<HttpRequestMessage, HttpResponseMessage> _respond = _ => FakeHandler.Json(HttpStatusCode.NotFound, "{}");
    private readonly HttpClient _http;
    private readonly SettingsService _settings;
    private readonly ArtworkService _art;
    private readonly DataSourcesService _svc;

    public DataSourcesServiceTests()
    {
        _http = new HttpClient(new FakeHandler(r => { lock (_sent) _sent.Add(r); return _respond(r); }));
        _settings = new SettingsService(_t.Repo);
        _art = new ArtworkService(new AppPaths(Path.Combine(_t.Dir.Path, "data")), _t.Repo, _http);
        _svc = new DataSourcesService(_t.Repo, _settings, _art, _secrets, _http);
        foreach (var id in new[] { "steamgriddb", "igdb", "rawg", "itad", "cheapshark", "wikidata", "steamdeck", "awacy" })
            _svc.Transport(id).Delay = (_, _) => Task.CompletedTask;
    }

    public void Dispose()
    {
        _http.Dispose();
        _t.Dispose();
    }

    private string SteamGame(string appId = "620", string title = "Portal 2")
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, appId, title, steamAppId: appId))]);
        return _t.Repo.LoadSnapshot((_, _) => null).Games.Single(g => g.Title == title).Id;
    }

    // ---------- Keys: stored only after the provider accepts them ----------

    [Fact]
    public async Task Connect_stores_the_key_only_when_the_provider_accepts_it()
    {
        _respond = _ => FakeHandler.Json(HttpStatusCode.Unauthorized, """{"success":false,"errors":["Authentication Required"]}""");
        var bad = await _svc.ConnectAsync("steamgriddb", "0123456789abcdef0123456789abcdef", null, CancellationToken.None);
        Assert.Equal("invalidKey", bad.Result.Outcome);
        Assert.Empty(_secrets.Items);
        Assert.False(bad.Status.Providers.Single(p => p.Id == "steamgriddb").Configured);

        _respond = r =>
        {
            Assert.Equal("Bearer", r.Headers.Authorization?.Scheme);
            return FakeHandler.Json(HttpStatusCode.OK, """{"success":true,"data":[{"id":1,"name":"Portal"}]}""");
        };
        var ok = await _svc.ConnectAsync("steamgriddb", "0123456789abcdef0123456789abcdef", null, CancellationToken.None);
        Assert.Equal("ok", ok.Result.Outcome);
        Assert.Equal("0123456789abcdef0123456789abcdef", _secrets.Items["VYSTRAL/SteamGridDB"]);
        var status = ok.Status.Providers.Single(p => p.Id == "steamgriddb");
        Assert.True(status.Configured);
        Assert.Equal("••••cdef", status.KeyMasked);
        // The key never appears in anything the page receives or in the database.
        Assert.DoesNotContain("0123456789abcdef0123456789abcdef", System.Text.Json.JsonSerializer.Serialize(ok));
        using var conn = _t.Db.Open();
        Assert.Equal(0, conn.ExecuteScalar<int>("SELECT COUNT(*) FROM settings WHERE value LIKE '%0123456789abcdef0123456789abcdef%'"));

        var after = _svc.Disconnect("steamgriddb");
        Assert.Empty(_secrets.Items);
        Assert.False(after.Providers.Single(p => p.Id == "steamgriddb").Configured);
    }

    [Fact]
    public async Task Igdb_connect_uses_a_form_body_for_the_secret_and_keeps_the_token_in_memory()
    {
        _respond = r =>
        {
            if (r.RequestUri!.Host == "id.twitch.tv")
            {
                Assert.Equal("", r.RequestUri.Query); // secret is never in the URL
                var form = r.Content!.ReadAsStringAsync().Result;
                Assert.Contains("client_secret=zyxwvutsrqponmlkjihgfedcba9876", form);
                return FakeHandler.Json(HttpStatusCode.OK, """{"access_token":"tok0123456789abcdef","expires_in":5000000,"token_type":"bearer"}""");
            }
            Assert.Equal("abcdefghijklmnopqrstuvwxyz0123", r.Headers.GetValues("Client-ID").Single());
            Assert.Equal("tok0123456789abcdef", r.Headers.Authorization!.Parameter);
            return FakeHandler.Json(HttpStatusCode.OK, """[{"id":1}]""");
        };
        var r = await _svc.ConnectAsync("igdb", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", "zyxwvutsrqponmlkjihgfedcba9876", CancellationToken.None);
        Assert.Equal("ok", r.Result.Outcome);
        Assert.True(_svc.Igdb.HasToken);
        Assert.Equal("abcdefghijklmnopqrstuvwxyz0123\nzyxwvutsrqponmlkjihgfedcba9876", _secrets.Items["VYSTRAL/IGDB"]);
        Assert.DoesNotContain(_secrets.Items.Values, v => v.Contains("tok0123456789abcdef"));
        _svc.Disconnect("igdb");
        Assert.False(_svc.Igdb.HasToken);
    }

    [Fact]
    public async Task Offline_mode_blocks_every_request()
    {
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        var r = await _svc.ConnectAsync("rawg", "0123456789abcdef0123456789abcdef", null, CancellationToken.None);
        Assert.Equal("offline", r.Result.Outcome);
        var game = SteamGame();
        var deals = await _svc.GetDealsAsync(game, refresh: false, CancellationToken.None);
        Assert.All(deals.Quotes, q => Assert.Empty(q.Offers));
        var compat = await _svc.GetCompatAsync(game, CancellationToken.None);
        Assert.Equal("offline", compat.DeckReason);
        await Assert.ThrowsAsync<DataSourceException>(() => _svc.RefreshPricesAsync(CancellationToken.None));
        Assert.Empty(_sent);
    }

    // ---------- Prices: on demand, cached ----------

    [Fact]
    public async Task Deals_are_cached_for_six_hours()
    {
        var game = SteamGame();
        _respond = r => r.RequestUri!.PathAndQuery switch
        {
            var p when p.Contains("steamAppID=620") => FakeHandler.Json(HttpStatusCode.OK, ProviderParsingTests.Fixture("cheapshark_lookup_620.json")),
            var p when p.EndsWith("/stores") => FakeHandler.Json(HttpStatusCode.OK, ProviderParsingTests.Fixture("cheapshark_stores.json")),
            _ => FakeHandler.Json(HttpStatusCode.OK, ProviderParsingTests.Fixture("cheapshark_game.json")),
        };
        var first = await _svc.GetDealsAsync(game, false, CancellationToken.None);
        var quote = Assert.Single(first.Quotes);
        Assert.Equal("cheapshark", quote.Provider);
        Assert.NotEmpty(quote.Offers);
        var calls = _sent.Count;
        var second = await _svc.GetDealsAsync(game, false, CancellationToken.None);
        Assert.Equal(calls, _sent.Count);
        Assert.Equal(quote.Offers.Count, second.Quotes[0].Offers.Count);
        // The page only gets an opaque offer ID; the link is looked up natively.
        Assert.StartsWith("https://www.cheapshark.com/redirect?dealID=", _svc.OfferUrl(game, quote.Offers[0].Id));
        Assert.Null(_svc.OfferUrl(game, "0000000000000000"));
        Assert.All(_sent, r => Assert.Equal("www.cheapshark.com", r.RequestUri!.Host));
    }

    [Fact]
    public async Task Deals_need_a_steam_appid()
    {
        var id = _t.Repo.AddManualGame("Lumen Garden", @"C:\Games\lumen\lumen.exe", null);
        var deals = await _svc.GetDealsAsync(id, false, CancellationToken.None);
        Assert.Equal("noSteamId", deals.Reason);
        Assert.Empty(_sent);
    }

    // ---------- Identity ----------

    [Fact]
    public async Task Identity_is_fetched_once_and_suggests_but_never_merges_duplicates()
    {
        var steamGame = SteamGame("1086940", "Baldur's Gate 3");
        // A deliberately different title, so only Wikidata links the two.
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Gog, TestDb.Install(PlatformId.Gog, "1456460669", "BG3 Digital Deluxe (GOG)"))]);
        var json = ProviderParsingTests.Fixture("wikidata_steam_batch.json").Replace("\"v_gog\" : {", "\"v_gogId\" : {\"type\":\"literal\",\"value\":\"1456460669\"}, \"v_gog\" : {");
        _respond = r =>
        {
            Assert.Equal("query.wikidata.org", r.RequestUri!.Host);
            return FakeHandler.Json(HttpStatusCode.OK, json);
        };
        var identity = await _svc.GetIdentityAsync(steamGame, false, CancellationToken.None);
        Assert.Equal("Q64441774", identity.WikidataId);
        Assert.Contains(identity.Ids, i => i.Name == "gog" && i.Platform == "gog" && i.Link);
        Assert.Equal("https://www.gog.com/en/game/baldurs_gate_iii", _svc.IdentityUrl(steamGame, "gog"));
        var calls = _sent.Count;
        await _svc.GetIdentityAsync(steamGame, false, CancellationToken.None);
        Assert.Equal(calls, _sent.Count); // cached

        var snap = _t.Repo.LoadSnapshot((_, _) => null);
        Assert.Equal(2, snap.Games.Count); // not merged
        Assert.Contains(snap.DuplicateSuggestions, s => s.Explanation.Contains("Wikidata", StringComparison.Ordinal));
    }

    // ---------- Compatibility ----------

    [Fact]
    public async Task Deck_report_follows_the_fetch_details_switch_and_is_cached()
    {
        var game = SteamGame("1245620", "ELDEN RING");
        _respond = r => r.RequestUri!.Host switch
        {
            "store.steampowered.com" => FakeHandler.Json(HttpStatusCode.OK, ProviderParsingTests.Fixture("steam_deck_verified.json")),
            _ => FakeHandler.Json(HttpStatusCode.OK, ProviderParsingTests.Fixture("awacy_subset.json")),
        };
        var compat = await _svc.GetCompatAsync(game, CancellationToken.None);
        Assert.Equal("verified", compat.Deck!.Category);
        Assert.NotEmpty(compat.Deck.Tests);
        var deckCalls = _sent.Count(r => r.RequestUri!.Host == "store.steampowered.com");
        await _svc.GetCompatAsync(game, CancellationToken.None);
        Assert.Equal(deckCalls, _sent.Count(r => r.RequestUri!.Host == "store.steampowered.com"));

        _settings.Set("library.fetchMetadata", JsonValue.Create(false));
        Assert.Equal("disabled", (await _svc.GetCompatAsync(game, CancellationToken.None)).DeckReason);
    }

    [Fact]
    public async Task Anti_cheat_list_maps_to_library_games()
    {
        var apex = SteamGame("1172470", "Apex Legends");
        _respond = _ => FakeHandler.Json(HttpStatusCode.OK, ProviderParsingTests.Fixture("awacy_subset.json"));
        Assert.True(await _svc.RefreshAntiCheatAsync(force: true, CancellationToken.None) >= 50);
        var map = _svc.AntiCheatMap();
        Assert.True(map[apex].Kernel);
        Assert.Contains("Easy Anti-Cheat", map[apex].Names);
        Assert.Contains("Linux", map[apex].StatusLabel);
        _settings.Set("dataSources.antiCheat", JsonValue.Create(false));
        Assert.Empty(_svc.AntiCheatMap());
    }

    // ---------- Value timeline ----------

    [Fact]
    public async Task Value_timeline_uses_current_steam_prices_with_their_provenance()
    {
        var portal = SteamGame("620", "Portal 2");
        SteamGame("440", "Team Fortress 2");
        _t.Repo.AddManualGame("Lumen Garden", @"C:\Games\lumen\lumen.exe", null);
        _respond = r =>
        {
            Assert.Contains("filters=price_overview", r.RequestUri!.Query);
            Assert.Contains("cc=US", r.RequestUri.Query);
            return FakeHandler.Json(HttpStatusCode.OK, ProviderParsingTests.Fixture("steam_prices.json"));
        };
        var value = await _svc.RefreshPricesAsync(CancellationToken.None);
        Assert.Equal("USD", value.Currency);
        Assert.Equal(1, value.Priced);
        Assert.Equal(2, value.Unpriced);
        var p = value.Games.Single(g => g.GameId == portal);
        Assert.True(p.PriceCents > 0);
        Assert.Equal("firstSeen", p.SinceSource);
        Assert.True(value.Games.Single(g => g.Title == "Team Fortress 2").NotSold);
        var calls = _sent.Count;
        await _svc.RefreshPricesAsync(CancellationToken.None);
        Assert.Equal(calls, _sent.Count); // fresh for a day
    }

    // ---------- Enrichment ----------

    [Fact]
    public async Task Enrichment_fills_only_missing_fields_and_records_their_source()
    {
        var game = SteamGame();
        _t.Repo.SetMetadata(game, "Steam Store (app 620)", "Steam's own description", null, null, null, []);
        _secrets.Items["VYSTRAL/IGDB"] = "abcdefghijklmnopqrstuvwxyz0123\nzyxwvutsrqponmlkjihgfedcba9876";
        _respond = r =>
        {
            if (r.RequestUri!.Host == "id.twitch.tv") return FakeHandler.Json(HttpStatusCode.OK, """{"access_token":"tok0123456789abcdef","expires_in":5000000}""");
            var body = r.Content!.ReadAsStringAsync().Result;
            return r.RequestUri.AbsolutePath switch
            {
                "/v4/external_games" => FakeHandler.Json(HttpStatusCode.OK, """[{"game":72,"uid":"620"}]"""),
                "/v4/game_time_to_beats" => FakeHandler.Json(HttpStatusCode.OK, """[{"game_id":72,"hastily":28800,"normally":36000,"completely":72000,"count":40}]"""),
                _ when body.Contains("where id = 72") => FakeHandler.Json(HttpStatusCode.OK, """
                    [{"id":72,"name":"Portal 2","url":"https://www.igdb.com/games/portal-2","summary":"IGDB summary","first_release_date":1303171200,
                      "genres":[{"name":"Puzzle"}],"themes":[{"name":"Science fiction"}],
                      "involved_companies":[{"company":{"name":"Valve"},"developer":true,"publisher":true}],"aggregated_rating":95}]
                    """),
                _ => FakeHandler.Json(HttpStatusCode.OK, "[]"),
            };
        };
        var changed = await _svc.Enrichment.RunAsync(10, () => false, CancellationToken.None);
        Assert.Equal(1, changed);
        var g = _t.Repo.GetGame(game)!;
        Assert.Equal("Steam's own description", g.Description); // never overwritten
        Assert.Equal("Valve", g.Developer);
        Assert.Equal(["Puzzle"], g.Genres);
        var sources = _t.Repo.GetFieldSources(game);
        Assert.Equal("igdb", sources["developer"]);
        Assert.False(sources.ContainsKey("description"));
        var details = _svc.GetEnrichment(game);
        var igdb = Assert.Single(details.Sources);
        Assert.Equal("steam-appid", igdb.MatchMethod);
        Assert.Equal(36000, igdb.Facts!.Value.GetProperty("timeToBeat").GetProperty("normally").GetInt64());
        Assert.Equal("https://www.igdb.com/games/portal-2", igdb.Url);

        // A second run doesn't ask again (the answer is fresh).
        var calls = _sent.Count;
        Assert.Equal(0, await _svc.Enrichment.RunAsync(10, () => false, CancellationToken.None));
        Assert.Equal(calls, _sent.Count);
    }

    [Fact]
    public void User_set_fields_are_never_filled_by_a_provider()
    {
        var game = SteamGame();
        using (var conn = _t.Db.Open())
            conn.Execute("INSERT INTO game_field_sources(game_id, field, source, updated) VALUES (@game, 'developer', 'user', 'now')", new { game });
        var filled = _t.Repo.ApplyEnrichedFields(game, "rawg", "1", "exact-title", 0.85, new EnrichedFields("Desc", "Someone", "Pub", "2011", ["Puzzle"]));
        Assert.DoesNotContain("developer", filled);
        Assert.Contains("publisher", filled);
        Assert.Null(_t.Repo.GetGame(game)!.Developer);
    }

    // ---------- Art picker ----------

    [Fact]
    public async Task Picked_art_becomes_user_art_that_scans_never_replace_and_reset_restores()
    {
        var game = SteamGame();
        _secrets.Items["VYSTRAL/SteamGridDB"] = "0123456789abcdef0123456789abcdef";
        var png = new byte[8000];
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49 }.CopyTo(png, 0);
        _respond = r => r.RequestUri!.Host switch
        {
            "cdn2.steamgriddb.com" => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(png) { Headers = { ContentType = new("image/png") } } },
            _ when r.RequestUri.AbsolutePath.StartsWith("/api/v2/games/steam/620") => FakeHandler.Json(HttpStatusCode.OK, """{"success":true,"data":{"id":17830,"name":"Portal 2"}}"""),
            _ => FakeHandler.Json(HttpStatusCode.OK, """
                {"success":true,"data":[{"id":101,"style":"alternate","width":600,"height":900,"mime":"image/png",
                  "url":"https://cdn2.steamgriddb.com/grid/abc.png","thumb":"https://cdn2.steamgriddb.com/thumb/abc.png","author":{"name":"Artist"}}]}
                """),
        };
        var options = await _svc.GetArtOptionsAsync(game, ArtworkKind.Cover, ["alternate"], false, 0, null, CancellationToken.None);
        Assert.Equal("steam", options.MatchedBy);
        var item = Assert.Single(options.Items);
        Assert.Null(item.Thumb);
        var thumb = await _svc.GetArtThumbAsync(game, ArtworkKind.Cover, item.Id, false, CancellationToken.None);
        Assert.StartsWith("https://art.vystral.example/_thumbs/sgdb/", thumb);
        Assert.True(await _svc.ApplyArtAsync(game, ArtworkKind.Cover, item.Id, CancellationToken.None));
        Assert.Equal("steamgriddb", _t.Repo.UserArtwork(game)["cover"]);
        Assert.Equal("Artist", _svc.UserArt(game).Single().Author);

        // A later scan or CDN fetch can't replace the user's choice.
        _t.Repo.SetArtwork(game, ArtworkKind.Cover, "other.jpg", "steam-cdn", isUser: false);
        Assert.True(_t.Repo.GetArtwork(game)["cover"].IsUser);

        Assert.True(_t.Repo.ResetUserArtwork(game, ArtworkKind.Cover));
        Assert.False(_t.Repo.GetArtwork(game).ContainsKey("cover"));
        Assert.Empty(_t.Repo.UserArtwork(game));

        // Unknown option IDs are refused (the page never sends URLs).
        await Assert.ThrowsAsync<DataSourceException>(() => _svc.ApplyArtAsync(game, ArtworkKind.Cover, "999", CancellationToken.None));
    }

    [Fact]
    public async Task Data_saver_pauses_previews_unless_asked()
    {
        var game = SteamGame();
        _secrets.Items["VYSTRAL/SteamGridDB"] = "0123456789abcdef0123456789abcdef";
        _art.SkipDownloads = () => true;
        _respond = r => r.RequestUri!.AbsolutePath.StartsWith("/api/v2/games/")
            ? FakeHandler.Json(HttpStatusCode.OK, """{"success":true,"data":{"id":1,"name":"Portal 2"}}""")
            : FakeHandler.Json(HttpStatusCode.OK, """{"success":true,"data":[{"id":5,"url":"https://cdn2.steamgriddb.com/grid/a.png","thumb":"https://cdn2.steamgriddb.com/thumb/a.png"}]}""");
        var options = await _svc.GetArtOptionsAsync(game, ArtworkKind.Hero, [], false, 0, null, CancellationToken.None);
        Assert.True(options.PreviewsPaused);
        var ex = await Assert.ThrowsAsync<DataSourceException>(() => _svc.GetArtThumbAsync(game, ArtworkKind.Hero, "5", false, CancellationToken.None));
        Assert.Equal(DataSourceOutcome.Disabled, ex.Outcome);
    }

    [Fact]
    public async Task Rate_limits_pause_the_provider()
    {
        _secrets.Items["VYSTRAL/RAWG"] = "0123456789abcdef0123456789abcdef";
        _respond = _ => new HttpResponseMessage(HttpStatusCode.TooManyRequests) { Headers = { RetryAfter = new(TimeSpan.FromSeconds(120)) }, Content = new StringContent("") };
        var r = await _svc.TestAsync("rawg", CancellationToken.None);
        Assert.Equal("rateLimited", r.Result.Outcome);
        Assert.NotNull(r.Status.Providers.Single(p => p.Id == "rawg").PausedUntil);
        var calls = _sent.Count;
        var again = await _svc.TestAsync("rawg", CancellationToken.None);
        Assert.Equal("rateLimited", again.Result.Outcome);
        Assert.Equal(calls, _sent.Count); // not even sent
    }
}

/// <summary>Migration 6 on a real version-5 database keeps everything.</summary>
public sealed class Migration6Tests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Upgrading_a_v5_database_keeps_data_and_adds_the_new_tables()
    {
        var path = Path.Combine(_dir.Path, "v5.db");
        var db = new Database(path);
        using (var conn = db.Open())
        {
            conn.Execute("PRAGMA journal_mode = WAL;");
            conn.Execute("CREATE TABLE schema_version (version INTEGER NOT NULL, applied TEXT NOT NULL, name TEXT NOT NULL);");
            foreach (var (version, name, sql) in Migrations.All.Where(m => m.Version <= 5))
            {
                conn.Execute(sql);
                conn.Execute("INSERT INTO schema_version VALUES (@version, 'then', @name)", new { version, name });
            }
            conn.Execute("""
                INSERT INTO games(id, title, sort_title, description, steam_app_id, added, updated) VALUES ('g1', 'Portal 2', 'portal 2', 'Keep me', '620', '2024-01-01T00:00:00Z', 'x');
                INSERT INTO artwork(game_id, kind, file, source, is_user, updated) VALUES ('g1', 'cover', 'g1/cover.png', 'user', 1, 'x');
                INSERT INTO settings(key, value) VALUES ('appearance.theme', '"oled"');
                """);
        }
        Assert.Equal(5, db.Migrate());
        using (var conn = db.Open())
        {
            Assert.Equal(6L, conn.ExecuteScalar<long>("SELECT MAX(version) FROM schema_version"));
            Assert.Equal("Keep me", conn.ExecuteScalar<string>("SELECT description FROM games WHERE id='g1'"));
            Assert.Equal(1L, conn.ExecuteScalar<long>("SELECT is_user FROM artwork WHERE game_id='g1'"));
            var tables = conn.Query<string>("SELECT name FROM sqlite_master WHERE type='table'").ToHashSet();
            foreach (var t in new[] { "external_ids", "game_field_sources", "game_enrichment", "provider_cache", "anticheat_games" }) Assert.Contains(t, tables);
        }
        Assert.True(Directory.EnumerateFiles(Path.Combine(_dir.Path, "backups"), "pre-migration-v5-*.db").Any());
        var repo = new LibraryRepository(db);
        Assert.Equal("Keep me", repo.LoadSnapshot((_, _) => null).Games.Single().Description);
        TestDb.ReleasePool(db);
    }

    [Fact]
    public void Migrations_stay_sorted_and_contiguous() =>
        Assert.Equal(Enumerable.Range(1, Migrations.All.Count), Migrations.All.Select(m => m.Version));

    [Fact]
    public void Provider_cache_expires_and_external_ids_round_trip()
    {
        using var t = new TestDb();
        t.Repo.SetProviderCache("p", "k", "{\"a\":1}", TimeSpan.FromHours(1));
        Assert.True(t.Repo.GetProviderCache("p", "k")!.Value.Fresh);
        t.Repo.SetProviderCache("p", "old", "{}", TimeSpan.FromSeconds(-1));
        Assert.False(t.Repo.GetProviderCache("p", "old")!.Value.Fresh);
        Assert.Equal(2, t.Repo.ClearProviderCache("p"));
        t.Repo.UpsertExternalIds("steam", "620", "Q279446", "Portal 2", new Dictionary<string, string> { ["igdb"] = "portal-2" });
        Assert.Equal("portal-2", t.Repo.GetExternalIds("steam", "620")!.Ids["igdb"]);
        Assert.Null(t.Repo.GetExternalIds("steam", "1"));
    }
}
