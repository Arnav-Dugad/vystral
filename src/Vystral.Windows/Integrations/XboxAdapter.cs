using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;

namespace Vystral.Windows.Integrations;

/// <summary>
/// Lists packaged games (Xbox app / PC Game Pass / Microsoft Store) installed for the current user via
/// <c>PackageManager.FindPackagesForUser("")</c>, which needs no elevation. A package counts as a game
/// only if it ships a MicrosoftGame.config (GDK titles), lives under an Xbox app library folder
/// declared by a drive's .GamingRoot file, or is an older Store (UWP) game that carries an Xbox Live
/// xboxservices.config (Forza Horizon 4, Gears 5…), minus Microsoft's own Xbox apps.
/// Games are activated by AppUserModelID through Windows.
/// </summary>
public sealed partial class XboxAdapter(IRegistryReader registry) : IPlatformAdapter
{
    /// <summary>What the scan needs to know about one installed package; decoupled from WinRT for tests.</summary>
    internal sealed record PackageInfo(
        string FamilyName,
        string? DisplayName,
        string? InstalledLocation,
        bool IsFramework,
        bool IsResourcePackage,
        bool IsStoreSigned);

    [GeneratedRegex(@"\.(?:scale|targetsize)-(\d+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex QualifierRegex();

    public PlatformId Platform => PlatformId.Xbox;

    public AdapterCapabilities Capabilities =>
        AdapterCapabilities.DiscoverInstalled | AdapterCapabilities.Launch | AdapterCapabilities.LocalArtwork |
        AdapterCapabilities.OpenInClient;

    public IReadOnlyList<string> Limitations =>
    [
        "Shows Xbox app and Microsoft Store games installed on this PC. Game Pass games you haven't installed aren't shown.",
        "Older Store games without Xbox Live may be missed; you can add them yourself.",
        "Playtime isn't available locally for Xbox games; VYSTRAL tracks sessions you start from here.",
    ];

    public AdapterStatus GetStatus()
    {
        var gamingServices = registry.GetString(Hive.LocalMachine, @"SOFTWARE\Microsoft\GamingServices", "CurrentVersion")
                             ?? registry.GetValue(Hive.LocalMachine, @"SOFTWARE\Microsoft\GamingServices", "CurrentVersion")?.ToString();
        return gamingServices is not null
            ? new AdapterStatus(ClientStatus.Available, null)
            : new AdapterStatus(ClientStatus.Available, null, "Gaming Services isn't installed. Most PC Game Pass games need it; install the Xbox app to get it.");
    }

    public string? GetClientPageUri(string platformGameId) =>
        platformGameId.Contains('_') && !platformGameId.Any(char.IsWhiteSpace)
            ? $"ms-windows-store://pdp/?PFN={Uri.EscapeDataString(platformGameId)}"
            : null;

    public Task<IReadOnlyList<DiscoveredInstallation>> DiscoverAsync(CancellationToken cancellationToken) =>
        Task.Run(() =>
        {
            var packages = EnumeratePackages();
            if (packages.Count == 0) return (IReadOnlyList<DiscoveredInstallation>)[];
            return Discover(packages, FindGamingFolders(EnumerateDriveRoots()), cancellationToken);
        }, cancellationToken);

    internal static IReadOnlyList<PackageInfo> EnumeratePackages()
    {
        var list = new List<PackageInfo>();
        try
        {
            var manager = new global::Windows.Management.Deployment.PackageManager();
            foreach (var package in manager.FindPackagesForUser(string.Empty))
            {
                try
                {
                    string? location;
                    try
                    {
                        location = package.InstalledLocation?.Path;
                    }
                    catch (Exception)
                    {
                        // InstalledLocation can throw for packages being serviced or staged.
                        continue;
                    }

                    string? displayName = null;
                    try
                    {
                        displayName = package.DisplayName;
                    }
                    catch (Exception)
                    {
                    }

                    list.Add(new PackageInfo(
                        package.Id.FamilyName,
                        displayName,
                        location,
                        package.IsFramework,
                        package.IsResourcePackage,
                        package.SignatureKind == global::Windows.ApplicationModel.PackageSignatureKind.Store));
                }
                catch (Exception)
                {
                    // One unreadable package must not hide the rest.
                }
            }
        }
        catch (Exception)
        {
            // WinRT failures surface as COMException/UnauthorizedAccessException/etc.; report nothing found.
            return [];
        }
        return list;
    }

    internal static IEnumerable<string> EnumerateDriveRoots()
    {
        try
        {
            return DriveInfo.GetDrives()
                .Where(d => d.DriveType is DriveType.Fixed or DriveType.Removable && d.IsReady)
                .Select(d => d.RootDirectory.FullName)
                .ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    /// <summary>Resolves the Xbox app library folder named by each drive's .GamingRoot file.</summary>
    internal static IReadOnlyList<string> FindGamingFolders(IEnumerable<string> driveRoots)
    {
        var folders = new List<string>();
        foreach (var root in driveRoots)
        {
            var file = Path.Combine(root, ".GamingRoot");
            if (!AdapterIo.FileExists(file)) continue;
            var relative = ParseGamingRoot(AdapterIo.ReadAllBytesShared(file, maxBytes: 64 * 1024));
            var folder = relative is null ? null : AdapterIo.CombineInside(root, relative);
            if (folder is not null) folders.Add(folder);
        }
        return folders;
    }

    /// <summary>
    /// .GamingRoot layout: ASCII "RGBX", a uint32 (observed 1), then UTF-16LE NUL-terminated
    /// folder path relative to the drive root (e.g. "XboxGames").
    /// </summary>
    internal static string? ParseGamingRoot(byte[]? bytes)
    {
        if (bytes is null || bytes.Length < 10) return null;
        if (bytes[0] != (byte)'R' || bytes[1] != (byte)'G' || bytes[2] != (byte)'B' || bytes[3] != (byte)'X') return null;
        var body = bytes.AsSpan(8);
        var length = body.Length & ~1;
        var text = Encoding.Unicode.GetString(body[..length]);
        var nul = text.IndexOf('\0');
        if (nul >= 0) text = text[..nul];
        text = text.Trim().Trim('\\', '/');
        if (text.Length == 0 || text.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || text.Contains(':') || text.Contains("..")) return null;
        return text;
    }

    /// <summary>
    /// Microsoft's Xbox apps carry an xboxservices.config too (the Insider Hub does) but aren't games.
    /// </summary>
    internal static bool IsXboxSystemApp(string familyName)
    {
        var name = familyName.Split('_')[0];
        return name.StartsWith("Microsoft.Xbox", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Microsoft.GamingApp", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Microsoft.GamingServices", StringComparison.OrdinalIgnoreCase);
    }

    internal static IReadOnlyList<DiscoveredInstallation> Discover(
        IEnumerable<PackageInfo> packages, IReadOnlyList<string> gamingFolders, CancellationToken ct)
    {
        var results = new List<DiscoveredInstallation>();
        var seenFamilies = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var package in packages)
        {
            ct.ThrowIfCancellationRequested();
            var found = TryBuild(package, gamingFolders);
            if (found is null) continue;
            if (!seenFamilies.Add(found.PlatformGameId) || !seenPaths.Add(found.InstallPath!)) continue;
            results.Add(found);
        }
        return results;
    }

    private static DiscoveredInstallation? TryBuild(PackageInfo package, IReadOnlyList<string> gamingFolders)
    {
        if (package.IsFramework || package.IsResourcePackage || !package.IsStoreSigned) return null;
        if (string.IsNullOrWhiteSpace(package.FamilyName)) return null;
        var location = AdapterIo.PathKey(package.InstalledLocation);
        if (location is null || !AdapterIo.DirectoryExists(location)) return null;

        var configPath = Path.Combine(location, "MicrosoftGame.config");
        var hasConfig = AdapterIo.FileExists(configPath);
        var underGamingRoot = gamingFolders.Any(f => AdapterIo.IsUnder(location, f));
        // Older UWP games (installed under WindowsApps, no MicrosoftGame.config) still ship the Xbox Live
        // config. Only its existence is checked: these packages' files are often encrypted and unreadable.
        var xboxLiveTitle = !hasConfig && !underGamingRoot &&
                            AdapterIo.FileExists(Path.Combine(location, "xboxservices.config")) &&
                            !IsXboxSystemApp(package.FamilyName);
        if (!hasConfig && !underGamingRoot && !xboxLiveTitle) return null;

        var manifest = AdapterIo.ReadXml(Path.Combine(location, "AppxManifest.xml"));
        if (manifest?.Root is null) return null;
        var application = manifest.Root.Elements().Where(e => e.Name.LocalName == "Applications")
            .Elements().FirstOrDefault(e => e.Name.LocalName == "Application" && !string.IsNullOrWhiteSpace(e.Attribute("Id")?.Value));
        if (application is null) return null;
        var appId = application.Attribute("Id")!.Value.Trim();
        var aumid = $"{package.FamilyName}!{appId}";

        var config = hasConfig ? AdapterIo.ReadXml(configPath)?.Root : null;
        var shellVisuals = config?.Elements().FirstOrDefault(e => e.Name.LocalName == "ShellVisuals");

        var title = Usable(package.DisplayName)
                    ?? Usable(shellVisuals?.Attribute("DefaultDisplayName")?.Value)
                    ?? Usable(manifest.Root.Elements().Where(e => e.Name.LocalName == "Properties").Elements()
                        .FirstOrDefault(e => e.Name.LocalName == "DisplayName")?.Value);
        if (title is null) return null;

        // Process hints: every executable the game declares, plus the manifest entry point unless it is the GDK helper.
        var hints = new List<string>();
        if (config is not null)
        {
            foreach (var exe in config.Descendants().Where(e => e.Name.LocalName == "Executable"))
            {
                var name = AdapterIo.ExeFileName(exe.Attribute("Name")?.Value);
                if (name is not null && !hints.Contains(name, StringComparer.OrdinalIgnoreCase)) hints.Add(name);
            }
        }
        var entry = AdapterIo.ExeFileName(application.Attribute("Executable")?.Value);
        if (entry is not null && !entry.Equals("GameLaunchHelper.exe", StringComparison.OrdinalIgnoreCase) &&
            !hints.Contains(entry, StringComparer.OrdinalIgnoreCase))
            hints.Add(entry);

        var artwork = new Dictionary<ArtworkKind, string>();
        var visual = application.Descendants().FirstOrDefault(e => e.Name.LocalName == "VisualElements");
        var logoCandidates = new[]
        {
            shellVisuals?.Attribute("Square480x480Logo")?.Value,
            visual?.Attribute("Square150x150Logo")?.Value,
            shellVisuals?.Attribute("Square150x150Logo")?.Value,
            visual?.Attribute("Square44x44Logo")?.Value,
            shellVisuals?.Attribute("Square44x44Logo")?.Value,
        };
        foreach (var candidate in logoCandidates)
        {
            var file = ResolveLogo(location, candidate);
            if (file is null) continue;
            artwork[ArtworkKind.Icon] = file;
            break;
        }

        return new DiscoveredInstallation
        {
            Platform = PlatformId.Xbox,
            PlatformGameId = package.FamilyName,
            Title = title,
            InstallPath = location,
            Launch = new LaunchTarget(LaunchKind.PackagedApp, aumid),
            ClientRequired = false,
            LocalArtwork = artwork,
            ProcessHints = hints,
        };
    }

    /// <summary>
    /// Manifest logo paths name a base file ("Assets\Logo.png") while the package ships qualified
    /// variants ("Logo.scale-200.png", "Logo.targetsize-256.png"). Picks the largest variant.
    /// </summary>
    internal static string? ResolveLogo(string packageDir, string? relative)
    {
        var basePath = AdapterIo.CombineInside(packageDir, relative);
        if (basePath is null) return null;
        var dir = Path.GetDirectoryName(basePath);
        if (dir is null || !AdapterIo.DirectoryExists(dir)) return null;
        var stem = Path.GetFileNameWithoutExtension(basePath);
        var ext = Path.GetExtension(basePath);

        var best = (Path: (string?)null, Score: -1L);
        try
        {
            foreach (var file in Directory.EnumerateFiles(dir, stem + "*" + ext))
            {
                var name = Path.GetFileNameWithoutExtension(file);
                if (!name.Equals(stem, StringComparison.OrdinalIgnoreCase) && !name.StartsWith(stem + ".", StringComparison.OrdinalIgnoreCase))
                    continue;
                // Skip theme/contrast variants (altform-unplated is fine, contrast-* is not).
                if (name.Contains("contrast-", StringComparison.OrdinalIgnoreCase)) continue;
                var q = QualifierRegex().Match(name);
                long score = q.Success && long.TryParse(q.Groups[1].Value, out var n) ? n * 1_000_000_000L : 100 * 1_000_000_000L;
                try
                {
                    score += new FileInfo(file).Length;
                }
                catch (IOException)
                {
                }
                if (score > best.Score) best = (file, score);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        return best.Path;
    }

    private static string? Usable(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        name = name.Trim();
        return name.StartsWith("ms-resource:", StringComparison.OrdinalIgnoreCase) ? null : name;
    }
}
