using System.Text;
using Vystral.Windows.Services.Rollback;
using Xunit;

namespace Vystral.Tests.Services;

/// <summary>The silent-rollback state machine, driven start by start over a fake clock.</summary>
public sealed class StartupGuardTests
{
    private DateTimeOffset _now = new(2026, 10, 5, 12, 0, 0, TimeSpan.Zero);

    /// <summary>Runs one start of <paramref name="version"/> and advances the clock.</summary>
    private (StartupLedger Ledger, StartDecision Decision) Start(StartupLedger l, string version, string? preserved = "0.4.0", bool safeMode = false, bool installed = true)
    {
        _now = _now.AddMinutes(1);
        return StartupGuard.OnStart(l, new StartContext(version, installed, safeMode, preserved, _now));
    }

    /// <summary>A ledger where 0.4.0 ran fine, then 0.4.1 got installed.</summary>
    private StartupLedger GoodThenUpdated()
    {
        var (l, d) = Start(new StartupLedger(), "0.4.0");
        Assert.Equal(StartAction.Proceed, d.Action);
        l = StartupGuard.OnStartSucceeded(l, "0.4.0");
        return l;
    }

    [Fact]
    public void A_healthy_start_proceeds_and_is_pending_until_confirmed()
    {
        var (l, d) = Start(new StartupLedger(), "0.4.0");
        Assert.Equal(StartAction.Proceed, d.Action);
        Assert.True(l.Pending);
        Assert.Equal("0.4.0", l.Version);
        l = StartupGuard.OnStartSucceeded(l, "0.4.0");
        Assert.False(l.Pending);
        Assert.True(l.EverSucceeded);
        Assert.Equal(0, l.ConsecutiveFailures);
    }

    [Fact]
    public void Two_failed_starts_of_a_new_version_roll_back_on_the_third()
    {
        var l = GoodThenUpdated();
        (l, var d1) = Start(l, "0.4.1");               // 1st start: crashes (never confirmed)
        Assert.Equal(StartAction.Proceed, d1.Action);
        Assert.Equal("0.4.0", l.LastGoodVersion);
        (l, var d2) = Start(l, "0.4.1");               // 2nd start: discovers failure #1, crashes again
        Assert.Equal(StartAction.Proceed, d2.Action);
        Assert.Equal(1, l.ConsecutiveFailures);
        (l, var d3) = Start(l, "0.4.1");               // 3rd start: failure #2 → roll back
        Assert.Equal(StartAction.RollBack, d3.Action);
        Assert.Equal("0.4.0", d3.TargetVersion);
        Assert.Equal(2, l.ConsecutiveFailures);
        Assert.True(StartupGuard.IsBlocked(l, "0.4.1"));
        Assert.False(StartupGuard.IsBlocked(l, "0.4.2"));
        Assert.Equal(new RollbackRecord("0.4.1", "0.4.0", _now.ToString("O")), l.LastRollback);
    }

    [Fact]
    public void The_previous_version_explains_the_rollback_once()
    {
        var l = GoodThenUpdated();
        (l, _) = Start(l, "0.4.1");
        (l, _) = Start(l, "0.4.1");
        (l, _) = Start(l, "0.4.1");
        (l, var back) = Start(l, "0.4.0");             // Velopack restarted the previous version
        Assert.Equal(StartAction.Proceed, back.Action);
        var notice = StartupGuard.PendingNotice(l, "0.4.0");
        Assert.NotNull(notice);
        Assert.Equal(("0.4.1", "0.4.0"), (notice!.From, notice.To));
        Assert.Null(StartupGuard.PendingNotice(l, "0.4.1"));
        l = StartupGuard.MarkNoticeShown(l);
        Assert.Null(StartupGuard.PendingNotice(l, "0.4.0"));
        Assert.True(StartupGuard.IsBlocked(l, "0.4.1")); // still skipped by auto-update
    }

