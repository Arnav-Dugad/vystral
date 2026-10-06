namespace Vystral.Windows.Monitoring;

/// <summary>
/// One GPU reading for the adapter the game is judged to run on: 3D-engine utilisation in percent
/// (what Task Manager shows as "3D") and dedicated video memory in use, in MB. Null = not measurable (yet).
/// </summary>
public readonly record struct GpuReading(double? Util, double? DedicatedMb);

/// <summary>A way of reading GPU load. <see cref="Read"/> returns null once the source has stopped working.</summary>
public interface IGpuSource : IDisposable
{
    string Name { get; }

    GpuReading? Read();
}

/// <summary>
/// A hardware adapter that can render. <paramref name="Luid"/> identifies it; <paramref name="Nodes3D"/>
/// are its 3D engines and <paramref name="DedicatedSegments"/> its non-aperture (on-board) memory segments.
/// </summary>
public sealed record GpuAdapter(long Luid, bool Integrated, IReadOnlyList<uint> Nodes3D, IReadOnlyList<uint> DedicatedSegments);

/// <summary>Kernel graphics statistics (D3DKMT). Abstracted so the utilisation math can be tested with fake numbers.</summary>
public interface IGpuStats
{
    /// <summary>Hardware adapters with at least one 3D engine; empty when the statistics are unavailable.</summary>
    IReadOnlyList<GpuAdapter> Adapters();

    /// <summary>Total time the node has been busy since boot, in 100 ns units; null when the query failed.</summary>
    long? NodeRunningTime(long luid, uint node);

    /// <summary>Bytes resident in the adapter's dedicated segments; null when the query failed.</summary>
    long? DedicatedBytes(GpuAdapter adapter);

    /// <summary>A monotonic clock in 100 ns units.</summary>
    long Now();
}

/// <summary>Utilisation from running-time deltas.</summary>
public static class GpuMath
{
    /// <summary>Shortest interval a utilisation is computed over (a shorter one is too noisy to report).</summary>
    public const long MinInterval100ns = 1_000_000; // 100 ms

    /// <summary>
    /// Busy percentage of one engine: the growth of its running time over the wall-clock time between two
    /// readings. Null without a usable interval; a counter that went backwards (driver reset) reads as idle.
    /// </summary>
    public static double? Utilisation(long previousRunning, long running, long elapsed100ns)
    {
        if (elapsed100ns < MinInterval100ns) return null;
        var busy = running - previousRunning;
        if (busy <= 0) return 0;
        return Math.Clamp(100.0 * busy / elapsed100ns, 0, 100);
    }
}

/// <summary>
/// Decides which adapter to report on systems with more than one GPU (hybrid laptops, desktops with an
/// enabled iGPU): the one that has done the most 3D work since recording started. A game keeps its GPU far
/// busier than the desktop does, so this settles on the game's GPU within a few samples and a loading screen
/// or a video on the other GPU doesn't flip it. Until any adapter has done measurable work (half a second of
/// 3D time) a discrete GPU is preferred. No process is opened to find out.
/// </summary>
public sealed class AdapterChooser
{
    /// <summary>Accumulated 3D busy time (percent × seconds) below which there is no evidence yet.</summary>
    public const double EvidencePercentSeconds = 50; // = 0.5 s of full 3D load

    private readonly Dictionary<long, double> _work = [];

    public long? Chosen { get; private set; }

    /// <param name="loads">This reading's per-adapter utilisation (percent).</param>
    /// <param name="seconds">Time the utilisation covers.</param>
    public long? Choose(IReadOnlyList<(long Luid, double Util, bool Integrated)> loads, double seconds)
    {
        if (loads.Count == 0) return Chosen;
        foreach (var (luid, util, _) in loads)
            _work[luid] = _work.GetValueOrDefault(luid) + Math.Clamp(util, 0, 100) * Math.Max(seconds, 0);
        var leader = loads.OrderByDescending(l => _work.GetValueOrDefault(l.Luid)).ThenBy(l => l.Integrated).First();
        if (_work.GetValueOrDefault(leader.Luid) < EvidencePercentSeconds)
            leader = loads.OrderBy(l => l.Integrated).ThenByDescending(l => _work.GetValueOrDefault(l.Luid)).First();
        Chosen = leader.Luid;
        return Chosen;
    }
}

/// <summary>
/// GPU load from kernel graphics statistics (D3DKMTQueryStatistics, the data Task Manager's "GPU Engine"
/// counters are built from): per adapter, the busiest 3D engine's running-time growth over wall-clock
/// time, and resident bytes in dedicated memory segments. One small kernel call per 3D engine and per
/// dedicated segment, no process opened, no performance-counter provider involved.
/// </summary>
public sealed class KernelGpuSource : IGpuSource
{
    private const long Reenumerate100ns = 30 * 10_000_000L;
    private const int MaxSilentReads = 3;
    private int _silent;
    private readonly IGpuStats _stats;
    private IReadOnlyList<GpuAdapter> _adapters;
    private readonly Dictionary<(long Luid, uint Node), long> _previous = [];
    private readonly AdapterChooser _chooser = new();
    private long _previousAt;
    private long _lastEnumerated;

