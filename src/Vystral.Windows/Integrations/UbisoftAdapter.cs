using Vystral.Core.Domain;
using Vystral.Core.Integrations;

namespace Vystral.Windows.Integrations;

/// <summary>
/// Reads Ubisoft Connect's install registrations (HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\&lt;id&gt;)
/// and launches through the registered uplay:// protocol.
/// </summary>
public sealed class UbisoftAdapter(IRegistryReader registry) : IPlatformAdapter
{
    private static readonly string[] LauncherRoots = [@"SOFTWARE\WOW6432Node\Ubisoft\Launcher", @"SOFTWARE\Ubisoft\Launcher"];

    public PlatformId Platform => PlatformId.Ubisoft;

    public AdapterCapabilities Capabilities => AdapterCapabilities.DiscoverInstalled | AdapterCapabilities.Launch;

    public IReadOnlyList<string> Limitations =>
    [
        "Shows Ubisoft Connect games installed on this PC. Games you own but haven't installed aren't imported.",
        "Playtime isn't available locally for Ubisoft games; VYSTRAL tracks sessions you start from here.",
        "Ubisoft doesn't keep cover art on disk, so artwork comes from VYSTRAL's metadata sources.",
        "Games start through Ubisoft Connect, which may ask you to sign in.",
    ];

    public string? FindClientDir()
    {
        foreach (var root in LauncherRoots)
        {
            var dir = UninstallScanner.NormalizeDir(registry.GetString(Hive.LocalMachine, root, "InstallDir"));
            if (dir is not null && AdapterIo.FileExists(Path.Combine(dir, "UbisoftConnect.exe"))) return AdapterIo.PathKey(dir);
        }
        foreach (var entry in UninstallScanner.Read(registry))
        {
            if ((string.Equals(entry.DisplayName, "Ubisoft Connect", StringComparison.OrdinalIgnoreCase) || entry.KeyName == "Uplay") &&
                entry.InstallLocation is not null && AdapterIo.FileExists(Path.Combine(entry.InstallLocation, "UbisoftConnect.exe")))
                return AdapterIo.PathKey(entry.InstallLocation);
        }
        return null;
    }

    public AdapterStatus GetStatus()
    {
        var dir = FindClientDir();
        return dir is not null
            ? new AdapterStatus(ClientStatus.Available, Path.Combine(dir, "UbisoftConnect.exe"))
            : new AdapterStatus(ClientStatus.NotInstalled, null);
    }

    public Task<IReadOnlyList<DiscoveredInstallation>> DiscoverAsync(CancellationToken cancellationToken) =>
        Task.FromResult(Discover(cancellationToken));

    internal IReadOnlyList<DiscoveredInstallation> Discover(CancellationToken ct)
    {
        var clientDir = FindClientDir();
        var names = UninstallScanner.Read(registry)
            .Where(e => e.KeyName.StartsWith("Uplay Install ", StringComparison.OrdinalIgnoreCase) && e.DisplayName is not null)
            .GroupBy(e => e.KeyName["Uplay Install ".Length..].Trim(), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First().DisplayName!, StringComparer.OrdinalIgnoreCase);

        var results = new List<DiscoveredInstallation>();
        var seenIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var root in LauncherRoots)
        foreach (var id in registry.GetSubKeyNames(Hive.LocalMachine, $@"{root}\Installs"))
        {
            ct.ThrowIfCancellationRequested();
            if (!IsNumericId(id) || seenIds.Contains(id)) continue;
            var dir = AdapterIo.PathKey(registry.GetString(Hive.LocalMachine, $@"{root}\Installs\{id}", "InstallDir"));
            // Stale keys exist: empty, pointing at removed folders, or at the client's own folder.
            if (dir is null || !AdapterIo.DirectoryExists(dir)) continue;
            if (clientDir is not null && AdapterIo.SamePath(dir, clientDir)) continue;
            if (!seenPaths.Add(dir)) continue;

            var title = names.TryGetValue(id, out var n) ? n : Path.GetFileName(dir);
            if (string.IsNullOrWhiteSpace(title)) continue;
            seenIds.Add(id);
            results.Add(new DiscoveredInstallation
            {
                Platform = PlatformId.Ubisoft,
                PlatformGameId = id,
                Title = title.Trim(),
                InstallPath = dir,
                Launch = new LaunchTarget(LaunchKind.Uri, $"uplay://launch/{id}/0"),
                ClientRequired = true,
            });
        }
        return results;
    }

    private static bool IsNumericId(string s) => s.Length is > 0 and < 12 && s.All(char.IsAsciiDigit);
}
