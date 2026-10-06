using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Contracts;
using Vystral.Core.Data;
using Vystral.Core.Health;
using Vystral.Windows.Integrations;

namespace Vystral.Windows.Services;

/// <summary>
/// Track Q: runs the library health check off the UI thread, entirely offline: the database, a few
/// file-existence checks (cached per drive, so a disconnected network drive is asked once) and the headers
/// of cached art files (cached per file). Dismissed issues are remembered in ui-state/health.json.
/// </summary>
public sealed class LibraryHealthService(LibraryRepository repo, AppPaths paths, SettingsService settings, Func<string?> steamPath)
{
    private readonly HealthDismissals _dismissals = new(paths.Root);
    private readonly ConcurrentDictionary<string, (long Length, DateTime Written, ArtFileInfo Info)> _artCache = new(StringComparer.OrdinalIgnoreCase);

    public HealthDismissals Dismissals => _dismissals;

    /// <summary>Sessions being recorded right now, by the app or the background tracker.</summary>
    public Func<IReadOnlySet<string>> ActiveSessions { get; set; } = () => new HashSet<string>();
    public Func<bool> IsScanning { get; set; } = () => false;

    public HealthReportDto Check()
    {
        var sw = Stopwatch.StartNew();
        var now = DateTimeOffset.UtcNow;
        var snapshot = repo.LoadSnapshot(ArtworkService.Url);
        var rows = repo.LoadHealthRows(now);
        var disabled = settings.GetAll()["library.platformsEnabled"] is System.Text.Json.Nodes.JsonObject map
            ? map.Where(p => p.Value is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<bool>(out var on) && !on).Select(p => p.Key).ToList()
            : [];
        var input = new HealthInputs
        {
            Games = snapshot.Games,
            Suggestions = snapshot.DuplicateSuggestions,
            Launches = rows.Launches,
            Art = rows.Art,
            MetadataAttempted = rows.MetadataAttempted,
            SteamAppIds = rows.SteamAppIds,
            OpenSessions = rows.OpenSessions,
            LongSessions = rows.LongSessions,
            ActiveSessionIds = ActiveSessions(),
            DisabledPlatforms = disabled,
            SteamDuplicates = SteamDuplicates(),
            Dismissed = _dismissals.Ids(),
            FetchMetadata = settings.GetBool("library.fetchMetadata") && !settings.GetBool("privacy.localOnly"),
            Now = now,
        };
        var (issues, dismissed) = LibraryHealth.Check(input, new Probe(paths.ArtCache, _artCache));
        var visibleGames = snapshot.Games.Count(g => !g.Hidden);
        return new HealthReportDto(now.ToString("O"), (int)sw.ElapsedMilliseconds, LibraryHealth.Score(issues, visibleGames), visibleGames,
            issues, dismissed, settings.GetBool("privacy.localOnly"), IsScanning());
    }

    /// <summary>Steam apps with a manifest in more than one of Steam's library folders (connected drives only).</summary>
    private IReadOnlyList<SteamLibraryDuplicate> SteamDuplicates()
    {
        var steam = steamPath();
        if (steam is null) return [];
        try
        {
            var seen = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (var library in SteamAdapter.GetLibraryFolders(steam).Take(32))
            {
                if (!LibraryRepository.DriveConnected(library)) continue;
                var steamapps = Path.Combine(library, "steamapps");
                if (!Directory.Exists(steamapps)) continue;
                foreach (var file in Directory.EnumerateFiles(steamapps, "appmanifest_*.acf").Take(20000))
                {
                    var id = Path.GetFileNameWithoutExtension(file)["appmanifest_".Length..];
                    if (id.Length is 0 or > 10 || !id.All(char.IsAsciiDigit)) continue;
                    if (!seen.TryGetValue(id, out var list)) seen[id] = list = [];
                    if (!list.Contains(library, StringComparer.OrdinalIgnoreCase)) list.Add(library);
                }
            }
            return seen.Where(p => p.Value.Count > 1).Select(p => new SteamLibraryDuplicate(p.Key, p.Value)).OrderBy(d => d.AppId, StringComparer.Ordinal).ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            Log.Warn("health", "Couldn't compare Steam libraries", ex: ex);
            return [];
        }
    }

