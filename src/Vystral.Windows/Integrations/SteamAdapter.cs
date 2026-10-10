using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Core.Parsing;

namespace Vystral.Windows.Integrations;

/// <summary>
/// Reads Steam's local library files (libraryfolders.vdf, appmanifest_*.acf, localconfig.vdf)
/// and its local artwork cache. Launches through the registered steam:// protocol.
/// </summary>
public sealed class SteamAdapter(IRegistryReader registry) : IPlatformAdapter
{
    // Steamworks redistributables and tools that are not games.
    private static readonly HashSet<string> IgnoredAppIds = ["228980", "1070560", "1391110", "1628350", "1493710", "2180100"];
    private const long SteamId64Base = 76561197960265728;

    public PlatformId Platform => PlatformId.Steam;

    public AdapterCapabilities Capabilities =>
        AdapterCapabilities.DiscoverInstalled | AdapterCapabilities.Launch | AdapterCapabilities.LocalArtwork |
        AdapterCapabilities.ImportPlaytime | AdapterCapabilities.ImportLastPlayed | AdapterCapabilities.InstallSize |
        AdapterCapabilities.OpenInClient;

    public IReadOnlyList<string> Limitations =>
    [
        "Shows games installed on this PC. Owned-but-not-installed games and achievements need the optional Steam Web API key below.",
        "Playtime comes from Steam's local records for the most recently signed-in account.",
        "Install and update progress is read from Steam's own manifest files, so speed and time left appear after a few seconds.",
    ];

    public string? FindSteamPath()
    {
        var path = registry.GetString(Hive.CurrentUser, @"Software\Valve\Steam", "SteamPath")
                   ?? registry.GetString(Hive.LocalMachine, @"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath")
                   ?? registry.GetString(Hive.LocalMachine, @"SOFTWARE\Valve\Steam", "InstallPath");
        path = UninstallScanner.NormalizeDir(path);
        return path is not null && Directory.Exists(path) ? Path.GetFullPath(path) : null;
    }

    public AdapterStatus GetStatus()
    {
        var path = FindSteamPath();
        if (path is null) return new AdapterStatus(ClientStatus.NotInstalled, null);
        var exe = Path.Combine(path, "steam.exe");
        return File.Exists(exe)
            ? new AdapterStatus(ClientStatus.Available, exe)
            : new AdapterStatus(ClientStatus.Error, path, "Steam's folder exists but steam.exe is missing.");
    }

    public string? GetClientPageUri(string platformGameId) =>
        IsAppId(platformGameId) ? $"steam://nav/games/details/{platformGameId}" : null;

    public Task<IReadOnlyList<DiscoveredInstallation>> DiscoverAsync(CancellationToken cancellationToken)
    {
        var steamPath = FindSteamPath();
        if (steamPath is null) return Task.FromResult<IReadOnlyList<DiscoveredInstallation>>([]);
        return Task.FromResult(Discover(steamPath, cancellationToken));
    }

    internal IReadOnlyList<DiscoveredInstallation> Discover(string steamPath, CancellationToken ct)
    {
        var activity = ReadLocalActivity(steamPath);
        var results = new List<DiscoveredInstallation>();
        var seen = new HashSet<string>();

        foreach (var library in GetLibraryFolders(steamPath))
        {
            ct.ThrowIfCancellationRequested();
            var steamapps = Path.Combine(library, "steamapps");
            if (!Directory.Exists(steamapps)) continue;
            foreach (var manifest in Directory.EnumerateFiles(steamapps, "appmanifest_*.acf"))
            {
                ct.ThrowIfCancellationRequested();
                var found = TryReadManifest(manifest, steamapps, steamPath, activity);
                if (found is not null && seen.Add(found.PlatformGameId)) results.Add(found);
            }
        }
        return results;
    }

