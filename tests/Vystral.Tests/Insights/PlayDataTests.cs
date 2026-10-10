using System.Text.Json;
using Dapper;
using Microsoft.Data.Sqlite;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Insights;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Launch;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Insights;

/// <summary>Track Y: migration 8, hardware history, the energy model and controller battery history.</summary>
public sealed class PlayDataRepositoryTests : IDisposable
{
    private readonly TestDb _t = new();
    private static readonly DateTimeOffset T0 = new(2026, 3, 1, 18, 0, 0, TimeSpan.Zero);

    public void Dispose() => _t.Dispose();

    private (string GameId, string InstallationId) Game(string appId, string title)
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, appId, title, steamAppId: appId))]);
        var inst = _t.Repo.GetInstallationsByPlatformId(PlatformId.Steam, appId)!;
        return (inst.GameId, inst.Id);
    }

    private string Session(string gameId, string instId, DateTimeOffset start, int seconds, string? perf = null)
    {
        var id = _t.Repo.StartSession(gameId, instId, start);
        _t.Repo.EndSession(id, start.AddSeconds(seconds), seconds, perf);
        return id;
    }

    [Fact]
    public void Migration_8_upgrades_a_version_7_database_without_touching_sessions()
    {
        using var dir = new TempDir();
        var path = Path.Combine(dir.Path, "v7.db");
        var db = new Database(path);
        using (var conn = db.Open())
        {
            conn.Execute("CREATE TABLE schema_version (version INTEGER NOT NULL, applied TEXT NOT NULL, name TEXT NOT NULL);");
            foreach (var (version, name, sql) in Migrations.All.Where(m => m.Version <= 7))
            {
                conn.Execute(sql);
                conn.Execute("INSERT INTO schema_version VALUES (@version, '2026-01-01', @name)", new { version, name });
            }
            conn.Execute("INSERT INTO games(id, title, sort_title, added, updated) VALUES ('g1', 'Game', 'game', '2026-01-01', '2026-01-01')");
            conn.Execute("INSERT INTO sessions(id, game_id, start, end, duration_seconds, source) VALUES ('s1', 'g1', '2026-01-02T10:00:00.0000000+00:00', '2026-01-02T11:00:00.0000000+00:00', 3600, 'tracked')");
        }

        Assert.Equal(7, db.Migrate());
        Assert.Equal(Database.LatestVersion, db.SchemaVersion()); // later migrations (Track C1: 9) run too
        using (var conn = db.Open())
        {
            var row = conn.QuerySingle<(long Duration, long? W, long? Hz, long? Hdr)>("SELECT duration_seconds, display_width, display_hz, display_hdr FROM sessions WHERE id='s1'");
            Assert.Equal((3600L, (long?)null, (long?)null, (long?)null), row);
            Assert.Equal(0, conn.ExecuteScalar<long>("SELECT COUNT(*) FROM controller_battery"));
        }
        TestDb.ReleasePool(db);
    }

    [Fact]
    public void Display_is_stored_sanitised_and_read_back_with_the_driver()
    {
        var (g, i) = Game("620", "Portal 2");
        var a = Session(g, i, T0, 3600);
        var b = Session(g, i, T0.AddDays(2), 1800);
        _t.Repo.SetSessionGpu(a, "572.16", "NVIDIA GeForce RTX 4070");
        _t.Repo.SetSessionDisplay(a, new SessionDisplay(2560, 1440, 165, true));
        _t.Repo.SetSessionDisplay(b, new SessionDisplay(99999, 1440, 5, null)); // nonsense width and rate are dropped

        var rows = _t.Repo.GetHardwareSessions(g);
        Assert.Equal(2, rows.Count);
        Assert.Equal((2560, 1440, 165, true, "572.16"), (rows[0].Width!.Value, rows[0].Height!.Value, rows[0].RefreshHz!.Value, rows[0].Hdr!.Value, rows[0].GpuDriver));
        Assert.Null(rows[1].Width);
        Assert.Null(rows[1].RefreshHz);
        Assert.Null(rows[1].Hdr);
        Assert.Empty(_t.Repo.GetHardwareSessions(new string('f', 32)));
    }

    [Fact]
    public void Battery_readings_round_trip_prune_and_clear_and_survive_history_deletion()
    {
        _t.Repo.AddBatteryReading(new BatteryReading("pad1", "Xbox Wireless Controller", 80, false, T0));
        _t.Repo.AddBatteryReading(new BatteryReading("pad1", "Xbox Wireless Controller", 74, false, T0.AddMinutes(10)));
        _t.Repo.AddBatteryReading(new BatteryReading("pad2", "DualSense", 140, true, T0.AddMinutes(5))); // clamped to 100
        _t.Repo.AddBatteryReading(new BatteryReading("pad1", "Old", 90, false, T0.AddDays(-100)));

        var all = _t.Repo.GetBatteryReadings(T0.AddDays(-200));
        Assert.Equal(4, all.Count);
        Assert.Equal(100, all.Single(r => r.Pad == "pad2").Percent);
        var latest = _t.Repo.GetLatestBatteryReadings();
        Assert.Equal(74, latest["pad1"].Percent);
        Assert.True(latest["pad2"].Charging);

        Assert.Equal(1, _t.Repo.PruneBatteryReadings(T0.AddDays(-90)));
        _t.Repo.DeleteTrackedHistory();
        Assert.Equal(3, _t.Repo.GetBatteryReadings(T0.AddDays(-1)).Count);
        Assert.Equal(3, _t.Repo.ClearBatteryReadings());
        Assert.Empty(_t.Repo.GetBatteryReadings(T0.AddDays(-1)));
    }

    [Fact]
    public void Battery_service_keeps_sparse_readings()
    {
        var svc = new ControllerBatteryService(_t.Repo, () => true);
        BatteryReading R(int minutes, int pct, bool charging = false) => new("pad", "Pad", pct, charging, T0.AddMinutes(minutes));
        Assert.Equal(1, svc.Observe([R(0, 90)]));
        Assert.Equal(0, svc.Observe([R(1, 89)]));   // a minute later, one point: skipped
        Assert.Equal(0, svc.Observe([R(9, 88)]));
        Assert.Equal(1, svc.Observe([R(10, 88)]));  // ten minutes since the last kept reading
        Assert.Equal(1, svc.Observe([R(11, 83)]));  // moved five points
        Assert.Equal(1, svc.Observe([R(12, 83, charging: true)])); // started charging
        Assert.Equal(4, _t.Repo.GetBatteryReadings(T0.AddDays(-1)).Count);

        // A new service (app restart) continues from the stored newest reading.
        var again = new ControllerBatteryService(_t.Repo, () => true);
        Assert.Equal(0, again.Observe([R(13, 83, charging: true)]));
    }

    [Fact]
    public void Energy_sessions_come_from_finished_observed_sessions()
    {
        var (g, i) = Game("620", "Portal 2");
        var s = Session(g, i, T0, 7200, JsonSerializer.Serialize(new { gpuAvg = 80.0, cpuAvg = 40.0 }));
        _t.Repo.SetSessionGpu(s, "572.16", "NVIDIA GeForce RTX 4070");
        _t.Repo.StartSession(g, i, T0.AddDays(1)); // still running: excluded
        var row = Assert.Single(_t.Repo.GetEnergySessions());
        Assert.Equal(("NVIDIA GeForce RTX 4070", 7200), (row.GpuName, row.DurationSeconds));
        Assert.Single(_t.Repo.GetEnergySessions(g));
    }
}