    [Fact]
    public void A_version_that_started_successfully_once_is_never_rolled_back()
    {
        var l = GoodThenUpdated();
        (l, _) = Start(l, "0.4.1");
        l = StartupGuard.OnStartSucceeded(l, "0.4.1");
        for (var i = 0; i < 4; i++)
        {
            (l, var d) = Start(l, "0.4.1");
            Assert.Equal(StartAction.Proceed, d.Action);
        }
        Assert.True(l.ConsecutiveFailures >= 2);
        Assert.Equal("startedBefore", StartupGuard.RollbackBlocker(l, new StartContext("0.4.1", true, false, "0.4.0", _now)));
    }

    [Fact]
    public void Never_loops_rolls_back_from_a_version_at_most_once()
    {
        var l = GoodThenUpdated();
        (l, _) = Start(l, "0.4.1");
        (l, _) = Start(l, "0.4.1");
        (l, var d) = Start(l, "0.4.1");
        Assert.Equal(StartAction.RollBack, d.Action);
        (l, _) = Start(l, "0.4.0");
        l = StartupGuard.OnStartSucceeded(l, "0.4.0");
        // The user installs 0.4.1 again by hand, and it still fails.
        for (var i = 0; i < 5; i++)
        {
            (l, d) = Start(l, "0.4.1");
            Assert.Equal(StartAction.Proceed, d.Action);
        }
        Assert.Equal("alreadyRolledBack", StartupGuard.RollbackBlocker(l, new StartContext("0.4.1", true, false, "0.4.0", _now)));
    }

    [Fact]
    public void A_rollback_that_did_not_apply_runs_the_version_normally_and_never_retries()
    {
        var l = GoodThenUpdated();
        (l, _) = Start(l, "0.4.1");
        (l, _) = Start(l, "0.4.1");
        (l, var d) = Start(l, "0.4.1");
        Assert.Equal(StartAction.RollBack, d.Action);
        // Update.exe failed and restarted 0.4.1 instead.
        (l, d) = Start(l, "0.4.1");
        Assert.Equal(StartAction.Proceed, d.Action);
        Assert.Null(l.LastRollback);
        Assert.False(StartupGuard.IsBlocked(l, "0.4.1"));
        (l, d) = Start(l, "0.4.1");
        Assert.Equal(StartAction.Proceed, d.Action);
    }

    [Fact]
    public void Rollback_failure_unblocks_and_keeps_the_start_pending()
    {
        var l = GoodThenUpdated();
        (l, _) = Start(l, "0.4.1");
        (l, _) = Start(l, "0.4.1");
        (l, _) = Start(l, "0.4.1");
        l = StartupGuard.OnRollbackFailed(l, "0.4.1");
        Assert.True(l.Pending);
        Assert.Null(l.LastRollback);
        Assert.False(StartupGuard.IsBlocked(l, "0.4.1"));
        Assert.Contains("0.4.1", l.RolledBackFrom);
    }

    [Theory]
    [InlineData(null, "noPreservedPackage")]
    [InlineData("0.3.9", "preservedPackageMismatch")]
    public void Needs_the_preserved_package_of_the_last_good_version(string? preserved, string reason)
    {
        var l = GoodThenUpdated();
        (l, _) = Start(l, "0.4.1", preserved);
        (l, _) = Start(l, "0.4.1", preserved);
        (l, var d) = Start(l, "0.4.1", preserved);
        Assert.Equal(StartAction.Proceed, d.Action);
        Assert.Equal(reason, d.Reason);
    }

    [Fact]
    public void Without_a_known_good_version_there_is_nothing_to_return_to()
    {
        // Upgraded from a VYSTRAL that didn't keep a ledger: the first version seen has no predecessor.
        var (l, _) = Start(new StartupLedger(), "0.4.1");
        (l, _) = Start(l, "0.4.1");
        (l, var d) = Start(l, "0.4.1");
        Assert.Equal("noKnownGoodVersion", d.Reason);
    }

    [Fact]
    public void A_previous_version_that_never_worked_is_not_a_rollback_target()
    {
        var (l, _) = Start(new StartupLedger(), "0.4.0");   // 0.4.0 never confirmed
        (l, _) = Start(l, "0.4.1");
        Assert.Null(l.LastGoodVersion);
    }

