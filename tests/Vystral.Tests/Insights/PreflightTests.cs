using Vystral.Core.Domain;
using Vystral.Core.Parsing;
using Vystral.Windows.Bridge;
using Vystral.Windows.Launch;
using Vystral.Windows.Monitoring;
using Xunit;

namespace Vystral.Tests.Insights;

public sealed class PreflightTests
{
    private const long Gb = 1024L * 1024 * 1024;

    private sealed class FakeCheck(string id, int delayMs, PreflightCheckDto? result, bool throws = false) : IPreflightCheck
    {
        public string Id => id;
        public async Task<PreflightCheckDto?> RunAsync(CancellationToken ct)
        {
            if (delayMs > 0) await Task.Delay(delayMs, CancellationToken.None);
            if (throws) throw new InvalidOperationException("boom");
            return result;
        }
    }

    private static PreflightCheckDto Row(string id) => new(id, id, "ok", "fine");

    [Fact]
    public async Task Runner_keeps_order_and_drops_failing_slow_and_empty_checks()
    {
        var checks = new IPreflightCheck[]
        {
            new FakeCheck("a", 0, Row("a")),
            new FakeCheck("slow", 2000, Row("slow")),
            new FakeCheck("throws", 0, Row("throws"), throws: true),
            new FakeCheck("none", 0, null),
            new FakeCheck("b", 20, Row("b")),
        };
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var results = await PreflightRunner.RunAsync(checks, TimeSpan.FromMilliseconds(300));
        Assert.True(sw.ElapsedMilliseconds < 1500, $"took {sw.ElapsedMilliseconds} ms");
        Assert.Equal(["a", "b"], results.Select(r => r.Id));
    }

    [Fact]
    public async Task Synchronous_checks_run_in_parallel_within_the_budget()
    {
        var checks = Enumerable.Range(0, 4).Select(i => (IPreflightCheck)new PreflightCheck($"c{i}", _ => { Thread.Sleep(100); return Row($"c{i}"); })).ToList();
        var results = await PreflightRunner.RunAsync(checks, TimeSpan.FromMilliseconds(300));
        Assert.Equal(4, results.Count);
    }

