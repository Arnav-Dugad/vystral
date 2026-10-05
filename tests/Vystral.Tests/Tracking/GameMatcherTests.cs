using Vystral.Core.Domain;
using Vystral.Windows.Launch;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Tracking;
using Xunit;

namespace Vystral.Tests.Tracking;

public sealed class GameMatcherTests
{
    private static Installation Inst(int n, string? path, params string[] hints) => new()
    {
        Id = n.ToString("x32"),
        GameId = (n + 100).ToString("x32"),
        Platform = PlatformId.Steam,
        PlatformGameId = n.ToString(),
        Title = $"Game {n}",
        InstallPath = path,
        State = InstallState.Installed,
        Launch = new LaunchTarget(LaunchKind.Uri, $"steam://rungameid/{n}"),
        ProcessHints = hints,
    };

    private static readonly string[] SteamClient = [@"C:\Program Files (x86)\Steam"];
    private static readonly IReadOnlyList<string> Protected = [@"C:\Windows", @"C:\Program Files", @"C:\Program Files (x86)", @"C:\Users\me"];

    private static IReadOnlyList<DetectionTarget> Build(params Installation[] installs) =>
        GameMatcher.BuildTargets(installs, SteamClient, new HashSet<string>(), protectedDirs: Protected);

    private static readonly RunningProcess[] Snapshot =
    [
        new(10, @"C:\Program Files (x86)\Steam\steam.exe"),
        new(11, @"C:\Program Files (x86)\Steam\bin\cef\cef.win7x64\steamwebhelper.exe"),
        new(20, @"C:\Program Files (x86)\Steam\steamapps\common\Ashen Crown\Ashen.exe"),
        new(21, @"C:\Program Files (x86)\Steam\steamapps\common\Ashen Crown\UnityCrashHandler64.exe"),
        new(30, @"D:\SteamLibrary\steamapps\common\Tidebreak\bin\Tidebreak.exe"),
        new(40, @"E:\Emulators\retro.exe"),
        new(50, @"C:\Windows\explorer.exe"),
        new(60, @"D:\SteamLibrary\steamapps\common\Tidebreak Soundtrack\player.exe"),
    ];

