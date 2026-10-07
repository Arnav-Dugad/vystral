using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Files;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;

namespace Vystral.Windows.Storage;

/// <param name="Id">Opaque id for "Open folder" (only valid for the last lookup of this game).</param>
/// <param name="Platform">windows | steam | microsoftStore | gog | epic | ea | ubisoft | battlenet.</param>
/// <param name="Raw">The location as PCGamingWiki writes it (tokens and all).</param>
/// <param name="Display">The same with friendly roots ("%APPDATA%\Game\Saves").</param>
/// <param name="Path">Where that is on this PC (null when the folder it starts from is unknown here).</param>
/// <param name="Problem">Why it can't be checked: unsupported (a registry key, another OS, an unsafe path) | noRoot.</param>
public sealed record SaveLocationDto(string Id, string Platform, string Raw, string Display, string? Path, bool Exists, bool IsFile,
    long? Bytes, int Files, string? Modified, bool Partial, string? Problem);

/// <param name="Status">ok | none (the article lists no Windows save location) | notFound (no article) | off | offline | dataSaver
/// | busy (a game is running) | noSteamApp | error.</param>
public sealed record SavesDto(string GameId, string Status, string? Message, string? Article, IReadOnlyList<SaveLocationDto> Locations,
    string? Fetched, bool Stale);

/// <summary>
/// Track X: where a game keeps its saves, from PCGamingWiki (opt-in), checked on this PC. Answers are cached in
/// <c>cache\pcgamingwiki.json</c> (14 days; 3 for "no article"), which stays on this PC: PCGamingWiki's content is
/// CC BY-NC-SA and is never bundled with VYSTRAL. Expansion is strict (see <see cref="SaveLocations.Expand"/>); every
/// expanded path is re-checked to stay under the folder it started from, wildcards match at most a few folders, and
/// only existence, sizes and dates are read.
/// </summary>
public sealed partial class SaveLocator(string cacheDir)
{
    public static readonly TimeSpan HitTtl = TimeSpan.FromDays(14);
    public static readonly TimeSpan MissTtl = TimeSpan.FromDays(3);
    private const int MaxCacheEntries = 2000, MaxMatchesPerLevel = 6, MaxResultsPerLocation = 8, FileBudget = 40_000;

    private readonly Lock _lock = new();
    private readonly ConcurrentDictionary<string, Dictionary<string, string>> _open = new(StringComparer.Ordinal);
    private string CacheFile => System.IO.Path.Combine(cacheDir, "pcgamingwiki.json");

    /// <summary>Known Windows folders (test hook).</summary>
    public Func<string, string?> KnownFolder { get; init; } = DefaultKnownFolder;

    [GeneratedRegex(@"^[0-9]{1,10}\z")]
    private static partial Regex AppId();

    public sealed record CacheEntry(string? Article, List<WikiSaveLocation>? Locations, string Fetched);

    public CacheEntry? Cached(string appId)
    {
        lock (_lock) return ReadCache().TryGetValue(appId, out var e) ? e : null;
    }

    public static bool Fresh(CacheEntry e, DateTimeOffset now) =>
        DateTimeOffset.TryParse(e.Fetched, out var at) && now - at < (e.Article is null ? MissTtl : HitTtl);

    /// <summary>Asks PCGamingWiki and caches the answer (also a miss). Throws <see cref="DataSourceException"/> on network trouble.</summary>
    public async Task<CacheEntry> FetchAsync(PcGamingWikiClient client, string appId, CancellationToken ct)
    {
        if (!AppId().IsMatch(appId)) throw new ArgumentException("Invalid app id.");
        var article = await client.FindBySteamAppIdAsync(appId, ct);
        List<WikiSaveLocation> locations = [];
        if (article is not null && await client.WikitextAsync(article, ct) is { } page)
        {
            article = page.Title;
            locations = [.. SaveLocations.ParseWikitext(page.Wikitext)];
        }
        var entry = new CacheEntry(article, locations, DateTimeOffset.UtcNow.ToString("O"));
        lock (_lock)
        {
            var map = ReadCache();
            map[appId] = entry;
            foreach (var old in map.OrderBy(p => p.Value.Fetched, StringComparer.Ordinal).Take(Math.Max(0, map.Count - MaxCacheEntries)).Select(p => p.Key).ToList())
                map.Remove(old);
            WriteCache(map);
        }
        return entry;
    }