    private sealed class Probe(string artRoot, ConcurrentDictionary<string, (long Length, DateTime Written, ArtFileInfo Info)> cache) : IHealthProbe
    {
        public bool DriveConnected(string path) => LibraryRepository.DriveConnected(path);

        public bool FileExists(string path)
        {
            try { return File.Exists(path); }
            catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException) { return false; }
        }

        public bool DirectoryExists(string path)
        {
            try { return Directory.Exists(path); }
            catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException) { return false; }
        }

        public ArtFileInfo? ArtFile(string relativeFile)
        {
            if (relativeFile.Contains("..") || Path.IsPathRooted(relativeFile)) return null;
            try
            {
                var info = new FileInfo(Path.Combine(artRoot, relativeFile));
                if (!info.Exists) return null;
                if (cache.TryGetValue(relativeFile, out var hit) && hit.Length == info.Length && hit.Written == info.LastWriteTimeUtc) return hit.Info;
                var size = ReadSize(info.FullName);
                var result = new ArtFileInfo(info.Length, size?.Width, size?.Height);
                cache[relativeFile] = (info.Length, info.LastWriteTimeUtc, result);
                return result;
            }
            catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException) { return null; }
        }

        /// <summary>Most headers fit in 4 KB; JPEGs with large metadata need up to 64 KB. Never more.</summary>
        private static (int Width, int Height)? ReadSize(string path)
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 4096);
            var buffer = new byte[4096];
            var n = fs.ReadAtLeast(buffer, buffer.Length, throwOnEndOfStream: false);
            var size = ImageHeader.Size(buffer.AsSpan(0, n));
            if (size is not null || n < buffer.Length) return size;
            var more = new byte[64 * 1024];
            buffer.CopyTo(more, 0);
            n += fs.ReadAtLeast(more.AsSpan(n), more.Length - n, throwOnEndOfStream: false);
            return ImageHeader.Size(more.AsSpan(0, n));
        }
    }
}

/// <summary>Issue ids the user dismissed, with when. Stored as ui-state/health.json (no migration, survives a settings reset).</summary>
public sealed partial class HealthDismissals(string dataRoot)
{
    public const int Max = 2000;
    private readonly Lock _lock = new();
    private string FilePath => Path.Combine(dataRoot, "ui-state", "health.json");

    [GeneratedRegex(@"^[a-zA-Z]{1,32}:[A-Za-z0-9:._\-]{1,100}\z")]
    public static partial Regex IdPattern();

    private sealed record State(Dictionary<string, string>? Dismissed);

    public IReadOnlySet<string> Ids()
    {
        lock (_lock) return Read().Keys.ToHashSet(StringComparer.Ordinal);
    }

    public void Dismiss(string id, DateTimeOffset now)
    {
        if (!IdPattern().IsMatch(id)) throw new ArgumentException("Invalid issue id.");
        lock (_lock)
        {
            var map = Read();
            map[id] = now.ToString("O");
            foreach (var old in map.OrderBy(p => p.Value, StringComparer.Ordinal).Take(Math.Max(0, map.Count - Max)).Select(p => p.Key).ToList())
                map.Remove(old);
            Write(map);
        }
    }

    public bool Restore(string id)
    {
        if (!IdPattern().IsMatch(id)) throw new ArgumentException("Invalid issue id.");
        lock (_lock)
        {
            var map = Read();
            if (!map.Remove(id)) return false;
            Write(map);
            return true;
        }
    }

    public int RestoreAll()
    {
        lock (_lock)
        {
            var map = Read();
            if (map.Count > 0) Write([]);
            return map.Count;
        }
    }

    private Dictionary<string, string> Read()
    {
        try
        {
            if (!File.Exists(FilePath) || new FileInfo(FilePath).Length > 512 * 1024) return [];
            var state = JsonSerializer.Deserialize<State>(File.ReadAllText(FilePath));
            return state?.Dismissed?.Where(p => IdPattern().IsMatch(p.Key)).Take(Max).ToDictionary(StringComparer.Ordinal) ?? [];
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            Log.Warn("health", "Dismissed health issues unreadable; starting fresh", ex: ex);
            return [];
        }
    }

    private void Write(Dictionary<string, string> map)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(new State(map), new JsonSerializerOptions { WriteIndented = true }));
            File.Move(tmp, FilePath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn("health", "Couldn't save dismissed health issues", ex: ex);
        }
    }
}
