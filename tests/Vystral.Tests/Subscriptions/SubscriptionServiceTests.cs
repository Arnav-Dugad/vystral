using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Vystral.Core.Domain;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;
using Vystral.Windows.Subscriptions;
using Xunit;

namespace Vystral.Tests.Subscriptions;

/// <summary>Track V: the subscription service end to end against the captured fixtures (nothing reaches the network).</summary>
public sealed class SubscriptionServiceTests : IDisposable
{
    private sealed class Events : IEventSink
    {
        public List<(string Name, object? Payload)> All { get; } = [];
        public void Emit(string eventName, object? payload) { lock (All) All.Add((eventName, payload)); }
        public int Count(string name) { lock (All) return All.Count(e => e.Name == name); }
    }

    private const string PacificDrive = "9PNKG0WBL61W";
    private const string ClairObscur = "9PPT8K6GQHRZ";

    private readonly TestDb _t = new();
    private readonly SettingsService _settings;
    private readonly List<Uri> _sent = [];
    private readonly HttpClient _http;
    private readonly Events _events = new();
    private DateTimeOffset _now = new(2026, 10, 7, 12, 0, 0, TimeSpan.Zero);
    private Func<HttpRequestMessage, HttpResponseMessage>? _override;
    private SubscriptionService _svc;

    public SubscriptionServiceTests()
    {
        _settings = new SettingsService(_t.Repo);
        _http = new HttpClient(new FakeHandler(r =>
        {
            lock (_sent) _sent.Add(r.RequestUri!);
            return _override?.Invoke(r) ?? Answer(r);
        }));
        _svc = Create();
    }

    private string CachePath => Path.Combine(_t.Dir.Path, "subscriptions-cache.json");

    private SubscriptionService Create()
    {
        var svc = new SubscriptionService(_t.Repo, _settings, _http, _events, CachePath)
        {
            Clock = () => _now,
            TimeZone = TimeZoneInfo.Utc,
            Market = () => "US",
            ArtUrl = rel => "https://art.vystral.example/" + rel.Replace('\\', '/'),
        };
        svc.NoDelaysForTests();
        return svc;
    }

    public void Dispose()
    {
        _http.Dispose();
        _t.Dispose();
    }