    /// <summary>Expands and checks every location of a cached answer. <paramref name="installPaths"/> are the game's own folders.</summary>
    public IReadOnlyList<SaveLocationDto> Check(string gameId, CacheEntry entry, IReadOnlyList<string> installPaths, string? steamPath, string? steamAccount)
    {
        var budget = new FolderBudget(FileBudget);
        var open = new Dictionary<string, string>(StringComparer.Ordinal);
        var result = new List<SaveLocationDto>();
        var n = 0;
        foreach (var loc in entry.Locations ?? [])
        {
            var pattern = SaveLocations.Expand(loc.Raw);
            if (pattern is null)
            {
                result.Add(new($"s{n++}", loc.Platform, loc.Raw, loc.Raw, null, false, false, null, 0, null, false, "unsupported"));
                continue;
            }
            var roots = Roots(pattern.Kind, installPaths, steamPath);
            if (roots.Count == 0)
            {
                result.Add(new($"s{n++}", loc.Platform, loc.Raw, pattern.Display, null, false, false, null, 0, null, false, "noRoot"));
                continue;
            }
            var matches = new List<string>();
            foreach (var root in roots) matches.AddRange(Resolve(root, pattern.Segments, pattern.Kind == "steam" ? steamAccount : null));
            matches = matches.Distinct(StringComparer.OrdinalIgnoreCase).Take(MaxResultsPerLocation).ToList();
            if (matches.Count == 0)
            {
                var literal = pattern.HasWildcard ? null : System.IO.Path.Combine([roots[0], .. pattern.Segments]);
                result.Add(new($"s{n++}", loc.Platform, loc.Raw, pattern.Display, literal, false, false, null, 0, null, false, null));
                continue;
            }
            foreach (var path in matches)
            {
                var id = $"s{n++}";
                var isFile = File.Exists(path);
                var m = budget.Measure(path, 8);
                open[id] = isFile ? System.IO.Path.GetDirectoryName(path)! : path;
                result.Add(new(id, loc.Platform, loc.Raw, pattern.Display, path, true, isFile, m.Bytes, m.Files, m.Newest?.ToString("O"), m.Partial, null));
            }
        }
        _open[gameId] = open;
        // Found ones first, then the rest in the wiki's order.
        return [.. result.OrderBy(r => r.Exists ? 0 : r.Problem is null ? 1 : 2)];
    }

    public string? FolderFor(string gameId, string id) =>
        _open.TryGetValue(gameId, out var map) && map.TryGetValue(id, out var p) ? p : null;

    private List<string> Roots(string kind, IReadOnlyList<string> installPaths, string? steamPath) => kind switch
    {
        "game" => installPaths.Where(p => System.IO.Path.IsPathFullyQualified(p) && !p.StartsWith(@"\\", StringComparison.Ordinal)).ToList(),
        "steam" => steamPath is null ? [] : [steamPath],
        _ => KnownFolder(kind) is { } f ? [f] : [],
    };