    [Fact]
    public void Only_downgrades()
    {
        var l = new StartupLedger { Version = "0.4.1", ConsecutiveFailures = 2, LastGoodVersion = "0.4.2" };
        Assert.Equal("notADowngrade", StartupGuard.RollbackBlocker(l, new StartContext("0.4.1", true, false, "0.4.2", _now)));
    }

    [Fact]
    public void Dev_builds_and_safe_mode_record_nothing_and_never_roll_back()
    {
        var l = new StartupLedger { Version = "0.4.1", Pending = true, ConsecutiveFailures = 5, LastGoodVersion = "0.4.0" };
        var (afterDev, dev) = Start(l, "0.4.1", installed: false);
        Assert.Equal((StartAction.Proceed, "notInstalled"), (dev.Action, dev.Reason));
        Assert.Same(l, afterDev);
        var (afterSafe, safe) = Start(l, "0.4.1", safeMode: true);
        Assert.Equal((StartAction.Proceed, "safeMode"), (safe.Action, safe.Reason));
        Assert.Same(l, afterSafe);
    }

    [Fact]
    public void A_clean_exit_after_the_interface_was_ready_is_not_a_failure()
    {
        var l = GoodThenUpdated();
        (l, _) = Start(l, "0.4.1");
        l = StartupGuard.OnCleanExit(l, "0.4.1", uiWasReady: true); // closed within the confirmation window
        (l, _) = Start(l, "0.4.1");
        Assert.Equal(0, l.ConsecutiveFailures);
    }

    [Fact]
    public void A_clean_exit_before_the_interface_was_ready_still_counts_as_a_failed_start()
    {
        var l = GoodThenUpdated();
        (l, _) = Start(l, "0.4.1");
        l = StartupGuard.OnCleanExit(l, "0.4.1", uiWasReady: false);
        (l, _) = Start(l, "0.4.1");
        Assert.Equal(1, l.ConsecutiveFailures);
    }

    [Fact]
    public void Success_resets_the_failure_streak()
    {
        var l = GoodThenUpdated();
        (l, _) = Start(l, "0.4.1");
        (l, _) = Start(l, "0.4.1");
        Assert.Equal(1, l.ConsecutiveFailures);
        l = StartupGuard.OnStartSucceeded(l, "0.4.1");
        Assert.Equal(0, l.ConsecutiveFailures);
        // Confirmation for another version (a stale timer) changes nothing.
        Assert.Same(l, StartupGuard.OnStartSucceeded(l, "0.3.0"));
    }

    [Fact]
    public void Blocklist_is_capped_and_newest_wins()
    {
        var l = new StartupLedger { Blocked = [.. Enumerable.Range(0, 8).Select(i => new BlockedVersion($"0.1.{i}", "t", "r"))] };
        l = l with { Version = "0.5.0", ConsecutiveFailures = 1, Pending = true, LastGoodVersion = "0.4.0" };
        var (next, d) = Start(l, "0.5.0");
        Assert.Equal(StartAction.RollBack, d.Action);
        Assert.Equal(8, next.Blocked.Count);
        Assert.True(StartupGuard.IsBlocked(next, "0.5.0"));
        Assert.False(StartupGuard.IsBlocked(next, "0.1.0"));
    }

    [Theory]
    [InlineData("0.4.0", "0.4.1", -1)]
    [InlineData("0.10.0", "0.9.9", 1)]
    [InlineData("1.0.0-beta.1", "1.0.0", -1)]
    [InlineData("1.0.0", "1.0.0", 0)]
    [InlineData("1.0.0+build", "1.0.0", 0)]
    public void Versions_compare_semantically(string a, string b, int sign) => Assert.Equal(sign, Math.Sign(AppVersion.Compare(a, b)));

    [Theory]
    [InlineData("0.4.0", true)]
    [InlineData("0.4.0-beta.2", true)]
    [InlineData("0.4", false)]
    [InlineData("../0.4.0", false)]
    [InlineData(null, false)]
    public void Version_validation(string? v, bool ok) => Assert.Equal(ok, AppVersion.IsValid(v));
}

