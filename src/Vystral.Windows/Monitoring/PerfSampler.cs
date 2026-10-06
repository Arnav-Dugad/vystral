using System.Runtime.InteropServices;
using System.Text.Json;
using Vystral.Core.Contracts;

namespace Vystral.Windows.Monitoring;

/// <summary>Summary stored with each tracked session. Null fields were not measurable.</summary>
public sealed record PerfSummary(
    int Samples,
    double? CpuAvg, double? CpuMax,
    double? GpuAvg, double? GpuMax,
    double? GpuMemAvgMb, double? GpuMemMaxMb,
    double? RamAvgMb, double? RamMaxMb,
    double? GpuTempAvgC, double? GpuTempMaxC,
    string FpsStatus,
    // ---- schema v4 additions (all null when not measured) ----
    int? ThrottledSeconds = null,
    int? PowerLimitedSeconds = null,
    IReadOnlyList<string>? ThrottleReasons = null,
    double? PeakTempC = null,
    double? GpuClockAvgMhz = null,
    string? ThermalNote = null,
    double? FpsAvg = null,
    double? Fps1Low = null,
    double? Fps01Low = null,
    double? FrameTimeP50Ms = null,
    double? FrameTimeP99Ms = null,
    int? StutterCount = null,
    int? FrameCount = null,
    IReadOnlyList<int>? FrameTimeHistogram = null,
    string? FpsSource = null);

/// <summary>
/// Read-only system sampling during a game session (no admin, no process opened): CPU from
/// GetSystemTimes, RAM from GlobalMemoryStatusEx, GPU 3D load and dedicated memory from kernel
/// graphics statistics (<see cref="GpuMeter"/>, with the PDH counters as fallback) and, when an
/// NVIDIA driver is installed, NVML's temperature, clock and throttle-reason queries. Nothing here
/// changes clocks, fans, power limits or any other hardware setting.
/// </summary>
public sealed class PerfSampler : IDisposable
{
    public const string FpsUnavailable =
        "Frame-rate capture is off. It can be turned on in Settings › Launching & sessions (it uses Intel PresentMon). FPS is not recorded.";

    private readonly CpuMeter _cpu = new();
    private readonly GpuMeter _gpu;
    private readonly Nvml? _nvml = Nvml.TryCreate();

    public PerfSampler() : this(GpuMeter.CreateDefault()) { }

    internal PerfSampler(GpuMeter gpu) => _gpu = gpu;

    /// <summary>Which GPU method is in use ("D3DKMT", "PDH"), or null when GPU load can't be read.</summary>
    public string? GpuSource => _gpu.Source;

    public PerfSampleDto Sample(int offsetMs)
    {
        double? cpu = _cpu.Read();
        var gpu = _gpu.Read();
        double? ram = ReadUsedRamMb();
        double? temp = _nvml?.ReadTemperature();
        return new PerfSampleDto(offsetMs, Round(cpu), Round(gpu.Util), Round(gpu.DedicatedMb), Round(ram), Round(temp));
    }

    /// <summary>NVIDIA graphics clock and throttle flags (read-only NVML queries); nulls elsewhere.</summary>
    public (double? ClockMhz, int? Flags) ReadGpuState()
    {
        if (_nvml is null) return (null, null);
        var reasons = _nvml.ReadThrottleReasons();
        return (_nvml.ReadGraphicsClock(), reasons is ulong r ? (int)Throttle.FromNvml(r) : null);
    }

    /// <summary>NVIDIA GPU name and driver version from NVML (read-only); null without an NVIDIA driver.</summary>
    public GpuIdentity? ReadGpuIdentity() => _nvml?.ReadIdentity();

    public static PerfSummary Summarize(IReadOnlyList<PerfSampleDto> samples) => Summarize(samples, [], null, FpsUnavailable);