    [Theory]
    [InlineData(200, 1000, "ok")]
    [InlineData(9, 1000, "warn")]      // under 10 GB
    [InlineData(30, 1000, "warn")]     // 30 GB, but only 3% of the drive
    [InlineData(60, 1000, "ok")]
    [InlineData(12, 100, "ok")]
    public void Disk_warns_below_10_gb_or_5_percent(long freeGb, long totalGb, string expected)
    {
        var row = PreflightChecks.Disk(@"D:\", freeGb * Gb, totalGb * Gb);
        Assert.Equal(expected, row.Status);
        Assert.Equal("Free space on D:", row.Label);
        Assert.EndsWith("free", row.Value);
    }

    [Fact]
    public void Steam_update_pending_from_bytes_or_flags()
    {
        var pending = PreflightChecks.SteamUpdate(Vdf.Parse("""
            "AppState" { "appid" "10" "StateFlags" "6" "BytesToDownload" "2147483648" "BytesDownloaded" "1073741824" }
            """)["AppState"]!);
        Assert.Equal("warn", pending.Status);
        Assert.Contains("Steam may update before the game starts", pending.Detail);
        Assert.Contains("1.0 GB", pending.Detail);

        var byFlag = PreflightChecks.SteamUpdate(Vdf.Parse("""
            "AppState" { "StateFlags" "1028" "BytesToDownload" "0" "BytesDownloaded" "0" }
            """)["AppState"]!);
        Assert.Equal("warn", byFlag.Status);

        var fine = PreflightChecks.SteamUpdate(Vdf.Parse("""
            "AppState" { "StateFlags" "4" "BytesToDownload" "500" "BytesDownloaded" "500" "UpdateResult" "0" }
            """)["AppState"]!);
        Assert.Equal("ok", fine.Status);

        var failed = PreflightChecks.SteamUpdate(Vdf.Parse("""
            "AppState" { "StateFlags" "4" "UpdateResult" "12" }
            """)["AppState"]!);
        Assert.Equal("info", failed.Status);
        Assert.Contains("12", failed.Detail);
    }

    [Fact]
    public void Steam_probe_reads_the_manifest_next_to_the_library()
    {
        using var dir = new Support.TempDir();
        var install = dir.Dir(@"steamapps\common\Nebula");
        dir.Write(@"steamapps\appmanifest_123.acf", """ "AppState" { "appid" "123" "StateFlags" "6" } """);
        var inst = new Installation
        {
            Id = "i", GameId = "g", Platform = PlatformId.Steam, PlatformGameId = "123", Title = "Nebula", InstallPath = install,
            State = InstallState.Installed, Launch = new LaunchTarget(LaunchKind.Uri, "steam://rungameid/123"),
        };
        Assert.Equal("warn", PreflightChecks.ProbeSteamUpdate(inst)!.Status);
        Assert.Null(PreflightChecks.ProbeSteamUpdate(inst with { Platform = PlatformId.Epic }));
        Assert.Null(PreflightChecks.ProbeSteamUpdate(inst with { PlatformGameId = "../x" }));
    }

    [Fact]
    public void Controllers_report_none_battery_and_low_battery()
    {
        Assert.Equal("info", PreflightChecks.Controllers([]).Status);

        var ok = PreflightChecks.Controllers([new ControllerInfo("Xbox Wireless Controller", 80, false, true)]);
        Assert.Equal("ok", ok.Status);
        Assert.Equal("Xbox Wireless Controller · 80% battery", ok.Value);

        var low = PreflightChecks.Controllers([new ControllerInfo("Pad", 12, false, true), new ControllerInfo("Wheel", null, null, false)]);
        Assert.Equal("warn", low.Status);
        Assert.Contains("Pad", low.Detail);

        var charging = PreflightChecks.Controllers([new ControllerInfo("Pad", 5, true, true)]);
        Assert.Equal("ok", charging.Status);
    }

    [Fact]
    public void Display_shows_refresh_and_hdr_state()
    {
        Assert.Null(PreflightChecks.Display(null));
        var on = PreflightChecks.Display(new DisplayState(@"\\.\DISPLAY1", 165, true, true))!;
        Assert.Equal(("ok", "165 Hz · HDR on"), (on.Status, on.Value));
        var off = PreflightChecks.Display(new DisplayState(@"\\.\DISPLAY1", 60, true, false))!;
        Assert.Equal(("info", "60 Hz · HDR off"), (off.Status, off.Value));
        Assert.NotNull(off.Detail);
        var sdr = PreflightChecks.Display(new DisplayState(@"\\.\DISPLAY1", 144, false, false))!;
        Assert.Equal("144 Hz · SDR", sdr.Value);
    }

    [Fact]
    public void Launchers_exclude_the_needed_store_and_sum_memory()
    {
        PreflightChecks.LauncherProcess P(string n, long mb) => new(n, mb * 1024 * 1024);
        var procs = new[] { P("steam", 300), P("steamwebhelper", 200), P("EpicGamesLauncher", 250), P("EADesktop", 150), P("notepad", 999) };

        var forSteam = PreflightChecks.Launchers(procs, PlatformId.Steam);
        Assert.Equal("info", forSteam.Status);
        Assert.Equal("2 running · 400 MB", forSteam.Value);
        Assert.DoesNotContain("Steam", forSteam.Detail);
        Assert.Contains("never closes", forSteam.Detail);

        var forEpic = PreflightChecks.Launchers(procs, PlatformId.Epic);
        Assert.Equal("2 running · 650 MB", forEpic.Value);

        Assert.Equal("ok", PreflightChecks.Launchers([P("steam", 100)], PlatformId.Steam).Status);
        Assert.Equal("warn", PreflightChecks.Launchers([P("EpicGamesLauncher", 1600)], PlatformId.Steam).Status);
    }
}
