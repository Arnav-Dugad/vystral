using System.Text.Json;
using Dapper;
using Microsoft.Data.Sqlite;
using Vystral.Core.Contracts;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Insights;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Insights;

/// <summary>Track F: migration 5, driver comparison, background apps, achievement feed and unlock detection.</summary>
public sealed class DataInsightsRepositoryTests : IDisposable
{
    private readonly TestDb _t = new();
    private static readonly DateTimeOffset T0 = new(2026, 3, 1, 18, 0, 0, TimeSpan.Zero);

    public void Dispose() => _t.Dispose();

    private (string GameId, string InstallationId) SteamGame(string appId, string title)
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, appId, title, steamAppId: appId))]);
        var inst = _t.Repo.GetInstallationsByPlatformId(PlatformId.Steam, appId)!;
        return (inst.GameId, inst.Id);
    }

    private string Session(string gameId, string instId, DateTimeOffset start, int seconds, string? perfJson = null)
    {
        var id = _t.Repo.StartSession(gameId, instId, start);
        _t.Repo.EndSession(id, start.AddSeconds(seconds), seconds, perfJson);
        return id;
    }

    private static string Perf(double fps, double low, double p99, int stutters = 0, double cpu = 40) =>
        JsonSerializer.Serialize(new { samples = 10, fpsStatus = "ok", fpsAvg = fps, fps1Low = low, frameTimeP99Ms = p99, stutterCount = stutters, cpuAvg = cpu });

    [Fact]
    public void Session_gpu_driver_is_stored_and_read_back_for_comparison()
    {
        var (g, i) = SteamGame("620", "Portal 2");
        var s = Session(g, i, T0, 3600, Perf(120, 80, 14));
        _t.Repo.SetSessionGpu(s, "572.16", "NVIDIA GeForce RTX 4060 Laptop GPU");
        var row = Assert.Single(_t.Repo.GetDriverSessions());
        Assert.Equal(("572.16", "NVIDIA GeForce RTX 4060 Laptop GPU"), (row.GpuDriver, row.GpuName));
        Assert.Equal(120, row.Perf.FpsAvg);
        Assert.True(row.Perf.HasFps);
        Assert.Empty(_t.Repo.GetDriverSessions(new string('f', 32)));
    }

    [Fact]
    public void Background_apps_are_saved_replaced_and_deleted_with_tracked_history()
    {
        var (g, i) = SteamGame("620", "Portal 2");
        var s = Session(g, i, T0, 3600);
        _t.Repo.SaveBackgroundApps(s, [new BackgroundAppSample("Discord.exe", 3, 410, 520, 2.5)], 3, 61, 74);
        _t.Repo.SaveBackgroundApps(s, [new BackgroundAppSample("Discord.exe", 5, 400, 530, 2.1), new BackgroundAppSample("chrome.exe", 4, 1900, 2300, 6)], 5, 63, 80);

        var apps = _t.Repo.GetBackgroundApps(s);
        Assert.Equal(["chrome.exe", "Discord.exe"], apps.Select(a => a.Name));
        Assert.Equal(5, apps.Single(a => a.Name == "Discord.exe").Samples);
        var (sessions, rows) = _t.Repo.GetImpactData();
        var session = Assert.Single(sessions);
        Assert.Equal((5, 63.0, 80.0), (session.Snapshots, session.MemLoadAvg!.Value, session.MemLoadMax!.Value));
        Assert.Equal(2, rows.Count);

        _t.Repo.SetBackgroundAppHidden("Chrome.exe", true);
        Assert.Equal(["chrome.exe"], _t.Repo.GetHiddenBackgroundApps());
        _t.Repo.SetBackgroundAppHidden("chrome.exe", false);
        Assert.Empty(_t.Repo.GetHiddenBackgroundApps());
        _t.Repo.SetBackgroundAppHidden("Discord.exe", true);

        _t.Repo.DeleteTrackedHistory();
        Assert.Empty(_t.Repo.GetBackgroundApps(s));
        Assert.Empty(_t.Repo.GetHiddenBackgroundApps());
        using var conn = _t.Db.Open();
        Assert.Equal(0L, conn.ExecuteScalar<long>("SELECT COUNT(*) FROM session_background_apps"));
    }

    [Fact]
    public void Removing_a_manual_game_cascades_to_its_background_apps()
    {
        var gameId = _t.Repo.AddManualGame("Indie", @"C:\Games\indie\indie.exe", null);
        var instId = _t.Repo.GetInstallations(gameId).Single().Id;
        var s = Session(gameId, instId, T0, 600);
        _t.Repo.SaveBackgroundApps(s, [new BackgroundAppSample("obs64.exe", 2, 300, 320, 8)], 2, null, null);
        Assert.True(_t.Repo.RemoveManualGame(gameId));
        using var conn = _t.Db.Open();
        Assert.Equal(0L, conn.ExecuteScalar<long>("SELECT COUNT(*) FROM session_background_apps"));
    }

    [Fact]
    public void Background_apps_for_a_missing_session_are_ignored()
    {
        _t.Repo.SaveBackgroundApps(new string('c', 32), [new BackgroundAppSample("x.exe", 1, 1, 1, 1)], 1, null, null);
        using var conn = _t.Db.Open();
        Assert.Equal(0L, conn.ExecuteScalar<long>("SELECT COUNT(*) FROM session_background_apps"));
    }

    private static SteamAchievementRow Ach(string api, bool achieved, DateTimeOffset? at, double? pct, int order, bool hidden = false) =>
        new(api, $"Name {api}", $"Desc {api}", hidden, null, null, null, null, achieved, at, pct, order);

    [Fact]
    public void Achievement_feed_is_newest_first_paginated_and_titled_from_the_library()
    {
        SteamGame("620", "Portal 2");
        _t.Repo.ApplyOwnedSteamGames([new OwnedSteamGame("400", "Portal", 90, null)]);
        _t.Repo.SaveAchievements("620", "76561197960287930", "ok", null,
        [
            Ach("A", true, T0.AddDays(-2), 40, 0), Ach("B", true, T0, 0.6, 1), Ach("C", false, null, 3, 2), Ach("D", true, null, 50, 3),
        ]);
        _t.Repo.SaveAchievements("400", "76561197960287930", "ok", null, [Ach("P", true, T0.AddDays(-1), 4, 0)]);

        Assert.Equal(3, _t.Repo.CountUnlockedAchievements()); // D has no unlock time, so it isn't in the feed
        var page1 = _t.Repo.GetAchievementFeed(0, 2);
        Assert.Equal(["B", "P"], page1.Select(r => r.ApiName));
        Assert.Equal("Portal 2", page1[0].GameTitle);
        Assert.NotNull(page1[0].GameId);
        Assert.Equal("Portal", page1[1].GameTitle);
        Assert.Equal(["A"], _t.Repo.GetAchievementFeed(2, 2).Select(r => r.ApiName));

        var totals = _t.Repo.GetAchievementTotals();
        Assert.Equal((4, 2, 2, 1), (totals.Unlocked, totals.Games, totals.Rare, totals.UltraRare));
        Assert.NotNull(totals.LastFetched);
    }

    [Fact]
    public void Achievement_progress_reports_the_rarest_locked_achievement()
    {
        SteamGame("620", "Portal 2");
        _t.Repo.SaveAchievements("620", "76561197960287930", "ok", null,
        [
            Ach("A", true, T0, 40, 0), Ach("B", true, T0, 20, 1), Ach("C", true, T0, 30, 2), Ach("D", false, null, 12, 3),
            Ach("E", false, null, 1.5, 4, hidden: true), Ach("F", true, T0.AddDays(1), 9, 5), Ach("G", true, T0, 9, 6),
        ]);
        var p = Assert.Single(_t.Repo.GetAchievementProgress());
        Assert.Equal((7, 5), (p.Total, p.Unlocked));
        Assert.Equal(("Name E", 1.5, true), (p.RarestLockedName, p.RarestLockedPercent!.Value, p.RarestLockedHidden));
        var near = Assert.Single(AchievementInsights.NearCompletion([p]));
        Assert.Equal(2, near.Remaining);
        Assert.Null(near.RarestRemainingName); // hidden: no spoilers
        Assert.True(near.RarestRemainingHidden);
    }
}

