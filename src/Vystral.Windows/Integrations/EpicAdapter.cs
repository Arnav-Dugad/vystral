using System.Text.Json;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;

namespace Vystral.Windows.Integrations;

/// <summary>
/// Reads the Epic Games Launcher's local install manifests
/// (%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item) and its install list
/// (%ProgramData%\Epic\UnrealEngineLauncher\LauncherInstalled.dat). Launches through the
/// registered com.epicgames.launcher:// protocol, so Epic's own login/ownership checks apply.
/// </summary>
public sealed class EpicAdapter(IRegistryReader registry, AdapterEnvironment environment) : IPlatformAdapter
{
    public const string LibraryUri = "com.epicgames.launcher://store/library";

    public PlatformId Platform => PlatformId.Epic;

    public AdapterCapabilities Capabilities =>
        AdapterCapabilities.DiscoverInstalled | AdapterCapabilities.Launch | AdapterCapabilities.InstallSize |
        AdapterCapabilities.OpenInClient;

    public IReadOnlyList<string> Limitations =>
    [
        "Shows games installed on this PC. Games you own but haven't installed aren't imported, because Epic only shares that with a signed-in account.",
        "Playtime isn't available locally for Epic games; VYSTRAL tracks sessions you start from here.",
        "Epic doesn't keep cover art on disk, so artwork comes from VYSTRAL's metadata sources.",
        "Games start through the Epic Games Launcher, which may ask you to sign in.",
    ];

    internal string ManifestsDir => Path.Combine(environment.ProgramData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
    internal string LauncherInstalledPath => Path.Combine(environment.ProgramData, "Epic", "UnrealEngineLauncher", "LauncherInstalled.dat");

    public string? FindClientExe()
    {
        var roots = new List<string>();
        foreach (var entry in UninstallScanner.Read(registry))
        {
            if (string.Equals(entry.DisplayName, "Epic Games Launcher", StringComparison.OrdinalIgnoreCase) && entry.InstallLocation is not null)
                roots.Add(entry.InstallLocation);
        }
        // The uninstall entry sometimes goes missing; fall back to the default locations.
        roots.Add(Path.Combine(environment.ProgramFilesX86, "Epic Games"));
        roots.Add(Path.Combine(environment.ProgramFiles, "Epic Games"));

        foreach (var root in roots)
        {
            foreach (var arch in new[] { "Win64", "Win32" })
            {
                var exe = Path.Combine(root, "Launcher", "Portal", "Binaries", arch, "EpicGamesLauncher.exe");
                if (AdapterIo.FileExists(exe)) return exe;
            }
        }
        return null;
    }

    public AdapterStatus GetStatus()
    {
        var exe = FindClientExe();
        if (exe is not null) return new AdapterStatus(ClientStatus.Available, exe);
        return AdapterIo.DirectoryExists(ManifestsDir)
            ? new AdapterStatus(ClientStatus.Error, null, "Epic game data was found, but the Epic Games Launcher isn't installed, so these games can't be started.")
            : new AdapterStatus(ClientStatus.NotInstalled, null);
    }

    public string? GetClientPageUri(string platformGameId) => LibraryUri;

    public Task<IReadOnlyList<DiscoveredInstallation>> DiscoverAsync(CancellationToken cancellationToken) =>
        Task.FromResult(Discover(cancellationToken));

    internal IReadOnlyList<DiscoveredInstallation> Discover(CancellationToken ct)
    {
        if (!AdapterIo.DirectoryExists(ManifestsDir)) return [];
        var installList = ReadLauncherInstalled(LauncherInstalledPath);

        IEnumerable<string> files;
        try
        {
            files = Directory.EnumerateFiles(ManifestsDir, "*.item").ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return [];
        }

        var byAppName = new Dictionary<string, DiscoveredInstallation>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in files)
        {
            ct.ThrowIfCancellationRequested();
            var found = TryReadManifest(file, installList);
            if (found is null) continue;

            if (byAppName.TryGetValue(found.PlatformGameId, out var existing))
            {
                // Several manifests for one AppName happen after moving a game; LauncherInstalled.dat decides.
                if (installList.TryGetValue(found.PlatformGameId, out var listed) && AdapterIo.SamePath(listed, found.InstallPath)
                    && !AdapterIo.SamePath(listed, existing.InstallPath))
                {
                    byAppName[found.PlatformGameId] = found;
                }
                continue;
            }
            byAppName[found.PlatformGameId] = found;
        }

        // Dedupe by install path as well (two AppNames pointing at one folder: keep the first).
        var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        return byAppName.Values.Where(g => seenPaths.Add(AdapterIo.PathKey(g.InstallPath) ?? g.PlatformGameId)).ToList();
    }

