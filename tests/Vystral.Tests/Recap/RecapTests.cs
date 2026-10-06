using System.Buffers.Binary;
using System.Text.Json;
using Dapper;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Recap;
using Xunit;

namespace Vystral.Tests.Recap;

/// <summary>Track M: sale calendar, backlog savings, anti-cheat notes, time to beat, the away query and replay images.</summary>
public sealed class SaleCalendarTests
{
    private const string Valid = """
        { "version": 3, "source": "Valve", "sourceUrl": "https://partner.steamgames.com/doc/marketing/upcoming_events", "retrieved": "2026-10-06",
          "sales": [
            { "id": "autumn-2026", "name": "Steam Autumn Sale", "start": "2026-10-01", "end": "2026-10-08" },
            { "id": "winter-2026", "name": "Steam Winter Sale", "start": "2026-12-17", "end": "2027-01-04" } ] }
        """;

    [Fact]
    public void Shipped_calendar_is_valid_cites_valve_and_is_ordered()
    {
        var c = SaleCalendar.Shipped;
        Assert.True(c.Version >= 1);
        Assert.StartsWith("https://partner.steamgames.com/", c.SourceUrl);
        Assert.NotEmpty(c.Sales);
        Assert.All(c.Sales, s => Assert.True(s.Start <= s.End));
        Assert.Equal(c.Sales.OrderBy(s => s.Start).Select(s => s.Id), c.Sales.Select(s => s.Id));
        Assert.Contains(c.Sales, s => s.Id == "winter-2026" && s.Start == new DateOnly(2026, 12, 17) && s.End == new DateOnly(2027, 1, 4));
    }

    [Fact]
    public void Forecast_reports_the_sale_on_now_and_the_next_one()
    {
        var c = SaleCalendar.Parse(Valid);
        var during = SaleCalendar.Forecast(c, new DateOnly(2026, 10, 6));
        Assert.Equal("autumn-2026", during.Current?.Id);
        Assert.Equal(2, during.DaysLeftInCurrent);
        Assert.Equal("winter-2026", during.Next?.Id);
        Assert.Equal(72, during.DaysUntilNext);
        Assert.False(during.Outdated);

        // Inclusive end date; the next sale starts strictly later.
        var lastDay = SaleCalendar.Forecast(c, new DateOnly(2026, 10, 8));
        Assert.Equal("autumn-2026", lastDay.Current?.Id);
        Assert.Equal(0, lastDay.DaysLeftInCurrent);

        var between = SaleCalendar.Forecast(c, new DateOnly(2026, 11, 1));
        Assert.Null(between.Current);
        Assert.Equal("winter-2026", between.Next?.Id);
        Assert.Equal("2026-12-17", between.Next?.Start);

        var startDay = SaleCalendar.Forecast(c, new DateOnly(2026, 12, 17));
        Assert.Equal("winter-2026", startDay.Current?.Id);
        Assert.Null(startDay.Next);
        Assert.False(startDay.Outdated);
    }

    [Fact]
    public void Forecast_never_guesses_past_the_announced_dates()
    {
        var f = SaleCalendar.Forecast(SaleCalendar.Parse(Valid), new DateOnly(2027, 2, 1));
        Assert.Null(f.Current);
        Assert.Null(f.Next);
        Assert.Null(f.DaysUntilNext);
        Assert.True(f.Outdated);
        Assert.Equal("2026-10-06", f.Retrieved);
        Assert.Equal(3, f.Version);
    }

    [Theory]
    [InlineData("\"end\": \"2027-01-04\"", "\"end\": \"2026-12-01\"")] // ends before it starts
    [InlineData("\"start\": \"2026-12-17\"", "\"start\": \"2026-10-05\"")] // overlaps the previous sale
    [InlineData("https://partner.steamgames.com/doc/marketing/upcoming_events", "https://example.com/sales")] // not Valve
    [InlineData("https://partner.steamgames.com/doc/marketing/upcoming_events", "http://partner.steamgames.com/doc")] // not https
    [InlineData("\"version\": 3", "\"version\": 0")]
    [InlineData("\"id\": \"winter-2026\"", "\"id\": \"autumn-2026\"")] // duplicate id (and overlap-free order kept)
    [InlineData("\"retrieved\": \"2026-10-06\"", "\"retrieved\": \"06/10/2026\"")]
    [InlineData("\"id\": \"winter-2026\"", "\"id\": \"Winter 2026!\"")]
    public void Invalid_calendars_are_rejected(string from, string to)
    {
        Assert.Throws<FormatException>(() => SaleCalendar.Parse(Valid.Replace(from, to)));
    }