public sealed class DataInsightsMigrationTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Migration_5_upgrades_an_existing_v4_database_and_keeps_its_data()
    {
        var path = Path.Combine(_dir.Path, "vystral.db");
        var cs = new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString();
        using (var conn = new SqliteConnection(cs))
        {
            conn.Open();
            conn.Execute("CREATE TABLE schema_version (version INTEGER NOT NULL, applied TEXT NOT NULL, name TEXT NOT NULL);");
            foreach (var (version, name, sql) in Migrations.All.Where(m => m.Version <= 4))
            {
                conn.Execute(sql);
                conn.Execute("INSERT INTO schema_version VALUES (@version, '2026-01-01T00:00:00Z', @name)", new { version, name });
            }
            conn.Execute("""
                INSERT INTO games(id, title, sort_title, steam_app_id, added, updated)
                VALUES ('0123456789abcdef0123456789abcdef', 'Old Game', 'old game', '620', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                INSERT INTO sessions(id, game_id, start, end, duration_seconds, source, perf_summary_json, detect_ms)
                VALUES ('fedcba9876543210fedcba9876543210', '0123456789abcdef0123456789abcdef', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z', 3600, 'tracked', '{"samples":3,"fpsAvg":90,"fps1Low":60}', 4200);
                INSERT INTO perf_samples(session_id, t_offset_ms, cpu_pct, fps) VALUES ('fedcba9876543210fedcba9876543210', 2000, 33.5, 88);
                INSERT INTO steam_achievements(app_id, api_name, display_name, achieved, unlock_time, global_percent)
                VALUES ('620', 'WIN', 'Winner', 1, '2026-01-02T10:30:00.0000000+00:00', 3.2);
                """);
        }

        var db = new Database(path);
        try
        {
            Assert.Equal(4, db.Migrate());
            Assert.Equal(5, Database.LatestVersion);
            var repo = new LibraryRepository(db);
            var g = repo.LoadSnapshot((_, _) => null).Games.Single();
            Assert.Equal(("Old Game", 3600L, 1), (g.Title, g.TrackedSeconds, g.SessionCount));
            var s = repo.ListSessions(null, 10).Single();
            Assert.Contains("fpsAvg", s.PerfSummary);
            Assert.Single(repo.GetPerfSamples(s.Id));
            Assert.Equal(88, Assert.Single(repo.GetInsightSamples(s.Id)).Fps);
            var row = Assert.Single(repo.GetDriverSessions());
            Assert.Null(row.GpuDriver);
            Assert.Equal(90, row.Perf.FpsAvg);
            Assert.Equal(1, repo.CountUnlockedAchievements());

            using var conn = db.Open();
            var tables = conn.Query<string>("SELECT name FROM sqlite_master WHERE type='table'").ToHashSet();
            Assert.Contains("session_background_apps", tables);
            Assert.Contains("hidden_background_apps", tables);
            Assert.Equal(4200L, conn.ExecuteScalar<long>("SELECT detect_ms FROM sessions"));
            Assert.True(Directory.EnumerateFiles(Path.Combine(_dir.Path, "backups"), "pre-migration-v4-*.db").Any());

            // The new columns and tables are usable straight away.
            repo.SetSessionGpu(s.Id, "576.02", "GPU");
            repo.SaveBackgroundApps(s.Id, [new BackgroundAppSample("Discord.exe", 2, 400, 420, 1)], 2, 50, 60);
            Assert.Equal("576.02", repo.GetDriverSessions().Single().GpuDriver);
            Assert.Single(repo.GetBackgroundApps(s.Id));
        }
        finally
        {
            TestDb.ReleasePool(db);
        }
    }
}