public sealed class HardwareHistoryTests
{
    private static readonly DateTimeOffset T0 = new(2026, 3, 1, 18, 0, 0, TimeSpan.Zero);

    private static HardwareSessionRow Row(int day, string? driver, int? w = null, int? h = null, int? hz = null, bool? hdr = null, string? gpu = "RTX 4070") =>
        new($"s{day}", "g", T0.AddDays(day), 3600, driver, gpu, w, h, hz, hdr);

    [Fact]
    public void Changes_are_found_only_between_known_values()
    {
        var history = HardwareHistory.Build([
            Row(3, "572.16", 2560, 1440, 165, false),
            Row(0, "566.36", 1920, 1080, 144, false),   // out of order on purpose
            Row(1, null),                               // nothing recorded: not a change
            Row(2, "566.36", 1920, 1080, 144, null),
            Row(5, "572.16", 2560, 1440, 165, true),
            Row(6, "572.16", 2560, 1440, 120, true, gpu: "RTX 5080"),
        ]);

        Assert.Equal(["s0", "s1", "s2", "s3", "s5", "s6"], history.Sessions.Select(s => s.SessionId));
        Assert.Equal(
            [("driver", "s3", "566.36", "572.16"), ("display", "s3", "1920 × 1080 · 144 Hz", "2560 × 1440 · 165 Hz"), ("hdr", "s5", "HDR off", "HDR on"),
             ("gpu", "s6", "RTX 4070", "RTX 5080"), ("display", "s6", "2560 × 1440 · 165 Hz", "2560 × 1440 · 120 Hz")],
            history.Changes.Select(c => (c.Kind, c.SessionId, c.From, c.To)));
        var drivers = history.Spans.Where(s => s.Lane == "driver").ToList();
        Assert.Equal([("566.36", 2), ("572.16", 3)], drivers.Select(s => (s.Value, s.Sessions)));
        Assert.Equal(T0.AddDays(2), DateTimeOffset.Parse(drivers[0].To));
        Assert.Equal(3, history.Spans.Count(s => s.Lane == "display"));
        Assert.Equal((5, 5), (history.WithDriver, history.WithDisplay));
    }