    /// <summary>
    /// Full summary including throttling (from <paramref name="extras"/>) and frame statistics.
    /// <paramref name="fpsStatus"/> explains how FPS was measured, or why it wasn't.
    /// </summary>
    public static PerfSummary Summarize(IReadOnlyList<PerfSampleDto> samples, IReadOnlyList<InsightSampleDto> extras, FrameSummary? frames, string fpsStatus)
    {
        var basic = SummarizeBasic(samples, fpsStatus);
        var (thermal, power, reasons) = ThrottleTotals(extras);
        var temps = samples.Where(x => x.GpuTempC.HasValue).Select(x => x.GpuTempC!.Value).ToList();
        var clocks = extras.Skip(extras.Count > 2 ? 1 : 0).Where(x => x.GpuClockMhz.HasValue).Select(x => x.GpuClockMhz!.Value).ToList();
        return basic with
        {
            ThrottledSeconds = thermal,
            PowerLimitedSeconds = power,
            ThrottleReasons = reasons,
            PeakTempC = temps.Count == 0 ? null : Math.Round(temps.Max(), 1),
            GpuClockAvgMhz = clocks.Count == 0 ? null : Math.Round(clocks.Average()),
            ThermalNote = thermal >= Throttle.NoteThresholdSeconds ? Throttle.ThermalNote(thermal.Value) : null,
            FpsAvg = frames?.FpsAvg,
            Fps1Low = frames?.Fps1Low,
            Fps01Low = frames?.Fps01Low,
            FrameTimeP50Ms = frames?.FrameTimeP50Ms,
            FrameTimeP99Ms = frames?.FrameTimeP99Ms,
            StutterCount = frames?.Stutters,
            FrameCount = frames?.Frames,
            FrameTimeHistogram = frames?.Histogram,
            FpsSource = frames is null ? null : $"Intel PresentMon {PresentMonRelease.Pinned.Version}",
        };
    }

    /// <summary>
    /// Seconds spent thermally throttled / power limited. Each sample counts for the time since
    /// the previous one (capped at 5 s so a gap in sampling isn't counted as throttling).
    /// All null when the GPU never reported throttle reasons.
    /// </summary>
    public static (int? Thermal, int? Power, IReadOnlyList<string>? Reasons) ThrottleTotals(IReadOnlyList<InsightSampleDto> extras)
    {
        var ordered = extras.Where(e => e.ThrottleFlags.HasValue).OrderBy(e => e.T).ToList();
        if (ordered.Count == 0) return (null, null, null);
        double thermalMs = 0, powerMs = 0;
        var all = ThrottleFlags.None;
        int? prev = null;
        foreach (var e in ordered)
        {
            var dt = prev is int p ? Math.Clamp(e.T - p, 0, 5000) : 2000;
            prev = e.T;
            if (Throttle.IsThermal(e.ThrottleFlags)) thermalMs += dt;
            if (Throttle.IsPowerLimited(e.ThrottleFlags)) powerMs += dt;
            all |= (ThrottleFlags)e.ThrottleFlags!.Value;
        }
        var keys = Throttle.ReasonKeys(all);
        return ((int)Math.Round(thermalMs / 1000), (int)Math.Round(powerMs / 1000), keys.Count == 0 ? null : keys);
    }

    private static PerfSummary SummarizeBasic(IReadOnlyList<PerfSampleDto> samples, string fpsStatus)
    {
        static (double?, double?) Stat(IEnumerable<double?> values)
        {
            var v = values.Where(x => x.HasValue).Select(x => x!.Value).ToList();
            return v.Count == 0 ? (null, null) : (Math.Round(v.Average(), 1), Math.Round(v.Max(), 1));
        }
        // The first sample of a CPU/GPU counter has no baseline; skip it for averages.
        var s = samples.Skip(samples.Count > 2 ? 1 : 0).ToList();
        var cpu = Stat(s.Select(x => x.Cpu));
        var gpu = Stat(s.Select(x => x.Gpu));
        var mem = Stat(s.Select(x => x.GpuMemMb));
        var ram = Stat(s.Select(x => x.RamMb));
        var temp = Stat(s.Select(x => x.GpuTempC));
        return new PerfSummary(samples.Count, cpu.Item1, cpu.Item2, gpu.Item1, gpu.Item2, mem.Item1, mem.Item2,
            ram.Item1, ram.Item2, temp.Item1, temp.Item2, fpsStatus);
    }

    public static string ToJson(PerfSummary summary) =>
        JsonSerializer.Serialize(summary, new JsonSerializerOptions(JsonSerializerDefaults.Web));

    private static double? Round(double? v) => v is null || double.IsNaN(v.Value) ? null : Math.Round(v.Value, 1);