    [Fact]
    public void Implausibly_long_sales_are_rejected()
    {
        Assert.Throws<FormatException>(() => SaleCalendar.Parse(Valid.Replace("\"end\": \"2027-01-04\"", "\"end\": \"2027-03-30\"")));
    }
}

public sealed class BacklogSavingsTests
{
    private static BacklogCandidateRow Game(string id, string? appId = "620") => new(id, $"Game {id}", appId, null, true);

    private static CachedQuote Quote(string provider, string currency, double? low, params double[] prices) =>
        new(provider, new PriceQuote(provider, currency, prices.Select((p, i) => new PriceOffer($"o{i}", $"Shop {i}", p, null, 0, currency, "https://example.com")).ToList(),
            low, "2025-11-27T00:00:00Z", null, DateTimeOffset.UtcNow), new DateTimeOffset(2026, 10, 1, 0, 0, 0, TimeSpan.Zero), false);

    [Fact]
    public void Saving_is_best_current_price_minus_the_historical_low()
    {
        var g = BacklogSavings.ForGame(Game("a"), [Quote("cheapshark", "USD", 4.99, 19.99, 14.99)]);
        Assert.NotNull(g);
        Assert.Equal(14.99, g.Current);
        Assert.Equal("Shop 1", g.Shop);
        Assert.Equal(4.99, g.Low);
        Assert.Equal(10.00, g.Saving);
    }

    [Fact]
    public void A_price_at_or_below_the_low_saves_nothing_and_never_goes_negative()
    {
        Assert.Equal(0, BacklogSavings.ForGame(Game("a"), [Quote("cheapshark", "USD", 9.99, 9.99)])!.Saving);
        Assert.Equal(0, BacklogSavings.ForGame(Game("a"), [Quote("cheapshark", "USD", 9.99, 7.49)])!.Saving);
    }

    [Fact]
    public void IsThereAnyDeal_in_the_users_currency_is_preferred_and_incomplete_quotes_are_skipped()
    {
        var g = BacklogSavings.ForGame(Game("a"), [Quote("cheapshark", "USD", 1, 20), Quote("itad", "EUR", 5, 30)]);
        Assert.Equal(("itad", "EUR", 25.0), (g!.Provider, g.Currency, g.Saving));
        Assert.Null(BacklogSavings.ForGame(Game("a"), [Quote("itad", "EUR", null, 30)]));
        Assert.Null(BacklogSavings.ForGame(Game("a"), [Quote("itad", "EUR", 5)]));
        var fallback = BacklogSavings.ForGame(Game("a"), [Quote("itad", "EUR", null, 30), Quote("cheapshark", "USD", 2, 12)]);
        Assert.Equal("cheapshark", fallback!.Provider);
    }

    [Fact]
    public void Totals_are_per_currency_exact_and_games_without_data_are_counted()
    {
        var quotes = new Dictionary<string, IReadOnlyList<CachedQuote>>
        {
            ["1"] = [Quote("cheapshark", "USD", 0.1, 0.3)],
            ["2"] = [Quote("cheapshark", "USD", 0.1, 0.2)],
            ["3"] = [Quote("itad", "EUR", 10, 15)],
            ["4"] = [],
        };
        var r = BacklogSavings.Build([Game("a", "1"), Game("b", "2"), Game("c", "3"), Game("d", "4"), Game("e", null)],
            app => quotes.TryGetValue(app, out var q) ? q : [], "DE", null);
        Assert.Equal(5, r.Candidates);
        Assert.Equal(3, r.Games.Count);
        Assert.Equal(2, r.WithoutData);
        Assert.Equal(1, r.WithoutSteamId);
        var usd = Assert.Single(r.Totals, t => t.Currency == "USD");
        Assert.Equal(0.3, usd.Total); // 0.2 + 0.1 exactly, not 0.30000000000000004
        Assert.Equal(2, usd.Games);
        Assert.Equal("USD", r.Totals[0].Currency); // the currency with most games first
        Assert.Equal(["c", "a", "b"], r.Games.Select(g => g.GameId)); // biggest saving first
    }
}