    [Fact]
    public void Empty_and_unknown_history_has_no_changes()
    {
        var empty = HardwareHistory.Build([]);
        Assert.Empty(empty.Sessions);
        Assert.Empty(empty.Changes);
        var unknown = HardwareHistory.Build([Row(0, null, gpu: null), Row(1, " ", gpu: null)]);
        Assert.Empty(unknown.Changes);
        Assert.Empty(unknown.Spans);
        Assert.Equal(0, unknown.WithDriver);
    }

    [Theory]
    [InlineData(2560, 1440, 165, "2560 × 1440 · 165 Hz")]
    [InlineData(null, null, 60, "60 Hz")]
    [InlineData(1920, 1080, null, "1920 × 1080")]
    [InlineData(null, 1080, null, null)]
    public void Display_label(int? w, int? h, int? hz, string? expected) => Assert.Equal(expected, SessionDisplay.Label(w, h, hz));
}

public sealed class EnergyModelTests
{
    [Theory]
    [InlineData("NVIDIA GeForce RTX 4090", "desktop", 450)]
    [InlineData("NVIDIA GeForce RTX 4070 SUPER", "desktop", 220)]
    [InlineData("NVIDIA GeForce RTX 4070 Ti SUPER", "desktop", 285)]
    [InlineData("NVIDIA GeForce RTX 4060 Laptop GPU", "laptop", 100)]
    [InlineData("NVIDIA GeForce GTX 1650", "desktop", 75)]
    [InlineData("AMD Radeon RX 7900 XTX", "desktop", 355)]
    [InlineData("AMD Radeon RX 9070 XT", "desktop", 304)]
    [InlineData("AMD Radeon RX 7600S", "laptop", 100)]
    [InlineData("AMD Radeon(TM) Graphics", "integrated", 25)]
    [InlineData("Intel(R) Iris(R) Xe Graphics", "integrated", 25)]
    [InlineData("Intel(R) Arc(TM) B580 Graphics", "desktop", 190)]
    [InlineData("NVIDIA GeForce RTX 6070", "desktop", 220)] // future card: by tier
    public void Gpu_classes(string name, string cls, double watts)
    {
        var (c, w, _, known) = EnergyModel.GpuPower(name);
        Assert.Equal((cls, watts, true), (c, w, known));
    }

