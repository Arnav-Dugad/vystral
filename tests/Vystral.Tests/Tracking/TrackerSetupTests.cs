using Vystral.Tests.Support;
using Vystral.Windows.Tracking;
using Xunit;

namespace Vystral.Tests.Tracking;

/// <summary>Command line, kernel-object names, the sign-in entry and the small state files.</summary>
public sealed class TrackerSetupTests
{
    // ---------------- command line ----------------

    [Fact]
    public void Only_the_exact_tracker_switch_starts_the_tracker()
    {
        Assert.Equal(new TrackerCommand(true, null), TrackerCommandLine.Parse(["--background-tracker"]));
        Assert.True(TrackerCommandLine.Parse(["--BACKGROUND-TRACKER"]).BackgroundTracker);
        Assert.False(TrackerCommandLine.Parse([]).BackgroundTracker);
        Assert.False(TrackerCommandLine.Parse(["--safe-mode"]).BackgroundTracker);
        Assert.False(TrackerCommandLine.Parse(["--uri", "vystral://open?route=x", "--background-tracker"]).BackgroundTracker);
        Assert.False(TrackerCommandLine.Parse(["--background-tracker", "--safe-mode"]).BackgroundTracker);
        Assert.False(TrackerCommandLine.Parse(["--background-tracker", "--data-dir"]).BackgroundTracker);
    }

    [Fact]
    public void A_data_folder_can_be_given_for_development_runs_and_is_validated()
    {
        var cmd = TrackerCommandLine.Parse(["--background-tracker", "--data-dir", @"C:\Temp\vystral-measure"]);
        Assert.True(cmd.BackgroundTracker);
        Assert.Equal(@"C:\Temp\vystral-measure", cmd.DataDir);

        Assert.False(TrackerCommandLine.Parse(["--background-tracker", "--data-dir", "relative"]).BackgroundTracker);
        Assert.False(TrackerCommandLine.Parse(["--background-tracker", "--data-dir", @"\\server\share\x"]).BackgroundTracker);
        Assert.False(TrackerCommandLine.Parse(["--background-tracker", "--data-dir", "C:\\a\"b"]).BackgroundTracker);
        Assert.False(TrackerCommandLine.Parse(["--background-tracker", "--data-dir", @"C:\x", "extra"]).BackgroundTracker);
    }

    // ---------------- names ----------------

