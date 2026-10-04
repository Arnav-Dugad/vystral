using System.Diagnostics;
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
    string FpsStatus);

/// <summary>
/// Read-only system sampling during a game session. Uses Windows performance counters
/// (no admin) and, when an NVIDIA driver is installed, NVML's temperature query. Nothing
/// here changes clocks, fans, power limits or any other hardware setting.
/// </summary>
public sealed class PerfSampler : IDisposable
{
    public const string FpsUnavailable =
        "Frame-rate capture needs Intel PresentMon with ETW access, which VYSTRAL does not use yet. FPS is not recorded.";

    private readonly CpuMeter _cpu = new();
    private readonly GpuCounters _gpu = new();
    private readonly Nvml? _nvml = Nvml.TryCreate();

    public PerfSampleDto Sample(int offsetMs)
    {
        double? cpu = _cpu.Read();
        var (gpu, gpuMem) = _gpu.Read();
        double? ram = ReadUsedRamMb();
        double? temp = _nvml?.ReadTemperature();
        return new PerfSampleDto(offsetMs, Round(cpu), Round(gpu), Round(gpuMem), Round(ram), Round(temp));
    }

    public static PerfSummary Summarize(IReadOnlyList<PerfSampleDto> samples)
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
            ram.Item1, ram.Item2, temp.Item1, temp.Item2, FpsUnavailable);
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
    /// GPU utilisation and dedicated memory from the "GPU Engine" / "GPU Adapter Memory"
    /// counters (the same source as Task Manager). Instances are refreshed periodically
    /// because they come and go with processes.
    /// </summary>
    private sealed class GpuCounters : IDisposable
    {
        private List<PerformanceCounter> _engines = [];
        private List<PerformanceCounter> _memory = [];
        private DateTime _refreshed = DateTime.MinValue;
        private bool _unavailable;

        public (double? Util, double? MemMb) Read()
        {
            if (_unavailable) return (null, null);
            try
            {
                if (DateTime.UtcNow - _refreshed > TimeSpan.FromSeconds(15)) Refresh();
                double util = 0;
                foreach (var c in _engines)
                {
                    try { util += c.NextValue(); } catch (InvalidOperationException) { }
                }
                double mem = 0;
                foreach (var c in _memory)
                {
                    try { mem += c.NextValue(); } catch (InvalidOperationException) { }
                }
                return (Math.Clamp(util, 0, 100), _memory.Count == 0 ? null : mem / 1048576.0);
            }
            catch (Exception ex) when (ex is InvalidOperationException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
            {
                _unavailable = true;
                return (null, null);
            }
        }

        private void Refresh()
        {
            Dispose();
            var engine = new PerformanceCounterCategory("GPU Engine");
            _engines = engine.GetInstanceNames()
                .Where(n => n.EndsWith("engtype_3D", StringComparison.OrdinalIgnoreCase))
                .Select(n => new PerformanceCounter("GPU Engine", "Utilization Percentage", n, readOnly: true))
                .ToList();
            var memory = new PerformanceCounterCategory("GPU Adapter Memory");
            _memory = memory.GetInstanceNames()
                .Select(n => new PerformanceCounter("GPU Adapter Memory", "Dedicated Usage", n, readOnly: true))
                .ToList();
            foreach (var c in _engines.Concat(_memory))
            {
                try { c.NextValue(); } catch (InvalidOperationException) { }
            }
            _refreshed = DateTime.UtcNow;
        }

        public void Dispose()
        {
            foreach (var c in _engines.Concat(_memory)) c.Dispose();
            _engines = [];
            _memory = [];
        }
    }

    /// <summary>Read-only NVML access (ships with NVIDIA drivers). Only the temperature query is used.</summary>
    private sealed class Nvml : IDisposable
    {
        private readonly IntPtr _device;

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

        public void Dispose()
        {
            try { nvmlShutdown(); } catch (DllNotFoundException) { }
        }

        [DllImport("nvml.dll")] private static extern int nvmlInit_v2();
        [DllImport("nvml.dll")] private static extern int nvmlShutdown();
        [DllImport("nvml.dll")] private static extern int nvmlDeviceGetHandleByIndex_v2(uint index, out IntPtr device);
        [DllImport("nvml.dll")] private static extern int nvmlDeviceGetTemperature(IntPtr device, int sensor, out uint temp);
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
