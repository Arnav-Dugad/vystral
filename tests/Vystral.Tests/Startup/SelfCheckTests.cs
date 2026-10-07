using Vystral.Tests.Support;
using Vystral.Windows.Services.Maintenance;
using Vystral.Windows.Services.Rollback;
using Xunit;

namespace Vystral.Tests.Startup;

/// <summary>Track AA: the after-update self-check — when it runs, what each outcome means, and how it feeds rollback.</summary>
public sealed class SelfCheckTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 7, 12, 0, 0, TimeSpan.Zero);

    private sealed class FakeProbes : ISelfCheckProbes
    {
        public string? DatabaseStartupProblem { get; set; }
        public int Schema { get; set; } = 7;
        public int LatestSchemaVersion { get; set; } = 7;
        public Func<string> Quick { get; set; } = () => "ok";
        public Action Art { get; set; } = () => { };
        public Func<int> Settings { get; set; } = () => 81;
        public Func<CancellationToken, Task<bool?>> Bridge { get; set; } = _ => Task.FromResult<bool?>(true);
        public double? ReadyAfterMs { get; set; } = 840;
        public int SchemaVersion() => Schema;
        public string QuickCheck() => Quick();
        public void ProbeArtCache() => Art();
        public int LoadSettings() => Settings();
        public Task<bool?> BridgeRoundTripAsync(CancellationToken ct) => Bridge(ct);
    }

    private static Task<SelfCheckReport> Run(FakeProbes p, bool manual = false) =>
        SelfCheckRunner.RunAsync(p, "0.7.0", manual, Now, CancellationToken.None, TimeSpan.FromMilliseconds(300), TimeSpan.FromMilliseconds(300));

    private static CheckOutcome Outcome(SelfCheckReport r, string id) => r.Checks.Single(c => c.Id == id).Outcome;

    [Fact]
    public async Task A_healthy_install_passes_six_of_six()
    {
        var r = await Run(new FakeProbes());
        Assert.Equal(6, r.Total);
        Assert.Equal(6, r.Passed);
        Assert.False(r.HardFailure);
        Assert.Equal(["database", "integrity", "bridge", "uiReady", "artCache", "settings"], r.Checks.Select(c => c.Id));
        Assert.Contains("0.8 s", r.Checks.Single(c => c.Id == "uiReady").Detail);
    }

    [Fact]
    public async Task Data_and_environment_problems_are_reported_but_never_roll_back()
    {
        var r = await Run(new FakeProbes
        {
            DatabaseStartupProblem = "reset",
            Quick = () => "*** in database main ***\nPage 12 is never used",
            Art = () => throw new UnauthorizedAccessException(),
        });
        Assert.Equal(CheckOutcome.Failed, Outcome(r, "database"));
        Assert.Equal(CheckOutcome.Failed, Outcome(r, "integrity"));
        Assert.Equal(CheckOutcome.Failed, Outcome(r, "artCache"));
        Assert.Equal(3, r.Passed);
        Assert.False(r.HardFailure);
    }

    [Fact]
    public async Task An_outdated_schema_fails_the_database_check()
    {
        var r = await Run(new FakeProbes { Schema = 6 });
        Assert.Equal(CheckOutcome.Failed, Outcome(r, "database"));
        Assert.Contains("expected 7", r.Checks[0].Detail);
    }

    [Fact]
    public async Task Slowness_is_never_a_failure()
    {
        var r = await Run(new FakeProbes
        {
            Quick = () => { Thread.Sleep(2_000); return "ok"; },
            Bridge = async ct => { await Task.Delay(Timeout.Infinite, ct); return true; },
        });
        Assert.Equal(CheckOutcome.Skipped, Outcome(r, "integrity"));
        Assert.Equal(CheckOutcome.Skipped, Outcome(r, "bridge"));
        Assert.False(r.HardFailure);

        var unanswered = await Run(new FakeProbes { Bridge = _ => Task.FromResult<bool?>(null) });
        Assert.Equal(CheckOutcome.Skipped, Outcome(unanswered, "bridge"));
        Assert.False(unanswered.HardFailure);
    }

    [Fact]
    public async Task A_changed_round_trip_or_unreadable_settings_count_as_a_failed_start()
    {
        var bridge = await Run(new FakeProbes { Bridge = _ => Task.FromResult<bool?>(false) });
        Assert.Equal(CheckOutcome.Failed, Outcome(bridge, "bridge"));
        Assert.True(bridge.HardFailure);

        var settings = await Run(new FakeProbes { Settings = () => throw new InvalidOperationException() });
        Assert.Equal(CheckOutcome.Failed, Outcome(settings, "settings"));
        Assert.True(settings.HardFailure);

        var thrown = await Run(new FakeProbes { Bridge = _ => throw new InvalidOperationException("boom") });
        Assert.Equal(CheckOutcome.Failed, Outcome(thrown, "bridge"));
    }

    [Fact]
    public async Task A_check_run_from_Settings_never_counts_toward_rollback()
    {
        var r = await Run(new FakeProbes { Bridge = _ => Task.FromResult<bool?>(false) }, manual: true);
        Assert.Equal(CheckOutcome.Failed, Outcome(r, "bridge"));
        Assert.False(r.HardFailure);
    }

    private static SelfCheckReport Report(string version, bool hardFail = false, bool manual = false) => new(version, Now.ToString("O"), manual,
        [new SelfCheckItem("bridge", "Bridge", hardFail ? CheckOutcome.Failed : CheckOutcome.Passed, "", true),
         new SelfCheckItem("integrity", "Integrity", CheckOutcome.Failed, "", false)]);

    [Fact]
    public void Runs_on_the_first_start_of_each_version_and_again_only_after_a_real_failure()
    {
        var s = new SelfCheckState();
        Assert.True(SelfCheckPolicy.ShouldRun(s, "0.7.0"));               // new install or first start after an update
        s = SelfCheckPolicy.Add(s, Report("0.7.0"));
        Assert.False(SelfCheckPolicy.ShouldRun(s, "0.7.0"));              // passed (a data-only failure doesn't re-run)
        Assert.True(SelfCheckPolicy.ShouldRun(s, "0.7.1"));               // the next update

        var failing = SelfCheckPolicy.Add(new SelfCheckState(), Report("0.7.0", hardFail: true));
        Assert.True(SelfCheckPolicy.ShouldRun(failing, "0.7.0"));         // re-checked until it passes
        for (var i = 1; i < SelfCheckPolicy.MaxAutomaticRunsPerVersion; i++) failing = SelfCheckPolicy.Add(failing, Report("0.7.0", hardFail: true));
        Assert.False(SelfCheckPolicy.ShouldRun(failing, "0.7.0"));        // but not forever

        var manualOnly = SelfCheckPolicy.Add(new SelfCheckState(), Report("0.7.0", manual: true));
        Assert.True(SelfCheckPolicy.ShouldRun(manualOnly, "0.7.0"));      // a Settings run isn't the after-update check
    }

    [Fact]
    public void History_is_capped_and_latest_prefers_the_running_version()
    {
        var s = new SelfCheckState();
        for (var i = 0; i < 12; i++) s = SelfCheckPolicy.Add(s, Report($"0.6.{i}"));
        Assert.Equal(SelfCheckPolicy.MaxReports, s.Reports.Count);
        Assert.Equal("0.6.11", SelfCheckPolicy.Latest(s, "0.7.0")!.Version);
        s = SelfCheckPolicy.Add(s, Report("0.7.0"));
        s = SelfCheckPolicy.Add(s, Report("0.6.11"));
        Assert.Equal("0.7.0", SelfCheckPolicy.Latest(s, "0.7.0")!.Version);
    }

    [Fact]
    public void Store_round_trips_and_survives_a_corrupt_file()
    {
        using var dir = new TempDir();
        var store = new SelfCheckStore(dir.Path);
        store.Add(Report("0.7.0", hardFail: true));
        var loaded = store.Load();
        Assert.Single(loaded.Reports);
        Assert.Equal(CheckOutcome.Failed, loaded.Reports[0].Checks[0].Outcome);
        Assert.True(loaded.Reports[0].HardFailure);
        Assert.True(File.Exists(Path.Combine(dir.Path, "update", "self-check.json")));

        File.WriteAllText(store.FilePath, "{ not json");
        Assert.Empty(store.Load().Reports);
    }

    /// <summary>
    /// How a hard failure feeds the existing rollback: that start is never confirmed (no OnStartSucceeded, and a clean
    /// exit is recorded as "not ready"), so it counts as a failed start. Two in a row, and the third start rolls back.
    /// </summary>
    [Fact]
    public void Two_starts_with_a_failed_self_check_roll_back_on_the_third()
    {
        var t = Now;
        StartContext Ctx(string v) => new(v, true, false, "0.6.0", t = t.AddMinutes(1));
        var (l, d) = StartupGuard.OnStart(new StartupLedger(), Ctx("0.6.0"));
        l = StartupGuard.OnStartSucceeded(l, "0.6.0");

        for (var start = 1; start <= 2; start++)
        {
            (l, d) = StartupGuard.OnStart(l, Ctx("0.7.0"));
            Assert.Equal(StartAction.Proceed, d.Action);
            // The UI got ready, but the self-check failed: AppBackend skips MarkSucceeded and reports uiWasReady=false on exit.
            l = StartupGuard.OnCleanExit(l, "0.7.0", uiWasReady: false);
        }
        (l, d) = StartupGuard.OnStart(l, Ctx("0.7.0"));
        Assert.Equal(StartAction.RollBack, d.Action);
        Assert.Equal("0.6.0", d.TargetVersion);
    }

    [Fact]
    public void A_passing_self_check_after_one_failure_confirms_the_version()
    {
        var t = Now;
        StartContext Ctx(string v) => new(v, true, false, "0.6.0", t = t.AddMinutes(1));
        var (l, _) = StartupGuard.OnStart(new StartupLedger(), Ctx("0.6.0"));
        l = StartupGuard.OnStartSucceeded(l, "0.6.0");
        (l, _) = StartupGuard.OnStart(l, Ctx("0.7.0"));
        l = StartupGuard.OnCleanExit(l, "0.7.0", uiWasReady: false); // failed self-check
        (l, _) = StartupGuard.OnStart(l, Ctx("0.7.0"));
        l = StartupGuard.OnStartSucceeded(l, "0.7.0");               // re-checked, passed, confirmed after 20 s
        var (_, d) = StartupGuard.OnStart(l, Ctx("0.7.0"));
        Assert.Equal(StartAction.Proceed, d.Action);
        Assert.True(l.EverSucceeded);
    }
}
