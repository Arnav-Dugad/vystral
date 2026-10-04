using System.Text.RegularExpressions;
using System.Xml.Linq;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;

namespace Vystral.Windows.Integrations;

/// <summary>
/// Finds games installed by the EA app from their installer registration (uninstall entries that
/// point at EAInstaller\...\Cleanup.exe) and the default "EA Games" folder, then reads each game's
/// own __Installer\installerdata.xml for its content ID and title. Launches through the EA app's
/// registered origin2:// protocol. The EA app's own (encrypted) state files are never read.
/// </summary>
public sealed partial class EaAdapter(IRegistryReader registry, AdapterEnvironment environment) : IPlatformAdapter
{
    private static readonly string[] ClientRoots = [@"SOFTWARE\Electronic Arts\EA Desktop", @"SOFTWARE\WOW6432Node\Electronic Arts\EA Desktop"];

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._:\-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex ContentIdRegex();

    public PlatformId Platform => PlatformId.Ea;

    public AdapterCapabilities Capabilities => AdapterCapabilities.DiscoverInstalled | AdapterCapabilities.Launch;

    public IReadOnlyList<string> Limitations =>
    [
        "Shows EA app games installed on this PC. Games you own but haven't installed aren't imported.",
        "EA games bought on Steam appear under Steam instead.",
        "Playtime isn't available locally for EA app games; VYSTRAL tracks sessions you start from here.",
        "Games start through the EA app, which may ask you to sign in.",
    ];

    public string? FindClientExe()
    {
        foreach (var root in ClientRoots)
        foreach (var value in new[] { "ClientPath", "DesktopAppPath" })
        {
            var exe = UninstallScanner.NormalizeDir(registry.GetString(Hive.LocalMachine, root, value));
            if (exe is not null && AdapterIo.FileExists(exe)) return exe;
        }
        return null;
    }

    public AdapterStatus GetStatus()
    {
        var exe = FindClientExe();
        return exe is not null
            ? new AdapterStatus(ClientStatus.Available, exe)
            : new AdapterStatus(ClientStatus.NotInstalled, null);
    }

    public Task<IReadOnlyList<DiscoveredInstallation>> DiscoverAsync(CancellationToken cancellationToken) =>
        Task.FromResult(Discover(cancellationToken));

    internal IReadOnlyList<DiscoveredInstallation> Discover(CancellationToken ct)
    {
        var steamLibraries = FindSteamLibraries();
        var candidates = new List<(string Dir, string? DisplayName)>();

        foreach (var entry in UninstallScanner.Read(registry))
        {
            if (entry.InstallLocation is null || entry.UninstallString is null) continue;
            if (entry.UninstallString.Contains("EAInstaller", StringComparison.OrdinalIgnoreCase) &&
                entry.UninstallString.Contains("Cleanup.exe", StringComparison.OrdinalIgnoreCase))
                candidates.Add((entry.InstallLocation, entry.DisplayName));
        }

        // Default EA app library folder; each game folder still has to carry installerdata.xml.
        var defaultLibrary = Path.Combine(environment.ProgramFiles, "EA Games");
        if (AdapterIo.DirectoryExists(defaultLibrary))
        {
            try
            {
                foreach (var dir in Directory.EnumerateDirectories(defaultLibrary)) candidates.Add((dir, null));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }

        var results = new List<DiscoveredInstallation>();
        var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var seenIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (dir, displayName) in candidates)
        {
            ct.ThrowIfCancellationRequested();
            var installDir = AdapterIo.PathKey(dir);
            if (installDir is null || !seenPaths.Add(installDir)) continue;
            if (IsSteamInstall(installDir, steamLibraries)) continue;
            if (!AdapterIo.DirectoryExists(installDir)) continue;

            var data = ReadInstallerData(Path.Combine(installDir, "__Installer", "installerdata.xml"));
            // Without a content ID there is no supported way to start the game; never guess an executable.
            if (data is null || data.ContentIds.Count == 0) continue;
            var id = data.ContentIds[0];
            if (!seenIds.Add(id)) continue;

            var title = data.Title ?? displayName ?? Path.GetFileName(installDir);
            if (string.IsNullOrWhiteSpace(title)) continue;

            results.Add(new DiscoveredInstallation
            {
                Platform = PlatformId.Ea,
                PlatformGameId = id,
                Title = title.Trim(),
                InstallPath = installDir,
                Launch = new LaunchTarget(LaunchKind.Uri, $"origin2://game/launch?offerIds={Uri.EscapeDataString(id)}&autoDownload=1"),
                ClientRequired = true,
                ProcessHints = data.ExeName is null ? [] : [data.ExeName],
            });
        }
        return results;
    }

