using System.Runtime.InteropServices;
using System.Text;
using Vystral.Windows.Launch;
using Vystral.Windows.Monitoring;

namespace Vystral.Windows.Tracking;

/// <summary>Running processes with their executable paths (what the game matcher needs).</summary>
public interface IRunningProcessSource
{
    /// <summary>Processes of this Windows session with a known image path; empty when the snapshot failed.</summary>
    IReadOnlyList<RunningProcess> Snapshot();

    /// <summary>The process that owns the foreground window, if any (no process is opened).</summary>
    int? ForegroundPid() => null;

    /// <summary>One process by id with its path, or null when it has exited. Much cheaper than a full snapshot.</summary>
    RunningProcess? Query(int pid) => Snapshot().FirstOrDefault(p => p.Id == pid);
}

/// <summary>
/// Executable path of a process without opening it: <c>NtQuerySystemInformation(SystemProcessIdInformation)</c>
/// returns the image name for a process id, as an NT device path (<c>\Device\HarddiskVolume3\Games\x.exe</c>),
/// which is mapped back to a drive letter or mount folder. No process handle is ever opened, so protected and
/// anti-cheat processes are never touched (Task Manager and Process Explorer read the same information).
/// </summary>
public sealed class NtImagePathResolver : IDisposable
{
    private const int SystemProcessIdInformation = 88;
    private const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
    private const int MaxBytes = 32767 * 2;
    private static readonly TimeSpan DeviceMapMaxAge = TimeSpan.FromMinutes(2);

    private readonly Lock _lock = new();
    private IntPtr _buffer;
    private int _bufferBytes;
    private List<(string Device, string Mount)> _devices = [];
    private DateTime _devicesRead;

    /// <summary>The DOS path of a process's executable, or null (exited, no image, or an unmapped volume).</summary>
    public string? Resolve(int pid)
    {
        if (pid <= 4) return null;
        lock (_lock)
        {
            var nt = QueryNtPath(pid);
            if (nt is null) return null;
            var dos = ToDosPath(nt, _devices);
            if (dos is null && DateTime.UtcNow - _devicesRead > TimeSpan.FromSeconds(30))
            {
                RefreshDevices();
                dos = ToDosPath(nt, _devices);
            }
            else if (DateTime.UtcNow - _devicesRead > DeviceMapMaxAge) RefreshDevices();
            return dos;
        }
    }

