namespace Vystral.Windows.Storage;

/// <summary>Size, file count and newest change of a folder (or one file).</summary>
/// <param name="Partial">The file budget ran out (or a sub-folder couldn't be read), so the numbers are a lower bound.</param>
public readonly record struct FolderMeasure(long Bytes, int Files, DateTimeOffset? Newest, bool Partial);

/// <summary>
/// Track X: read-only folder measuring for the Files tab. Enumerates with a shared file budget, a depth limit and
/// reparse points (junctions, symlinks) skipped, so a link can't send it across the disk or into a loop. Never opens a file.
/// </summary>
public sealed class FolderBudget(int files)
{
    public int Left { get; private set; } = files;

    public FolderMeasure Measure(string path, int maxDepth = 12)
    {
        try
        {
            var file = new FileInfo(path);
            if (file.Exists)
            {
                Left--;
                return new FolderMeasure(file.Length, 1, new DateTimeOffset(file.LastWriteTimeUtc, TimeSpan.Zero), false);
            }
            var dir = new DirectoryInfo(path);
            if (!dir.Exists || dir.LinkTarget is not null) return default;
            long bytes = 0;
            var count = 0;
            DateTimeOffset? newest = new DateTimeOffset(dir.LastWriteTimeUtc, TimeSpan.Zero);
            var options = new EnumerationOptions
            {
                RecurseSubdirectories = true, MaxRecursionDepth = maxDepth, IgnoreInaccessible = true,
                AttributesToSkip = FileAttributes.ReparsePoint | FileAttributes.System,
            };
            foreach (var f in dir.EnumerateFiles("*", options))
            {
                if (Left <= 0) return new FolderMeasure(bytes, count, newest, true);
                Left--;
                count++;
                bytes += f.Length;
                var at = new DateTimeOffset(f.LastWriteTimeUtc, TimeSpan.Zero);
                if (newest is null || at > newest) newest = at;
            }
            return new FolderMeasure(bytes, count, newest, false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException or System.Security.SecurityException)
        {
            return new FolderMeasure(0, 0, null, true);
        }
    }
}