public sealed class DataInsightsLogicTests
{
    private static readonly DateTimeOffset T0 = new(2026, 3, 1, 18, 0, 0, TimeSpan.Zero);
    private static readonly string G1 = new('1', 32), G2 = new('2', 32);

    private static DriverSessionRow D(string game, int day, string? driver, double? fps, double? low = null, double? p99 = null, int seconds = 3600, string? gpu = "RTX") =>
        new($"{game[..4]}{day}", game, T0.AddDays(day), seconds, driver, gpu, new PerfFields(fps, low ?? (fps is null ? null : fps * 0.7), p99 ?? (fps is null ? null : 2000 / fps), null, 40));

    [Fact]
    public void Driver_comparison_compares_the_two_latest_drivers_with_fps_per_game()
    {
        var result = DriverComparison.Build(
        [
            D(G1, 0, "566.36", 100), D(G1, 1, "572.16", 110), D(G1, 2, "572.16", 112), D(G1, 3, "572.16", 108),
            D(G1, 5, "576.02", 120), D(G1, 6, "576.02", 124), D(G1, 7, "576.02", 122, seconds: 60), // too short: ignored
            D(G2, 1, "572.16", null), D(G2, 6, "576.02", null), // no FPS on either side
            D(G2, 8, null, 99),
        ]);

        Assert.Equal(["566.36", "572.16", "576.02"], result.Drivers.Select(d => d.Version));
        Assert.Equal(4, result.Drivers.Single(d => d.Version == "576.02").Sessions);
        var cmp = Assert.Single(result.Games);
        Assert.Equal(G1, cmp.GameId);
        Assert.Equal(("572.16", 3, 110.0), (cmp.Before.Version, cmp.Before.Sessions, cmp.Before.FpsAvg!.Value));
        Assert.Equal(("576.02", 2, 122.0), (cmp.After.Version, cmp.After.Sessions, cmp.After.FpsAvg!.Value));
        Assert.Equal(77.0, cmp.Before.Fps1Low);
        Assert.True(cmp.SmallSample);
        Assert.False(cmp.GpuChanged);
        Assert.Equal(T0.AddDays(5).ToString("O"), cmp.ChangedAt);
        Assert.Equal(1, result.GamesWithoutFps);
        Assert.Equal(9, result.SessionsWithDriver);
        Assert.Equal(8, result.SessionsWithFps);
    }