    [Fact]
    public void Unknown_gpu_and_cpu_fall_back_to_typical_values()
    {
        Assert.Equal(("unknown", EnergyModel.UnknownDesktopGpuWatts, false), (EnergyModel.GpuPower("Some Card").Class, EnergyModel.GpuPower("Some Card").Watts, EnergyModel.GpuPower("Some Card").Known));
        Assert.False(EnergyModel.GpuPower(null).Known);
        Assert.Equal((EnergyModel.UnknownCpuWatts, false, false), EnergyModel.CpuPower("Mystery CPU"));
    }

    [Theory]
    [InlineData("Intel(R) Core(TM) i7-13700K", 125, false)]
    [InlineData("13th Gen Intel(R) Core(TM) i7-13700H", 45, true)]
    [InlineData("Intel(R) Core(TM) Ultra 7 155H", 45, true)]
    [InlineData("Intel(R) Core(TM) Ultra 9 285K", 125, false)]
    [InlineData("Intel(R) Core(TM) i5-1235U", 20, true)]
    [InlineData("AMD Ryzen 7 7800X3D 8-Core Processor", 120, false)]
    [InlineData("AMD Ryzen 9 7945HX with Radeon Graphics", 75, true)]
    [InlineData("AMD Ryzen 5 5600X 6-Core Processor", 105, false)]
    [InlineData("AMD Ryzen 5 5600 6-Core Processor", 65, false)]
    public void Cpu_classes(string name, double watts, bool laptop)
    {
        var (w, l, known) = EnergyModel.CpuPower(name);
        Assert.Equal((watts, laptop, true), (w, l, known));
    }

    [Fact]
    public void Power_model_is_linear_in_load_and_respects_manual_wattage()
    {
        var p = EnergyModel.Profile("NVIDIA GeForce RTX 4070", "AMD Ryzen 7 7800X3D", null);
        Assert.False(p.Laptop);
        // 50 + 200 × (0.2 + 0.8 × 1) + 120 × (0.25 + 0.75 × 0.5) = 50 + 200 + 75 = 325 W
        Assert.Equal(325, EnergyModel.Watts(p, 1, 0.5), 6);
        Assert.Equal(50 + 200 * 0.2 + 120 * 0.25, EnergyModel.Watts(p, 0, 0), 6);
        Assert.Equal(EnergyModel.Watts(p, 1, 1), EnergyModel.Watts(p, 3, 7), 6); // clamped

        // Linear: the average of per-sample power equals power at the average load.
        double[] g = [0.2, 0.9, 1.0, 0.5];
        double[] c = [0.1, 0.4, 0.6, 0.3];
        var perSample = g.Zip(c).Average(x => EnergyModel.Watts(p, x.First, x.Second));
        Assert.Equal(perSample, EnergyModel.Watts(p, g.Average(), c.Average()), 6);

        var manual = EnergyModel.Profile("NVIDIA GeForce RTX 4070", null, 400);
        Assert.Equal(400, EnergyModel.Watts(manual, 1, 1), 6);
        Assert.Equal(120, EnergyModel.Watts(manual, 0, 0), 6);
        Assert.Null(EnergyModel.Profile(null, null, 0).ManualWatts);
    }

    [Fact]
    public void Session_energy_uses_duration_and_marks_assumed_loads()
    {
        var p = EnergyModel.Profile("NVIDIA GeForce RTX 4070", "AMD Ryzen 7 7800X3D", null);
        var full = EnergyModel.Session(p, 7200, 100, 50)!.Value;
        Assert.Equal(0.65, full.KWh, 6); // 325 W for two hours
        Assert.False(full.Partial);
        Assert.True(EnergyModel.Session(p, 3600, null, 50)!.Value.Partial);
        Assert.Null(EnergyModel.Session(p, 3600, null, null));
        Assert.Null(EnergyModel.Session(p, 0, 50, 50));
        Assert.Equal((80.0, 40.0), EnergyModel.Loads("""{"gpuAvg":80,"cpuAvg":40}""") is (double gg, double cc) ? (gg, cc) : (0, 0));
        Assert.Equal((null, null), EnergyModel.Loads("not json"));
        Assert.Equal((100.0, null), EnergyModel.Loads("""{"gpuAvg":250}"""));
    }