    private string? QueryNtPath(int pid)
    {
        if (!Environment.Is64BitProcess) return null;
        if (_buffer == IntPtr.Zero) Allocate(1024);
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var info = new ProcessIdInformation
            {
                ProcessId = pid,
                ImageName = new UnicodeString { Length = 0, MaximumLength = (ushort)Math.Min(_bufferBytes, ushort.MaxValue - 1), Buffer = _buffer },
            };
            var status = NtQuerySystemInformation(SystemProcessIdInformation, ref info, Marshal.SizeOf<ProcessIdInformation>(), out _);
            if (status == StatusInfoLengthMismatch && info.ImageName.MaximumLength > _bufferBytes && info.ImageName.MaximumLength <= MaxBytes)
            {
                Allocate(info.ImageName.MaximumLength);
                continue;
            }
            if (status < 0 || info.ImageName.Length == 0) return null;
            return Marshal.PtrToStringUni(_buffer, info.ImageName.Length / 2);
        }
        return null;
    }

    /// <summary>Maps <c>\Device\HarddiskVolume3\x</c> to <c>C:\x</c> (longest matching device wins) and <c>\Device\Mup\s\x</c> to <c>\\s\x</c>.</summary>
    internal static string? ToDosPath(string ntPath, IReadOnlyList<(string Device, string Mount)> devices)
    {
        const string mup = @"\Device\Mup\";
        if (ntPath.StartsWith(mup, StringComparison.OrdinalIgnoreCase)) return @"\\" + ntPath[mup.Length..];
        (string Device, string Mount)? best = null;
        foreach (var d in devices)
        {
            if (ntPath.Length <= d.Device.Length || ntPath[d.Device.Length] != '\\' ||
                !ntPath.StartsWith(d.Device, StringComparison.OrdinalIgnoreCase)) continue;
            if (best is null || d.Device.Length > best.Value.Device.Length) best = d;
        }
        if (best is not { } b) return null;
        return b.Mount.TrimEnd('\\') + ntPath[b.Device.Length..];
    }

    private void RefreshDevices()
    {
        var list = new List<(string, string)>();
        var target = new StringBuilder(1024);
        try
        {
            // Volumes, including ones mounted into folders rather than drive letters.
            var name = new StringBuilder(64);
            var find = FindFirstVolumeW(name, name.Capacity);
            if (find != new IntPtr(-1))
            {
                try
                {
                    do
                    {
                        var volume = name.ToString(); // \\?\Volume{guid}\
                        if (volume.StartsWith(@"\\?\", StringComparison.Ordinal) && volume.EndsWith('\\'))
                        {
                            target.Clear();
                            if (QueryDosDeviceW(volume[4..^1], target, target.Capacity) > 0 && FirstMountPoint(volume) is { } mount)
                                list.Add((target.ToString(), mount));
                        }
                        name.Clear();
                    }
                    while (FindNextVolumeW(find, name, name.Capacity));
                }
                finally { FindVolumeClose(find); }
            }
            // Drive letters (also covers SUBST and network drive letters that resolve to a device).
            for (var c = 'A'; c <= 'Z'; c++)
            {
                target.Clear();
                if (QueryDosDeviceW($"{c}:", target, target.Capacity) <= 0) continue;
                var device = target.ToString();
                if (device.StartsWith(@"\??\", StringComparison.Ordinal)) continue; // SUBST: the real path is reported instead
                if (!list.Any(x => string.Equals(x.Item1, device, StringComparison.OrdinalIgnoreCase))) list.Add((device, $@"{c}:\"));
            }
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            Services.Log.Warn("tracker", "Volume list unavailable", ex: ex);
        }
        _devices = list;
        _devicesRead = DateTime.UtcNow;
    }

    private static string? FirstMountPoint(string volume)
    {
        var buffer = new char[1024];
        if (!GetVolumePathNamesForVolumeNameW(volume, buffer, buffer.Length, out var length) || length <= 1) return null;
        var names = new string(buffer, 0, (int)length).Split('\0', StringSplitOptions.RemoveEmptyEntries);
        // Prefer a drive letter; otherwise the first folder the volume is mounted into.
        return names.FirstOrDefault(n => n.Length == 3 && n[1] == ':') ?? names.FirstOrDefault();
    }

    private void Allocate(int bytes)
    {
        if (_buffer != IntPtr.Zero) Marshal.FreeHGlobal(_buffer);
        _bufferBytes = Math.Max(bytes, 1024);
        _buffer = Marshal.AllocHGlobal(_bufferBytes);
    }

    public void Dispose()
    {
        lock (_lock)
        {
            if (_buffer != IntPtr.Zero) Marshal.FreeHGlobal(_buffer);
            _buffer = IntPtr.Zero;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessIdInformation
    {
        public nint ProcessId;
        public UnicodeString ImageName;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(int infoClass, ref ProcessIdInformation info, int length, out int returnLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindFirstVolumeW(StringBuilder name, int length);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool FindNextVolumeW(IntPtr find, StringBuilder name, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FindVolumeClose(IntPtr find);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int QueryDosDeviceW(string deviceName, StringBuilder target, int max);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetVolumePathNamesForVolumeNameW(string volumeName, [Out] char[] names, int length, out uint returnLength);
}

/// <summary>
/// The game detector's view of running processes: one handle-free system snapshot
/// (<see cref="NtProcessSnapshotSource"/>) plus an image path for each process, resolved once per
/// process (by pid and name) and cached. Only processes in this Windows session are returned, so another
/// signed-in user's games are never recorded in this user's journal.
/// </summary>
public sealed class HandleFreeProcessSource : IRunningProcessSource, IDisposable
{
    private readonly IProcessSnapshotSource _snapshots;
    private readonly Func<int, string?> _resolve;
    private readonly int? _session;
    private readonly IDisposable? _owned;
    private Dictionary<int, (string Name, string? Path)> _cache = [];

    public HandleFreeProcessSource(IProcessSnapshotSource snapshots, Func<int, string?> resolve, int? sessionId, IDisposable? owned = null)
    {
        _snapshots = snapshots;
        _resolve = resolve;
        _session = sessionId;
        _owned = owned;
    }

    /// <summary>The production source: NT snapshot + NT image paths, filtered to this process's Windows session.</summary>
    public static HandleFreeProcessSource CreateDefault()
    {
        var resolver = new NtImagePathResolver();
        int? session = null;
        try { session = System.Diagnostics.Process.GetCurrentProcess().SessionId; } catch (InvalidOperationException) { }
        return new HandleFreeProcessSource(new NtProcessSnapshotSource(), resolver.Resolve, session, resolver);
    }

    /// <summary>Number of processes whose path is cached (for diagnostics and tests).</summary>
    public int CachedPaths { get { lock (this) return _cache.Count; } }

    public IReadOnlyList<RunningProcess> Snapshot()
    {
        lock (this)
        {
            var entries = _snapshots.Take();
            if (entries.Count == 0) return [];
            var next = new Dictionary<int, (string Name, string? Path)>(entries.Count);
            var list = new List<RunningProcess>(entries.Count);
            foreach (var e in entries)
            {
                if (e.Pid <= 4 || (_session is int s && e.SessionId != s)) continue;
                if (!_cache.TryGetValue(e.Pid, out var known) || !string.Equals(known.Name, e.Name, StringComparison.OrdinalIgnoreCase))
                    known = (e.Name, _resolve(e.Pid));
                next[e.Pid] = known;
                if (known.Path is not null) list.Add(new RunningProcess(e.Pid, known.Path));
            }
            _cache = next;
            return list;
        }
    }

    public int? ForegroundPid()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return null;
        return GetWindowThreadProcessId(hwnd, out var pid) == 0 || pid <= 4 ? null : (int)pid;
    }

    /// <summary>The image-path lookup doubles as the liveness check: it fails once the process has exited.</summary>
    public RunningProcess? Query(int pid) => _resolve(pid) is { } path ? new RunningProcess(pid, path) : null;

    public void Dispose()
    {
        (_snapshots as IDisposable)?.Dispose();
        _owned?.Dispose();
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
