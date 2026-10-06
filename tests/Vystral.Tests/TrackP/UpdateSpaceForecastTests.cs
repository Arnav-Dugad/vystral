using System.Text.Json;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using Vystral.Windows.Storage;
using Xunit;
using static Vystral.Windows.Storage.UpdateSpaceForecast;

namespace Vystral.Tests.TrackP;

public sealed class UpdateSpaceForecastTests
{
    private const long GB = 1L << 30;

    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "TrackP", name));

    private static AppManifestInfo M(long flags, long toDl = 0, long dl = 0, long toStage = 0, long staged = 0, string appId = "1", string build = "1", string target = "1") =>
        new(appId, $"App {appId}", flags, build, target, toDl, dl, toStage, staged, 10 * GB, 0, 0, 0);

    // ---------- Parsing (fixtures mirror real manifests on the dev PC, with values changed) ----------

    [Fact]
    public void Parses_every_field_of_a_real_shaped_manifest()
    {
        var m = ParseManifest(Fixture("appmanifest_finished.acf"))!;
        Assert.Equal("3405690", m.AppId);
        Assert.Equal("EA SPORTS FC™ 26", m.Name);
        Assert.Equal(4, m.StateFlags);
        Assert.Equal("24476534", m.BuildId);
        Assert.Equal("24476534", m.TargetBuildId);
        Assert.Equal(245128608, m.BytesToDownload);
        Assert.Equal(245128608, m.BytesDownloaded);
        Assert.Equal(247208632, m.BytesToStage);
        Assert.Equal(247208632, m.BytesStaged);
        Assert.Equal(62952466589, m.SizeOnDisk);
        Assert.Equal(0, m.UpdateResult);
        Assert.Equal(0, m.AutoUpdateBehavior);
    }

    [Fact]
    public void A_finished_update_leaves_its_counters_full_but_nothing_is_pending()
    {
        var m = ParseManifest(Fixture("appmanifest_finished.acf"))!;
        Assert.Null(PendingKind(m));
        Assert.Equal(0, DownloadRemaining(m));
        Assert.Equal(0, StageRemaining(m));
    }

    [Fact]
    public void Queued_update_needs_its_whole_download_plus_its_whole_staging()
    {
        var m = ParseManifest(Fixture("appmanifest_queued.acf"))!;
        Assert.Equal("update", PendingKind(m));
        Assert.Equal("queued", Phase(m));
        Assert.Equal(45_000_000_000, NeedBytes(m));
        Assert.Equal(1, m.AutoUpdateBehavior);
        Assert.Equal(1786100000, m.ScheduledAutoUpdate);
    }

    [Fact]
    public void Staging_update_needs_only_what_is_left_to_stage()
    {
        var m = ParseManifest(Fixture("appmanifest_staging.acf"))!;
        Assert.Equal("update", PendingKind(m));
        Assert.Equal("staging", Phase(m));
        Assert.Equal(3_000_000_000, NeedBytes(m));
    }

    [Fact]
    public void Flagged_update_with_last_updates_counters_has_an_unknown_size()
    {
        var m = ParseManifest(Fixture("appmanifest_stale.acf"))!;
        Assert.Equal("update", PendingKind(m));
        Assert.Null(NeedBytes(m));
        Assert.Equal("unknown", Fit(NeedBytes(m), 100 * GB, GB));
    }

    [Theory]
    [InlineData("")]
    [InlineData("\"AppState\" { \"appid\" \"abc\" }")]
    [InlineData("\"AppState\" { \"appid\" \"12345678901\" }")]
    [InlineData("\"Other\" { \"appid\" \"10\" }")]
    [InlineData("{{{")]
    public void Malformed_manifests_are_ignored(string text) => Assert.Null(ParseManifest(text));

    [Fact]
    public void Negative_and_garbage_counters_become_zero_and_names_are_cleaned()
    {
        var m = ParseManifest("\"AppState\" { \"appid\" \"10\" \"name\" \"Bad\u202Ename\u0007\" \"BytesToDownload\" \"-5\" \"BytesDownloaded\" \"x\" \"buildid\" \"12ab\" }")!;
        Assert.Equal(0, m.BytesToDownload);
        Assert.Equal(0, m.BytesDownloaded);
        Assert.Null(m.BuildId);
        Assert.Equal("Badname", m.Name);
    }

    // ---------- Pending and phases ----------

    [Fact]
    public void Pending_kinds()
    {
        Assert.Null(PendingKind(M(0)));
        Assert.Null(PendingKind(M(1)));                                           // uninstalled
        Assert.Null(PendingKind(M(4 | 2048, toDl: 10)));                          // uninstalling
        Assert.Equal("install", PendingKind(M(1024 | 2, toDl: 10)));              // install in progress
        Assert.Equal("install", PendingKind(M(1, toDl: 10, dl: 2)));
        Assert.Equal("update", PendingKind(M(4 | 512, toDl: 10, dl: 5)));         // paused
        Assert.Equal("update", PendingKind(M(4, toDl: 10, build: "1", target: "2")));  // target build differs, bytes left
        Assert.Null(PendingKind(M(4, toDl: 10, dl: 10, build: "1", target: "2")));     // nothing left: not pending
    }

    [Fact]
    public void Phases_follow_the_runtime_bits()
    {
        Assert.Equal("paused", Phase(M(4 | 512 | 1048576)));
        Assert.Equal("staging", Phase(M(4 | 4194304)));
        Assert.Equal("downloading", Phase(M(4 | 1048576)));
        Assert.Equal("downloading", Phase(M(4 | 524288)));
        Assert.Equal("queued", Phase(M(6)));
    }

    [Fact]
    public void A_running_update_with_nothing_left_needs_no_more_room()
    {
        Assert.Equal(0, NeedBytes(M(4 | 4194304, toDl: 10, dl: 10, toStage: 20, staged: 20)));
        Assert.Null(NeedBytes(M(4 | 512, toDl: 10, dl: 10))); // paused with full counters: unknown
    }

    // ---------- Space maths ----------

    [Fact]
    public void Tight_threshold_is_five_percent_clamped_between_1_and_50_GB()
    {
        Assert.Equal(5 * GB, TightThreshold(100 * GB));
        Assert.Equal(GB, TightThreshold(10 * GB));
        Assert.Equal(50 * GB, TightThreshold(4096 * GB));
        Assert.Equal(GB, TightThreshold(0));
    }

    [Fact]
    public void Fit_ratings()
    {
        Assert.Equal("short", Fit(11 * GB, 10 * GB, GB));
        Assert.Equal("tight", Fit(9 * GB + GB / 2, 10 * GB, GB));
        Assert.Equal("ok", Fit(5 * GB, 10 * GB, GB));
        Assert.Equal("ok", Fit(9 * GB, 10 * GB, GB)); // exactly the threshold left is fine
    }

    private static VolumeSpace D(long free, long total = 1000 * GB) => new("D:\\", "D:", "Games", free, total);

    [Fact]
    public void Updates_on_one_drive_add_up_even_across_two_libraries_and_each_is_rated_alone()
    {
        var volume = D(30 * GB);
        var libs = new[]
        {
            new LibraryVolume(@"D:\SteamLibrary", volume, [M(6, toDl: 10 * GB, toStage: 10 * GB, appId: "10"), M(4, appId: "11")]),
            new LibraryVolume(@"D:\Second", volume, [M(6, toDl: 5 * GB, toStage: 8 * GB, appId: "12")]),
        };
        var f = Build(libs, new Dictionary<string, string> { ["10"] = new('a', 32) }, DateTimeOffset.UnixEpoch);
        var drive = Assert.Single(f.Drives);
        Assert.Equal("D:", drive.Drive);
        Assert.Equal(33 * GB, drive.NeedBytes);
        Assert.Equal(-3 * GB, drive.AfterBytes);
        Assert.Equal("short", drive.Status);
        Assert.Equal("short", f.Status);
        Assert.Equal(2, f.PendingCount);
        Assert.Equal("10", drive.Updates[0].AppId);                // biggest first
        Assert.Equal(new string('a', 32), drive.Updates[0].GameId);
        Assert.Equal("tight", drive.Updates[0].Fit);               // 20 GB of 30 GB leaves 10 GB < 50 GB threshold
        Assert.Equal(50 * GB, drive.TightBelowBytes);
    }

    [Fact]
    public void Drives_without_pending_updates_are_left_out_and_unknown_sizes_count_as_zero()
    {
        var libs = new[]
        {
            new LibraryVolume(@"C:\Steam", new VolumeSpace("C:\\", "C:", null, 500 * GB, 1000 * GB), [M(4, appId: "1")]),
            new LibraryVolume(@"E:\Steam", new VolumeSpace("E:\\", "E:", null, 500 * GB, 1000 * GB), [M(6, toDl: 1, dl: 1, appId: "2")]),
        };
        var f = Build(libs, new Dictionary<string, string>(), DateTimeOffset.UnixEpoch);
        var drive = Assert.Single(f.Drives);
        Assert.Equal("E:", drive.Drive);
        Assert.Equal("ok", drive.Status);
        Assert.Null(drive.Updates[0].NeedBytes);
        Assert.Equal("unknown", drive.Updates[0].Fit);
        Assert.Equal(0, drive.NeedBytes);
    }

    [Fact]
    public void Nothing_pending_is_status_none_and_worst_drive_sorts_first()
    {
        Assert.Equal("none", Build([], new Dictionary<string, string>(), DateTimeOffset.UnixEpoch).Status);
        var libs = new[]
        {
            new LibraryVolume("C:\\S", new VolumeSpace("C:\\", "C:", null, 500 * GB, 1000 * GB), [M(6, toDl: GB, appId: "1")]),
            new LibraryVolume("F:\\S", new VolumeSpace("F:\\", "F:", null, 2 * GB, 100 * GB), [M(6, toDl: GB, appId: "2")]),
        };
        var f = Build(libs, new Dictionary<string, string>(), DateTimeOffset.UnixEpoch);
        Assert.Equal(["F:", "C:"], f.Drives.Select(d => d.Drive));
        Assert.Equal("tight", f.Status);
    }

    [Fact]
    public void Signature_ignores_small_byte_changes_but_not_status_changes()
    {
        DiskForecastDto At(long downloaded, long free) => Build(
            [new LibraryVolume("D:\\S", D(free), [M(4 | 1048576, toDl: 10 * GB, dl: downloaded, appId: "1")])],
            new Dictionary<string, string>(), DateTimeOffset.UnixEpoch);
        const long MB = 1L << 20;
        Assert.Equal(Signature(At(GB + 100 * MB, 100 * GB + 100 * MB)), Signature(At(GB + 100 * MB + 1000, 100 * GB + 100 * MB - 1000)));
        Assert.NotEqual(Signature(At(GB, 100 * GB)), Signature(At(GB, 5 * GB)));
    }

    [Fact]
    public void Drive_names()
    {
        Assert.Equal("D:", DriveName("d:\\"));
        Assert.Equal(@"C:\Mount\Games", DriveName(@"C:\Mount\Games\"));
    }

    // ---------- Reading libraries ----------

    private sealed class FakeVolumes(VolumeSpace? v) : IVolumeInfo
    {
        public List<string> Asked { get; } = [];
        public VolumeSpace? Describe(string folder) { Asked.Add(folder); return v; }
    }

    [Fact]
    public void ReadLibraries_parses_manifests_only_and_skips_oversized_files()
    {
        using var dir = new TempDir();
        dir.Write("Lib/steamapps/appmanifest_620.acf", Fixture("appmanifest_queued.acf"));
        dir.Write("Lib/steamapps/appmanifest_400.acf", Fixture("appmanifest_staging.acf"));
        dir.Write("Lib/steamapps/appmanifest_9.acf", new string('x', 300 * 1024));
        dir.Write("Lib/steamapps/libraryfolders.vdf", "\"libraryfolders\" {}");
        var volumes = new FakeVolumes(D(100 * GB));
        var libs = UpdateSpaceService.ReadLibraries([Path.Combine(dir.Path, "Lib"), Path.Combine(dir.Path, "Missing")], volumes);
        var lib = Assert.Single(libs);
        Assert.Equal(["400", "620"], lib.Manifests.Select(m => m.AppId).Order());
        Assert.Single(volumes.Asked);
    }

    private sealed class Events : IEventSink
    {
        public List<string> Names { get; } = [];
        public void Emit(string eventName, object? payload) { lock (Names) Names.Add(eventName); }
    }

    [Fact]
    public void Service_rescans_and_emits_only_when_something_changed()
    {
        using var dir = new TempDir();
        dir.Write("Steam/steamapps/appmanifest_620.acf", Fixture("appmanifest_queued.acf"));
        var events = new Events();
        using var svc = new UpdateSpaceService(() => Path.Combine(dir.Path, "Steam"), () => new Dictionary<string, string>(), events, () => false, new FakeVolumes(D(10 * GB)));
        var first = svc.Rescan();
        Assert.Equal("short", first.Status);
        svc.Rescan();
        Assert.Single(events.Names);
        dir.Write("Steam/steamapps/appmanifest_620.acf", Fixture("appmanifest_finished.acf").Replace("3405690", "620"));
        Assert.Equal("none", svc.Rescan().Status);
        Assert.Equal(2, events.Names.Count);
    }

    [Fact]
    public void Service_without_Steam_reports_unavailable()
    {
        using var svc = new UpdateSpaceService(() => null, () => new Dictionary<string, string>(), NullEventSink.Instance, () => false, new FakeVolumes(null));
        var f = svc.Current();
        Assert.False(f.Available);
        Assert.Empty(f.Drives);
    }

    // ---------- Notifications ----------

    private static NotificationPolicy Policy(bool disk = true) =>
        new(k => k switch { NotificationPolicy.Enabled => true, NotificationPolicy.DiskSpace => disk, _ => false }, _ => "Nebula Drift");

    private static JsonElement J(object o) => JsonSerializer.SerializeToElement(o, new JsonSerializerOptions(JsonSerializerDefaults.Web));

    private static DiskForecastDto Short() => Build(
        [new LibraryVolume("D:\\S", D(9 * GB), [M(6, toDl: 20 * GB, toStage: 3 * GB, appId: "620")])],
        new Dictionary<string, string> { ["620"] = new('a', 32) }, DateTimeOffset.UnixEpoch);

    [Fact]
    public void A_short_drive_notifies_once_and_opens_Storage_Studio()
    {
        var policy = Policy();
        var n = Assert.Single(policy.Evaluate("disk.forecast", J(Short()), foreground: false));
        Assert.Equal("An update won’t fit on D:", n.Title);
        Assert.Contains("Nebula Drift needs 23.0 GB", n.Body);
        Assert.Contains("9.0 GB free", n.Body);
        Assert.Contains("\"storage\"", n.RouteJson);
        Assert.Empty(policy.Evaluate("disk.forecast", J(Short()), foreground: false));
    }

    [Fact]
    public void Disk_notifications_respect_their_setting_and_ok_drives_stay_quiet()
    {
        Assert.Empty(Policy(disk: false).Evaluate("disk.forecast", J(Short()), foreground: false));
        var ok = Build([new LibraryVolume("D:\\S", D(900 * GB), [M(6, toDl: GB, appId: "1")])], new Dictionary<string, string>(), DateTimeOffset.UnixEpoch);
        Assert.Empty(Policy().Evaluate("disk.forecast", J(ok), foreground: false));
    }
}
