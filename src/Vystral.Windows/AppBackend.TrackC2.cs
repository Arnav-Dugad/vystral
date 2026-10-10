using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;
using Vystral.Windows.Services.Startup;

namespace Vystral.Windows;

public sealed record StartupHistoryParams(int? Limit);

/// <summary>This PC as the Performance page's summary shows it. Read-only; null when Windows didn't say.</summary>
public sealed record RigDto(string? GpuName, string? Driver, string? CpuName, int Threads, double? MemoryGb);

// Track C2: the Performance page's rig summary and the startup timing history in Settings › About.
public sealed partial class AppBackend
{
    private readonly object _rigLock = new();
    private (RigDto Rig, DateTimeOffset At)? _rig;

    private void RegisterTrackC2Handlers()
    {
        // Recent starts from VYSTRAL's own local log files only (see StartupHistory for the bounds).
        Dispatcher.Register<StartupHistoryParams>("diagnostics.startupHistory", (p, _) =>
        {
            var limit = p.Limit ?? StartupHistory.DefaultLimit;
            if (limit is < 1 or > StartupHistory.MaxLimit) throw new BridgeException("invalid", $"Limit must be between 1 and {StartupHistory.MaxLimit}.");
            return Task.FromResult<object?>(StartupHistory.Read(Paths.Logs, limit));
        });

        Dispatcher.Register("performance.rig", _ => Task.FromResult<object?>(Rig()));
    }

    /// <summary>GPU and driver (registry, the same read the sessions use), CPU name, threads and memory. Re-read every 10 minutes.</summary>
    private RigDto Rig()
    {
        lock (_rigLock)
        {
            if (_rig is { } cached && DateTimeOffset.UtcNow - cached.At < TimeSpan.FromMinutes(10)) return cached.Rig;
        }
        GpuIdentity? gpu = null;
        try { gpu = GpuDriverProbe.FromRegistry(new WindowsRegistryReader()); }
        catch (Exception ex) { Log.Warn("perf", "GPU identity unavailable", ex: ex); }
        var (gpuName, cpuName) = _machine.Value;
        double? memoryGb = null;
        try
        {
            var bytes = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;
            if (bytes > 0) memoryGb = Math.Round(bytes / (1024d * 1024 * 1024), 1);
        }
        catch (Exception ex) { Log.Warn("perf", "Memory size unavailable", ex: ex); }
        var rig = new RigDto(Cap(gpu?.Name ?? gpuName), Cap(gpu?.Driver), Cap(cpuName), Environment.ProcessorCount, memoryGb);
        lock (_rigLock) _rig = (rig, DateTimeOffset.UtcNow);
        return rig;

        static string? Cap(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim() is { Length: > 128 } t ? t[..128] : s.Trim();
    }
}