/// <summary>Package preservation and verification over an in-memory file system.</summary>
public sealed class RollbackPackageStoreTests
{
    private const string Dir = @"C:\data\update\rollback";
    private const string Source = @"C:\app\packages\Vystral-0.4.0-full.nupkg";

    [Fact]
    public void Preserves_the_running_package_with_its_hashes_and_writes_a_velopack_feed()
    {
        var fs = new FakeFs();
        fs.Files[Source] = Encoding.UTF8.GetBytes("package-0.4.0");
        var store = new RollbackPackageStore(Dir, fs);

        var pkg = store.Preserve("Vystral", "0.4.0", Source, DateTimeOffset.UnixEpoch);
        Assert.NotNull(pkg);
        Assert.Equal("Vystral-0.4.0-full.nupkg", pkg!.FileName);
        Assert.Equal(13, pkg.Size);
        Assert.Equal(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(fs.Files[Source])), pkg.Sha256);
        Assert.Equal(1, fs.Links);                       // hard-linked, not copied
        Assert.False(fs.Files.ContainsKey(Path.Combine(Dir, pkg.FileName + ".partial")));
        Assert.Equal(pkg, store.Get());
        Assert.True(store.Verify(pkg));

        var feed = Encoding.UTF8.GetString(fs.Files[store.WriteFeed(pkg, "win")]);
        Assert.Contains("\"Assets\":[{\"PackageId\":\"Vystral\",\"Version\":\"0.4.0\",\"Type\":\"Full\",\"FileName\":\"Vystral-0.4.0-full.nupkg\"", feed);
        Assert.Contains($"\"SHA256\":\"{pkg.Sha256}\"", feed);
        Assert.Contains($"\"SHA1\":\"{pkg.Sha1}\"", feed);
        Assert.EndsWith("releases.win.json", store.WriteFeed(pkg, "win"));
    }

    [Fact]
    public void Velopack_deleting_its_copy_leaves_ours_intact()
    {
        var fs = new FakeFs();
        fs.Files[Source] = Encoding.UTF8.GetBytes("package-0.4.0");
        var store = new RollbackPackageStore(Dir, fs);
        var pkg = store.Preserve("Vystral", "0.4.0", Source, DateTimeOffset.UnixEpoch)!;
        fs.Files.Remove(Source);
        Assert.Equal(pkg, store.Get());
        Assert.True(store.Verify(pkg));
    }

    [Fact]
    public void Tampering_fails_verification()
    {
        var fs = new FakeFs();
        fs.Files[Source] = Encoding.UTF8.GetBytes("package-0.4.0");
        var store = new RollbackPackageStore(Dir, fs);
        var pkg = store.Preserve("Vystral", "0.4.0", Source, DateTimeOffset.UnixEpoch)!;
        fs.Files[Path.Combine(Dir, pkg.FileName)] = Encoding.UTF8.GetBytes("package-0.4.X"); // same size, different bytes
        Assert.NotNull(store.Get());
        Assert.False(store.Verify(pkg));
        fs.Files[Path.Combine(Dir, pkg.FileName)] = Encoding.UTF8.GetBytes("short");
        Assert.Null(store.Get());                         // size mismatch: not offered at all
    }

    [Fact]
    public void Keeps_only_one_package_and_skips_rework_for_the_same_version()
    {
        var fs = new FakeFs();
        fs.Files[Source] = Encoding.UTF8.GetBytes("package-0.4.0");
        var store = new RollbackPackageStore(Dir, fs);
        store.Preserve("Vystral", "0.4.0", Source, DateTimeOffset.UnixEpoch);
        store.Preserve("Vystral", "0.4.0", Source, DateTimeOffset.UnixEpoch);
        Assert.Equal(1, fs.Links);

        const string next = @"C:\app\packages\Vystral-0.4.1-full.nupkg";
        fs.Files[next] = Encoding.UTF8.GetBytes("package-0.4.1!");
        var pkg = store.Preserve("Vystral", "0.4.1", next, DateTimeOffset.UnixEpoch)!;
        Assert.Equal("0.4.1", store.Get()!.Version);
        Assert.Equal([Path.Combine(Dir, "Vystral-0.4.1-full.nupkg")], fs.EnumerateFiles(Dir, "*.nupkg"));

        store.DeleteIfOlderThan("0.4.1");                 // same version: kept (it is the rollback point)
        Assert.NotNull(store.Get());
        store.DeleteIfOlderThan("0.4.2");
        Assert.Null(store.Get());
        Assert.Empty(fs.EnumerateFiles(Dir, "*.nupkg"));
        _ = pkg;
    }

    [Fact]
    public void Missing_source_or_bad_version_preserves_nothing()
    {
        var fs = new FakeFs();
        var store = new RollbackPackageStore(Dir, fs);
        Assert.Null(store.Preserve("Vystral", "0.4.0", Source, DateTimeOffset.UnixEpoch));
        fs.Files[Source] = [1, 2, 3];
        Assert.Null(store.Preserve("Vystral", "..\\evil", Source, DateTimeOffset.UnixEpoch));
        Assert.Null(store.Get());
    }

    [Fact]
    public void A_manifest_pointing_outside_the_folder_is_ignored()
    {
        var fs = new FakeFs();
        fs.Files[Path.Combine(Dir, "package.json")] = Encoding.UTF8.GetBytes(
            """{"PackageId":"Vystral","Version":"0.4.0","FileName":"..\\..\\evil.nupkg","Size":3,"Sha256":"00","Sha1":"00","PreservedAt":"x"}""");
        Assert.Null(new RollbackPackageStore(Dir, fs).Get());
    }

    [Fact]
    public void The_ledger_round_trips_through_startup_protection()
    {
        var fs = new FakeFs();
        var protection = new StartupProtection(@"C:\data", fs);
        Assert.Equal(new StartupLedger().Version, protection.Load().Version);
        var ledger = new StartupLedger { Version = "0.4.1", Blocked = [new BlockedVersion("0.4.1", "t", "r")], LastRollback = new RollbackRecord("0.4.1", "0.4.0", "t") };
        protection.Save(ledger);
        Assert.True(protection.IsBlocked("0.4.1"));
        Assert.Equal("0.4.0", protection.PendingNotice("0.4.0")!.To);
        protection.DismissNotice();
        Assert.Null(protection.PendingNotice("0.4.0"));
        fs.Files[@"C:\data\update\startup.json"] = Encoding.UTF8.GetBytes("{not json");
        Assert.Null(protection.Load().Version);           // corrupt ledger: start fresh, never crash
    }

    private sealed class FakeFs : IRollbackFileSystem
    {
        public Dictionary<string, byte[]> Files { get; } = new(StringComparer.OrdinalIgnoreCase);
        public int Links { get; private set; }

        public bool FileExists(string path) => Files.ContainsKey(path);
        public long FileLength(string path) => Files[path].Length;
        public Stream OpenRead(string path) => new MemoryStream(Files[path], writable: false);
        public void CreateDirectory(string path) { }
        public void LinkOrCopy(string source, string dest) { Files[dest] = Files[source]; Links++; }
        public void Move(string source, string dest) { Files[dest] = Files[source]; Files.Remove(source); }
        public string? ReadAllText(string path) => Files.TryGetValue(path, out var b) ? Encoding.UTF8.GetString(b) : null;
        public void WriteAllText(string path, string text) => Files[path] = Encoding.UTF8.GetBytes(text);
        public void Delete(string path) => Files.Remove(path);
        public IEnumerable<string> EnumerateFiles(string directory, string pattern) =>
            Files.Keys.Where(k => string.Equals(Path.GetDirectoryName(k), directory, StringComparison.OrdinalIgnoreCase) &&
                                  k.EndsWith(pattern.TrimStart('*'), StringComparison.OrdinalIgnoreCase)).ToList();
    }
}
