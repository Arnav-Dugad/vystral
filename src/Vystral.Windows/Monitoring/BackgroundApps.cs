using System.Runtime.InteropServices;
using Vystral.Core.Insights;

namespace Vystral.Windows.Monitoring;

/// <summary>One process from a system snapshot. No handle was opened to obtain it.</summary>
/// <param name="PrivateBytes">Private working set (what Task Manager shows as "Memory").</param>
/// <param name="CpuTime100ns">User + kernel CPU time since the process started.</param>
public readonly record struct ProcessEntry(int Pid, int ParentPid, int SessionId, string Name, long PrivateBytes, long CpuTime100ns);

public interface IProcessSnapshotSource
{
    /// <summary>Every process on the system; empty when the snapshot couldn't be taken.</summary>
    IReadOnlyList<ProcessEntry> Take();
}

/// <summary>
/// Handle-free process snapshot via NtQuerySystemInformation(SystemProcessInformation): the kernel
/// returns names, private working set and CPU times for every process in one call, without opening any
/// process (so protected and anti-cheat processes are never touched). The buffer is reused.
/// </summary>
public sealed class NtProcessSnapshotSource : IProcessSnapshotSource, IDisposable
{
    private const int SystemProcessInformation = 5;
    private const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
    private const int MaxBuffer = 16 * 1024 * 1024;

    // x64 SYSTEM_PROCESS_INFORMATION offsets (stable since Windows 7).
    private const int OffNext = 0x00, OffPrivateWs = 0x08, OffUserTime = 0x28, OffKernelTime = 0x30,
        OffNameLength = 0x38, OffNameBuffer = 0x40, OffPid = 0x50, OffParent = 0x58, OffSession = 0x64;

    private IntPtr _buffer;
    private int _size;

    public IReadOnlyList<ProcessEntry> Take()
    {
        if (!Environment.Is64BitProcess) return [];
        try
        {
            for (var attempt = 0; attempt < 4; attempt++)
            {
                if (_buffer == IntPtr.Zero) Allocate(Math.Max(_size, 512 * 1024));
                var status = NtQuerySystemInformation(SystemProcessInformation, _buffer, _size, out var needed);
                if (status == StatusInfoLengthMismatch)
                {
                    if (needed > MaxBuffer) return [];
                    Allocate(Math.Max(needed + 64 * 1024, _size * 2));
                    continue;
                }
                return status < 0 ? [] : Parse(_buffer);
            }
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or OutOfMemoryException)
        {
            Services.Log.Warn("bgapps", "Process snapshot unavailable", ex: ex);
        }
        return [];
    }

    private static List<ProcessEntry> Parse(IntPtr start)
    {
        var list = new List<ProcessEntry>(384);
        var p = start;
        for (var guard = 0; guard < 20_000; guard++)
        {
            var nameBytes = Marshal.ReadInt16(p, OffNameLength) & 0xFFFF;
            var namePtr = Marshal.ReadIntPtr(p, OffNameBuffer);
            var pid = (int)Marshal.ReadIntPtr(p, OffPid);
            var name = namePtr == IntPtr.Zero || nameBytes == 0 ? (pid == 0 ? "Idle" : "System") : Marshal.PtrToStringUni(namePtr, Math.Min(nameBytes / 2, 260));
            list.Add(new ProcessEntry(pid, (int)Marshal.ReadIntPtr(p, OffParent), Marshal.ReadInt32(p, OffSession), name,
                Marshal.ReadInt64(p, OffPrivateWs), Marshal.ReadInt64(p, OffUserTime) + Marshal.ReadInt64(p, OffKernelTime)));
            var next = Marshal.ReadInt32(p, OffNext);
            if (next <= 0) break;
            p += next;
        }
        return list;
    }

    private void Allocate(int size)
    {
        if (_buffer != IntPtr.Zero) Marshal.FreeHGlobal(_buffer);
        _buffer = Marshal.AllocHGlobal(size);
        _size = size;
    }