    internal sealed record InstallerData(IReadOnlyList<string> ContentIds, string? Title, string? ExeName);

    /// <summary>
    /// Parses installerdata.xml in either the EA app "DiPManifest" form or the legacy Origin
    /// "game" form, in UTF-8 or UTF-16.
    /// </summary>
    internal static InstallerData? ReadInstallerData(string path)
    {
        if (!AdapterIo.FileExists(path)) return null;
        var doc = AdapterIo.ReadXml(path);
        if (doc?.Root is null) return null;
        var root = doc.Root;

        var ids = root.Descendants().Where(e => e.Name.LocalName.Equals("contentID", StringComparison.OrdinalIgnoreCase))
            .Select(e => e.Value.Trim())
            .Where(v => ContentIdRegex().IsMatch(v))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        // DiPManifest: <gameTitles><gameTitle locale="en_US">..</gameTitle></gameTitles>
        var title = PickLocalized(root.Descendants().Where(e => e.Name.LocalName == "gameTitle"));
        // Legacy: <game><metadata><localeInfo locale="en_US"><title>..</title></localeInfo></metadata></game>
        title ??= PickLocalized(root.Descendants().Where(e => e.Name.LocalName == "localeInfo")
            .Select(li => li.Elements().FirstOrDefault(c => c.Name.LocalName == "title")).OfType<XElement>(),
            e => e.Parent?.Attribute("locale")?.Value);

        // <runtime><launcher><filePath>[HKEY_...\Install Dir]bin\game.exe</filePath>
        string? exe = null;
        foreach (var fp in root.Descendants().Where(e => e.Name.LocalName == "filePath" && e.Parent?.Name.LocalName == "launcher"))
        {
            var value = fp.Value.Trim();
            var bracket = value.LastIndexOf(']');
            if (bracket >= 0) value = value[(bracket + 1)..];
            exe = AdapterIo.ExeFileName(value);
            if (exe is not null) break;
        }

        return new InstallerData(ids, title, exe);
    }

    private static string? PickLocalized(IEnumerable<XElement> elements, Func<XElement, string?>? locale = null)
    {
        locale ??= e => e.Attribute("locale")?.Value;
        var list = elements.Where(e => !string.IsNullOrWhiteSpace(e.Value)).ToList();
        var pick = list.FirstOrDefault(e => string.Equals(locale(e), "en_US", StringComparison.OrdinalIgnoreCase))
                   ?? list.FirstOrDefault(e => locale(e)?.StartsWith("en", StringComparison.OrdinalIgnoreCase) == true)
                   ?? list.FirstOrDefault();
        return pick?.Value.Trim();
    }

    private IReadOnlyList<string> FindSteamLibraries()
    {
        var steamPath = new SteamAdapter(registry).FindSteamPath();
        return steamPath is null ? [] : SteamAdapter.GetLibraryFolders(steamPath).Select(l => Path.Combine(l, "steamapps")).ToList();
    }

    /// <summary>EA games sold on Steam register EA uninstall data too; the Steam adapter owns those.</summary>
    internal static bool IsSteamInstall(string installDir, IReadOnlyList<string> steamLibraries) =>
        installDir.Contains(@"\steamapps\", StringComparison.OrdinalIgnoreCase) ||
        steamLibraries.Any(lib => AdapterIo.IsUnder(installDir, lib));
}