    [Fact]
    public void Matches_are_exactly_what_a_launch_would_find_for_each_game()
    {
        var targets = Build(
            Inst(1, @"C:\Program Files (x86)\Steam\steamapps\common\Ashen Crown"),
            Inst(2, @"D:\SteamLibrary\steamapps\common\Tidebreak\"),
            Inst(3, null, "retro.exe"),
            Inst(4, @"D:\SteamLibrary\steamapps\common\Nothing Running"));
        var matcher = new GameMatcher(targets);
        var matches = matcher.Match(Snapshot).ToDictionary(m => m.Target.InstallationId, m => m.Pids.Order().ToList());

        foreach (var t in targets)
        {
            var expected = ProcessScanner.FindUnder(Snapshot, t.Root, t.Hints, t.Excluded).Select(p => p.Id).Order().ToList();
            Assert.Equal(expected, matches.GetValueOrDefault(t.InstallationId, []));
            Assert.Equal(expected, GameMatcher.PidsFor(t, Snapshot).Order().ToList());
        }
        Assert.Equal([20, 21], matches[1.ToString("x32")]);
        Assert.Equal([30], matches[2.ToString("x32")]);
        Assert.Equal([40], matches[3.ToString("x32")]);
        Assert.False(matches.ContainsKey(4.ToString("x32")));
    }

    [Fact]
    public void The_store_client_itself_is_never_a_game_even_when_an_entry_points_at_its_folder()
    {
        // A broken entry whose "install folder" is Steam's own folder (or a folder above it).
        Assert.Empty(Build(Inst(1, @"C:\Program Files (x86)\Steam"), Inst(2, @"C:\Program Files (x86)\Steam\")));
        var targets = Build(Inst(3, @"C:\Program Files (x86)\Steam\steamapps\common\Ashen Crown"));
        var matched = new GameMatcher(targets).Match(Snapshot).SelectMany(m => m.Pids).ToList();
        Assert.DoesNotContain(10, matched);
        Assert.DoesNotContain(11, matched);
    }

    [Fact]
    public void Folders_too_broad_to_identify_a_game_are_skipped()
    {
        var targets = Build(
            Inst(1, @"C:\"),
            Inst(2, @"C:\Program Files"),
            Inst(3, @"C:\Users"),
            Inst(4, @"C:\Users\me"),
            Inst(5, @"D:\Games\Real Game"));
        Assert.Equal([5.ToString("x32")], targets.Select(t => t.InstallationId));
    }

    [Fact]
    public void Generic_executable_names_are_not_enough_without_a_folder()
    {
        var targets = Build(Inst(1, null, "launcher.exe", "Game.exe"), Inst(2, null, "retro.exe"));
        Assert.Equal([2.ToString("x32")], targets.Select(t => t.InstallationId));
    }

    [Fact]
    public void Ignored_hidden_or_missing_games_are_not_watched()
    {
        var missing = Inst(2, @"D:\Games\Gone") with { State = InstallState.Missing };
        var ignored = new HashSet<string> { (1 + 100).ToString("x32") };
        var targets = GameMatcher.BuildTargets([Inst(1, @"D:\Games\One"), missing, Inst(3, @"D:\Games\Three")], [], ignored, protectedDirs: Protected);
        Assert.Equal([3.ToString("x32")], targets.Select(t => t.InstallationId));
    }

    [Fact]
    public void Primary_means_the_game_itself_not_a_crash_handler_or_installer()
    {
        var targets = Build(Inst(1, @"D:\Games\Ashen"));
        var matcher = new GameMatcher(targets);
        RunningProcess[] onlyHelpers =
        [
            new(1, @"D:\Games\Ashen\UnityCrashHandler64.exe"),
            new(2, @"D:\Games\Ashen\_CommonRedist\vcredist\2019\VC_redist.x64.exe"),
            new(3, @"D:\Games\Ashen\EasyAntiCheat\EasyAntiCheat_EOS_Setup.exe"),
        ];
        var m = Assert.Single(matcher.Match(onlyHelpers));
        Assert.False(m.HasPrimary);
        Assert.Equal(3, m.Pids.Count);

        var withGame = matcher.Match([.. onlyHelpers, new(4, @"D:\Games\Ashen\Ashen.exe")]);
        Assert.True(Assert.Single(withGame).HasPrimary);
    }

    [Fact]
    public void Nested_install_folders_match_both_and_the_detector_prefers_the_deeper_one()
    {
        var targets = Build(Inst(1, @"D:\Games\Collection"), Inst(2, @"D:\Games\Collection\Episode 2"));
        var matches = new GameMatcher(targets).Match([new RunningProcess(7, @"D:\Games\Collection\Episode 2\ep2.exe")]);
        Assert.Equal(2, matches.Count);

        var d = new GameDetector();
        var now = DateTimeOffset.UtcNow;
        d.Observe(now, matches);
        var started = d.Observe(now.AddSeconds(4), matches);
        Assert.Equal(2.ToString("x32"), started.Target!.InstallationId);
    }

    [Fact]
    public void Paths_are_compared_case_insensitively()
    {
        var targets = Build(Inst(1, @"d:\games\ASHEN"));
        Assert.Single(new GameMatcher(targets).Match([new RunningProcess(1, @"D:\Games\Ashen\Ashen.exe")]));
    }

    [Fact]
    public void Handle_free_source_resolves_each_process_once_and_keeps_only_this_session()
    {
        var snapshots = new FakeSnapshots();
        var resolved = new List<int>();
        var source = new HandleFreeProcessSource(snapshots, pid => { resolved.Add(pid); return $@"D:\p\{pid}.exe"; }, sessionId: 1);

        snapshots.Entries = [Entry(100, "a.exe", 1), Entry(200, "b.exe", 2), Entry(4, "System", 0)];
        Assert.Equal([100], source.Snapshot().Select(p => p.Id));
        snapshots.Entries = [Entry(100, "a.exe", 1), Entry(101, "c.exe", 1)];
        Assert.Equal([100, 101], source.Snapshot().Select(p => p.Id));
        Assert.Equal([100, 101], resolved); // 100 resolved once; other sessions never resolved

        // A reused pid with a different name is resolved again.
        snapshots.Entries = [Entry(100, "z.exe", 1)];
        source.Snapshot();
        Assert.Equal([100, 101, 100], resolved);
        Assert.Equal(1, source.CachedPaths);
    }

    [Fact]
    public void NT_device_paths_map_to_drive_letters_and_mount_folders()
    {
        (string, string)[] devices = [(@"\Device\HarddiskVolume3", @"C:\"), (@"\Device\HarddiskVolume7", @"C:\Games\Fast\")];
        Assert.Equal(@"C:\Windows\explorer.exe", NtImagePathResolver.ToDosPath(@"\Device\HarddiskVolume3\Windows\explorer.exe", devices));
        Assert.Equal(@"C:\Games\Fast\Ashen\a.exe", NtImagePathResolver.ToDosPath(@"\Device\HarddiskVolume7\Ashen\a.exe", devices));
        Assert.Equal(@"\\nas\games\x.exe", NtImagePathResolver.ToDosPath(@"\Device\Mup\nas\games\x.exe", devices));
        Assert.Null(NtImagePathResolver.ToDosPath(@"\Device\HarddiskVolume30\x.exe", devices));
        Assert.Null(NtImagePathResolver.ToDosPath(@"\Device\HarddiskVolume3", devices));
    }

    [Fact]
    public void The_real_handle_free_snapshot_sees_this_test_process_with_its_path()
    {
        using var source = HandleFreeProcessSource.CreateDefault();
        var self = source.Snapshot().FirstOrDefault(p => p.Id == Environment.ProcessId);
        Assert.NotNull(self);
        Assert.Equal(Path.GetFullPath(Environment.ProcessPath!), Path.GetFullPath(self!.ImagePath), ignoreCase: true);
    }

    private static ProcessEntry Entry(int pid, string name, int session) => new(pid, 1, session, name, 0, 0);

    private sealed class FakeSnapshots : IProcessSnapshotSource
    {
        public IReadOnlyList<ProcessEntry> Entries { get; set; } = [];
        public IReadOnlyList<ProcessEntry> Take() => Entries;
    }
}