    public void Dispose()
    {
        if (_buffer != IntPtr.Zero) Marshal.FreeHGlobal(_buffer);
        _buffer = IntPtr.Zero;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(int infoClass, IntPtr buffer, int length, out int returnLength);
}

/// <summary>
/// Notes which other apps were among the heaviest while a game ran. Called from the session's 2 s
/// sampling loop but only every ~30 s. Keeps only per-name aggregates in memory (no paths, titles or
/// command lines). Excludes the game's process tree, VYSTRAL's own tree (WebView2, PresentMon), processes
/// of other sessions (services, other users) and core Windows processes.
/// </summary>
public sealed class BackgroundAppTracker(IProcessSnapshotSource source, Func<double?> memoryLoad, int ownPid, int processorCount, Func<DateTime>? clock = null)
    : IDisposable
{
    /// <summary>Loop ticks (2 s each) between snapshots: about 30 s.</summary>
    public const int EveryTicks = 15;
    public const int TopByMemory = 8;
    public const int TopByCpu = 4;
    public const double MinCpuPct = 1;

    public static readonly IReadOnlySet<string> SystemNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "System", "Idle", "Registry", "Memory Compression", "Secure System", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe",
        "services.exe", "lsass.exe", "lsaiso.exe", "svchost.exe", "fontdrvhost.exe", "dwm.exe", "sihost.exe", "taskhostw.exe",
        "explorer.exe", "ctfmon.exe", "RuntimeBroker.exe", "SearchHost.exe", "SearchApp.exe", "SearchIndexer.exe",
        "StartMenuExperienceHost.exe", "ShellExperienceHost.exe", "ShellHost.exe", "TextInputHost.exe", "dllhost.exe", "conhost.exe",
        "audiodg.exe", "SecurityHealthSystray.exe", "SecurityHealthService.exe", "smartscreen.exe", "WmiPrvSE.exe", "spoolsv.exe",
        "ApplicationFrameHost.exe", "LockApp.exe", "backgroundTaskHost.exe", "UserOOBEBroker.exe", "WUDFHost.exe", "dasHost.exe",
        "MsMpEng.exe", "NisSrv.exe", "SgrmBroker.exe", "CompPkgSrv.exe", "SystemSettingsBroker.exe", "Vystral.exe", "msedgewebview2.exe",
    };

    private readonly Func<DateTime> _clock = clock ?? (() => DateTime.UtcNow);
    private readonly Dictionary<string, Agg> _apps = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>Executable names the game ran as, so a launcher hand-off never shows the game as "background".</summary>
    private readonly HashSet<string> _gameNames = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<int, (string Name, long Cpu)> _previous = [];
    private DateTime _previousAt;
    private int? _ownSession;
    private double _memSum;
    private int _memCount;

    public int Snapshots { get; private set; }
    public double? MemLoadMax { get; private set; }
    public double? MemLoadAvg => _memCount == 0 ? null : Math.Round(_memSum / _memCount, 1);
    /// <summary>True when something changed since <see cref="Results"/> was last read.</summary>
    public bool Dirty { get; private set; }