    /// <summary>AppName → InstallLocation from LauncherInstalled.dat (may be empty or stale).</summary>
    internal static IReadOnlyDictionary<string, string> ReadLauncherInstalled(string path)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using var doc = AdapterIo.ReadJson(path);
        if (doc?.RootElement.Child("InstallationList", JsonValueKind.Array) is not { } list) return result;
        foreach (var item in list.EnumerateArray())
        {
            var app = item.Str("AppName");
            var loc = UninstallScanner.NormalizeDir(item.Str("InstallLocation"));
            if (app is not null && loc is not null) result.TryAdd(app, loc);
        }
        return result;
    }

    private static DiscoveredInstallation? TryReadManifest(string file, IReadOnlyDictionary<string, string> installList)
    {
        using var doc = AdapterIo.ReadJson(file);
        if (doc is null || doc.RootElement.ValueKind != JsonValueKind.Object) return null;
        var m = doc.RootElement;

        var appName = m.Str("AppName");
        var ns = m.Str("CatalogNamespace");
        var itemId = m.Str("CatalogItemId");
        if (appName is null || ns is null || itemId is null) return null;
        if (m.GetBool("bIsIncompleteInstall")) return null;

        var categories = m.GetStringArray("AppCategories");
        // DLC: add-ons that are not themselves launchable.
        if (categories.Contains("addons", StringComparer.OrdinalIgnoreCase) &&
            !categories.Contains("addons/launchable", StringComparer.OrdinalIgnoreCase))
            return null;
        // Unreal Engine plugins and engine installs.
        if (categories.Any(c => c.Equals("plugins", StringComparison.OrdinalIgnoreCase) || c.Equals("plugins/engine", StringComparison.OrdinalIgnoreCase)) ||
            m.GetStringArray("CompatibleApps").Any(a => a.StartsWith("UE_", StringComparison.OrdinalIgnoreCase)) ||
            (m.Str("TechnicalType")?.Contains("plugins/engine", StringComparison.OrdinalIgnoreCase) ?? false))
            return null;
        // A manifest whose main game is a different app is DLC, unless Epic marks it launchable.
        var mainGame = m.Str("MainGameAppName");
        if (mainGame is not null && !mainGame.Equals(appName, StringComparison.OrdinalIgnoreCase) &&
            !categories.Contains("addons/launchable", StringComparer.OrdinalIgnoreCase))
            return null;

        // The manifest path can be stale after a move; LauncherInstalled.dat tends to be right then.
        var install = UninstallScanner.NormalizeDir(m.Str("InstallLocation"));
        if (!AdapterIo.DirectoryExists(install) && installList.TryGetValue(appName, out var listed)) install = listed;
        if (!AdapterIo.DirectoryExists(install)) return null;

        var title = m.Str("DisplayName") ?? Path.GetFileName(install!.TrimEnd('\\'));
        if (string.IsNullOrWhiteSpace(title)) return null;

        long? size = long.TryParse(m.Str("InstallSize"), out var s) && s > 0 ? s : null;
        var hint = AdapterIo.ExeFileName(m.Str("LaunchExecutable"));

        var uri = $"com.epicgames.launcher://apps/{Uri.EscapeDataString(ns)}%3A{Uri.EscapeDataString(itemId)}%3A{Uri.EscapeDataString(appName)}?action=launch&silent=true";

        return new DiscoveredInstallation
        {
            Platform = PlatformId.Epic,
            PlatformGameId = appName,
            Title = title.Trim(),
            InstallPath = AdapterIo.PathKey(install),
            SizeBytes = size,
            Launch = new LaunchTarget(LaunchKind.Uri, uri),
            ClientRequired = true,
            ProcessHints = hint is null ? [] : [hint],
        };
    }
}