    [Fact]
    public void Report_aggregates_per_game_and_per_local_month()
    {
        var zone = TimeZoneInfo.CreateCustomTimeZone("UTC+10", TimeSpan.FromHours(10), "UTC+10", "UTC+10");
        string Perf(double gpu, double cpu) => JsonSerializer.Serialize(new { gpuAvg = gpu, cpuAvg = cpu });
        var rows = new List<EnergySessionRow>
        {
            // 31 Jan 20:00 UTC is 1 Feb 06:00 at UTC+10: February.
            new("a", "g1", new DateTimeOffset(2026, 1, 31, 20, 0, 0, TimeSpan.Zero), 3600, Perf(100, 50), "NVIDIA GeForce RTX 4070"),
            new("b", "g1", new DateTimeOffset(2026, 1, 15, 10, 0, 0, TimeSpan.Zero), 7200, Perf(100, 50), null),
            new("c", "g2", new DateTimeOffset(2026, 2, 3, 10, 0, 0, TimeSpan.Zero), 3600, Perf(0, 0), "NVIDIA GeForce RTX 4090"),
            new("d", "g2", new DateTimeOffset(2026, 2, 4, 10, 0, 0, TimeSpan.Zero), 3600, null, null), // metrics off
        };
        var r = EnergyModel.Build(rows, "NVIDIA GeForce RTX 4070", "AMD Ryzen 7 7800X3D", null, 0.30, "EUR", zone);

        Assert.True(r.Enabled);
        Assert.Equal((3, 1, 0), (r.Sessions, r.Excluded, r.Partial));
        // a: 0.325, b: 0.65 (current GPU), c: (50 + 450 × 0.2 + 120 × 0.25) W × 1 h = 0.17
        Assert.Equal(0.325 + 0.65 + 0.17, r.TotalKWh, 4);
        Assert.Equal(["2026-01", "2026-02"], r.Months.Select(m => m.Month));
        Assert.Equal(0.65, r.Months[0].KWh, 4);
        Assert.Equal(0.495, r.Months[1].KWh, 4);
        Assert.Equal(["g1", "g2"], r.Games.Select(g => g.GameId));
        Assert.Equal((2, 3.0), (r.Games[0].Sessions, r.Games[0].Hours));
        Assert.Equal(["c", "a", "b"], r.SessionList.Select(s => s.SessionId)); // newest first
        Assert.Equal((0.30, "EUR"), (r.Price!.Value, r.Currency));
        Assert.Equal(("typical", 200.0), (r.Method!.Source, r.Method.GpuWatts));

        var none = EnergyModel.Build(rows, null, null, 500, 0, "", zone);
        Assert.Null(none.Price);
        Assert.Null(none.Currency);
        Assert.Equal("manual", none.Method!.Source);
    }
}

public sealed class BatteryHistoryTests
{
    private static readonly DateTimeOffset T0 = new(2026, 3, 1, 18, 0, 0, TimeSpan.Zero);
    private static BatteryReading R(int minutes, int pct, bool charging = false, string pad = "p") => new(pad, "Pad", pct, charging, T0.AddMinutes(minutes));

    [Fact]
    public void Recording_policy()
    {
        Assert.True(BatteryHistory.ShouldRecord(null, R(0, 50)));
        Assert.False(BatteryHistory.ShouldRecord(R(0, 50), R(9, 47)));
        Assert.True(BatteryHistory.ShouldRecord(R(0, 50), R(10, 50)));
        Assert.True(BatteryHistory.ShouldRecord(R(0, 50), R(1, 45)));
        Assert.True(BatteryHistory.ShouldRecord(R(0, 50), R(1, 50, charging: true)));
    }

