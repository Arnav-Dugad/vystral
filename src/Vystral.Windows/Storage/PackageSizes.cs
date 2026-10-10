using Vystral.Core.Data;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;

namespace Vystral.Windows.Storage;

/// <summary>
/// Track C1: install sizes for Xbox / Microsoft Store packages, which no store file reports. Measured in the
/// background by adding up file sizes (metadata only; encrypted files still report their size), skipping reparse
/// points, and stored with the package version so a package is measured again only after an update. Paused while
/// a game runs. Read-only: nothing on disk is changed.
/// </summary>
public sealed class PackageSizeService(LibraryRepository repo, IEventSink events, Func<bool> isGameActive)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private int _again;

    /// <summary>Test hook: replaces the folder measurement.</summary>
    internal Func<string, CancellationToken, long?> Measure { get; set; } = (path, ct) => MeasureFolder(path, ct);

    /// <summary>Queues a pass (after a scan). A pass already running picks up the request when it ends.</summary>
    public void Poke(CancellationToken ct)
    {
        Interlocked.Exchange(ref _again, 1);
        _ = Task.Factory.StartNew(() => RunAsync(ct), ct, TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap();
    }

    /// <summary>Measures every package that needs it. Returns how many sizes were stored.</summary>
    public async Task<int> RunAsync(CancellationToken ct)
    {
        if (!await _gate.WaitAsync(0, ct)) return 0;
        var stored = 0;
        try
        {
            do
            {
                Interlocked.Exchange(ref _again, 0);
                foreach (var work in repo.PackagesNeedingSize())
                {
                    while (isGameActive() && !ct.IsCancellationRequested) await Task.Delay(TimeSpan.FromSeconds(20), ct);
                    ct.ThrowIfCancellationRequested();
                    var bytes = Measure(work.InstallPath, ct);
                    if (bytes is not null && repo.SetMeasuredSize(work.InstallationId, work.InstallPath, bytes.Value, work.Version)) stored++;
                }
            }
            while (Volatile.Read(ref _again) == 1); // a scan finished meanwhile: one more pass
            if (stored > 0)
            {
                Log.Info("storage", "Measured package sizes", new { stored });
                events.Emit("library.changed", new { reason = "packageSizes" });
            }
            return stored;
        }
        catch (OperationCanceledException) { return stored; }
        catch (Exception ex)
        {
            Log.Warn("storage", "Measuring package sizes stopped", ex: ex);
            return stored;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Total size of the files under <paramref name="root"/>: one directory at a time, reparse points (junctions,
    /// symlinks, mount points) skipped so nothing is counted twice or outside the folder, unreadable folders skipped.
    /// Null when the folder can't be read at all or holds an implausible number of entries.
    /// </summary>
    public static long? MeasureFolder(string root, CancellationToken ct, int maxEntries = 2_000_000)
    {
        DirectoryInfo start;
        try
        {
            start = new DirectoryInfo(root);
            if (!start.Exists || start.Attributes.HasFlag(FileAttributes.ReparsePoint)) return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or System.Security.SecurityException)
        {
            return null;
        }
        var options = new EnumerationOptions
        {
            IgnoreInaccessible = true,
            RecurseSubdirectories = false,
            AttributesToSkip = FileAttributes.ReparsePoint,
            ReturnSpecialDirectories = false,
        };
        long total = 0;
        var entries = 0;
        var readRoot = false;
        var stack = new Stack<DirectoryInfo>();
        stack.Push(start);
        while (stack.Count > 0)
        {
            ct.ThrowIfCancellationRequested();
            var dir = stack.Pop();
            try
            {
                foreach (var entry in dir.EnumerateFileSystemInfos("*", options))
                {
                    if (++entries > maxEntries) return null;
                    if (entry is DirectoryInfo sub) stack.Push(sub);
                    else if (entry is FileInfo file)
                    {
                        try { total += file.Length; }
                        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
                    }
                }
                if (dir == start) readRoot = true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
            {
                if (dir == start) return null;
            }
        }
        return readRoot ? total : null;
    }
}