    [Fact]
    public void Driver_comparison_flags_a_gpu_change_and_needs_two_drivers()
    {
        var one = DriverComparison.Build([D(G1, 0, "572.16", 100), D(G1, 1, "572.16", 101)]);
        Assert.Empty(one.Games);
        Assert.Single(one.Drivers);

        var swapped = DriverComparison.Build([D(G1, 0, "31.0.101.5186", 60, gpu: "Intel Iris Xe"), D(G1, 1, "572.16", 140, gpu: "RTX 4060")]);
        Assert.True(Assert.Single(swapped.Games).GpuChanged);
    }

    [Fact]
    public void Median_ignores_missing_values()
    {
        Assert.Null(DriverComparison.Median([null, null]));
        Assert.Equal(2.0, DriverComparison.Median([3, null, 1, 2]));
        Assert.Equal(2.5, DriverComparison.Median([1, 2, 3, 4]));
    }

    [Theory]
    [InlineData("32.0.15.7216", "572.16")]
    [InlineData("32.0.15.7602", "576.02")]
    [InlineData("31.0.15.5222", "552.22")]
    [InlineData("27.21.14.5671", "456.71")]
    [InlineData("1.2.3", null)]
    [InlineData("a.b.c.d", null)]
    public void Nvidia_driver_versions_convert_to_the_familiar_form(string windows, string? expected) =>
        Assert.Equal(expected, GpuDriverProbe.NvidiaVersion(windows));

    [Fact]
    public void Registry_probe_prefers_the_discrete_gpu_and_skips_virtual_adapters()
    {
        var reg = new FakeRegistry()
            .Set(Hive.LocalMachine, $@"{GpuDriverProbe.ClassKey}\0000", "DriverDesc", "Intel(R) UHD Graphics")
            .Set(Hive.LocalMachine, $@"{GpuDriverProbe.ClassKey}\0000", "DriverVersion", "31.0.101.5186")
            .Set(Hive.LocalMachine, $@"{GpuDriverProbe.ClassKey}\0000", "ProviderName", "Intel Corporation")
            .Set(Hive.LocalMachine, $@"{GpuDriverProbe.ClassKey}\0001", "DriverDesc", "NVIDIA GeForce RTX 4060 Laptop GPU")
            .Set(Hive.LocalMachine, $@"{GpuDriverProbe.ClassKey}\0001", "DriverVersion", "32.0.15.7216")
            .Set(Hive.LocalMachine, $@"{GpuDriverProbe.ClassKey}\0001", "ProviderName", "NVIDIA")
            .Set(Hive.LocalMachine, $@"{GpuDriverProbe.ClassKey}\0002", "DriverDesc", "Microsoft Basic Display Adapter")
            .Set(Hive.LocalMachine, $@"{GpuDriverProbe.ClassKey}\0002", "DriverVersion", "10.0.0.1")
            .Set(Hive.LocalMachine, $@"{GpuDriverProbe.ClassKey}\Properties", "DriverDesc", "nope");
        Assert.Equal(new GpuIdentity("NVIDIA GeForce RTX 4060 Laptop GPU", "572.16"), GpuDriverProbe.FromRegistry(reg));

        var amdOnly = new FakeRegistry()
            .Set(Hive.LocalMachine, $@"{GpuDriverProbe.ClassKey}\0000", "DriverDesc", "AMD Radeon RX 7800 XT")
            .Set(Hive.LocalMachine, $@"{GpuDriverProbe.ClassKey}\0000", "DriverVersion", "31.0.24027.1012");
        Assert.Equal(new GpuIdentity("AMD Radeon RX 7800 XT", "31.0.24027.1012"), GpuDriverProbe.FromRegistry(amdOnly));
        Assert.Null(GpuDriverProbe.FromRegistry(new FakeRegistry()));
    }