    private static double? ReadUsedRamMb()
    {
        var status = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };
        return GlobalMemoryStatusEx(ref status) ? (status.TotalPhys - status.AvailPhys) / 1048576.0 : null;
    }

    public void Dispose()
    {
        _gpu.Dispose();
        _nvml?.Dispose();
    }

    /// <summary>System-wide CPU utilisation from GetSystemTimes deltas.</summary>
    private sealed class CpuMeter
    {
        private ulong _idle, _kernel, _user;

        public double? Read()
        {
            if (!GetSystemTimes(out var idle, out var kernel, out var user)) return null;
            var (di, dk, du) = (idle - _idle, kernel - _kernel, user - _user);
            var first = _kernel == 0;
            (_idle, _kernel, _user) = (idle, kernel, user);
            if (first) return null;
            var total = dk + du; // kernel time includes idle time
            return total == 0 ? null : Math.Clamp(100.0 * (total - di) / total, 0, 100);
        }
    }

    /// <summary>
    /// Read-only NVML access (ships with NVIDIA drivers): temperature, graphics clock and the
    /// clock-event (throttle) reasons. No set/control function is ever called.
    /// </summary>
    private sealed class Nvml : IDisposable
    {
        private readonly IntPtr _device;
        private bool _noEventReasons;
        private bool _noThrottleReasons;
        private bool _noClock;

        private Nvml(IntPtr device) => _device = device;

        public static Nvml? TryCreate()
        {
            try
            {
                if (nvmlInit_v2() != 0) return null;
                if (nvmlDeviceGetHandleByIndex_v2(0, out var device) != 0)
                {
                    nvmlShutdown();
                    return null;
                }
                return new Nvml(device);
            }
            catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
            {
                return null;
            }
        }

        public double? ReadTemperature() => nvmlDeviceGetTemperature(_device, 0, out var t) == 0 ? t : null;

        public double? ReadGraphicsClock()
        {
            if (_noClock) return null;
            try { return nvmlDeviceGetClockInfo(_device, 0 /* NVML_CLOCK_GRAPHICS */, out var mhz) == 0 ? mhz : null; }
            catch (EntryPointNotFoundException) { _noClock = true; return null; }
        }

        /// <summary>nvmlDeviceGetCurrentClocksEventReasons (newer drivers), falling back to the older ...ThrottleReasons.</summary>
        public ulong? ReadThrottleReasons()
        {
            if (!_noEventReasons)
            {
                try
                {
                    if (nvmlDeviceGetCurrentClocksEventReasons(_device, out var r) == 0) return r;
                }
                catch (EntryPointNotFoundException) { _noEventReasons = true; }
            }
            if (!_noThrottleReasons)
            {
                try
                {
                    if (nvmlDeviceGetCurrentClocksThrottleReasons(_device, out var r) == 0) return r;
                }
                catch (EntryPointNotFoundException) { _noThrottleReasons = true; }
            }
            return null;
        }

        /// <summary>nvmlSystemGetDriverVersion ("572.16") and nvmlDeviceGetName.</summary>
        public GpuIdentity? ReadIdentity()
        {
            try
            {
                var buffer = new byte[96];
                string? driver = nvmlSystemGetDriverVersion(buffer, (uint)buffer.Length) == 0 ? Text(buffer) : null;
                Array.Clear(buffer);
                string? name = nvmlDeviceGetName(_device, buffer, (uint)buffer.Length) == 0 ? Text(buffer) : null;
                return driver is null && name is null ? null : new GpuIdentity(name, driver);
            }
            catch (EntryPointNotFoundException)
            {
                return null;
            }

            static string? Text(byte[] b)
            {
                var n = Array.IndexOf(b, (byte)0);
                var s = System.Text.Encoding.ASCII.GetString(b, 0, n < 0 ? b.Length : n).Trim();
                return s.Length == 0 ? null : s;
            }
        }

        public void Dispose()
        {
            try { nvmlShutdown(); } catch (DllNotFoundException) { }
        }

        [DllImport("nvml.dll")] private static extern int nvmlInit_v2();
        [DllImport("nvml.dll")] private static extern int nvmlShutdown();
        [DllImport("nvml.dll")] private static extern int nvmlDeviceGetHandleByIndex_v2(uint index, out IntPtr device);
        [DllImport("nvml.dll")] private static extern int nvmlDeviceGetTemperature(IntPtr device, int sensor, out uint temp);
        [DllImport("nvml.dll")] private static extern int nvmlDeviceGetClockInfo(IntPtr device, int clockType, out uint mhz);
        [DllImport("nvml.dll")] private static extern int nvmlDeviceGetCurrentClocksEventReasons(IntPtr device, out ulong reasons);
        [DllImport("nvml.dll")] private static extern int nvmlDeviceGetCurrentClocksThrottleReasons(IntPtr device, out ulong reasons);
        [DllImport("nvml.dll")] private static extern int nvmlSystemGetDriverVersion(byte[] version, uint length);
        [DllImport("nvml.dll")] private static extern int nvmlDeviceGetName(IntPtr device, byte[] name, uint length);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint Length, MemoryLoad;
        public ulong TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemTimes(out ulong idle, out ulong kernel, out ulong user);
}