    internal static IReadOnlyList<string> GetLibraryFolders(string steamPath)
    {
        var folders = new List<string> { steamPath };
        var vdfPath = Path.Combine(steamPath, "steamapps", "libraryfolders.vdf");
        if (!File.Exists(vdfPath)) return folders;
        try
        {
            var root = Vdf.ParseFile(vdfPath);
            var lf = root["libraryfolders"] ?? root["LibraryFolders"];
            if (lf is null) return folders;
            foreach (var (key, node) in lf.Children)
            {
                if (!long.TryParse(key, out _)) continue;
                // New format: object with "path"; legacy format: the value is the path.
                var path = node.IsObject ? node.GetString("path") : node.Value;
                path = UninstallScanner.NormalizeDir(path);
                if (path is not null && !folders.Contains(path, StringComparer.OrdinalIgnoreCase)) folders.Add(path);
            }
        }
        catch (Exception ex) when (ex is FormatException or IOException or UnauthorizedAccessException)
        {
            // A corrupt libraryfolders.vdf still leaves the main library usable.
        }
        return folders;
    }

    private static DiscoveredInstallation? TryReadManifest(string manifestPath, string steamapps, string steamPath,
        IReadOnlyDictionary<string, (DateTimeOffset? LastPlayed, int? Minutes)> activity)
    {
        VdfNode state;
        try
        {
            state = Vdf.ParseFile(manifestPath)["AppState"] ?? throw new FormatException("No AppState");
        }
        catch (Exception ex) when (ex is FormatException or IOException or UnauthorizedAccessException)
        {
            return null;
        }

        var appId = state.GetString("appid");
        var name = state.GetString("name");
        var installDir = state.GetString("installdir");
        if (appId is null || !IsAppId(appId) || IgnoredAppIds.Contains(appId) || string.IsNullOrWhiteSpace(name) || installDir is null)
            return null;

        var flags = state.GetLong("StateFlags") ?? 0;
        var fullPath = Path.Combine(steamapps, "common", installDir);
        // StateFlags bit 4 = fully installed. Updates in progress keep the bit set.
        if ((flags & 4) == 0 || !Directory.Exists(fullPath)) return null;

        activity.TryGetValue(appId, out var act);
        var manifestLastPlayed = state.GetLong("LastPlayed") is > 0 and var lp ? DateTimeOffset.FromUnixTimeSeconds(lp) : (DateTimeOffset?)null;
        var lastPlayed = Max(act.LastPlayed, manifestLastPlayed);

        return new DiscoveredInstallation
        {
            Platform = PlatformId.Steam,
            PlatformGameId = appId,
            Title = name,
            InstallPath = fullPath,
            SizeBytes = state.GetLong("SizeOnDisk") is > 0 and var size ? size : null,
            LastPlayed = lastPlayed,
            PlaytimeMinutes = act.Minutes,
            Launch = new LaunchTarget(LaunchKind.Uri, $"steam://rungameid/{appId}"),
            ClientRequired = true,
            SteamAppId = appId,
            LocalArtwork = FindLocalArtwork(steamPath, appId),
            // Track D1: the installed build and when Steam installed it, for the game page's update timeline.
            BuildId = state.GetString("buildid") is { Length: > 0 and <= 20 } build && build.All(char.IsAsciiDigit) && build != "0" ? build : null,
            BuildUpdated = state.GetLong("LastUpdated") is > 946684800 and < 32503680000 and var updated ? DateTimeOffset.FromUnixTimeSeconds(updated) : null,
        };
    }