    // ---------------- achievements ----------------

    private static SteamAchievementRow A(string api, bool achieved, DateTimeOffset? at, double? pct = null, int order = 0) =>
        new(api, api, null, false, null, null, null, null, achieved, at, pct, order);

    [Fact]
    public void Newly_unlocked_excludes_earlier_unlocks_and_anything_before_the_session()
    {
        HashSet<string> before = ["OLD"];
        var after = new[]
        {
            A("OLD", true, T0.AddMinutes(10), 1),             // already achieved before
            A("STALE", true, T0.AddDays(-3), 2),             // unlocked before the session; the cache was just stale
            A("EDGE", true, T0.AddSeconds(-20), 50),         // within the detection tolerance
            A("NEW", true, T0.AddMinutes(30), 0.4),
            A("LOCKED", false, null, 0.1),
            A("NOTIME", true, null, 3),
        };
        var fresh = AchievementInsights.NewlyUnlocked(before, after, T0);
        Assert.Equal(["NEW", "EDGE"], fresh.Select(f => f.ApiName));
    }

    [Fact]
    public void Rare_summary_picks_the_tightest_threshold()
    {
        Assert.Equal((2.0, 1), AchievementInsights.RareSummary([1.5, 30, 12]));
        Assert.Equal((1.0, 2), AchievementInsights.RareSummary([0.5, 0.9, 4]));
        Assert.Equal((10.0, 1), AchievementInsights.RareSummary([9.9, 40]));
        Assert.Equal((null, 0), AchievementInsights.RareSummary([12, 40]));
        Assert.Equal((null, 0), AchievementInsights.RareSummary([null]));
    }

    [Fact]
    public void Near_completion_sorts_by_achievements_left_then_progress()
    {
        AchievementProgressRow P(string app, int total, int unlocked, string? last = null) =>
            new(app, null, $"Game {app}", total, unlocked, last, "Rare one", 2, false);
        var list = AchievementInsights.NearCompletion(
        [
            P("a", 10, 7), P("b", 50, 47), P("c", 4, 3), P("d", 20, 20), P("e", 10, 6), P("f", 100, 97, "2026-03-02"), P("g", 0, 0),
        ]);
        Assert.Equal(["c", "f", "b", "a"], list.Select(n => n.AppId));
        Assert.Equal(1, list[0].Remaining);
        Assert.Equal(0.75, list[0].Fraction);
        Assert.Equal("Rare one", list[0].RarestRemainingName);
    }

    // ---------------- background apps ----------------

    private sealed class FakeSnapshots : IProcessSnapshotSource
    {
        public Queue<IReadOnlyList<ProcessEntry>> Next { get; } = new();
        public IReadOnlyList<ProcessEntry> Take() => Next.Count > 0 ? Next.Dequeue() : [];
    }

    private const int Own = 1000, Game = 2000;

    private static ProcessEntry P(int pid, string name, double mb, long cpuSeconds = 0, int parent = 1, int session = 1) =>
        new(pid, parent, session, name, (long)(mb * 1048576), cpuSeconds * 10_000_000);

