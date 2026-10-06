using System.Buffers.Binary;
using Dapper;
using Vystral.Core.Contracts;
using Vystral.Core.Domain;
using Vystral.Core.Health;
using Vystral.Tests.Support;
using Vystral.Windows.Services;
using Xunit;
using static Vystral.Tests.Support.TestDb;

namespace Vystral.Tests.Health;

public sealed class LibraryHealthTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 6, 12, 0, 0, TimeSpan.Zero);
    private static int _seq;
    private static string Id() => Interlocked.Increment(ref _seq).ToString("x32");

    private sealed class FakeProbe : IHealthProbe
    {
        public HashSet<string> Files { get; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> Dirs { get; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> OfflineDrives { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, ArtFileInfo> Art { get; } = new();
        public int DriveQueries;
        public bool DriveConnected(string path) { DriveQueries++; return !OfflineDrives.Contains(LibraryHealth.DriveKey(path)); }
        public bool FileExists(string path) => Files.Contains(path);
        public bool DirectoryExists(string path) => Dirs.Contains(path);
        public ArtFileInfo? ArtFile(string relativeFile) => Art.GetValueOrDefault(relativeFile);
    }

    private static InstallationDto Inst(string platform, string state = "installed", string? path = null, string? lastSeen = null, long? size = null, string? pgid = null) =>
        new(Id(), platform, pgid ?? Id()[..6], "t", state, path, path?[..2], size, false, platform == "manual" ? "Executable" : "Uri", null, null, null, false,
            (lastSeen ?? Now.ToString("O")));

    private static GameDto Game(string title, params InstallationDto[] installs) => Game(title, false, installs);

    private static GameDto Game(string title, bool hidden, params InstallationDto[] installs) =>
        new(Id(), title, title.ToLowerInvariant(), "A description", "Dev", null, null, ["Action"], false, hidden, null, null, null, null, null,
            new ArtworkDto(null, null, null, null, null), installs, [], 0, 0, null, Now.ToString("O"));

    /// <summary>Gives every game a healthy cover and background so tests see only what they set up.</summary>
    private static (HealthInputs Input, FakeProbe Probe) Setup(IReadOnlyList<GameDto> games, Func<HealthInputs, HealthInputs>? change = null)
    {
        var probe = new FakeProbe();
        var art = new List<HealthArtRow>();
        foreach (var g in games)
        {
            foreach (var i in g.Installations.Where(i => i.InstallPath is not null)) probe.Dirs.Add(i.InstallPath!);
            foreach (var kind in (string[])["cover", "hero"])
            {
                var file = $"{g.Id}/{kind}.jpg";
                art.Add(new HealthArtRow(g.Id, kind, file, "steam-cdn", false));
                probe.Art[file] = new ArtFileInfo(300_000, kind == "cover" ? 600 : 1920, kind == "cover" ? 900 : 620);
            }
        }
        var input = new HealthInputs { Games = games, Art = art, Now = Now };
        return (change?.Invoke(input) ?? input, probe);
    }

    private static IReadOnlyList<HealthIssueDto> Run(HealthInputs input, IHealthProbe probe) => LibraryHealth.Check(input, probe).Issues;

    [Fact]
    public void A_healthy_library_has_no_issues_and_scores_100()
    {
        var (input, probe) = Setup([Game("Alpha", Inst("steam", path: @"C:\Games\Alpha")), Game("Beta", Inst("epic", path: @"D:\Beta"))]);
        var issues = Run(input, probe);
        Assert.Empty(issues);
        Assert.Equal(100, LibraryHealth.Score(issues, 2));
    }

    [Fact]
    public void Broken_shortcut_for_a_game_you_added_offers_locate_and_hide()
    {
        var inst = Inst("manual", path: @"C:\Tools\App");
        var (input, probe) = Setup([Game("My Tool", inst)], i => i with { Launches = [new HealthLaunchRow(inst.Id, "Executable", @"C:\Tools\App\app.exe")] });

        var issue = Assert.Single(Run(input, probe));
        Assert.Equal(("brokenShortcut", "problem", "launch"), (issue.Kind, issue.Severity, issue.Group));
        Assert.Equal($"brokenShortcut:{inst.Id}", issue.Id);
        Assert.Equal(inst.Id, issue.InstallationId);
        Assert.Equal(@"C:\Tools\App\app.exe", issue.Path);
        Assert.Equal(["locate", "hide"], issue.Fixes.Select(f => f.Action));
        Assert.DoesNotContain(issue.Fixes, f => f.Safe);

        probe.Files.Add(@"C:\Tools\App\app.exe");
        Assert.Empty(Run(input, probe));
    }

    [Fact]
    public void Store_install_whose_folder_or_program_is_gone_offers_a_rescan()
    {
        var gone = Inst("epic", path: @"C:\Games\Gone");
        var exe = Inst("gog", path: @"C:\Games\Here");
        var (input, probe) = Setup([Game("Gone", gone), Game("Here", exe)],
            i => i with { Launches = [new HealthLaunchRow(exe.Id, "Executable", @"C:\Games\Here\game.exe")] });
        probe.Dirs.Remove(@"C:\Games\Gone");

        var issues = Run(input, probe);
        Assert.Equal(2, issues.Count);
        Assert.All(issues, i => Assert.Equal("launchTargetMissing", i.Kind));
        Assert.All(issues, i => Assert.Equal(new HealthFixDto("rescan", "Rescan", true), i.Fixes[0]));
    }

    [Fact]
    public void Games_on_a_disconnected_drive_become_one_drive_issue_not_many_broken_ones()
    {
        var a = Inst("steam", path: @"E:\SteamLibrary\steamapps\common\A");
        var b = Inst("manual", path: @"E:\Tools\B");
        var c = Inst("steam", state: "missing", path: @"e:\SteamLibrary\steamapps\common\C", lastSeen: Now.AddDays(-90).ToString("O"));
        var owned = Inst("steam", state: "notinstalled", path: @"E:\SteamLibrary\steamapps\common\D");
        var (input, probe) = Setup([Game("A", a), Game("B", b), Game("C", c), Game("D", owned)],
            i => i with { Launches = [new HealthLaunchRow(b.Id, "Executable", @"E:\Tools\B\b.exe")] });
        probe.OfflineDrives.Add("E:");

        var issue = Assert.Single(Run(input, probe));
        Assert.Equal(("missingDrive", "missingDrive:E", "E:"), (issue.Kind, issue.Id, issue.Drive));
        Assert.Equal(3, issue.GameIds.Count); // not-installed games don't count
        Assert.Equal(["manual", "steam"], issue.Platforms);
        Assert.Contains("3 games", issue.Detail);
        Assert.Equal(1, probe.DriveQueries); // asked once per drive, even for a slow network drive
    }

    [Fact]
    public void Same_game_installed_from_two_stores_and_steam_library_duplicates()
    {
        var g = Game("Twice", Inst("steam", path: @"C:\S\Twice", size: 10L << 30, pgid: "4000"), Inst("epic", path: @"D:\E\Twice", size: 12L << 30));
        var (input, probe) = Setup([g], i => i with { SteamDuplicates = [new SteamLibraryDuplicate("4000", [@"C:\Steam", @"D:\SteamLibrary"])] });

        var issues = Run(input, probe);
        var dup = Assert.Single(issues, i => i.Kind == "duplicateInstall");
        Assert.Contains("Steam and Epic Games", dup.Detail);
        Assert.Contains("22 GB", dup.Detail);
        var lib = Assert.Single(issues, i => i.Kind == "steamLibraryDuplicate");
        Assert.Equal(g.Id, lib.GameId);
        Assert.Contains(@"D:\SteamLibrary", lib.Detail);
    }

    [Fact]
    public void Unmerged_duplicate_suggestions_offer_merge_and_keep_separate()
    {
        var a = Game("Kingsfall", Inst("steam", path: @"C:\K"));
        var b = Game("Kingsfall Remastered", Inst("xbox", path: @"C:\KR"));
        var hidden = Game("Hidden one", true, Inst("gog", path: @"C:\H"));
        var (input, probe) = Setup([a, b, hidden], i => i with
        {
            Suggestions = [new DuplicateSuggestionDto(a.Id, b.Id, "Both reduce to “kingsfall”."), new DuplicateSuggestionDto(a.Id, hidden.Id, "x")],
        });
        var issue = Assert.Single(Run(input, probe));
        Assert.Equal(($"duplicateSuggestion:{a.Id}-{b.Id}", b.Id), (issue.Id, issue.OtherGameId));
        Assert.Equal(["merge", "keepSeparate"], issue.Fixes.Select(f => f.Action));
    }

    [Fact]
    public void Art_problems_missing_placeholder_low_res_and_files_gone()
    {
        var noCover = Game("No cover", Inst("steam", path: @"C:\1"));
        var placeholder = Game("Placeholder", Inst("steam", path: @"C:\2"));
        var lowRes = Game("Low res", Inst("steam", path: @"C:\3"));
        var gone = Game("Gone file", Inst("epic", path: @"C:\4"));
        var userLow = Game("User low", Inst("steam", path: @"C:\5"));
        var (input, probe) = Setup([noCover, placeholder, lowRes, gone, userLow], i => i with
        {
            Art = i.Art.Where(a => a.GameId != noCover.Id || a.Kind != "cover")
                .Select(a => a.GameId == userLow.Id && a.Kind == "cover" ? a with { IsUser = true } : a).ToList(),
            SteamAppIds = new Dictionary<string, string> { [noCover.Id] = "10", [placeholder.Id] = "20", [lowRes.Id] = "30", [userLow.Id] = "50" },
        });
        probe.Art[$"{placeholder.Id}/cover.jpg"] = new ArtFileInfo(4500, 600, 900);
        probe.Art[$"{lowRes.Id}/cover.jpg"] = new ArtFileInfo(40_000, 200, 300);
        probe.Art.Remove($"{gone.Id}/hero.jpg");
        probe.Art[$"{userLow.Id}/cover.jpg"] = new ArtFileInfo(40_000, 200, 300);

        var issues = Run(input, probe);
        var missing = Assert.Single(issues, i => i.Kind == "artMissing");
        Assert.Equal((noCover.Id, "cover", "warning"), (missing.GameId, missing.ArtKind, missing.Severity));
        Assert.Equal(["refetchArt", "pickArt"], missing.Fixes.Select(f => f.Action));
        Assert.True(missing.Fixes[0].Safe);
        Assert.Equal(placeholder.Id, Assert.Single(issues, i => i.Kind == "artPlaceholder").GameId);
        var low = issues.Where(i => i.Kind == "artLowRes").ToList();
        Assert.Equal(2, low.Count);
        Assert.Contains("200×300", low[0].Detail);
        // Art the user chose is never replaced automatically.
        Assert.Equal(["pickArt"], low.Single(i => i.GameId == userLow.Id).Fixes.Select(f => f.Action));
        var fileGone = Assert.Single(issues, i => i.Kind == "artFileMissing");
        Assert.Equal((gone.Id, "hero"), (fileGone.GameId, fileGone.ArtKind));
        Assert.DoesNotContain(fileGone.Fixes, f => f.Action == "refetchArt"); // not a Steam game
    }

    [Fact]
    public void Missing_details_only_after_a_lookup_was_tried()
    {
        var bare = Game("Bare", Inst("steam", path: @"C:\B")) with { Description = null, Developer = null, Genres = [] };
        var pending = Game("Pending", Inst("steam", path: @"C:\P")) with { Description = null, Developer = null, Genres = [] };
        var (input, probe) = Setup([bare, pending], i => i with { MetadataAttempted = new HashSet<string> { bare.Id } });
        var issue = Assert.Single(Run(input, probe));
        Assert.Equal(("metadataMissing", bare.Id), (issue.Kind, issue.GameId));
        Assert.Equal(new HealthFixDto("lookupMetadata", "Look again", true), issue.Fixes[0]);

        var off = Assert.Single(Run(input with { FetchMetadata = false }, probe));
        Assert.Equal("openSettings", off.Fixes[0].Action);
    }

    [Fact]
    public void Stale_missing_installs_sessions_disabled_stores_and_empty_entries()
    {
        var stale = Game("Stale", Inst("epic", state: "missing", lastSeen: Now.AddDays(-45).ToString("O")));
        var recent = Game("Recent", Inst("epic", state: "missing", lastSeen: Now.AddDays(-3).ToString("O")));
        var ubi = Game("Ubi", Inst("ubisoft", path: @"C:\U"));
        var empty = Game("Empty");
        var (input, probe) = Setup([stale, recent, ubi, empty], i => i with
        {
            OpenSessions = [new HealthSessionRow("a".PadLeft(32, 'a'), ubi.Id, Now.AddDays(-2).ToString("O"), 0), new HealthSessionRow("b".PadLeft(32, 'b'), ubi.Id, Now.ToString("O"), 0)],
            ActiveSessionIds = new HashSet<string> { "b".PadLeft(32, 'b') },
            LongSessions = [new HealthSessionRow("c".PadLeft(32, 'c'), ubi.Id, Now.AddDays(-10).ToString("O"), 20 * 3600)],
            DisabledPlatforms = ["ubisoft", "gog"],
        });
        var issues = Run(input, probe);
        var s = Assert.Single(issues, i => i.Kind == "staleMissing");
        Assert.Equal(stale.Id, s.GameId);
        Assert.Contains("45 days", s.Title);
        Assert.Equal(["rescan", "hide"], s.Fixes.Select(f => f.Action));
        var open = Assert.Single(issues, i => i.Kind == "openSession"); // the one being recorded right now is left alone
        Assert.Equal("a".PadLeft(32, 'a'), open.SessionId);
        Assert.Contains("20-hour", Assert.Single(issues, i => i.Kind == "longSession").Title);
        var off = Assert.Single(issues, i => i.Kind == "platformOff"); // GOG has no games: not reported
        Assert.Equal(("ubisoft", "enableStore"), (off.Platform, off.Fixes[0].Action));
        Assert.Equal(empty.Id, Assert.Single(issues, i => i.Kind == "emptyEntry").GameId);
    }

    [Fact]
    public void Hidden_games_and_dismissed_issues_are_left_out_and_order_is_by_severity()
    {
        var manual = Inst("manual", path: @"C:\M");
        var hidden = Inst("manual", path: @"C:\H");
        var noCover = Game("No cover", Inst("steam", path: @"C:\N"));
        var (input, probe) = Setup([Game("Manual", manual), Game("Hidden", true, hidden), noCover], i => i with
        {
            Launches = [new HealthLaunchRow(manual.Id, "Executable", @"C:\M\m.exe"), new HealthLaunchRow(hidden.Id, "Executable", @"C:\H\h.exe")],
            Art = i.Art.Where(a => a.GameId != noCover.Id || a.Kind != "cover").ToList(),
        });
        var issues = Run(input, probe);
        Assert.Equal(["brokenShortcut", "artMissing"], issues.Select(i => i.Kind));

        var (shown, dismissed) = LibraryHealth.Check(input with { Dismissed = new HashSet<string> { issues[0].Id } }, probe);
        Assert.Equal(1, dismissed);
        Assert.Equal("artMissing", Assert.Single(shown).Kind);
    }

    [Fact]
    public void Score_falls_with_severity_and_scales_with_library_size()
    {
        HealthIssueDto I(string severity, int games = 1) => new("x:1", "k", "g", severity, "", "", null, Enumerable.Repeat("g", games).ToList(), null, null, [], null, null, null, null, null, []);
        Assert.Equal(100, LibraryHealth.Score([], 10));
        var oneProblem = LibraryHealth.Score([I("problem")], 100);
        var oneInfo = LibraryHealth.Score([I("info")], 100);
        Assert.InRange(oneProblem, 80, 90);
        Assert.InRange(oneInfo, 95, 99);
        Assert.True(LibraryHealth.Score([I("warning", 6)], 100) < LibraryHealth.Score([I("warning")], 100));
        Assert.True(LibraryHealth.Score([I("problem")], 2000) > oneProblem);
        Assert.Equal(1, LibraryHealth.Score(Enumerable.Repeat(I("problem"), 500).ToList(), 10));
    }

    // ---------- image headers ----------

    [Fact]
    public void Image_sizes_from_headers()
    {
        var png = new byte[32];
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, (byte)'I', (byte)'H', (byte)'D', (byte)'R' }.CopyTo(png, 0);
        BinaryPrimitives.WriteInt32BigEndian(png.AsSpan(16), 600);
        BinaryPrimitives.WriteInt32BigEndian(png.AsSpan(20), 900);
        Assert.Equal((600, 900), ImageHeader.Size(png));

        // JPEG: SOI, an APP0 segment, then SOF0 with height 620, width 1920.
        byte[] jpg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x02, 0x6C, 0x07, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0];
        Assert.Equal((1920, 620), ImageHeader.Size(jpg));

        var webp = new byte[32];
        "RIFF"u8.CopyTo(webp); "WEBPVP8X"u8.CopyTo(webp.AsSpan(8));
        webp[24] = 0x57; webp[25] = 0x02; // 600 - 1 = 599 = 0x257
        webp[27] = 0x83; webp[28] = 0x03; // 900 - 1 = 899 = 0x383
        Assert.Equal((600, 900), ImageHeader.Size(webp));

        Assert.Null(ImageHeader.Size(new byte[40]));
        Assert.Null(ImageHeader.Size([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    }
}

public sealed class LibraryHealthRepositoryTests : IDisposable
{
    private readonly TestDb _t = new();
    public void Dispose() => _t.Dispose();

    [Fact]
    public void Relocating_a_game_you_added_updates_only_its_launch_details()
    {
        var gameId = _t.Repo.AddManualGame("Tool", @"C:\Old\tool.exe", null);
        var inst = _t.Repo.GetInstallations(gameId).Single();
        Assert.True(_t.Repo.RelocateManualExecutable(inst.Id, @"D:\New\tool2.exe"));
        var after = _t.Repo.GetInstallation(inst.Id)!;
        Assert.Equal(@"D:\New\tool2.exe", after.Launch.Value);
        Assert.Equal(@"D:\New", after.InstallPath);
        Assert.Equal(["tool2.exe"], after.ProcessHints);
        Assert.Equal(gameId, after.GameId);

        _t.Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "10", "Store game", @"C:\S"))]);
        var store = _t.Repo.GetInstallationsByPlatformId(PlatformId.Steam, "10")!;
        Assert.False(_t.Repo.RelocateManualExecutable(store.Id, @"D:\x.exe")); // store games are found by scanning
    }

    [Fact]
    public void Closing_an_open_session_keeps_its_best_known_length()
    {
        var gameId = _t.Repo.AddManualGame("Tool", @"C:\Old\tool.exe", null);
        var start = DateTimeOffset.UtcNow.AddHours(-3);
        var sessionId = _t.Repo.StartSession(gameId, null, start);
        _t.Repo.AddPerfSamples(sessionId, [new PerfSampleDto(1_800_000, 10, 10, 1, 1, 50)]);

        var rows = _t.Repo.LoadHealthRows(DateTimeOffset.UtcNow);
        Assert.Equal(sessionId, Assert.Single(rows.OpenSessions).Id);

        Assert.True(_t.Repo.CloseOpenSession(sessionId));
        Assert.False(_t.Repo.CloseOpenSession(sessionId)); // already closed: nothing changes
        var s = _t.Repo.ListSessions(gameId, 10).Single();
        Assert.Equal(1800, s.DurationSeconds);
        Assert.Empty(_t.Repo.LoadHealthRows(DateTimeOffset.UtcNow).OpenSessions);
    }

    [Fact]
    public void Health_rows_and_metadata_reset()
    {
        _t.Repo.ApplyScan([Ok(PlatformId.Steam, Install(PlatformId.Steam, "620", "Portal 2", @"C:\P2", steamAppId: "620"))]);
        var gameId = _t.Repo.LoadSnapshot((_, f) => f).Games.Single().Id;
        _t.Repo.SetArtwork(gameId, ArtworkKind.Cover, $"{gameId}/cover.jpg", "steam-cdn", false);
        _t.Repo.MarkMetadataAttempted(gameId);

        var rows = _t.Repo.LoadHealthRows(DateTimeOffset.UtcNow);
        Assert.Equal("620", rows.SteamAppIds[gameId]);
        Assert.Contains(gameId, rows.MetadataAttempted);
        Assert.Equal(new HealthArtRow(gameId, "cover", $"{gameId}/cover.jpg", "steam-cdn", false), Assert.Single(rows.Art));
        Assert.Equal("Uri", Assert.Single(rows.Launches).LaunchKind);

        Assert.Equal(1, _t.Repo.ResetMetadataLookup([gameId]));
        Assert.DoesNotContain(gameId, _t.Repo.LoadHealthRows(DateTimeOffset.UtcNow).MetadataAttempted);
    }
}

public sealed class HealthDismissalsTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Dismiss_restore_persist_and_validate()
    {
        var store = new HealthDismissals(_dir.Path);
        store.Dismiss("artMissing:abc-cover", DateTimeOffset.UtcNow);
        store.Dismiss("missingDrive:E", DateTimeOffset.UtcNow);
        Assert.Equal(2, new HealthDismissals(_dir.Path).Ids().Count); // survives a restart
        Assert.True(store.Restore("missingDrive:E"));
        Assert.False(store.Restore("missingDrive:E"));
        Assert.Equal(["artMissing:abc-cover"], store.Ids());
        Assert.Throws<ArgumentException>(() => store.Dismiss("../../etc", DateTimeOffset.UtcNow));
        Assert.Throws<ArgumentException>(() => store.Dismiss("x:" + new string('a', 200), DateTimeOffset.UtcNow));
        Assert.Equal(1, store.RestoreAll());
        Assert.Empty(store.Ids());

        File.WriteAllText(Path.Combine(_dir.Path, "ui-state", "health.json"), "{ not json");
        Assert.Empty(new HealthDismissals(_dir.Path).Ids()); // corrupt file: start fresh, never throw
    }
}