    private static HttpResponseMessage Answer(HttpRequestMessage r)
    {
        var url = r.RequestUri!.AbsoluteUri;
        if (url.StartsWith("https://catalog.gamepass.com/subscriptions?", StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, SubscriptionParsingTests.Fixture("subs_lists.json"));
        if (url.Contains(SubscriptionCatalogClient.LeavingSoonSigl, StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, SubscriptionParsingTests.Fixture("sigl_leaving.json"));
        if (url.Contains(SubscriptionCatalogClient.RecentlyAddedSigl, StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, SubscriptionParsingTests.Fixture("sigl_recent.json"));
        if (url.Contains(SubscriptionCatalogClient.PopularSigl, StringComparison.Ordinal))
            return FakeHandler.Json(HttpStatusCode.OK, SubscriptionParsingTests.Fixture("sigl_popular.json"));
        if (url.StartsWith("https://displaycatalog.mp.microsoft.com/", StringComparison.Ordinal))
        {
            // Answer with whatever the fixtures know of the asked products (both fixtures parse with either template).
            var asked = System.Web.HttpUtility.ParseQueryString(r.RequestUri.Query)["bigIds"]!.Split(',').ToHashSet();
            var products = new JsonArray();
            foreach (var file in new[] { "dc_full_leaving.json", "dc_browse_recent.json" })
                foreach (var p in JsonNode.Parse(SubscriptionParsingTests.Fixture(file))!["Products"]!.AsArray())
                    if (asked.Contains(p!["ProductId"]!.GetValue<string>())) products.Add(p.DeepClone());
            return FakeHandler.Json(HttpStatusCode.OK, new JsonObject { ["Products"] = products }.ToJsonString());
        }
        return FakeHandler.Json(HttpStatusCode.NotFound, "{}");
    }

    private void Set(string key, JsonNode value) => Assert.Null(_settings.Set(key, value));

    private void Plans(string csv)
    {
        Set("subs.owned", JsonValue.Create(csv));
        Set("subs.asked", JsonValue.Create(true));
    }

    private string AddGame(PlatformId platform, string id, string title)
    {
        _t.Repo.ApplyScan([TestDb.Ok(platform, TestDb.Install(platform, id, title, steamAppId: platform == PlatformId.Steam ? id : null))]);
        return _t.Repo.LoadSnapshot((_, _) => null).Games.Single(g => g.Title == title).Id;
    }

    [Fact]
    public async Task Off_by_default_sends_nothing()
    {
        Assert.False(_svc.CatalogOn);
        Plans("gp-ultimate");
        Assert.Empty(_svc.Map());
        Assert.Empty(_svc.Included());
        Assert.Equal("off", _svc.Status().State);
        var ex = await Assert.ThrowsAsync<DataSourceException>(() => _svc.RefreshAsync(manual: true, CancellationToken.None));
        Assert.Equal(DataSourceOutcome.Disabled, ex.Outcome);
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task Offline_mode_and_plans_without_lists_send_nothing()
    {
        Set("subs.catalog", JsonValue.Create(true));
        Plans("humble-choice,prime-gaming");
        Assert.Equal("noPlans", _svc.Status().State);
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        Assert.Empty(_sent);

        Plans("gp-pc");
        Set("privacy.localOnly", JsonValue.Create(true));
        var ex = await Assert.ThrowsAsync<DataSourceException>(() => _svc.RefreshAsync(manual: true, CancellationToken.None));
        Assert.Equal(DataSourceOutcome.Offline, ex.Outcome);
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task Refresh_matches_library_games_to_plans_and_marks_leaving_games()
    {
        var pacific = AddGame(PlatformId.Xbox, "KeplerInteractive.PacificDrive_ymj30pw7xe604", "Pacific Drive");
        var clair = AddGame(PlatformId.Steam, "1903340", "Clair Obscur: Expedition 33");
        var other = AddGame(PlatformId.Steam, "220", "Half-Life 2");
        Set("subs.catalog", JsonValue.Create(true));
        Plans("gp-pc");

        var status = await _svc.RefreshAsync(manual: true, CancellationToken.None);
        Assert.Equal("ok", status.State);
        Assert.Equal(9, status.Leaving);
        var pc = Assert.Single(status.Counts);
        Assert.True(pc.HasList);
        Assert.Equal(2, pc.InLibrary);

        var map = _svc.Map();
        var p = Assert.Single(map[pacific]);
        Assert.Equal("gp-pc", p.Plan);
        Assert.Equal("store", p.Match); // the Xbox copy's package family name, read from the Store's full answer
        Assert.True(p.Leaving);
        Assert.Equal(new DateTimeOffset(2026, 10, 16, 9, 59, 59, TimeSpan.Zero), DateTimeOffset.Parse(p.LeavingEnd!));
        var c = Assert.Single(map[clair]);
        Assert.Equal("title", c.Match); // a Steam copy: likely, by title
        Assert.False(map.ContainsKey(other));

        // Every request went to the expected public hosts, without cookies (the handler has none) and over https.
        Assert.All(_sent, u => Assert.Contains(u.Host, new[] { "catalog.gamepass.com", "displaycatalog.mp.microsoft.com" }));
        Assert.All(_sent, u => Assert.Equal("https", u.Scheme));
    }

    [Fact]
    public async Task Home_row_lists_included_games_you_do_not_own_leaving_first()
    {
        AddGame(PlatformId.Steam, "1903340", "Clair Obscur: Expedition 33");
        Set("subs.catalog", JsonValue.Create(true));
        Plans("gp-pc");
        await _svc.RefreshAsync(manual: true, CancellationToken.None);

        var picks = _svc.Included();
        Assert.NotEmpty(picks);
        Assert.DoesNotContain(picks, x => x.ProductId == ClairObscur); // owned (by title)
        Assert.Equal("leaving", picks[0].Reason);
        Assert.Contains(picks, x => x.Reason == "new" && x.Title == "Gears of War: E-Day");
        Assert.All(picks, x => Assert.Equal("PC Game Pass", x.PlanName));
        Assert.True(picks.Count <= SubscriptionService.Picks);
        Assert.True(_svc.IsKnownProduct(picks[0].ProductId));
        Assert.False(_svc.IsKnownProduct("9ZZZZZZZZZZZ"));
        Assert.False(_svc.IsKnownProduct("../../x"));
    }

    [Fact]
    public async Task Leaving_notification_waits_for_a_few_days_before_and_is_sent_once()
    {
        AddGame(PlatformId.Xbox, "KeplerInteractive.PacificDrive_ymj30pw7xe604", "Pacific Drive");
        Set("subs.catalog", JsonValue.Create(true));
        Plans("gp-ultimate");
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        Assert.Equal(0, _events.Count("subs.leaving")); // 16 Oct is 9 days away

        _now = new DateTimeOffset(2026, 10, 13, 9, 0, 0, TimeSpan.Zero);
        _svc.CheckLeaving();
        Assert.Equal(1, _events.Count("subs.leaving"));
        var payload = JsonSerializer.SerializeToElement(_events.All.Last(e => e.Name == "subs.leaving").Payload, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal("Pacific Drive", payload.GetProperty("items")[0].GetProperty("title").GetString());

        _svc.CheckLeaving();
        // A restart reads the cache file: still only once.
        _svc = Create();
        _svc.CheckLeaving();
        Assert.Equal(1, _events.Count("subs.leaving"));
    }

    [Fact]
    public async Task Leaving_notifications_respect_the_setting_and_need_game_pass()
    {
        AddGame(PlatformId.Xbox, "KeplerInteractive.PacificDrive_ymj30pw7xe604", "Pacific Drive");
        Set("subs.catalog", JsonValue.Create(true));
        Plans("gp-pc");
        Set("subs.leavingNotify", JsonValue.Create(false));
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        _now = new DateTimeOffset(2026, 10, 15, 9, 0, 0, TimeSpan.Zero);
        _svc.CheckLeaving();
        Assert.Equal(0, _events.Count("subs.leaving"));
        Set("subs.leavingNotify", JsonValue.Create(true));
        Plans("ea-play");
        _svc.CheckLeaving();
        Assert.Equal(0, _events.Count("subs.leaving"));
    }

    [Fact]
    public async Task Refresh_is_daily_and_backs_off_after_errors_keeping_the_last_copy()
    {
        var pacific = AddGame(PlatformId.Xbox, "KeplerInteractive.PacificDrive_ymj30pw7xe604", "Pacific Drive");
        Set("subs.catalog", JsonValue.Create(true));
        Plans("gp-pc");
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        var listCalls = _sent.Count(u => u.AbsolutePath == "/subscriptions");
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        Assert.Equal(listCalls, _sent.Count(u => u.AbsolutePath == "/subscriptions")); // once a day
        Assert.NotNull(_svc.Status().NextRefreshAt);

        _now = _now.AddDays(1.1);
        _override = r => r.RequestUri!.AbsolutePath == "/subscriptions" ? FakeHandler.Json(HttpStatusCode.ServiceUnavailable, "{}") : null!;
        var status = await _svc.RefreshAsync(manual: true, CancellationToken.None);
        Assert.Equal("stale", status.State);
        Assert.NotNull(status.Error);
        Assert.Single(_svc.Map()[pacific]); // the last good copy is kept
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        Assert.Equal(listCalls + 1, _sent.Count(u => u.AbsolutePath == "/subscriptions")); // not asked again during the back-off
    }

    [Fact]
    public async Task Value_counts_this_months_time_in_plan_games_and_cost_per_hour_only_with_a_price()
    {
        var pacific = AddGame(PlatformId.Xbox, "KeplerInteractive.PacificDrive_ymj30pw7xe604", "Pacific Drive");
        var other = AddGame(PlatformId.Steam, "220", "Half-Life 2");
        Set("subs.catalog", JsonValue.Create(true));
        Plans("gp-pc");
        await _svc.RefreshAsync(manual: true, CancellationToken.None);
        foreach (var (game, start, secs) in new[] { (pacific, _now.AddDays(-2), 5400), (pacific, _now.AddDays(-1), 1800), (other, _now.AddDays(-1), 9000), (pacific, _now.AddDays(-40), 9000) })
        {
            var id = _t.Repo.StartSession(game, null, start);
            _t.Repo.EndSession(id, start.AddSeconds(secs), secs, null);
        }
        var v = _svc.Value();
        Assert.Equal(7200, v.Seconds);
        Assert.Equal(1, v.Games);
        Assert.Null(v.CostPerHour);
        Assert.Equal("Pacific Drive", Assert.Single(v.Top).Title);

        Set("subs.price", JsonValue.Create(12.0));
        Set("subs.currency", JsonValue.Create("GBP"));
        v = _svc.Value();
        Assert.Equal(6.0, v.CostPerHour); // 12 ÷ 2 h
        Assert.Equal("GBP", v.Currency);
    }

    [Fact]
    public void A_corrupt_or_hostile_cache_file_is_ignored_or_cleaned()
    {
        File.WriteAllText(CachePath, "{ not json");
        Assert.Empty(Create().Map());
        File.WriteAllText(CachePath, """
            {"market":"US","listsAt":"2026-10-07T00:00:00Z","lists":{"pc":["9PNKG0WBL61W","bad id"],"evil":["9PNKG0WBL61W"]},
             "products":{"9PNKG0WBL61W":{"title":"Pacific Drive","poster":"https://evil.example/x.jpg","art":"..\\..\\secret.jpg","at":"2026-10-07T00:00:00Z"},"bad":{"at":"2026-10-07T00:00:00Z"}}}
            """);
        var clean = SubscriptionCache.Load(CachePath);
        Assert.Equal(["9PNKG0WBL61W"], clean.Lists["pc"]);
        Assert.False(clean.Lists.ContainsKey("evil"));
        var p = Assert.Single(clean.Products).Value;
        Assert.Null(p.Poster);
        Assert.Null(p.Art);
    }
}
