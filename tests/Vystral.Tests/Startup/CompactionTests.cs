using Dapper;
using Vystral.Tests.Support;
using Vystral.Windows.Services.Maintenance;
using Xunit;

namespace Vystral.Tests.Startup;

/// <summary>Track AA: when the monthly compaction runs, and that it really compacts (and handles locks).</summary>
public sealed class CompactionTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 7, 3, 0, 0, TimeSpan.Zero);
    private const long Mb = 1024 * 1024;

    private static CompactionContext Ctx(bool auto = true, bool ac = true, double idleMin = 30, bool game = false, bool tracker = false,
        bool safe = false, long db = 50 * Mb, long free = 10_000 * Mb, bool manual = false, DateTimeOffset? now = null) =>
        new(now ?? Now, auto, ac, TimeSpan.FromMinutes(idleMin), game, tracker, safe, db, free, manual);

    private static CompactionState LastRun(int daysAgo) => new() { LastRunAt = Now.AddDays(-daysAgo).ToString("O"), LastOutcome = "compacted", LastAttemptAt = Now.AddDays(-daysAgo).ToString("O") };

    [Fact]
    public void Never_compacted_and_all_conditions_met_runs()
    {
        Assert.Equal(new CompactionDecision(true, CompactionBlock.None), CompactionPolicy.Decide(new CompactionState(), Ctx()));
        Assert.Null(CompactionPolicy.NextDue(new CompactionState()));
    }

    [Theory]
    [InlineData(29, false)]
    [InlineData(30, true)]
    [InlineData(45, true)]
    public void Runs_about_once_a_month(int daysAgo, bool runs)
    {
        var d = CompactionPolicy.Decide(LastRun(daysAgo), Ctx());
        Assert.Equal(runs, d.Run);
        if (!runs) Assert.Equal(CompactionBlock.NotDue, d.Reason);
        Assert.Equal(Now.AddDays(-daysAgo + 30), CompactionPolicy.NextDue(LastRun(daysAgo)));
    }

    [Fact]
    public void Each_quiet_condition_blocks_an_automatic_run()
    {
        var s = new CompactionState();
        Assert.Equal(CompactionBlock.Disabled, CompactionPolicy.Decide(s, Ctx(auto: false)).Reason);
        Assert.Equal(CompactionBlock.OnBattery, CompactionPolicy.Decide(s, Ctx(ac: false)).Reason);
        Assert.Equal(CompactionBlock.NotIdle, CompactionPolicy.Decide(s, Ctx(idleMin: 9.9)).Reason);
        Assert.Equal(CompactionBlock.GameRunning, CompactionPolicy.Decide(s, Ctx(game: true)).Reason);
        Assert.Equal(CompactionBlock.TrackerActive, CompactionPolicy.Decide(s, Ctx(tracker: true)).Reason);
        Assert.Equal(CompactionBlock.SafeMode, CompactionPolicy.Decide(s, Ctx(safe: true)).Reason);
        Assert.Equal(CompactionBlock.LowDisk, CompactionPolicy.Decide(s, Ctx(db: 50 * Mb, free: 99 * Mb)).Reason);
        Assert.True(CompactionPolicy.Decide(s, Ctx(db: 50 * Mb, free: 100 * Mb)).Run);
    }

    [Fact]
    public void Compact_now_skips_the_schedule_but_never_the_safety_rules()
    {
        var recent = LastRun(2);
        Assert.True(CompactionPolicy.Decide(recent, Ctx(manual: true, auto: false, ac: false, idleMin: 0)).Run);
        Assert.Equal(CompactionBlock.GameRunning, CompactionPolicy.Decide(recent, Ctx(manual: true, game: true)).Reason);
        Assert.Equal(CompactionBlock.TrackerActive, CompactionPolicy.Decide(recent, Ctx(manual: true, tracker: true)).Reason);
        Assert.Equal(CompactionBlock.LowDisk, CompactionPolicy.Decide(recent, Ctx(manual: true, free: 10 * Mb)).Reason);
    }

    [Fact]
    public void A_busy_or_failed_attempt_waits_six_hours()
    {
        var busy = CompactionPolicy.Attempted(new CompactionState(), Now.AddHours(-2), "busy");
        Assert.Equal(CompactionBlock.RetryLater, CompactionPolicy.Decide(busy, Ctx()).Reason);
        Assert.True(CompactionPolicy.Decide(busy, Ctx(now: Now.AddHours(4.1))).Run);
        var failed = CompactionPolicy.Attempted(LastRun(40), Now.AddHours(-1), "failed");
        Assert.Equal(CompactionBlock.RetryLater, CompactionPolicy.Decide(failed, Ctx()).Reason);
    }

    [Fact]
    public void Compacts_a_real_database_and_records_before_and_after()
    {
        using var t = new TestDb();
        using (var conn = t.Db.Open())
        {
            conn.Execute("CREATE TABLE filler (id INTEGER PRIMARY KEY, blob BLOB)");
            for (var i = 0; i < 200; i++) conn.Execute("INSERT INTO filler (blob) VALUES (randomblob(16384))");
            conn.Execute("DELETE FROM filler");
            conn.Execute("PRAGMA wal_checkpoint(TRUNCATE)");
        }
        var compactor = new DatabaseCompactor(t.Db, t.Dir.Path);
        var backup = Path.Combine(t.Dir.Path, "backups", "pre-compaction.db");
        var before = t.Db.SizeOnDisk();
        var r = compactor.Run(Ctx(db: before), backup);

        Assert.Equal("compacted", r.Outcome);
        Assert.Equal(before, r.BeforeBytes);
        Assert.True(r.AfterBytes < before / 4, $"{r.AfterBytes} should be well under {before}");
        Assert.True(File.Exists(backup)); // the existing backup path ran first (there was room)
        var state = compactor.Load();
        Assert.Equal("compacted", state.LastOutcome);
        Assert.Equal(r.AfterBytes, state.AfterBytes);
        Assert.Equal("ok", t.Db.QuickCheck());
        // A month hasn't passed: the next automatic check skips.
        Assert.Equal("skipped", compactor.Run(Ctx(db: r.AfterBytes, now: Now.AddDays(1)), null).Outcome);
        TestDb.ReleasePool(t.Db);
    }

    [Fact]
    public void A_locked_database_is_busy_not_an_error_and_is_left_unchanged()
    {
        using var t = new TestDb();
        var compactor = new DatabaseCompactor(t.Db, t.Dir.Path);
        // Another connection holds a write transaction (as the background tracker or a scan might).
        using var other = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={t.Db.FilePath};Pooling=False");
        other.Open();
        other.Execute("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; CREATE TABLE held (x INTEGER);");
        var r = compactor.Run(Ctx(manual: true), null);
        Assert.Equal("busy", r.Outcome);
        Assert.Equal("busy", compactor.Load().LastOutcome);
        other.Execute("ROLLBACK");
        Assert.Equal("ok", t.Db.QuickCheck());
        TestDb.ReleasePool(t.Db);
    }

    [Fact]
    public void A_corrupt_state_file_starts_over()
    {
        using var dir = new TempDir();
        dir.Write(Path.Combine("maintenance", "compaction.json"), "{ nope");
        var compactor = new DatabaseCompactor(new Vystral.Core.Data.Database(":memory:"), dir.Path);
        Assert.Null(compactor.Load().LastRunAt);
    }
}
