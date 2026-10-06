using System.Runtime.InteropServices;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Services;

namespace Vystral.Windows.Storage;

/// <summary>Where a folder lives and how much room its volume has (abstracted for tests).</summary>
public interface IVolumeInfo
{
    VolumeSpace? Describe(string folder);
}

/// <summary>GetVolumePathNameW (handles drive letters and mount folders) and GetDiskFreeSpaceExW (free space this user may use).</summary>
public sealed class WindowsVolumeInfo : IVolumeInfo
{
    public VolumeSpace? Describe(string folder)
    {
        var buffer = new char[1024];
        if (!GetVolumePathNameW(folder, buffer, (uint)buffer.Length)) return null;
        var key = new string(buffer, 0, Array.IndexOf(buffer, '\0') is var n and >= 0 ? n : buffer.Length);
        if (key.Length == 0 || !GetDiskFreeSpaceExW(folder, out var free, out var total, out _)) return null;
        string? label = null;
        try { label = new DriveInfo(key).VolumeLabel; } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { }
        return new VolumeSpace(key, UpdateSpaceForecast.DriveName(key), string.IsNullOrWhiteSpace(label) ? null : label, (long)Math.Min(free, long.MaxValue), (long)Math.Min(total, long.MaxValue));
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetVolumePathNameW(string fileName, [Out] char[] volumePathName, uint bufferLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetDiskFreeSpaceExW(string directoryName, out ulong freeBytesAvailable, out ulong totalBytes, out ulong totalFreeBytes);
}

/// <summary>
/// Track P: keeps the update-space forecast current, cheaply and read-only. A FileSystemWatcher on
/// every library's <c>steamapps</c> folder (app manifests only) triggers a debounced rescan; a slow
/// timer re-checks every few minutes anyway (free space changes for other reasons, and watchers can
/// miss events). Nothing is read while a game runs. Each rescan parses only the small app manifests.
/// The page gets a <c>disk.forecast</c> event when something it shows changed.
/// </summary>
public sealed class UpdateSpaceService : IDisposable
{
    public static readonly TimeSpan Debounce = TimeSpan.FromSeconds(4);
    public static readonly TimeSpan Periodic = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan MinGap = TimeSpan.FromSeconds(10);

    private readonly Func<string?> _steamPath;
    private readonly Func<IReadOnlyDictionary<string, string>> _appToGame;
    private readonly IEventSink _events;
    private readonly Func<bool> _isGameActive;
    private readonly IVolumeInfo _volumes;
    private readonly Lock _lock = new();
    private readonly List<FileSystemWatcher> _watchers = [];
    private readonly SemaphoreSlim _wake = new(0, 1);
    private IReadOnlyList<string> _watched = [];
    private DiskForecastDto? _current;
    private DateTimeOffset _scannedAt = DateTimeOffset.MinValue;
    private string? _signature;
    private int _dirty = 1;

    public UpdateSpaceService(Func<string?> steamPath, Func<IReadOnlyDictionary<string, string>> appToGame, IEventSink events,
        Func<bool> isGameActive, IVolumeInfo volumes)
    {
        _steamPath = steamPath;
        _appToGame = appToGame;
        _events = events;
        _isGameActive = isGameActive;
        _volumes = volumes;
    }

    /// <summary>The latest forecast; rescans first when it is older than a minute (or never ran).</summary>
    public DiskForecastDto Current()
    {
        lock (_lock)
        {
            if (_current is not null && DateTimeOffset.UtcNow - _scannedAt < TimeSpan.FromMinutes(1) && Volatile.Read(ref _dirty) == 0) return _current;
        }
        if (_isGameActive()) lock (_lock) return _current ?? Unavailable();
        return Rescan();
    }

    public Task RunAsync(CancellationToken ct) => Task.Run(async () =>
    {
        var last = DateTimeOffset.MinValue;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                // Wait for a manifest change (then let Steam finish writing) or the slow timer.
                var woke = await _wake.WaitAsync(Periodic, ct);
                if (woke) await Task.Delay(Debounce, ct);
                var gap = DateTimeOffset.UtcNow - last;
                if (gap < MinGap) await Task.Delay(MinGap - gap, ct);
                while (_isGameActive()) await Task.Delay(TimeSpan.FromSeconds(15), ct); // Performance Mode: no disk activity
                last = DateTimeOffset.UtcNow;
                Rescan();
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { Log.Warn("storage", "Update space check failed", ex: ex); }
        }
    }, ct);

    /// <summary>Marks the forecast stale and wakes the loop (also used after a Steam rescan).</summary>
    public void Poke()
    {
        Volatile.Write(ref _dirty, 1);
        try { if (_wake.CurrentCount == 0) _wake.Release(); } catch (SemaphoreFullException) { }
    }

    internal DiskForecastDto Rescan()
    {
        Volatile.Write(ref _dirty, 0);
        var steam = _steamPath();
        DiskForecastDto result;
        if (steam is null)
        {
            result = Unavailable();
        }
        else
        {
            var libraries = SteamAdapter.GetLibraryFolders(steam);
            EnsureWatchers(libraries);
            IReadOnlyDictionary<string, string> games;
            try { games = _appToGame(); }
            catch (Exception ex) { Log.Warn("storage", "Couldn't map Steam apps to games", ex: ex); games = new Dictionary<string, string>(); }
            result = UpdateSpaceForecast.Build(ReadLibraries(libraries, _volumes), games, DateTimeOffset.UtcNow);
        }

        string signature = UpdateSpaceForecast.Signature(result);
        bool changed;
        lock (_lock)
        {
            changed = _signature != signature;
            _current = result;
            _scannedAt = DateTimeOffset.UtcNow;
            _signature = signature;
        }
        // Also when a bridge call found the change first: notifications follow events, not calls.
        if (changed) _events.Emit("disk.forecast", result);
        return result;
    }

    /// <summary>Reads every library's manifests (files over 256 KB or unreadable mid-write are skipped this time).</summary>
    internal static IReadOnlyList<LibraryVolume> ReadLibraries(IEnumerable<string> libraries, IVolumeInfo volumes)
    {
        var list = new List<LibraryVolume>();
        foreach (var library in libraries)
        {
            var steamapps = Path.Combine(library, "steamapps");
            if (!Directory.Exists(steamapps)) continue;
            var volume = volumes.Describe(steamapps);
            if (volume is null) continue;
            var manifests = new List<AppManifestInfo>();
            IEnumerable<string> files;
            try { files = Directory.EnumerateFiles(steamapps, "appmanifest_*.acf").Take(5000).ToList(); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { continue; }
            foreach (var file in files)
            {
                try
                {
                    var info = new FileInfo(file);
                    if (!info.Exists || info.Length > 256 * 1024) continue;
                    if (UpdateSpaceForecast.ParseManifest(File.ReadAllText(file)) is { } m) manifests.Add(m);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            }
            list.Add(new LibraryVolume(library, volume, manifests));
        }
        return list;
    }

    private void EnsureWatchers(IReadOnlyList<string> libraries)
    {
        var folders = libraries.Select(l => Path.Combine(l, "steamapps")).Where(Directory.Exists).ToList();
        lock (_lock)
        {
            if (folders.SequenceEqual(_watched, StringComparer.OrdinalIgnoreCase)) return;
            foreach (var w in _watchers) w.Dispose();
            _watchers.Clear();
            foreach (var folder in folders)
            {
                try
                {
                    var w = new FileSystemWatcher(folder, "appmanifest_*.acf")
                    {
                        NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size,
                        IncludeSubdirectories = false,
                        InternalBufferSize = 16 * 1024,
                    };
                    w.Changed += (_, _) => Poke();
                    w.Created += (_, _) => Poke();
                    w.Deleted += (_, _) => Poke();
                    w.Renamed += (_, _) => Poke();
                    w.Error += (_, _) => Poke();
                    w.EnableRaisingEvents = true;
                    _watchers.Add(w);
                }
                catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException or PlatformNotSupportedException)
                {
                    Log.Warn("storage", "Couldn't watch a Steam library; the slow check still covers it", new { error = ex.GetType().Name });
                }
            }
            _watched = folders;
        }
    }

    private static DiskForecastDto Unavailable() => new(false, "none", DateTimeOffset.UtcNow.ToString("O"), 0, []);

    public void Dispose()
    {
        lock (_lock)
        {
            foreach (var w in _watchers) w.Dispose();
            _watchers.Clear();
        }
    }
}
