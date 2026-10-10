namespace Vystral.Core.Files;

/// <summary>Size on disk, file count and the oldest/newest write time of one cache.</summary>
public sealed record CacheMeasure(long Bytes, int Files, DateTimeOffset? Newest, DateTimeOffset? Oldest)
{
    public static readonly CacheMeasure Empty = new(0, 0, null, null);

    public CacheMeasure Plus(CacheMeasure o) => new(Bytes + o.Bytes, Files + o.Files, Max(Newest, o.Newest), Min(Oldest, o.Oldest));

    private static DateTimeOffset? Max(DateTimeOffset? a, DateTimeOffset? b) => a is null ? b : b is null ? a : a > b ? a : b;
    private static DateTimeOffset? Min(DateTimeOffset? a, DateTimeOffset? b) => a is null ? b : b is null ? a : a < b ? a : b;
}

/// <summary>
/// Track D6: the only code that deletes cache files for the cache viewer. It works on a fixed allow-list of
/// relative locations inside the data folder (<see cref="Targets"/>): the page names a cache by id, never a path,
/// and even a wrong id inside VYSTRAL can't reach anything else. Every target is resolved and must stay strictly under
/// the data folder; no folder on the way may be a link (junction or symbolic link), links met while walking are never
/// followed or deleted, and only plain files are removed (folders stay, so writers never trip over a missing one).
/// </summary>
public static class CacheJanitor
{
    /// <summary>Every location a cache clear may touch, relative to the data folder (Windows separators).</summary>
    public static readonly IReadOnlyList<string> Targets =
    [
        @"cache\art\_thumbs",
        @"cache\art\_thumbs\wishlist",
        @"cache\art\_avatars",
        @"cache\art\_store",
        @"cache\live",
        @"cache\news",
        @"cache\ai",
        @"cache\fx",
        @"cache\game-pages\steam-reviews.json",
        @"cache\game-pages\igdb-game-series.json",
        @"cache\game-pages\igdb-series.json",
        @"cache\game-pages\steam-tags.json",
        @"cache\game-pages\steam-tag-names.json",
        @"cache\friends-recent.json",
        @"cache\pcgamingwiki.json",
        @"cache\workshop-titles.json",
        @"subscriptions-cache.json",
        @"ui-state\first-paint.json",
    ];

    /// <summary>Locations that may be measured but are cleared only by their own service (they mix in user choices).</summary>
    public static readonly IReadOnlyList<string> MeasureOnly = [@"cache\art", @"cache\game-pages\store-facts.json", @"cache\wishlist.json"];

    public const int MaxFilesWalked = 250_000;

    /// <summary>
    /// The absolute path of <paramref name="relative"/>, or null when it isn't an allowed target, escapes the data
    /// folder, or passes through a link. <paramref name="dataRoot"/> must be an absolute local path.
    /// </summary>
    public static string? Resolve(string dataRoot, string relative, bool measureOnly = false)
    {
        if (string.IsNullOrWhiteSpace(dataRoot) || string.IsNullOrWhiteSpace(relative)) return null;
        var allowed = Targets.Contains(relative, StringComparer.Ordinal) || (measureOnly && MeasureOnly.Contains(relative, StringComparer.Ordinal));
        if (!allowed) return null;
        if (!Path.IsPathFullyQualified(dataRoot) || dataRoot.StartsWith(@"\\", StringComparison.Ordinal)) return null;
        string root, full;
        try
        {
            root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(dataRoot));
            full = Path.GetFullPath(Path.Combine(root, relative));
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { return null; }
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return null;
        if (full.IndexOf(':', 2) >= 0) return null; // alternate data streams
        // Nothing between the data folder and the target (nor the target itself) may be a link.
        var probe = full;
        while (probe.Length > root.Length)
        {
            if (IsLink(probe)) return null;
            probe = Path.GetDirectoryName(probe) ?? root;
        }
        return IsLink(root) ? null : full;
    }

    public static CacheMeasure Measure(string dataRoot, string relative, IReadOnlyCollection<string>? excludeFolders = null)
    {
        var full = Resolve(dataRoot, relative, measureOnly: true);
        if (full is null) return CacheMeasure.Empty;
        if (File.Exists(full)) return MeasureFile(full);
        if (!Directory.Exists(full)) return CacheMeasure.Empty;
        var exclude = (excludeFolders ?? []).Select(e => Path.GetFullPath(Path.Combine(full, e))).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var total = CacheMeasure.Empty;
        foreach (var file in Walk(full, exclude)) total = total.Plus(MeasureFile(file));
        return total;
    }

    /// <summary>Deletes the target's plain files (a file target: the file). Returns what was freed. Never throws for IO.</summary>
    public static (long Bytes, int Files, int Failed) Clear(string dataRoot, string relative)
    {
        var full = Resolve(dataRoot, relative);
        if (full is null) throw new ArgumentException("Not a cache location VYSTRAL may clear.", nameof(relative));
        long bytes = 0;
        int files = 0, failed = 0;
        IEnumerable<string> victims = File.Exists(full) ? [full] : Directory.Exists(full) ? Walk(full, new HashSet<string>()).ToList() : [];
        foreach (var f in victims)
        {
            try
            {
                var info = new FileInfo(f);
                if (!info.Exists || info.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
                // Re-check right before deleting: still inside the target, still not behind a link.
                if (!Inside(full, f) || Resolve(dataRoot, relative) is null) { failed++; continue; }
                var size = info.Length;
                if (info.IsReadOnly) info.IsReadOnly = false;
                info.Delete();
                bytes += size;
                files++;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { failed++; }
        }
        return (bytes, files, failed);
    }

    private static bool Inside(string target, string file) =>
        string.Equals(target, file, StringComparison.OrdinalIgnoreCase) ||
        Path.GetFullPath(file).StartsWith(Path.TrimEndingDirectorySeparator(target) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    /// <summary>Plain files under <paramref name="dir"/>; link folders and link files are skipped, never followed.</summary>
    private static IEnumerable<string> Walk(string dir, HashSet<string> exclude)
    {
        var stack = new Stack<string>();
        stack.Push(dir);
        var seen = 0;
        while (stack.Count > 0)
        {
            var d = stack.Pop();
            string[] entries;
            try { entries = Directory.GetFileSystemEntries(d); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { continue; }
            foreach (var e in entries)
            {
                if (++seen > MaxFilesWalked) yield break;
                FileAttributes attrs;
                try { attrs = File.GetAttributes(e); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { continue; }
                if (attrs.HasFlag(FileAttributes.ReparsePoint)) continue;
                if (attrs.HasFlag(FileAttributes.Directory))
                {
                    if (!exclude.Contains(Path.GetFullPath(e))) stack.Push(e);
                }
                else yield return e;
            }
        }
    }

    private static CacheMeasure MeasureFile(string f)
    {
        try
        {
            var info = new FileInfo(f);
            if (!info.Exists || info.Attributes.HasFlag(FileAttributes.ReparsePoint)) return CacheMeasure.Empty;
            var at = new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero);
            return new CacheMeasure(info.Length, 1, at, at);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return CacheMeasure.Empty; }
    }

    private static bool IsLink(string path)
    {
        try
        {
            if (!File.Exists(path) && !Directory.Exists(path)) return false;
            return File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return true; }
    }
}
