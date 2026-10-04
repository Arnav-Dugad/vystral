using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;

namespace Vystral.Windows.Integrations;

/// <summary>
/// Finds GOG games from their installer registration ("&lt;id&gt;_is1" uninstall entries published by
/// GOG.com, plus HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\&lt;id&gt;) and reads each game's own
/// goggame-&lt;id&gt;.info for its primary play task. GOG games are DRM-free, so they start directly
/// from their executable without GOG Galaxy.
/// </summary>
public sealed partial class GogAdapter(IRegistryReader registry) : IPlatformAdapter
{
    private static readonly string[] GamesRoots = [@"SOFTWARE\WOW6432Node\GOG.com\Games", @"SOFTWARE\GOG.com\Games"];
    private static readonly string[] ClientRoots = [@"SOFTWARE\WOW6432Node\GOG.com\GalaxyClient\paths", @"SOFTWARE\GOG.com\GalaxyClient\paths"];

    [GeneratedRegex(@"^(\d+)_is1$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex UninstallKeyRegex();

    public PlatformId Platform => PlatformId.Gog;

    public AdapterCapabilities Capabilities =>
        AdapterCapabilities.DiscoverInstalled | AdapterCapabilities.Launch | AdapterCapabilities.LocalArtwork |
        AdapterCapabilities.OpenInClient;

    public IReadOnlyList<string> Limitations =>
    [
        "Shows GOG games installed on this PC, whether installed with GOG Galaxy or an offline installer.",
        "Games start directly from their own executable, so GOG Galaxy features such as cloud saves and overlay aren't active for sessions started here.",
        "Playtime recorded by GOG Galaxy isn't imported; VYSTRAL tracks sessions you start from here.",
    ];

    public string? FindGalaxyExe()
    {
        foreach (var root in ClientRoots)
        {
            var dir = UninstallScanner.NormalizeDir(registry.GetString(Hive.LocalMachine, root, "client"));
            if (dir is null) continue;
            var exe = Path.Combine(dir, "GalaxyClient.exe");
            if (AdapterIo.FileExists(exe)) return exe;
        }
        return null;
    }

    public AdapterStatus GetStatus()
    {
        var exe = FindGalaxyExe();
        if (exe is not null) return new AdapterStatus(ClientStatus.Available, exe);
        // GOG games do not need Galaxy, so registered games alone make the integration usable.
        var hasGames = GamesRoots.Any(r => registry.GetSubKeyNames(Hive.LocalMachine, r).Count > 0) ||
                       UninstallScanner.Read(registry).Any(IsGogUninstallEntry);
        return hasGames
            ? new AdapterStatus(ClientStatus.Available, null, "GOG Galaxy isn't installed; games from GOG offline installers are still detected and start directly.")
            : new AdapterStatus(ClientStatus.NotInstalled, null);
    }

    public string? GetClientPageUri(string platformGameId) =>
        platformGameId.Length is > 0 and < 20 && platformGameId.All(char.IsAsciiDigit) && FindGalaxyExe() is not null
            ? $"goggalaxy://openGameView/{platformGameId}"
            : null;

    public Task<IReadOnlyList<DiscoveredInstallation>> DiscoverAsync(CancellationToken cancellationToken) =>
        Task.FromResult(Discover(cancellationToken));

    private sealed record Candidate(string Id, string InstallDir, string? Name, string? RegistryExe, string? RegistryWorkingDir, string? RegistryArgs);

    internal IReadOnlyList<DiscoveredInstallation> Discover(CancellationToken ct)
    {
        var candidates = new Dictionary<string, Candidate>(StringComparer.OrdinalIgnoreCase);

        foreach (var entry in UninstallScanner.Read(registry))
        {
            if (!IsGogUninstallEntry(entry) || entry.InstallLocation is null) continue;
            var id = UninstallKeyRegex().Match(entry.KeyName).Groups[1].Value;
            candidates.TryAdd(id, new Candidate(id, entry.InstallLocation, entry.DisplayName, null, null, null));
        }

        foreach (var root in GamesRoots)
        foreach (var id in registry.GetSubKeyNames(Hive.LocalMachine, root))
        {
            if (!IsNumericId(id)) continue;
            var key = $@"{root}\{id}";
            var dir = UninstallScanner.NormalizeDir(registry.GetString(Hive.LocalMachine, key, "path"));
            var exe = registry.GetString(Hive.LocalMachine, key, "exe");
            var workDir = registry.GetString(Hive.LocalMachine, key, "workingDir");
            var args = registry.GetString(Hive.LocalMachine, key, "launchParam");
            var name = registry.GetString(Hive.LocalMachine, key, "gameName");
            if (candidates.TryGetValue(id, out var existing))
            {
                candidates[id] = existing with { Name = existing.Name ?? name, RegistryExe = exe, RegistryWorkingDir = workDir, RegistryArgs = args };
            }
            else if (dir is not null)
            {
                candidates[id] = new Candidate(id, dir, name, exe, workDir, args);
            }
        }

        var results = new List<DiscoveredInstallation>();
        var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var c in candidates.Values)
        {
            ct.ThrowIfCancellationRequested();
            var found = TryBuild(c);
            if (found is not null && seenPaths.Add(AdapterIo.PathKey(found.InstallPath) ?? found.PlatformGameId)) results.Add(found);
        }
        return results;
    }

    private static DiscoveredInstallation? TryBuild(Candidate c)
    {
        var installDir = AdapterIo.PathKey(c.InstallDir);
        if (installDir is null || !AdapterIo.DirectoryExists(installDir)) return null;

        LaunchTarget? launch = null;
        string? title = c.Name;
        var infoPath = Path.Combine(installDir, $"goggame-{c.Id}.info");
        if (AdapterIo.FileExists(infoPath))
        {
            using var doc = AdapterIo.ReadJson(infoPath);
            if (doc is null || doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            var info = doc.RootElement;
            // DLC carries its parent's id as rootGameId.
            var rootId = info.Str("rootGameId");
            if (rootId is not null && !rootId.Equals(c.Id, StringComparison.OrdinalIgnoreCase)) return null;
            title = info.Str("name") ?? title;
            launch = PrimaryFileTask(info, installDir);
            // No primary play task means a DLC or a non-game package; never guess an executable.
            if (launch is null) return null;
        }
        else
        {
            // Older installers without a .info file: use only the executable GOG registered.
            launch = RegistryLaunch(c, installDir);
            if (launch is null) return null;
        }

        if (string.IsNullOrWhiteSpace(title)) title = Path.GetFileName(installDir);
        if (string.IsNullOrWhiteSpace(title)) return null;

        var artwork = new Dictionary<ArtworkKind, string>();
        var icon = Path.Combine(installDir, $"goggame-{c.Id}.ico");
        if (AdapterIo.FileExists(icon)) artwork[ArtworkKind.Icon] = icon;

        var hint = AdapterIo.ExeFileName(launch.Value);
        return new DiscoveredInstallation
        {
            Platform = PlatformId.Gog,
            PlatformGameId = c.Id,
            Title = title.Trim(),
            InstallPath = installDir,
            Launch = launch,
            ClientRequired = false,
            LocalArtwork = artwork,
            ProcessHints = hint is null ? [] : [hint],
        };
    }

    internal static LaunchTarget? PrimaryFileTask(JsonElement info, string installDir)
    {
        if (info.Child("playTasks", JsonValueKind.Array) is not { } tasks) return null;
        foreach (var task in tasks.EnumerateArray())
        {
            if (task.ValueKind != JsonValueKind.Object || !task.GetBool("isPrimary")) continue;
            if (!string.Equals(task.Str("type"), "FileTask", StringComparison.OrdinalIgnoreCase)) continue;
            var exe = AdapterIo.CombineInside(installDir, task.Str("path"));
            if (exe is null || !AdapterIo.FileExists(exe)) continue;
            var workDir = AdapterIo.CombineInside(installDir, task.Str("workingDir"));
            if (workDir is null || !AdapterIo.DirectoryExists(workDir)) workDir = Path.GetDirectoryName(exe);
            return new LaunchTarget(LaunchKind.Executable, exe, task.Str("arguments"), workDir);
        }
        return null;
    }

    private static LaunchTarget? RegistryLaunch(Candidate c, string installDir)
    {
        if (string.IsNullOrWhiteSpace(c.RegistryExe)) return null;
        var exe = UninstallScanner.NormalizeDir(c.RegistryExe);
        if (exe is null) return null;
        if (!Path.IsPathRooted(exe)) exe = AdapterIo.CombineInside(installDir, exe);
        // Only accept an existing .exe inside the game's own folder.
        if (exe is null || !AdapterIo.IsUnder(exe, installDir) || AdapterIo.ExeFileName(exe) is null || !AdapterIo.FileExists(exe)) return null;
        var workDir = UninstallScanner.NormalizeDir(c.RegistryWorkingDir);
        if (!AdapterIo.DirectoryExists(workDir)) workDir = Path.GetDirectoryName(exe);
        return new LaunchTarget(LaunchKind.Executable, exe, c.RegistryArgs, workDir);
    }

    private static bool IsGogUninstallEntry(UninstallEntry e) =>
        UninstallKeyRegex().IsMatch(e.KeyName) && string.Equals(e.Publisher, "GOG.com", StringComparison.OrdinalIgnoreCase);

    private static bool IsNumericId(string s) => s.Length is > 0 and < 20 && s.All(char.IsAsciiDigit);
}