public sealed class AntiCheatNoteTests
{
    private static AntiCheatRow Row(params string[] names) => new("steam", "1", "Game", "game", "Supported", names, null, "2026-01-02T00:00:00Z");

    [Fact]
    public void Kernel_anti_cheat_gets_an_informative_note()
    {
        var n = AntiCheatNotes.For(Row("Easy Anti-Cheat", "Custom"), fpsCaptureOn: false);
        Assert.NotNull(n);
        Assert.Equal(["Easy Anti-Cheat"], n.Kernel);
        Assert.Equal(["Custom"], n.Other);
        Assert.Equal("Uses kernel anti-cheat (Easy Anti-Cheat). VYSTRAL never interacts with it.", n.Headline);
        Assert.DoesNotContain(AntiCheatNotes.FpsCapture, n.Notes);
        Assert.Contains(AntiCheatNotes.Decides, n.Notes);
        Assert.Contains("AreWeAntiCheatYet", n.Source);
    }

    [Fact]
    public void No_note_without_a_kernel_level_product()
    {
        Assert.Null(AntiCheatNotes.For(null, true));
        Assert.Null(AntiCheatNotes.For(Row("Valve Anti-Cheat"), true));
        Assert.Null(AntiCheatNotes.For(Row(), true));
        Assert.Null(AntiCheatNotes.Preflight(Row("Custom"), true));
    }

    [Fact]
    public void Frame_rate_capture_note_appears_only_when_capture_is_on()
    {
        var n = AntiCheatNotes.For(Row("BattlEye", "Vanguard"), fpsCaptureOn: true)!;
        Assert.Contains(AntiCheatNotes.FpsCapture, n.Notes);
        Assert.StartsWith("Uses kernel anti-cheat (BattlEye and Vanguard).", n.Headline);
        var row = AntiCheatNotes.Preflight(Row("BattlEye"), fpsCaptureOn: true)!;
        Assert.Equal(("antiCheat", "info", "BattlEye · kernel"), (row.Id, row.Status, row.Value));
        Assert.Contains("ETW", row.Detail);
        Assert.DoesNotContain("ETW", AntiCheatNotes.Preflight(Row("BattlEye"), fpsCaptureOn: false)!.Detail);
    }

    [Fact]
    public void Names_are_matched_case_insensitively_and_joined_naturally()
    {
        Assert.Equal(["easy anti-cheat"], AntiCheatNotes.For(Row("easy anti-cheat"), false)!.Kernel);
        Assert.Equal("A, B and C", AntiCheatNotes.Join(["A", "B", "C"]));
    }
}

