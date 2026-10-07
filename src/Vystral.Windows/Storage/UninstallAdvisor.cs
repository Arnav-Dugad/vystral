using System.Text.RegularExpressions;
using Vystral.Core.Parsing;
using Vystral.Windows.Integrations;

namespace Vystral.Windows.Storage;

/// <param name="State">steamCloud (Steam keeps copies online) | localOnly (no Steam Cloud data for it here) | unknown (not a Steam game, or Steam isn't here).</param>
/// <param name="Files">Files Steam Cloud tracks for this game on this PC (0 when unknown).</param>
/// <param name="LastSync">The newest file time Steam recorded (ISO), when known.</param>
public sealed record CloudSavesDto(string State, int Files, long Bytes, string? LastSync);

/// <summary>A subscription or streaming service that also lists the game (from data VYSTRAL already has).</summary>
public sealed record AdviceServiceDto(string Service, string Name, string Note);

/// <param name="SizeSource">manifest (Steam's appmanifest SizeOnDisk) | scan (last library scan) | none.</param>
/// <param name="Action">steamUninstall | openStore | windowsApps | none.</param>
public sealed record UninstallAdviceDto(
    string GameId,
    string InstallationId,
    string Platform,
    long? SizeBytes,
    string SizeSource,
    string? Drive,
    CloudSavesDto Saves,
    IReadOnlyList<AdviceServiceDto> Services,
    string Action,
    string ActionLabel);

/// <summary>
/// Track X: read-only facts for the uninstall advisor. Steam Cloud presence comes from Steam's own per-user folders
/// (<c>userdata\&lt;account&gt;\&lt;appid&gt;\remotecache.vdf</c> and <c>…\remote</c>); the re-download size from the app manifest's
/// SizeOnDisk. Files are size-capped, paths stay inside Steam's folder, and nothing is ever written.
/// </summary>
public static partial class UninstallFacts
{
    private const int MaxRemoteCacheBytes = 2 * 1024 * 1024;
    private const int MaxManifestBytes = 256 * 1024;
    private const int MaxFiles = 5000;

    [GeneratedRegex(@"^[0-9]{1,10}\z")]
    private static partial Regex AppId();

    [GeneratedRegex(@"^[0-9]{1,12}\z")]
    private static partial Regex Account();

    /// <summary>What Steam Cloud has for an app on this PC. <paramref name="account"/> is the 32-bit account folder name.</summary>
    public static CloudSavesDto SteamCloud(string? steamPath, string? account, string appId)
    {
        if (steamPath is null || account is null || !AppId().IsMatch(appId) || !Account().IsMatch(account)) return new("unknown", 0, 0, null);
        try
        {
            var root = Path.GetFullPath(steamPath);
            var app = Path.Combine(root, "userdata", account, appId);
            var cache = Path.Combine(app, "remotecache.vdf");
            var remote = Path.Combine(app, "remote");
            int files = 0;
            long bytes = 0;
            DateTimeOffset? newest = null;
            var any = false;
            var text = SteamInputLocator.ReadCapped(cache, root, MaxRemoteCacheBytes);
            if (text is not null)
            {
                any = true;
                try
                {
                    var node = Vdf.Parse(text, 8)[appId];
                    if (node is { IsObject: true })
                    {
                        foreach (var (_, entry) in node.Children.Take(MaxFiles))
                        {
                            if (!entry.IsObject || entry.GetLong("size") is not { } size || size < 0) continue;
                            files++;
                            bytes += size;
                            var t = entry.GetLong("remotetime") ?? entry.GetLong("time");
                            if (t is > 0 and < 32503680000)
                            {
                                var at = DateTimeOffset.FromUnixTimeSeconds(t.Value);
                                if (newest is null || at > newest) newest = at;
                            }
                        }
                    }
                }
                catch (FormatException) { }
            }
            if (Directory.Exists(remote) && Inside(remote, root) && new DirectoryInfo(remote).LinkTarget is null)
            {
                any = true;
                if (files == 0)
                {
                    foreach (var f in new DirectoryInfo(remote).EnumerateFiles("*", new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 6, AttributesToSkip = FileAttributes.ReparsePoint }).Take(MaxFiles))
                    {
                        files++;
                        bytes += f.Length;
                        var at = new DateTimeOffset(f.LastWriteTimeUtc, TimeSpan.Zero);
                        if (newest is null || at > newest) newest = at;
                    }
                }
            }
            return any && files > 0 ? new("steamCloud", files, bytes, newest?.ToString("O")) : new("localOnly", 0, 0, null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return new("unknown", 0, 0, null);
        }
    }

    /// <summary>SizeOnDisk from appmanifest_&lt;appid&gt;.acf in any of Steam's library folders, or null.</summary>
    public static long? SteamSizeOnDisk(string? steamPath, string appId)
    {
        if (steamPath is null || !AppId().IsMatch(appId)) return null;
        try
        {
            foreach (var library in SteamAdapter.GetLibraryFolders(steamPath).Take(32))
            {
                var file = Path.Combine(library, "steamapps", $"appmanifest_{appId}.acf");
                var info = new FileInfo(file);
                if (!info.Exists || info.Length > MaxManifestBytes) continue;
                var state = Vdf.Parse(File.ReadAllText(file), 8)["AppState"];
                if (state?.GetLong("SizeOnDisk") is > 0 and var size) return size;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or FormatException or NotSupportedException) { }
        return null;
    }

    private static bool Inside(string path, string root)
    {
        var full = Path.GetFullPath(path);
        var prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }
}
