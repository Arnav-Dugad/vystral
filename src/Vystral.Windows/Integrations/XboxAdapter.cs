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
        bool IsStoreSigned,
        // Track C1: read-only package details (null when Windows didn't say).
        string? FullName = null,
        string? Version = null,
        DateTimeOffset? InstalledDate = null,
        string? PublisherDisplayName = null);

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
        "When VYSTRAL hasn't seen you play, \"last played\" is estimated from when the game last wrote its saves.",
        "Windows doesn't say locally whether a game came with Game Pass or was bought, so VYSTRAL doesn't guess.",
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
            return Discover(packages, FindGamingFolders(EnumerateDriveRoots()), cancellationToken, ReadContext.ForThisPc());
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

                    // Track C1: details for the game page and size refreshes. Each read may fail on its own.
                    string? fullName = null, version = null, publisher = null;
                    DateTimeOffset? installed = null;
                    try { fullName = package.Id.FullName; } catch (Exception) { }
                    try { var v = package.Id.Version; version = $"{v.Major}.{v.Minor}.{v.Build}.{v.Revision}"; } catch (Exception) { }
                    try { publisher = package.PublisherDisplayName; } catch (Exception) { }
                    try { installed = package.InstalledDate; } catch (Exception) { }

                    list.Add(new PackageInfo(
                        package.Id.FamilyName,
                        displayName,
                        location,
                        package.IsFramework,
                        package.IsResourcePackage,
                        package.SignatureKind == global::Windows.ApplicationModel.PackageSignatureKind.Store,
                        fullName, version, installed, publisher));
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

    /// <summary>
    /// Resolves the Xbox app library folder named by each drive's .GamingRoot file. A drive without one (or with an
    /// unreadable one) that still has the Xbox app's default "XboxGames" folder counts too (Track C1: games on
    /// other drives whose marker file is missing).
    /// </summary>
    internal static IReadOnlyList<string> FindGamingFolders(IEnumerable<string> driveRoots)
    {
        var folders = new List<string>();
        foreach (var root in driveRoots)
        {
            var file = Path.Combine(root, ".GamingRoot");
            string? folder = null;
            if (AdapterIo.FileExists(file))
            {
                var relative = ParseGamingRoot(AdapterIo.ReadAllBytesShared(file, maxBytes: 64 * 1024));
                folder = relative is null ? null : AdapterIo.CombineInside(root, relative);
            }
            if (folder is null)
            {
                var fallback = Path.Combine(root, "XboxGames");
                if (AdapterIo.DirectoryExists(fallback)) folder = fallback;
            }
            if (folder is not null && !folders.Contains(folder, StringComparer.OrdinalIgnoreCase)) folders.Add(folder);
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
        IEnumerable<PackageInfo> packages, IReadOnlyList<string> gamingFolders, CancellationToken ct, ReadContext? context = null)
    {
        context ??= ReadContext.None;
        var results = new List<DiscoveredInstallation>();
        var seenFamilies = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var package in packages)
        {
            ct.ThrowIfCancellationRequested();
            var found = TryBuild(package, gamingFolders, context);
            if (found is null) continue;
            if (!seenFamilies.Add(found.PlatformGameId) || !seenPaths.Add(found.InstallPath!)) continue;
            results.Add(found);
        }
        return results;
    }

    private static DiscoveredInstallation? TryBuild(PackageInfo package, IReadOnlyList<string> gamingFolders, ReadContext context)
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
        // Microsoft's own Xbox apps are never games, wherever they are installed (a GDK game config says otherwise).
        if (!hasConfig && IsXboxSystemApp(package.FamilyName)) return null;

        var manifest = AdapterIo.ReadXml(Path.Combine(location, "AppxManifest.xml"));
        if (manifest?.Root is null) return null;
        var config = hasConfig ? AdapterIo.ReadXml(configPath)?.Root : null;
        var shellVisuals = config?.Elements().FirstOrDefault(e => e.Name.LocalName == "ShellVisuals");

        var application = PickApplication(manifest.Root, config);
        if (application is null) return null;
        var appId = application.Attribute("Id")!.Value.Trim();
        var aumid = $"{package.FamilyName}!{appId}";
        var visual = application.Elements().FirstOrDefault(e => e.Name.LocalName == "VisualElements");
        var properties = manifest.Root.Elements().FirstOrDefault(e => e.Name.LocalName == "Properties");
        string? Prop(string name) => properties?.Elements().FirstOrDefault(e => e.Name.LocalName == name)?.Value;

        // Names: Windows' own display name, else the config's or manifest's, resolving ms-resource: references read-only.
        var packageName = package.FamilyName.Split('_')[0];
        string? Text(string? value, int max) => ReadableText(value, max, package.FullName, packageName, context.ResolveResource);
        var title = Text(package.DisplayName, 200)
                    ?? Text(shellVisuals?.Attribute("DefaultDisplayName")?.Value, 200)
                    ?? Text(visual?.Attribute("DisplayName")?.Value, 200)
                    ?? Text(Prop("DisplayName"), 200);
        if (title is null) return null;
        var publisher = Text(package.PublisherDisplayName, 120)
                        ?? Text(shellVisuals?.Attribute("PublisherDisplayName")?.Value, 120)
                        ?? Text(Prop("PublisherDisplayName"), 120);
        var version = UsableVersion(package.Version)
                      ?? UsableVersion(manifest.Root.Elements().FirstOrDefault(e => e.Name.LocalName == "Identity")?.Attribute("Version")?.Value);

        // Process hints: every executable the game declares, plus the chosen app's entry point unless it is the GDK helper.
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

        var lastPlayed = EstimateLastPlayed(context.PackagesRoot, package.FamilyName, context.Now());

        return new DiscoveredInstallation
        {
            Platform = PlatformId.Xbox,
            PlatformGameId = package.FamilyName,
            Title = title,
            InstallPath = location,
            Launch = new LaunchTarget(LaunchKind.PackagedApp, aumid),
            ClientRequired = false,
            LocalArtwork = PackageArtwork(location, shellVisuals, visual, Prop("Logo")),
            ProcessHints = hints,
            LastPlayed = lastPlayed,
            LastPlayedSource = lastPlayed is null ? null : LastPlayedSources.SaveData,
            Publisher = publisher,
            Version = version,
            InstalledAt = package.InstalledDate is { } d && d.Year >= 2012 && d <= context.Now().AddDays(1) ? d : null,
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
}