    /// <summary>Walks the segments under a root; "*" segments (and patterns like "*.sav") match at most a few entries.</summary>
    internal static IEnumerable<string> Resolve(string root, IReadOnlyList<string> segments, string? preferredWild = null)
    {
        string full;
        try { full = System.IO.Path.GetFullPath(root); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { yield break; }
        var prefix = full.TrimEnd('\\') + "\\";
        var current = new List<string> { full.TrimEnd('\\') };
        for (var i = 0; i < segments.Count && current.Count > 0; i++)
        {
            var seg = segments[i];
            var last = i == segments.Count - 1;
            var next = new List<string>();
            foreach (var dir in current)
            {
                if (!seg.Contains('*'))
                {
                    next.Add(System.IO.Path.Combine(dir, seg));
                    continue;
                }
                try
                {
                    var info = new DirectoryInfo(dir);
                    if (!info.Exists || info.LinkTarget is not null) continue;
                    IEnumerable<FileSystemInfo> entries = last ? info.EnumerateFileSystemInfos() : info.EnumerateDirectories();
                    var hits = entries.Where(e => SaveLocations.Matches(seg, e.Name) && (e.Attributes & FileAttributes.ReparsePoint) == 0)
                        .OrderByDescending(e => preferredWild is not null && e.Name == preferredWild).ThenByDescending(e => e.LastWriteTimeUtc)
                        .Take(MaxMatchesPerLevel).Select(e => e.FullName);
                    next.AddRange(hits);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException) { }
            }
            current = next;
        }
        foreach (var path in current)
        {
            string resolved;
            try { resolved = System.IO.Path.GetFullPath(path); }
            catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { continue; }
            // Belt and braces: whatever the segments were, the result must still be under the root.
            if (!resolved.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && !resolved.Equals(prefix.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) continue;
            if (Directory.Exists(resolved) || File.Exists(resolved)) yield return resolved;
        }
    }

    private static string? DefaultKnownFolder(string kind)
    {
        string F(Environment.SpecialFolder f) => Environment.GetFolderPath(f);
        var path = kind switch
        {
            "userprofile" => F(Environment.SpecialFolder.UserProfile),
            "documents" => F(Environment.SpecialFolder.MyDocuments),
            "savedgames" => System.IO.Path.Combine(F(Environment.SpecialFolder.UserProfile), "Saved Games"),
            "appdata" => F(Environment.SpecialFolder.ApplicationData),
            "localappdata" => F(Environment.SpecialFolder.LocalApplicationData),
            "locallow" => System.IO.Path.Combine(F(Environment.SpecialFolder.UserProfile), "AppData", "LocalLow"),
            "programdata" => F(Environment.SpecialFolder.CommonApplicationData),
            "public" => Environment.GetEnvironmentVariable("PUBLIC"),
            _ => null,
        };
        return string.IsNullOrEmpty(path) || !System.IO.Path.IsPathFullyQualified(path) ? null : path;
    }

    private Dictionary<string, CacheEntry> ReadCache()
    {
        try
        {
            if (!File.Exists(CacheFile) || new FileInfo(CacheFile).Length > 16 * 1024 * 1024) return [];
            var map = JsonSerializer.Deserialize<Dictionary<string, CacheEntry>>(File.ReadAllText(CacheFile)) ?? [];
            // The cache is a file other programs could edit: re-validate everything read back.
            return map.Where(p => AppId().IsMatch(p.Key) && p.Value is not null && (p.Value.Article is null || PcGamingWikiClient.IsTitle(p.Value.Article)))
                .ToDictionary(p => p.Key, p => p.Value with
                {
                    Locations = (p.Value.Locations ?? []).Where(l => l is not null && l.Raw is { Length: > 0 and <= SaveLocations.MaxRawLength } && l.Platform is { Length: <= 20 })
                        .Take(SaveLocations.MaxLocations).ToList(),
                }, StringComparer.Ordinal);
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            Log.Warn("saves", "PCGamingWiki cache unreadable; starting fresh", ex: ex);
            return [];
        }
    }

    private void WriteCache(Dictionary<string, CacheEntry> map)
    {
        try
        {
            Directory.CreateDirectory(cacheDir);
            var tmp = CacheFile + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(map));
            File.Move(tmp, CacheFile, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn("saves", "Couldn't save the PCGamingWiki cache", ex: ex);
        }
    }
}
