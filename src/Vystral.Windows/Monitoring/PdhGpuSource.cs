using System.Globalization;
using System.Runtime.InteropServices;

namespace Vystral.Windows.Monitoring;

/// <summary>
/// Fallback GPU source: the "GPU Engine" and "GPU Adapter Memory" performance counters through one PDH
/// query whose wildcard paths are added once (PDH expands them on every collection, so processes that
/// start later are included). Same meaning as <see cref="KernelGpuSource"/> but every collection makes
/// the counter provider walk every process's GPU statistics, so it costs far more CPU.
/// </summary>
public sealed class PdhGpuSource : IGpuSource
{
    private const uint FmtDouble = 0x00000200, FmtNoCap100 = 0x00008000;
    private const uint MoreData = 0x800007D2;
    private const int ItemSize = 24; // PDH_FMT_COUNTERVALUE_ITEM_W on x64: szName @0, CStatus @8, doubleValue @16

    private IntPtr _query;
    private readonly IntPtr _engines;
    private readonly IntPtr _memory;
    private IntPtr _buffer;
    private uint _bufferSize;
    private readonly AdapterChooser _chooser = new();
    private long _lastCollect = System.Diagnostics.Stopwatch.GetTimestamp();

    private PdhGpuSource(IntPtr query, IntPtr engines, IntPtr memory)
    {
        _query = query;
        _engines = engines;
        _memory = memory;
    }

    public string Name => "PDH";

    public static PdhGpuSource? TryCreate()
    {
        if (!Environment.Is64BitProcess) return null;
        if (PdhOpenQueryW(null, IntPtr.Zero, out var query) != 0) return null;
        if (PdhAddEnglishCounterW(query, @"\GPU Engine(*)\Utilization Percentage", IntPtr.Zero, out var engines) != 0
            || PdhAddEnglishCounterW(query, @"\GPU Adapter Memory(*)\Dedicated Usage", IntPtr.Zero, out var memory) != 0
            || PdhCollectQueryData(query) != 0)
        {
            PdhCloseQuery(query);
            return null;
        }
        return new PdhGpuSource(query, engines, memory);
    }

    public GpuReading? Read()
    {
        if (_query == IntPtr.Zero || PdhCollectQueryData(_query) != 0) return null;

        // Per adapter: sum over processes per engine, then the busiest 3D engine (as Task Manager does).
        var engines = new Dictionary<(long Luid, int Engine), double>();
        foreach (var (name, value) in Items(_engines))
        {
            if (ParseEngine(name) is not var (luid, engine, is3D) || !is3D) continue;
            engines[(luid, engine)] = engines.GetValueOrDefault((luid, engine)) + value;
        }
        var memory = new Dictionary<long, double>();
        foreach (var (name, value) in Items(_memory))
        {
            if (ParseLuid(name, 0) is long luid) memory[luid] = memory.GetValueOrDefault(luid) + value;
        }

        var seconds = System.Diagnostics.Stopwatch.GetElapsedTime(_lastCollect).TotalSeconds;
        _lastCollect = System.Diagnostics.Stopwatch.GetTimestamp();
        var loads = engines.GroupBy(kv => kv.Key.Luid)
            .Select(g => (Luid: g.Key, Util: Math.Clamp(g.Max(kv => kv.Value), 0, 100), Integrated: memory.GetValueOrDefault(g.Key) <= 0))
            .ToList();
        if (_chooser.Choose(loads, seconds) is not long chosen)
            return new GpuReading(null, memory.Count == 0 || memory.Values.Max() <= 0 ? null : memory.Values.Max() / 1048576.0);
        double? util = loads.Where(l => l.Luid == chosen).Select(l => (double?)l.Util).FirstOrDefault();
        // As with the kernel source: an integrated GPU (no dedicated memory in use) has no VRAM to report.
        double? mb = memory.TryGetValue(chosen, out var bytes) && bytes > 0 ? bytes / 1048576.0 : null;
        return new GpuReading(util, mb);
    }

    private List<(string Name, double Value)> Items(IntPtr counter)
    {
        var list = new List<(string, double)>();
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var size = _bufferSize;
            var status = PdhGetFormattedCounterArrayW(counter, FmtDouble | FmtNoCap100, ref size, out var count, _buffer);
            if (status == MoreData || (status == 0 && _buffer == IntPtr.Zero && size > 0))
            {
                if (size > 64 * 1024 * 1024) return list;
                if (_buffer != IntPtr.Zero) Marshal.FreeHGlobal(_buffer);
                _bufferSize = size + 4096;
                _buffer = Marshal.AllocHGlobal((int)_bufferSize);
                continue;
            }
            if (status != 0) return list;
            for (var i = 0; i < count; i++)
            {
                var item = _buffer + i * ItemSize;
                if (Marshal.ReadInt32(item, 8) is not (0 or 1)) continue; // PDH_CSTATUS_VALID_DATA / NEW_DATA
                var name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(item));
                if (name is not null) list.Add((name, BitConverter.Int64BitsToDouble(Marshal.ReadInt64(item, 16))));
            }
            return list;
        }
        return list;
    }

    /// <summary>"pid_123_luid_0x00000000_0x0000D1B4_phys_0_eng_0_engtype_3D" â†’ (LUID, engine 0, is 3D).</summary>
    public static (long Luid, int Engine, bool Is3D)? ParseEngine(string instance)
    {
        var at = instance.IndexOf("luid_", StringComparison.OrdinalIgnoreCase);
        if (at < 0 || ParseLuid(instance, at) is not long luid) return null;
        var eng = instance.IndexOf("_eng_", at, StringComparison.OrdinalIgnoreCase);
        if (eng < 0) return null;
        var start = eng + 5;
        var end = instance.IndexOf('_', start);
        if (end < 0 || !int.TryParse(instance.AsSpan(start, end - start), NumberStyles.None, CultureInfo.InvariantCulture, out var engine)) return null;
        return (luid, engine, instance.EndsWith("engtype_3D", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>The LUID in "luid_0x00000000_0x0000D1B4..." starting at <paramref name="at"/> (HighPart, then LowPart).</summary>
    public static long? ParseLuid(string instance, int at)
    {
        if (at < 0 || !instance.AsSpan(at).StartsWith("luid_0x", StringComparison.OrdinalIgnoreCase)) return null;
        var parts = instance.AsSpan(at + 5);
        if (parts.Length < 21 || parts[10] != '_' || !parts.Slice(11).StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return null;
        if (!uint.TryParse(parts.Slice(2, 8), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var high)
            || !uint.TryParse(parts.Slice(13, 8), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var low)) return null;
        return ((long)high << 32) | low;
    }

    public void Dispose()
    {
        if (_query != IntPtr.Zero) PdhCloseQuery(_query);
        _query = IntPtr.Zero;
        if (_buffer != IntPtr.Zero) Marshal.FreeHGlobal(_buffer);
        _buffer = IntPtr.Zero;
        _bufferSize = 0;
    }

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] private static extern uint PdhOpenQueryW(string? dataSource, IntPtr userData, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] private static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr userData, out IntPtr counter);
    [DllImport("pdh.dll")] private static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] private static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint bufferSize, out uint itemCount, IntPtr buffer);
    [DllImport("pdh.dll")] private static extern uint PdhCloseQuery(IntPtr query);
}