    /// <summary>
    /// Steam keeps artwork it already downloaded in appcache\librarycache\&lt;appid&gt;, either flat
    /// or inside content-hash subfolders. Reusing it avoids any network request.
    /// </summary>
    internal static IReadOnlyDictionary<ArtworkKind, string> FindLocalArtwork(string steamPath, string appId)
    {
        var dir = Path.Combine(steamPath, "appcache", "librarycache", appId);
        var result = new Dictionary<ArtworkKind, string>();
        if (!Directory.Exists(dir)) return result;
        var wanted = new (string File, ArtworkKind Kind)[]
        {
            ("library_600x900_2x.jpg", ArtworkKind.Cover), ("library_600x900.jpg", ArtworkKind.Cover),
            // Newer apps: the same art under content-hash folders with store-asset names.
            ("library_capsule_2x.jpg", ArtworkKind.Cover), ("library_capsule.jpg", ArtworkKind.Cover),
            ("library_hero.jpg", ArtworkKind.Hero), ("logo.png", ArtworkKind.Logo),
            ("header.jpg", ArtworkKind.Header), ("library_header.jpg", ArtworkKind.Header),
        };
        try
        {
            var files = Directory.EnumerateFiles(dir, "*.*", new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 2 })
                .GroupBy(f => Path.GetFileName(f).ToLowerInvariant())
                .ToDictionary(g => g.Key, g => g.OrderByDescending(File.GetLastWriteTimeUtc).First());
            foreach (var (file, kind) in wanted)
            {
                if (!result.ContainsKey(kind) && files.TryGetValue(file, out var path)) result[kind] = path;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
        return result;
    }

    /// <summary>Reads per-app LastPlayed/Playtime for the most recently signed-in Steam account.</summary>
    internal static IReadOnlyDictionary<string, (DateTimeOffset? LastPlayed, int? Minutes)> ReadLocalActivity(string steamPath)
    {
        var result = new Dictionary<string, (DateTimeOffset?, int?)>();
        var accountId = FindMostRecentAccountId(steamPath);
        if (accountId is null) return result;
        var file = Path.Combine(steamPath, "userdata", accountId, "config", "localconfig.vdf");
        if (!File.Exists(file)) return result;
        try
        {
            var apps = Vdf.ParseFile(file).Path("UserLocalConfigStore", "Software", "Valve", "Steam", "apps")
                       ?? Vdf.ParseFile(file).Path("UserLocalConfigStore", "Software", "valve", "Steam", "apps");
            if (apps is null) return result;
            foreach (var (appId, node) in apps.Children)
            {
                if (!node.IsObject || !IsAppId(appId)) continue;
                DateTimeOffset? last = node.GetLong("LastPlayed") is > 0 and var lp ? DateTimeOffset.FromUnixTimeSeconds(lp) : null;
                // "Playtime" can appear more than once in a block; take the largest value.
                int? minutes = node.Children.Where(c => c.Key.Equals("Playtime", StringComparison.OrdinalIgnoreCase))
                    .Select(c => int.TryParse(c.Value.Value, out var m) ? m : 0).DefaultIfEmpty(0).Max() is > 0 and var mm ? mm : null;
                result[appId] = (last, minutes);
            }
        }
        catch (Exception ex) when (ex is FormatException or IOException or UnauthorizedAccessException)
        {
        }
        return result;
    }

    internal static string? FindMostRecentAccountId(string steamPath)
    {
        var loginUsers = Path.Combine(steamPath, "config", "loginusers.vdf");
        try
        {
            if (File.Exists(loginUsers))
            {
                var users = Vdf.ParseFile(loginUsers)["users"];
                var recent = users?.Children.FirstOrDefault(u => u.Value.GetString("MostRecent") == "1").Key
                             ?? users?.Children.FirstOrDefault().Key;
                if (recent is not null && long.TryParse(recent, out var id64) && id64 > SteamId64Base)
                {
                    var accountId = (id64 - SteamId64Base).ToString();
                    if (Directory.Exists(Path.Combine(steamPath, "userdata", accountId))) return accountId;
                }
            }
        }
        catch (Exception ex) when (ex is FormatException or IOException or UnauthorizedAccessException)
        {
        }
        // Fall back to the most recently modified userdata folder.
        var userdata = Path.Combine(steamPath, "userdata");
        if (!Directory.Exists(userdata)) return null;
        return new DirectoryInfo(userdata).EnumerateDirectories()
            .Where(d => long.TryParse(d.Name, out var n) && n > 0)
            .OrderByDescending(d => d.LastWriteTimeUtc).FirstOrDefault()?.Name;
    }

    private static bool IsAppId(string s) => s.Length is > 0 and < 12 && s.All(char.IsAsciiDigit);

    private static DateTimeOffset? Max(DateTimeOffset? a, DateTimeOffset? b) =>
        a is null ? b : b is null ? a : a > b ? a : b;
}