    private KernelGpuSource(IGpuStats stats, IReadOnlyList<GpuAdapter> adapters)
    {
        _stats = stats;
        _adapters = adapters;
        _lastEnumerated = stats.Now();
    }

    public string Name => "D3DKMT";

    /// <summary>Null when there is no hardware adapter with a 3D engine to measure.</summary>
    public static KernelGpuSource? TryCreate(IGpuStats stats)
    {
        var adapters = stats.Adapters();
        return adapters.Count == 0 ? null : new KernelGpuSource(stats, adapters);
    }

    public GpuReading? Read()
    {
        var now = _stats.Now();
        var elapsed = now - _previousAt;
        var loads = new List<(long Luid, double Util, bool Integrated)>(_adapters.Count);
        var current = new Dictionary<(long, uint), long>();
        var failed = false;
        foreach (var a in _adapters)
        {
            double? util = null;
            foreach (var node in a.Nodes3D)
            {
                if (_stats.NodeRunningTime(a.Luid, node) is not long running) { failed = true; continue; }
                current[(a.Luid, node)] = running;
                // An adapter can have several 3D engines; like Task Manager, report the busiest.
                if (_previous.TryGetValue((a.Luid, node), out var before) && GpuMath.Utilisation(before, running, elapsed) is double u)
                    util = Math.Max(util ?? 0, u);
            }
            if (util is double v) loads.Add((a.Luid, v, a.Integrated));
        }

        _previous.Clear();
        foreach (var kv in current) _previous[kv.Key] = kv.Value;
        _previousAt = now;

        // Adapters come and go (driver update, external GPU): list them again when a query fails (at most every
        // 30 s while others still answer). Nothing answering three times in a row hands over to the next method.
        if (failed && (current.Count == 0 || now - _lastEnumerated >= Reenumerate100ns))
        {
            _lastEnumerated = now;
            var fresh = _stats.Adapters();
            if (fresh.Count == 0) return null;
            _adapters = fresh;
        }
        if (current.Count == 0) return ++_silent >= MaxSilentReads ? null : new GpuReading(null, null);
        _silent = 0;

        var chosen = _chooser.Choose(loads, elapsed / 1e7);
        var adapter = _adapters.FirstOrDefault(a => a.Luid == chosen) ?? _adapters.OrderBy(a => a.Integrated).First();
        double? util3D = null;
        foreach (var l in loads)
            if (l.Luid == adapter.Luid) util3D = l.Util;
        // An integrated GPU has no VRAM of its own (it uses shared system memory): nothing to report.
        double? mb = adapter.Integrated || adapter.DedicatedSegments.Count == 0 ? null : _stats.DedicatedBytes(adapter) / 1048576.0;
        return new GpuReading(util3D, mb);
    }

    public void Dispose() { }
}

/// <summary>
/// Tries GPU sources in order and moves to the next one when a source can't be created, throws, or reports
/// that it stopped working. Never throws; with no working source every reading is (null, null).
/// </summary>
public sealed class GpuMeter : IDisposable
{
    private readonly Queue<Func<IGpuSource?>> _factories;
    private IGpuSource? _source;
    private int _tried;

    public GpuMeter(IEnumerable<Func<IGpuSource?>> factories)
    {
        _factories = new Queue<Func<IGpuSource?>>(factories);
        Advance();
        // The first reading only sets the baseline, so the sampler's first sample already has a value.
        if (_source is not null) Read();
    }

    /// <summary>Kernel statistics first, then the PDH counters.</summary>
    public static GpuMeter CreateDefault() => new([
        () => D3dkmtStats.Supported ? KernelGpuSource.TryCreate(new D3dkmtStats()) : null,
        PdhGpuSource.TryCreate,
    ]);

    /// <summary>The working source's name ("D3DKMT", "PDH"), or null when none works.</summary>
    public string? Source => _source?.Name;

    public GpuReading Read()
    {
        while (_source is not null)
        {
            GpuReading? reading;
            try { reading = _source.Read(); }
            catch (Exception ex)
            {
                Services.Log.Warn("gpu", $"{_source.Name} GPU readings failed; trying the next method", ex: ex);
                reading = null;
            }
            if (reading is GpuReading r) return r;
            Advance();
        }
        return new GpuReading(null, null);
    }

    private void Advance()
    {
        SafeDispose(_source);
        _source = null;
        while (_factories.Count > 0)
        {
            var make = _factories.Dequeue();
            _tried++;
            try { _source = make(); }
            catch (Exception ex) { Services.Log.Warn("gpu", "A GPU reading method is unavailable", ex: ex); }
            if (_source is null) continue;
            if (_tried > 1) Services.Log.Info("gpu", $"GPU load is read through {_source.Name}");
            return;
        }
    }

    private static void SafeDispose(IGpuSource? source)
    {
        try { source?.Dispose(); }
        catch (Exception) { }
    }

    public void Dispose()
    {
        SafeDispose(_source);
        _source = null;
        _factories.Clear();
    }
}