public sealed class TimeToBeatDataTests
{
    private static readonly DateTimeOffset At = new(2026, 9, 1, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Extracts_igdb_estimates_from_enrichment_facts()
    {
        var t = TimeToBeatData.Extract("""{"name":"X","timeToBeat":{"hastily":36000,"normally":72000,"completely":180000,"count":42}}""", At);
        Assert.Equal((36000L, 72000L, 180000L, 42), (t!.Main, t.Extras, t.Completionist, t.Count));
        Assert.Equal("igdb", t.Source);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"timeToBeat":null}""")]
    [InlineData("""{"timeToBeat":{"hastily":null,"normally":0,"completely":-5}}""")]
    [InlineData("""{"timeToBeat":{"hastily":"36000"}}""")]
    [InlineData("""{"timeToBeat":{"hastily":36000000}}""")]
    [InlineData("not json")]
    [InlineData("[]")]
    public void Missing_or_malformed_estimates_mean_no_bar(string json)
    {
        Assert.Null(TimeToBeatData.Extract(json, At));
    }

    [Fact]
    public void Partial_estimates_are_kept_and_progress_uses_the_first_known_one()
    {
        var t = TimeToBeatData.Extract("""{"timeToBeat":{"normally":10000,"count":3}}""", At)!;
        Assert.Null(t.Main);
        Assert.Equal(0.5, TimeToBeatData.Progress(5000, t));
        Assert.Equal(1, TimeToBeatData.Progress(50000, t));
        Assert.Equal(0, TimeToBeatData.Progress(-10, t));
        Assert.Null(TimeToBeatData.Progress(10, null));
    }
}

public sealed class RecapRepositoryTests : IDisposable
{
    private readonly TestDb _t = new();
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);

    public void Dispose() => _t.Dispose();

    private string SteamGame(string appId, string title)
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, appId, title, steamAppId: appId))]);
        return _t.Repo.GetInstallationsByPlatformId(PlatformId.Steam, appId)!.GameId;
    }

    private string Session(string gameId, DateTimeOffset start, int seconds, string source, string? perf = null)
    {
        var id = source == SessionSources.Tracked ? _t.Repo.StartSession(gameId, null, start) : _t.Repo.StartSession(gameId, null, start, source);
        _t.Repo.EndSession(id, start.AddSeconds(seconds), seconds, perf);
        return id;
    }

    [Fact]
    public void Away_query_returns_only_noticed_sessions_that_ended_after_the_marker()
    {
        var g = SteamGame("620", "Portal 2");
        var old = Session(g, T0.AddDays(-2), 3600, SessionSources.Background);
        var tracked = Session(g, T0.AddHours(1), 3600, SessionSources.Tracked);
        var bg = Session(g, T0.AddHours(2), 5400, SessionSources.Background, """{"fpsAvg":118.4,"fps1Low":80,"gpuTempMaxC":71}""");
        var detected = Session(g, T0.AddHours(5), 1200, SessionSources.Detected);
        var straddles = Session(g, T0.AddMinutes(-30), 3600, SessionSources.Detected); // started before, ended after
        var tiny = Session(g, T0.AddHours(6), 30, SessionSources.Detected);
        var open = _t.Repo.StartSession(g, null, T0.AddHours(7), SessionSources.Background); // still running

        var rows = _t.Repo.ObservedSessionsEndedAfter(T0, AwaySummary.Sources);
        Assert.Equal(new[] { tiny, detected, bg, straddles }.ToHashSet(), rows.Select(r => r.Id).ToHashSet());
        Assert.DoesNotContain(rows, r => r.Id == old || r.Id == tracked || r.Id == open);

        var summary = AwaySummary.Build(rows, T0, T0.AddDays(1), _ => [], _ => false)!;
        Assert.Equal(3, summary.Sessions.Count); // the 30-second detection is left out
        Assert.Equal(5400 + 1200 + 3600, summary.TotalSeconds);
        Assert.Equal(bg, summary.Best!.Id);
        Assert.Equal(118.4, summary.BestFps!.Perf.FpsAvg);
        Assert.Equal(71, summary.BestFps.Perf.PeakTempC);
        var game = Assert.Single(summary.Games);
        Assert.Equal(("Portal 2", 3), (game.Title, game.Sessions));
        Assert.Equal(1, summary.GamesWithoutAchievementData);
        Assert.Null(AwaySummary.Build(rows, T0.AddDays(1), T0.AddDays(2), _ => [], _ => true));
    }

    [Fact]
    public void Achievements_unlocked_during_a_session_are_found_with_slack()
    {
        SteamGame("620", "Portal 2");
        static SteamAchievementRow A(string api, bool done, DateTimeOffset? at) => new(api, $"Name {api}", null, false, null, null, null, null, done, at, 4.2, 0);
        _t.Repo.SaveAchievements("620", "76561197960287930", "ok", null,
            [A("BEFORE", true, T0.AddMinutes(-1)), A("DURING", true, T0.AddMinutes(30)), A("JUST_AFTER", true, T0.AddMinutes(61)), A("LATER", true, T0.AddHours(3)), A("LOCKED", false, null)]);
        var found = _t.Repo.UnlocksBetween("620", T0, T0.AddHours(1) + AwaySummary.UnlockSlack);
        Assert.Equal(["DURING", "JUST_AFTER"], found.Select(f => f.ApiName));
        Assert.True(_t.Repo.AchievementsFetched("620"));
        Assert.False(_t.Repo.AchievementsFetched("400"));
        Assert.Empty(_t.Repo.UnlocksBetween("not-an-app", T0, T0.AddDays(1)));
    }

    [Fact]
    public void Recap_session_lookup_ignores_unfinished_and_imported_sessions()
    {
        var g = SteamGame("620", "Portal 2");
        var done = Session(g, T0, 600, SessionSources.Tracked);
        var open = _t.Repo.StartSession(g, null, T0.AddHours(1));
        using (var conn = _t.Db.Open())
            conn.Execute("INSERT INTO sessions(id, game_id, start, end, duration_seconds, source) VALUES (@id, @g, @s, @s, 60, 'imported')",
                new { id = new string('e', 32), g, s = T0.ToString("O") });
        Assert.Equal("Portal 2", _t.Repo.GetRecapSession(done)!.Title);
        Assert.Null(_t.Repo.GetRecapSession(open));
        Assert.Null(_t.Repo.GetRecapSession(new string('e', 32)));
    }

    [Fact]
    public void Time_to_beat_rows_come_from_matched_igdb_answers_only()
    {
        var a = SteamGame("620", "Portal 2");
        var b = SteamGame("400", "Portal");
        var c = SteamGame("500", "Left 4 Dead");
        _t.Repo.SetEnrichment(a, "igdb", "1", "steam-appid", 1, true, """{"timeToBeat":{"hastily":30000,"normally":40000,"completely":90000,"count":9}}""", null);
        _t.Repo.SetEnrichment(b, "igdb", null, null, null, false, "{}", null);
        _t.Repo.SetEnrichment(c, "rawg", "2", "exact-title", 0.8, true, """{"timeToBeat":{"hastily":1}}""", null);
        var map = TimeToBeatData.Map(_t.Repo.IgdbTimeToBeatRows());
        Assert.Equal([a], map.Keys);
        Assert.Equal(30000, map[a].Main);
    }

    [Fact]
    public void Backlog_candidates_are_backlog_games_and_never_played_games_without_a_status()
    {
        var backlog = SteamGame("1", "Backlog game");
        var never = SteamGame("2", "Never played");
        var played = SteamGame("3", "Played");
        var beaten = SteamGame("4", "Beaten, never tracked");
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam,
            TestDb.Install(PlatformId.Steam, "1", "Backlog game", steamAppId: "1", playtime: 300),
            TestDb.Install(PlatformId.Steam, "2", "Never played", steamAppId: "2"),
            TestDb.Install(PlatformId.Steam, "3", "Played", steamAppId: "3"),
            TestDb.Install(PlatformId.Steam, "4", "Beaten, never tracked", steamAppId: "4"))]);
        Session(played, T0, 600, SessionSources.Tracked);
        using (var conn = _t.Db.Open())
        {
            conn.Execute("UPDATE games SET status='backlog' WHERE id=@backlog", new { backlog });
            conn.Execute("UPDATE games SET status='beaten' WHERE id=@beaten", new { beaten });
        }
        var rows = _t.Repo.BacklogCandidates();
        Assert.Equal(new[] { backlog, never }.ToHashSet(), rows.Select(r => r.GameId).ToHashSet());
        Assert.False(rows.Single(r => r.GameId == backlog).NeverPlayed); // store playtime
        Assert.True(rows.Single(r => r.GameId == never).NeverPlayed);
        Assert.Equal("2", rows.Single(r => r.GameId == never).SteamAppId);
    }

    [Fact]
    public void Last_seen_marker_ignores_garbage_and_the_far_future()
    {
        var now = T0;
        Assert.Null(AwaySummary.ParseSeen(null, now));
        Assert.Null(AwaySummary.ParseSeen("yesterday", now));
        Assert.Null(AwaySummary.ParseSeen(now.AddDays(1).ToString("O"), now));
        Assert.Equal(now.AddHours(-3), AwaySummary.ParseSeen(now.AddHours(-3).ToString("O"), now));
        _t.Repo.SetInternalValue("home.awayLastSeen", now.ToString("O"));
        Assert.Equal(now, AwaySummary.ParseSeen(_t.Repo.GetInternalValue("home.awayLastSeen"), now));
    }

    [Fact]
    public void Perf_summaries_are_read_tolerantly()
    {
        Assert.False(AwaySummary.ParsePerf(null).HasMetrics);
        Assert.False(AwaySummary.ParsePerf("{oops").HasMetrics);
        var p = AwaySummary.ParsePerf("""{"fpsAvg":"fast","fps1Low":-3,"peakTempC":88.26,"gpuTempMaxC":70,"cpuAvg":45.55}""");
        Assert.True(p.HasMetrics);
        Assert.Null(p.FpsAvg);
        Assert.Null(p.Fps1Low);
        Assert.Equal(88.3, p.PeakTempC); // the throttle-aware peak wins over the sampled max
        Assert.Equal(45.6, p.CpuAvg);
    }
}

public sealed class ReplayImageStoreTests
{
    private static byte[] Png(int w = 1920, int h = 1080, int bodyBytes = 100)
    {
        var bytes = new List<byte> { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, (byte)'I', (byte)'H', (byte)'D', (byte)'R' };
        var dims = new byte[8];
        BinaryPrimitives.WriteUInt32BigEndian(dims, (uint)w);
        BinaryPrimitives.WriteUInt32BigEndian(dims.AsSpan(4), (uint)h);
        bytes.AddRange(dims);
        bytes.AddRange(new byte[5 + 4 + bodyBytes]);
        bytes.AddRange(new byte[] { 0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82 });
        return bytes.ToArray();
    }

    private static string Upload(ReplayImageStore store, byte[] png, int chunk = 40)
    {
        var token = store.Begin("s1", png.Length);
        var b64 = Convert.ToBase64String(png);
        for (int i = 0, idx = 0; i < b64.Length; i += chunk, idx++) store.Append(token, idx, b64.Substring(i, Math.Min(chunk, b64.Length - i)));
        return token;
    }

    [Fact]
    public void A_chunked_1080p_png_round_trips()
    {
        var store = new ReplayImageStore();
        var png = Png();
        var (session, bytes) = store.Take(Upload(store, png));
        Assert.Equal("s1", session);
        Assert.Equal(png, bytes);
        Assert.Equal(0, store.Pending);
    }

    [Fact]
    public void Wrong_size_or_not_png_is_rejected()
    {
        var store = new ReplayImageStore();
        Assert.Throws<BridgeException>(() => store.Take(Upload(store, Png(1280, 720))));
        var bad = Png();
        bad[1] = 0;
        Assert.Throws<BridgeException>(() => store.Take(Upload(store, bad)));
        Assert.True(ReplayImageStore.IsExpectedPng(Png()));
        Assert.False(ReplayImageStore.IsExpectedPng(Png()[..^1]));
    }

    [Fact]
    public void Chunks_must_be_in_order_and_not_exceed_the_announced_size()
    {
        var store = new ReplayImageStore();
        var token = store.Begin("s1", 100);
        Assert.Throws<BridgeException>(() => store.Append(token, 1, "AAAA"));
        store.Append(token, 0, "AAAA");
        Assert.Throws<BridgeException>(() => store.Append(token, 1, "not base64!"));
        Assert.Throws<BridgeException>(() => store.Take(token)); // incomplete
        var small = store.Begin("s1", 64);
        Assert.Throws<BridgeException>(() => store.Append(small, 0, Convert.ToBase64String(new byte[65])));
        Assert.Throws<BridgeException>(() => store.Begin("s1", ReplayImageStore.MaxBytes + 1));
        Assert.Throws<BridgeException>(() => store.Begin("s1", 10));
    }

    [Fact]
    public void Uploads_expire_and_only_two_are_kept()
    {
        var now = DateTimeOffset.UtcNow;
        var store = new ReplayImageStore(() => now);
        var a = store.Begin("s1", 100);
        var b = store.Begin("s2", 100);
        var c = store.Begin("s3", 100);
        Assert.Throws<BridgeException>(() => store.Append(a, 0, "AAAA")); // evicted (oldest)
        store.Append(b, 0, "AAAA");
        now += ReplayImageStore.Ttl + TimeSpan.FromSeconds(1);
        Assert.Throws<BridgeException>(() => store.Append(c, 0, "AAAA"));
        Assert.Equal(0, store.Pending);
    }

    [Fact]
    public void Suggested_file_name_is_built_natively_and_safe()
    {
        var name = ReplayImageStore.SuggestedName("Half-Life: <Alyx>/\\?*", new DateTimeOffset(2026, 10, 5, 20, 0, 0, TimeSpan.Zero));
        Assert.StartsWith("VYSTRAL replay - Half-Life Alyx - 2026-10-0", name);
        Assert.DoesNotContain(name, c => Path.GetInvalidFileNameChars().Contains(c));
        Assert.Contains("Session", ReplayImageStore.SuggestedName("???", DateTimeOffset.UtcNow));
    }
}