    [Fact]
    public void Names_are_session_local_stable_and_differ_per_data_folder()
    {
        var a = TrackerNames.For(@"C:\Users\me\AppData\Local\VYSTRAL.Data");
        var b = TrackerNames.For(@"c:\users\ME\AppData\Local\VYSTRAL.Data\");
        var other = TrackerNames.For(@"C:\Temp\scratch");

        Assert.StartsWith(@"Local\VYSTRAL-", a.Tracker);
        Assert.Equal(a.Tracker, b.Tracker);
        Assert.NotEqual(a.Tracker, other.Tracker);
        var all = new[] { a.App, a.Tracker, a.Helper, a.Yield, a.Stop, a.Migrate };
        Assert.Equal(all.Length, all.Distinct().Count());
    }

    // ---------------- sign-in entry ----------------

    private sealed class FakeRunKey : IRunKeyStore
    {
        public Dictionary<string, string> Values { get; } = [];
        public bool? Disabled { get; set; }
        public int Writes { get; private set; }
        public string? Get(string name) => Values.GetValueOrDefault(name);
        public void Set(string name, string value) { Values[name] = value; Writes++; }
        public void Delete(string name) { Values.Remove(name); Writes++; }
        public bool? IsDisabledInStartupApps(string name) => Disabled;
    }

    private const string Launcher = @"C:\Users\me\AppData\Local\Vystral\Vystral.exe";

    [Fact]
    public void Enabling_writes_the_root_launcher_with_the_tracker_switch_once()
    {
        var store = new FakeRunKey();
        var autostart = new TrackerAutostart(store, Launcher);
        Assert.Equal(AutostartState.Off, autostart.State());

        Assert.True(autostart.Enable());
        Assert.True(autostart.Enable());

        Assert.Equal("\"C:\\Users\\me\\AppData\\Local\\Vystral\\Vystral.exe\" --background-tracker", store.Values[TrackerAutostart.ValueName]);
        Assert.DoesNotContain(@"\current\", store.Values[TrackerAutostart.ValueName]);
        Assert.Equal(1, store.Writes);
        Assert.Equal(AutostartState.On, autostart.State());
    }

    [Fact]
    public void Disabling_removes_only_its_own_value()
    {
        var store = new FakeRunKey();
        store.Values["OneDrive"] = "\"C:\\OneDrive.exe\" /background";
        var autostart = new TrackerAutostart(store, Launcher);
        autostart.Enable();
        autostart.Disable();
        Assert.False(store.Values.ContainsKey(TrackerAutostart.ValueName));
        Assert.True(store.Values.ContainsKey("OneDrive"));
        Assert.Equal(AutostartState.Off, autostart.State());
    }

    [Fact]
    public void Development_builds_never_write_or_remove_the_entry()
    {
        var store = new FakeRunKey();
        store.Values[TrackerAutostart.ValueName] = $"\"{Launcher}\" --background-tracker"; // the installed app's entry
        var dev = new TrackerAutostart(store, null);

        Assert.False(dev.Available);
        Assert.Equal(AutostartState.Unavailable, dev.State());
        Assert.False(dev.Enable());
        dev.Disable();
        Assert.Equal(0, store.Writes);
        Assert.True(store.Values.ContainsKey(TrackerAutostart.ValueName));

        // Uninstall removes it whatever the copy.
        dev.Remove();
        Assert.False(store.Values.ContainsKey(TrackerAutostart.ValueName));
    }

    [Fact]
    public void A_moved_install_is_reported_stale_and_repaired_and_Task_Manager_off_is_respected()
    {
        var store = new FakeRunKey();
        store.Values[TrackerAutostart.ValueName] = "\"D:\\Old\\Vystral.exe\" --background-tracker";
        var autostart = new TrackerAutostart(store, Launcher);
        Assert.Equal(AutostartState.Stale, autostart.State());
        autostart.Enable();
        Assert.Equal(AutostartState.On, autostart.State());

        store.Disabled = true;
        Assert.Equal(AutostartState.DisabledByWindows, autostart.State());
    }

    [Fact]
    public void Unsafe_launcher_paths_are_never_registered()
    {
        foreach (var bad in new[] { @"\\server\share\Vystral.exe", "Vystral.exe", @"C:\a""b\Vystral.exe", @"C:\%TEMP%\Vystral.exe", @"C:\x\Vystral.bat" })
        {
            var store = new FakeRunKey();
            Assert.False(new TrackerAutostart(store, bad).Enable());
            Assert.Empty(store.Values);
        }
    }

    [Fact]
    public void The_launcher_is_found_only_in_an_installed_layout()
    {
        using var dir = new TempDir();
        var root = dir.Dir("Vystral");
        var exe = Path.Combine(root, "current", "Vystral.exe");
        Assert.Null(TrackerAutostart.FindLauncher(root, false, exe)); // no stub, no Update.exe
        File.WriteAllText(Path.Combine(root, "Vystral.exe"), "");
        Assert.Null(TrackerAutostart.FindLauncher(root, false, exe)); // still no Update.exe
        File.WriteAllText(Path.Combine(root, "Update.exe"), "");
        Assert.Equal(Path.Combine(root, "Vystral.exe"), TrackerAutostart.FindLauncher(root, false, exe));
        Assert.Null(TrackerAutostart.FindLauncher(root, portable: true, exe));
        Assert.Null(TrackerAutostart.FindLauncher(null, false, exe));
    }

    // ---------------- state files ----------------

    private static string Id(int n) => n.ToString("x32");

    [Fact]
    public void The_session_note_round_trips_and_clears_only_its_own_session()
    {
        using var dir = new TempDir();
        var files = new TrackerFiles(dir.Path);
        Assert.Null(files.ReadSession());

        var start = DateTimeOffset.Parse("2026-10-05T20:00:00Z");
        var note = new TrackerSessionNote(Id(1), Id(2), Id(3), "background", start, start.AddMinutes(30), 4242, Parked: true);
        files.WriteSession(note);
        Assert.Equal(note, files.ReadSession());

        files.ClearSession(Id(9));
        Assert.NotNull(files.ReadSession());
        files.ClearSession(Id(1));
        Assert.Null(files.ReadSession());
    }

    [Fact]
    public void A_corrupt_or_tampered_note_is_ignored()
    {
        using var dir = new TempDir();
        var files = new TrackerFiles(dir.Path);
        foreach (var content in new[]
                 {
                     "not json",
                     "{}",
                     """{"sessionId":"../../x","gameId":"00000000000000000000000000000002","source":"background","start":"2026-10-05T20:00:00Z","lastSeen":"2026-10-05T20:10:00Z","ownerPid":1,"parked":true}""",
                     """{"sessionId":"00000000000000000000000000000001","gameId":"00000000000000000000000000000002","source":"imported","start":"2026-10-05T20:00:00Z","lastSeen":"2026-10-05T20:10:00Z","ownerPid":1,"parked":true}""",
                     """{"sessionId":"00000000000000000000000000000001","gameId":"00000000000000000000000000000002","source":"background","start":"2026-10-05T20:00:00Z","lastSeen":"2026-10-05T19:00:00Z","ownerPid":1,"parked":true}""",
                 })
        {
            File.WriteAllText(files.SessionPath, content);
            Assert.Null(files.ReadSession());
        }
        File.WriteAllText(files.SessionPath, new string('x', 100_000));
        Assert.Null(files.ReadSession());
    }

    [Fact]
    public void The_ignore_list_adds_removes_and_validates_ids()
    {
        using var dir = new TempDir();
        var files = new TrackerFiles(dir.Path);
        Assert.Empty(files.ReadIgnored());
        files.SetIgnored(Id(1), true);
        files.SetIgnored(Id(2), true);
        files.SetIgnored(Id(1), true);
        Assert.Equal([Id(1), Id(2)], files.ReadIgnored().Order());
        files.SetIgnored(Id(1), false);
        Assert.Equal([Id(2)], files.ReadIgnored());
        Assert.Throws<ArgumentException>(() => files.SetIgnored("nope", true));

        File.WriteAllText(files.IgnoredPath, """{"gameIds":["00000000000000000000000000000005","bad",null]}""");
        Assert.Equal([Id(5)], files.ReadIgnored());
    }
}