    [Fact]
    public void Tracker_excludes_the_game_vystral_other_sessions_and_windows_and_measures_cpu()
    {
        var src = new FakeSnapshots();
        var clock = new DateTime(2026, 3, 1, 18, 0, 0, DateTimeKind.Utc);
        var mem = 55.0;
        IReadOnlyList<ProcessEntry> Snap(long discordCpu) =>
        [
            P(Own, "Vystral.exe", 300), P(1100, "msedgewebview2.exe", 200, parent: Own), P(1101, "PresentMon-2.6.0-x64.exe", 30, parent: Own),
            P(Game, "Game.exe", 6000, 100), P(2100, "CrashHandler.exe", 20, parent: Game),
            P(3000, "Discord.exe", 300, discordCpu), P(3001, "Discord.exe", 150, 0, parent: 3000),
            P(3100, "chrome.exe", 900), P(3200, "svchost.exe", 800), P(3300, "explorer.exe", 120),
            P(4000, "OtherUser.exe", 5000, session: 2), P(4, "System", 10),
        ];
        src.Next.Enqueue(Snap(10));
        src.Next.Enqueue(Snap(13)); // 3 s of CPU over 30 s on 2 cores = 5%
        using var tracker = new BackgroundAppTracker(src, () => mem, Own, 2, () => clock);

        tracker.Snapshot([Game]);
        clock = clock.AddSeconds(30);
        mem = 91;
        tracker.Snapshot([Game]);
        tracker.Snapshot([Game]); // empty snapshot: ignored

        Assert.Equal(2, tracker.Snapshots);
        Assert.Equal((73.0, 91.0), (tracker.MemLoadAvg!.Value, tracker.MemLoadMax!.Value));
        var results = tracker.Results();
        Assert.False(tracker.Dirty);
        Assert.Equal(["chrome.exe", "Discord.exe"], results.Select(r => r.Name));
        var discord = results.Single(r => r.Name == "Discord.exe");
        Assert.Equal((2, 450.0, 450.0, 5.0), (discord.Samples, discord.AvgMb!.Value, discord.MaxMb!.Value, discord.AvgCpu!.Value));
    }

    [Fact]
    public void Tracker_keeps_only_the_heaviest_apps_per_snapshot()
    {
        var src = new FakeSnapshots();
        src.Next.Enqueue([P(Own, "Vystral.exe", 1), .. Enumerable.Range(0, 20).Select(i => P(5000 + i, $"app{i}.exe", 100 + i))]);
        using var tracker = new BackgroundAppTracker(src, () => null, Own, 4);
        tracker.Snapshot([]);
        var names = tracker.Results().Select(r => r.Name).ToList();
        Assert.Equal(BackgroundAppTracker.TopByMemory, names.Count);
        Assert.Equal("app19.exe", names[0]);
        Assert.Null(tracker.MemLoadAvg);
    }

    [Fact]
    public void Descendants_follow_parent_chains_without_looping_on_reused_pids()
    {
        var set = BackgroundAppTracker.Descendants([P(10, "a", 1, parent: 5), P(11, "b", 1, parent: 10), P(12, "c", 1, parent: 12), P(5, "root", 1, parent: 11)], [5]);
        Assert.Equal([5, 10, 11], set.Order());
    }

    private static ImpactSessionRow S(int i, double? fps, double? low, int snapshots = 4, double? memMax = 60, int stutters = 0) =>
        new($"s{i}", G1, T0.AddDays(i), 3600, snapshots, new PerfFields(fps, low, null, stutters, 40), 50, memMax);

    [Fact]
    public void Impact_report_suggests_apps_seen_more_in_rough_sessions()
    {
        // Sessions 0-3 rough (1% low under half the average), 4-7 clean.
        var sessions = Enumerable.Range(0, 8).Select(i => S(i, 120, i < 4 ? 40 : 90)).ToList();
        var apps = new List<BackgroundAppRow>();
        for (var i = 0; i < 8; i++)
        {
            apps.Add(new($"s{i}", "Discord.exe", 3, 400, 450, 1));                       // always there
            if (i < 4) apps.Add(new($"s{i}", "obs64.exe", 3, 700, 900, 12));            // only in rough
            if (i is 0 or 5) apps.Add(new($"s{i}", "Hidden.exe", 3, 100, 100, 1));
            if (i == 1) apps.Add(new($"s{i}", "msedgewebview2.exe", 3, 900, 900, 1));
        }
        apps.Add(new("other", "ghost.exe", 1, 1, 1, 1)); // session not analysed

        var report = BackgroundImpact.Analyze(sessions, apps, ["hidden.exe"], collecting: true);
        Assert.Equal(("fps", 8, 4, 4, true), (report.Mode, report.SessionsAnalyzed, report.RoughSessions, report.CleanSessions, report.Enough));
        var suspect = Assert.Single(report.Suspects);
        Assert.Equal(("obs64.exe", "obs64", 1.0, 0.0, 1.0), (suspect.Name, suspect.DisplayName, suspect.RoughPresence!.Value, suspect.CleanPresence!.Value, suspect.Lift!.Value));
        Assert.Equal(700, suspect.AvgMb);
        Assert.Equal(["Discord.exe", "obs64.exe"], report.Common.Select(c => c.Name));
        Assert.Equal(["hidden.exe"], report.Hidden);
    }