    [Fact]
    public void Drain_rate_skips_charging_gaps_and_rises()
    {
        // 100 → 90 over an hour, then charging, then a long gap, then 80 → 75 over 30 minutes.
        var readings = new[]
        {
            R(0, 100), R(20, 96), R(40, 92), R(60, 90),
            R(70, 91, charging: true), R(80, 95, charging: true),
            R(300, 80), R(315, 78), R(330, 75),
        };
        // (10 + 5) points over 1.5 h
        Assert.Equal(10, BatteryHistory.DrainPerHour(readings));
        Assert.Null(BatteryHistory.DrainPerHour([R(0, 100), R(20, 98)])); // too little to go on
        Assert.Equal(270, BatteryHistory.MinutesLeft(45, 10, false));
        Assert.Null(BatteryHistory.MinutesLeft(45, 10, true));
        Assert.Null(BatteryHistory.MinutesLeft(45, null, false));
    }

    [Fact]
    public void Build_groups_pads_and_limits_points_to_the_window()
    {
        var readings = Enumerable.Range(0, 30).Select(i => R(i * 10, 100 - i)).Concat([R(5, 60, pad: "q")]).ToList();
        var pads = BatteryHistory.Build(readings, T0.AddMinutes(100), maxPoints: 10);
        // q's only reading is before the window, so it has nothing to chart.
        var p = Assert.Single(pads);
        Assert.Equal("p", p.Pad);
        Assert.Equal(10, p.Points.Count);
        Assert.Equal(71, p.Points[^1].Percent);
        Assert.Equal(71, p.Latest);
        Assert.Equal(6, p.DrainPerHour);
        Assert.Equal(710, p.MinutesLeft);
        Assert.Equal(2, BatteryHistory.Build(readings, T0, maxPoints: 10).Count);
    }

    [Fact]
    public void Preflight_warns_from_the_usual_drain()
    {
        ControllerInfo Pad(int pct, bool? charging = false) => new("Xbox Wireless Controller", pct, charging, true, "k1");
        // 40% at 30 points an hour: 80 minutes left → warn above the 20% threshold.
        var soon = PreflightChecks.Controllers([Pad(40)], _ => 30);
        Assert.Equal("warn", soon.Status);
        Assert.Contains("1 h 20 min", soon.Detail);
        Assert.Equal("ok", PreflightChecks.Controllers([Pad(80)], _ => 30).Status);
        Assert.Equal("ok", PreflightChecks.Controllers([Pad(40, charging: true)], _ => 30).Status);
        Assert.Equal("ok", PreflightChecks.Controllers([Pad(40)], _ => null).Status);
        var low = PreflightChecks.Controllers([Pad(10)], _ => 20);
        Assert.Equal("warn", low.Status);
        Assert.Contains("about 30 min left", low.Detail);
        // Without history, the original message is unchanged.
        Assert.Equal("Xbox Wireless Controller is low on battery. Charge it or swap the batteries before a long session.",
            PreflightChecks.Controllers([Pad(10)]).Detail);
        Assert.Equal("ok", PreflightChecks.Controllers([Pad(40)], _ => throw new InvalidOperationException()).Status);
    }

    [Theory]
    [InlineData(45, "45 min")]
    [InlineData(80, "1 h 20 min")]
    [InlineData(121, "2 h")]
    [InlineData(250, "4 h")]
    public void Minutes_format(int minutes, string expected) => Assert.Equal(expected, PreflightChecks.FormatMinutes(minutes));

    [Fact]
    public void Controller_keys_are_stable_opaque_and_distinct()
    {
        var a = ControllerKeys.For(@"{device-a}", "Pad");
        Assert.Equal(a, ControllerKeys.For(@"{device-a}", "Other name"));
        Assert.NotEqual(a, ControllerKeys.For(@"{device-b}", "Pad"));
        Assert.Matches("^[0-9a-f]{16}$", a);
        Assert.DoesNotContain("device", a);
        Assert.NotEqual(ControllerKeys.For(null, "Pad"), ControllerKeys.For(null, "Pad 2"));
    }
}
