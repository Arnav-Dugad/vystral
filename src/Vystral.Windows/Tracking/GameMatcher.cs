using Vystral.Core.Domain;
using Vystral.Windows.Launch;

namespace Vystral.Windows.Tracking;

/// <summary>
/// One installed game the detector watches for. <see cref="Root"/>, <see cref="Hints"/> and
/// <see cref="Excluded"/> have exactly the meaning they have for a launch (<see cref="ProcessScanner.FindUnder"/>),
/// so a game is recognised the same way whether VYSTRAL started it or not.
/// </summary>
public sealed record DetectionTarget(
    string InstallationId,
    string GameId,
    string Title,
    string? Root,
    IReadOnlyCollection<string> Hints,
    IReadOnlyList<string> Excluded)
{
    /// <summary>Directory depth of <see cref="Root"/>; a deeper (more specific) install folder wins a tie.</summary>
    public int Depth => Root?.Count(c => c == '\\') ?? 0;
}

/// <summary>A target with the processes that belong to it in one snapshot.</summary>
/// <param name="HasPrimary">At least one of the processes is the game itself rather than a crash handler, redistributable installer or similar.</param>
public sealed record GameMatch(DetectionTarget Target, IReadOnlyList<int> Pids, bool HasPrimary);

/// <summary>
/// Builds detection targets from the library and matches snapshots against them. Matching uses the
/// same rule as a launch (a process whose executable is inside the install folder, or — for games
/// without one — a hinted executable name), indexed by folder so a poll costs a few dictionary lookups
/// per process rather than one string comparison per process per game.
/// </summary>
public sealed class GameMatcher
{
    /// <summary>Helpers that run inside game folders but don't mean the game is being played (they never start a session).</summary>
    public static readonly IReadOnlySet<string> AuxiliaryNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "UnityCrashHandler64.exe", "UnityCrashHandler32.exe", "CrashReportClient.exe", "CrashReporter.exe", "crashpad_handler.exe",
        "CrashSender1403.exe", "BsSndRpt64.exe", "BsSndRpt.exe", "EasyAntiCheat_EOS_Setup.exe", "EasyAntiCheat_Setup.exe",
        "vc_redist.x64.exe", "vc_redist.x86.exe", "vcredist_x64.exe", "vcredist_x86.exe", "DXSETUP.exe", "dxwebsetup.exe",
        "UEPrereqSetup_x64.exe", "UE4PrereqSetup_x64.exe", "oalinst.exe", "PhysX_SystemSoftware.exe", "unins000.exe", "unins001.exe",
        "uninstall.exe", "Uninstaller.exe", "setup.exe", "installer.exe", "QtWebEngineProcess.exe", "CefSharp.BrowserSubprocess.exe",
    };

    /// <summary>Folders inside games that hold installers and redistributables.</summary>
    public static readonly IReadOnlyList<string> AuxiliaryFolders =
        [@"\_CommonRedist\", @"\__Installer\", @"\Redist\", @"\Redistributables\", @"\DirectX\", @"\Support\", @"\Prerequisites\"];

    /// <summary>Executable names too generic to identify a game without its folder.</summary>
    public static readonly IReadOnlySet<string> GenericHints = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "launcher.exe", "game.exe", "start.exe", "setup.exe", "client.exe", "app.exe", "main.exe", "run.exe", "play.exe",
        "bootstrapper.exe", "launch.exe", "update.exe", "updater.exe", "unins000.exe", "java.exe", "javaw.exe", "python.exe",
    };

    private readonly Dictionary<string, List<DetectionTarget>> _byRoot = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, List<DetectionTarget>> _byHint = new(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyList<DetectionTarget> Targets { get; }

    public GameMatcher(IEnumerable<DetectionTarget> targets)
    {
        Targets = targets.ToList();
        foreach (var t in Targets)
        {
            if (t.Root is not null) Add(_byRoot, t.Root, t);
            else foreach (var h in t.Hints) Add(_byHint, h, t);
        }
    }

    /// <summary>Every target with at least one process in the snapshot.</summary>
    public IReadOnlyList<GameMatch> Match(IReadOnlyList<RunningProcess> snapshot)
    {
        Dictionary<DetectionTarget, (List<int> Pids, bool Primary)>? found = null;
        foreach (var p in snapshot)
        {
            foreach (var t in Candidates(p.ImagePath))
            {
                if (IsExcluded(t, p.ImagePath)) continue;
                found ??= [];
                if (!found.TryGetValue(t, out var entry)) found[t] = entry = ([], false);
                entry.Pids.Add(p.Id);
                if (!entry.Primary && !IsAuxiliary(p.ImagePath)) found[t] = (entry.Pids, true);
            }
        }
        return found is null ? [] : found.Select(kv => new GameMatch(kv.Key, kv.Value.Pids, kv.Value.Primary)).ToList();
    }

    /// <summary>The processes of one target, exactly as a launch would find them.</summary>
    public static IReadOnlyList<int> PidsFor(DetectionTarget target, IReadOnlyList<RunningProcess> snapshot) =>
        ProcessScanner.FindUnder(snapshot, target.Root, target.Hints, target.Excluded).Select(p => p.Id).ToList();

    public static bool IsAuxiliary(string imagePath) =>
        AuxiliaryNames.Contains(Path.GetFileName(imagePath)) ||
        AuxiliaryFolders.Any(f => imagePath.Contains(f, StringComparison.OrdinalIgnoreCase));

    private IEnumerable<DetectionTarget> Candidates(string imagePath)
    {
        if (_byHint.Count > 0 && _byHint.TryGetValue(Path.GetFileName(imagePath), out var hinted))
            foreach (var t in hinted) yield return t;
        if (_byRoot.Count == 0) yield break;
        // Walk up the folders of the executable: C:\a\b\c.exe → C:\a\b\, C:\a\.
        for (var i = imagePath.LastIndexOf('\\'); i > 2; i = imagePath.LastIndexOf('\\', i - 1))
        {
            if (_byRoot.TryGetValue(imagePath[..(i + 1)], out var rooted))
                foreach (var t in rooted) yield return t;
        }
    }

    private static bool IsExcluded(DetectionTarget t, string imagePath)
    {
        foreach (var e in t.Excluded)
            if (imagePath.StartsWith(e, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static void Add(Dictionary<string, List<DetectionTarget>> map, string key, DetectionTarget t)
    {
        if (!map.TryGetValue(key, out var list)) map[key] = list = [];
        list.Add(t);
    }

    // ---------------- building targets ----------------

    /// <summary>Normalises a folder the way <see cref="ProcessScanner.FindUnder"/> does: full path with one trailing backslash.</summary>
    public static string NormalizeDir(string dir) => Path.GetFullPath(dir).TrimEnd('\\') + "\\";

    /// <summary>
    /// Targets for the installed games. Store client folders are excluded unless the game lives inside
    /// one (Steam's steamapps), exactly as for a launch. Games that are ignored, or whose folder is too
    /// broad to identify a game (a drive root, Program Files, Windows, the user profile, or a folder holding
    /// a store client), are skipped.
    /// </summary>
    public static IReadOnlyList<DetectionTarget> BuildTargets(IEnumerable<Installation> installations, IEnumerable<string> clientDirs,
        IReadOnlySet<string> ignoredGameIds, Func<string, string>? title = null, IReadOnlyList<string>? protectedDirs = null)
    {
        var clients = clientDirs.Where(d => !string.IsNullOrWhiteSpace(d)).Select(SafeNormalize).OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var broad = (protectedDirs ?? DefaultProtectedDirs()).Select(SafeNormalize).OfType<string>().ToList();
        var list = new List<DetectionTarget>();
        foreach (var inst in installations)
        {
            if (inst.State != InstallState.Installed || ignoredGameIds.Contains(inst.GameId)) continue;
            string? root = null;
            if (!string.IsNullOrWhiteSpace(inst.InstallPath))
            {
                root = SafeNormalize(inst.InstallPath);
                // A "game folder" holding a store client (or a system folder) would make the client a game.
                if (root is null || IsTooBroad(root, broad) || clients.Any(c => c.StartsWith(root, StringComparison.OrdinalIgnoreCase))) continue;
            }
            var hints = inst.ProcessHints.Where(h => !string.IsNullOrWhiteSpace(h) && (root is not null || !GenericHints.Contains(h)))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (root is null && hints.Count == 0) continue;
            var excluded = clients.Where(c => root is null || !root.StartsWith(c, StringComparison.OrdinalIgnoreCase)).ToList();
            list.Add(new DetectionTarget(inst.Id, inst.GameId, title?.Invoke(inst.GameId) ?? inst.Title, root, hints, excluded));
        }
        return list;
    }

    /// <summary>A drive root, or a folder that is (or contains) a system or profile folder.</summary>
    public static bool IsTooBroad(string root, IReadOnlyList<string> protectedDirs)
    {
        if (root.Length <= 3 || root.StartsWith(@"\\", StringComparison.Ordinal) && root.Count(c => c == '\\') <= 4) return true;
        return protectedDirs.Any(p => p.StartsWith(root, StringComparison.OrdinalIgnoreCase));
    }

    public static IReadOnlyList<string> DefaultProtectedDirs()
    {
        var dirs = new List<string>();
        void Add(Environment.SpecialFolder f)
        {
            try { if (Environment.GetFolderPath(f) is { Length: > 0 } p) dirs.Add(p); } catch (PlatformNotSupportedException) { }
        }
        Add(Environment.SpecialFolder.Windows);
        Add(Environment.SpecialFolder.ProgramFiles);
        Add(Environment.SpecialFolder.ProgramFilesX86);
        Add(Environment.SpecialFolder.CommonApplicationData);
        Add(Environment.SpecialFolder.UserProfile);
        Add(Environment.SpecialFolder.LocalApplicationData);
        Add(Environment.SpecialFolder.ApplicationData);
        Add(Environment.SpecialFolder.Desktop);
        Add(Environment.SpecialFolder.MyDocuments);
        if (Path.GetDirectoryName(AppContext.BaseDirectory.TrimEnd('\\')) is { } own) dirs.Add(own);
        return dirs;
    }

    private static string? SafeNormalize(string dir)
    {
        try { return NormalizeDir(dir); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException or System.Security.SecurityException) { return null; }
    }
}