    [Fact]
    public void Impact_report_falls_back_to_memory_pressure_and_is_honest_about_small_samples()
    {
        var sessions = Enumerable.Range(0, 5).Select(i => S(i, null, null, memMax: i < 2 ? 95 : 70)).ToList();
        var apps = sessions.Select(s => new BackgroundAppRow(s.SessionId, "chrome.exe", 2, 2000, 2500, 3)).ToList();
        var report = BackgroundImpact.Analyze(sessions, apps, [], collecting: true);
        Assert.Equal(("memory", 2, 3, false), (report.Mode, report.RoughSessions, report.CleanSessions, report.Enough));
        Assert.Empty(report.Suspects);
        Assert.Equal("chrome.exe", Assert.Single(report.Common).Name);

        var none = BackgroundImpact.Analyze([S(1, null, null, memMax: null)], [], [], collecting: false);
        Assert.Equal(("none", false, false), (none.Mode, none.Enough, none.Collecting));
    }

    [Fact]
    public void Rough_session_rules_cover_stutter_and_cpu_contention()
    {
        Assert.True(BackgroundImpact.IsRough(S(1, 100, 80, stutters: 90), "fps"));  // 1.5 stutters/min
        Assert.False(BackgroundImpact.IsRough(S(1, 100, 80, stutters: 30), "fps"));
        Assert.True(BackgroundImpact.IsRough(new ImpactSessionRow("x", G1, T0, 3600, 2, new PerfFields(100, 80, null, 0, 92), null, null), "fps"));
        Assert.False(BackgroundImpact.IsRough(S(1, null, null, memMax: 95), "fps"));
        Assert.True(BackgroundImpact.IsRough(S(1, null, null, memMax: 95), "memory"));
    }
}

public sealed class SessionAchievementWatcherTests : IDisposable
{
    private const string SteamId = "76561197960287930";
    private readonly TestDb _t = new();
    private readonly List<(string Name, object? Payload)> _events = [];
    private readonly DateTimeOffset _start = DateTimeOffset.UtcNow.AddHours(-1);

    public void Dispose() => _t.Dispose();

    private sealed class Sink(List<(string, object?)> list) : IEventSink
    {
        public void Emit(string eventName, object? payload) { lock (list) list.Add((eventName, payload)); }
    }

    private static SteamAchievementRow A(string api, bool achieved, DateTimeOffset? at, double pct) =>
        new(api, $"Name {api}", null, false, null, null, null, null, achieved, at, pct, 0);