    /// <summary>Takes one snapshot. <paramref name="gamePids"/> are the game's processes (their children are excluded too).</summary>
    public void Snapshot(IReadOnlyCollection<int> gamePids)
    {
        var entries = source.Take();
        if (entries.Count == 0) return;
        var now = _clock();
        _ownSession ??= entries.FirstOrDefault(e => e.Pid == ownPid) is { Name: not null } self ? self.SessionId : null;

        var excluded = Descendants(entries, gamePids.Append(ownPid));
        foreach (var e in entries)
            if (gamePids.Contains(e.Pid)) _gameNames.Add(e.Name);
        var elapsed = Snapshots > 0 ? (now - _previousAt).Ticks : 0; // 100 ns units
        var perName = new Dictionary<string, (double Mb, double? Cpu)>(StringComparer.OrdinalIgnoreCase);
        var current = new Dictionary<int, (string Name, long Cpu)>(entries.Count);
        foreach (var e in entries)
        {
            current[e.Pid] = (e.Name, e.CpuTime100ns);
            if (e.Pid <= 4 || excluded.Contains(e.Pid) || SystemNames.Contains(e.Name) || _gameNames.Contains(e.Name)) continue;
            if (_ownSession is int s && e.SessionId != s) continue;
            double? cpu = null;
            if (elapsed > 0)
            {
                var before = _previous.TryGetValue(e.Pid, out var p) && string.Equals(p.Name, e.Name, StringComparison.OrdinalIgnoreCase) ? p.Cpu : 0;
                var delta = Math.Max(0, e.CpuTime100ns - before);
                cpu = Math.Clamp(100.0 * delta / ((double)elapsed * Math.Max(1, processorCount)), 0, 100);
            }
            var mb = Math.Max(0, e.PrivateBytes) / 1048576.0;
            perName[e.Name] = perName.TryGetValue(e.Name, out var agg)
                ? (agg.Mb + mb, agg.Cpu is null && cpu is null ? null : (agg.Cpu ?? 0) + (cpu ?? 0))
                : (mb, cpu);
        }

        var top = perName.OrderByDescending(kv => kv.Value.Mb).Take(TopByMemory)
            .Concat(perName.Where(kv => kv.Value.Cpu >= MinCpuPct).OrderByDescending(kv => kv.Value.Cpu).Take(TopByCpu))
            .DistinctBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase);
        foreach (var (name, v) in top)
        {
            if (!_apps.TryGetValue(name, out var a)) _apps[name] = a = new Agg(name);
            a.Samples++;
            a.MbSum += v.Mb;
            a.MbMax = Math.Max(a.MbMax, v.Mb);
            if (v.Cpu is double c)
            {
                a.CpuSum += c;
                a.CpuSamples++;
            }
        }

        if (memoryLoad() is double load && double.IsFinite(load))
        {
            _memSum += load;
            _memCount++;
            MemLoadMax = Math.Max(MemLoadMax ?? 0, load);
        }
        _previous = current;
        _previousAt = now;
        Snapshots++;
        Dirty = true;
    }

    /// <summary>Per-app aggregates so far, heaviest first. Clears <see cref="Dirty"/>.</summary>
    public IReadOnlyList<BackgroundAppSample> Results()
    {
        Dirty = false;
        return _apps.Values
            .Select(a => new BackgroundAppSample(a.Name, a.Samples, Math.Round(a.MbSum / a.Samples), Math.Round(a.MbMax),
                a.CpuSamples == 0 ? null : Math.Round(a.CpuSum / a.CpuSamples, 1)))
            .OrderByDescending(a => a.AvgMb).ThenBy(a => a.Name, StringComparer.OrdinalIgnoreCase)
            .Take(48)
            .ToList();
    }

    public void Dispose() => (source as IDisposable)?.Dispose();

    /// <summary>The roots and every process whose parent chain leads to one of them.</summary>
    internal static HashSet<int> Descendants(IReadOnlyList<ProcessEntry> entries, IEnumerable<int> roots)
    {
        var children = entries.Where(e => e.Pid != e.ParentPid).ToLookup(e => e.ParentPid, e => e.Pid);
        var result = new HashSet<int>();
        var queue = new Queue<int>(roots.Where(r => r > 4));
        while (queue.Count > 0)
        {
            var pid = queue.Dequeue();
            if (!result.Add(pid)) continue;
            foreach (var c in children[pid]) if (!result.Contains(c)) queue.Enqueue(c);
        }
        return result;
    }

    /// <summary>Memory load in percent (GlobalMemoryStatusEx); null when unavailable.</summary>
    public static double? ReadMemoryLoad()
    {
        var status = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };
        return GlobalMemoryStatusEx(ref status) ? status.MemoryLoad : null;
    }

    private sealed class Agg(string name)
    {
        public string Name { get; } = name;
        public int Samples;
        public double MbSum;
        public double MbMax;
        public double CpuSum;
        public int CpuSamples;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint Length, MemoryLoad;
        public ulong TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);
}