    private (string GameId, SessionAchievementWatcher Watcher, List<TimeSpan> Delays) Setup(Func<int, IReadOnlyList<SteamAchievementRow>?> onRefresh, bool canRefresh = true)
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "620", "Portal 2", steamAppId: "620"))]);
        var gameId = _t.Repo.GetInstallationsByPlatformId(PlatformId.Steam, "620")!.GameId;
        _t.Repo.SaveAchievements("620", SteamId, "ok", null, [A("OLD", true, _start.AddDays(-5), 30), A("NEXT", false, null, 1.2), A("LATER", false, null, 40)]);
        var calls = 0;
        var delays = new List<TimeSpan>();
        var watcher = new SessionAchievementWatcher(_t.Repo, () => canRefresh,
            (appId, _) =>
            {
                var rows = onRefresh(calls++);
                if (rows is not null) _t.Repo.SaveAchievements(appId, SteamId, "ok", null, rows);
                return Task.FromResult(true);
            },
            (_, _, _, _) => Task.CompletedTask, _ => null, new Sink(_events))
        {
            Delay = (d, _) => { delays.Add(d); return Task.CompletedTask; },
        };
        return (gameId, watcher, delays);
    }

    [Fact]
    public async Task Reports_unlocks_from_the_session_after_retrying_once_when_steam_lags()
    {
        var (gameId, watcher, delays) = Setup(call => call == 0
            ? null // Steam hasn't caught up yet
            : [A("OLD", true, _start.AddDays(-5), 30), A("NEXT", true, _start.AddMinutes(20), 1.2), A("LATER", true, _start.AddMinutes(40), 40)]);

        var evt = await watcher.CheckAsync(new string('e', 32), gameId, _start, CancellationToken.None);

        Assert.NotNull(evt);
        Assert.Equal([SessionAchievementWatcher.FirstDelay, SessionAchievementWatcher.RetryDelay], delays);
        Assert.Equal(["NEXT", "LATER"], evt!.Items.Select(i => i.ApiName));
        Assert.Equal(("Portal 2", 2.0, 1), (evt.GameTitle, evt.RareThreshold!.Value, evt.RareCount));
        var (name, payload) = Assert.Single(_events);
        Assert.Equal("achievements.unlocked", name);
        Assert.Same(evt, payload);

        // The same session is never reported twice.
        Assert.Null(await watcher.CheckAsync(new string('e', 32), gameId, _start, CancellationToken.None));
    }

    [Fact]
    public async Task Never_reports_achievements_unlocked_before_the_session()
    {
        var (gameId, watcher, delays) = Setup(_ => [A("OLD", true, _start.AddDays(-5), 30), A("NEXT", true, _start.AddDays(-1), 1.2), A("LATER", false, null, 40)]);
        Assert.Null(await watcher.CheckAsync(new string('e', 32), gameId, _start, CancellationToken.None));
        Assert.Equal(2, delays.Count); // tried, then retried once, then gave up
        Assert.Empty(_events);
    }

    [Fact]
    public async Task Does_nothing_when_steam_may_not_be_contacted_or_the_game_is_not_from_steam()
    {
        var (gameId, watcher, delays) = Setup(_ => throw new InvalidOperationException("must not refresh"), canRefresh: false);
        Assert.Null(await watcher.CheckAsync(new string('e', 32), gameId, _start, CancellationToken.None));
        Assert.Null(await watcher.CheckAsync(new string('d', 32), new string('9', 32), _start, CancellationToken.None));
        Assert.Empty(delays);
        Assert.Empty(_events);
    }
}

public sealed class AchievementNotificationTests
{
    private static NotificationPolicy Policy(bool achievements = true) => new(key => key switch
    {
        NotificationPolicy.Achievements => achievements,
        NotificationPolicy.OnlyInBackground => true,
        _ => true,
    }, _ => "Portal 2");

    private static JsonElement Payload(int items, double? threshold, int rare) => JsonSerializer.SerializeToElement(new
    {
        sessionId = new string('b', 32),
        gameId = new string('a', 32),
        gameTitle = "Portal 2",
        items = Enumerable.Range(0, items).Select(i => new { name = $"Ach {i}" }).ToArray(),
        rareThreshold = threshold,
        rareCount = rare,
    });

    [Fact]
    public void Unlocks_become_one_notification_with_rarity()
    {
        var n = Assert.Single(Policy().Evaluate("achievements.unlocked", Payload(3, 2, 1), foreground: false));
        Assert.Equal("You unlocked 3 achievements in Portal 2", n.Title);
        Assert.StartsWith("1 is rarer than 2% of players.", n.Body);
        Assert.Contains("Ach 0, Ach 1, Ach 2", n.Body);
        Assert.Contains("\"tab\":\"achievements\"", n.RouteJson);
        Assert.Empty(Policy().Evaluate("achievements.unlocked", Payload(3, 2, 1), foreground: true)); // VYSTRAL in front: the toast is enough
    }

    [Fact]
    public void Achievement_notifications_respect_the_setting_and_show_once()
    {
        Assert.Empty(Policy(achievements: false).Evaluate("achievements.unlocked", Payload(1, null, 0), false));
        var policy = Policy();
        var single = Assert.Single(policy.Evaluate("achievements.unlocked", Payload(1, null, 0), false));
        Assert.Equal("Achievement unlocked in Portal 2", single.Title);
        Assert.Empty(policy.Evaluate("achievements.unlocked", Payload(1, null, 0), false));
        Assert.Empty(Policy().Evaluate("achievements.unlocked", Payload(0, null, 0), false));
    }
}
