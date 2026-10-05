namespace Vystral.Core.Contracts;

// Serialized to the UI with camelCase names; mirrored in ui/src/bridge/types.ts (InsightSample).

/// <summary>
/// Extra per-sample data added in schema v4, stored alongside <see cref="PerfSampleDto"/> (same
/// session and time offset). Every field is null when it wasn't measurable.
/// </summary>
/// <param name="T">Milliseconds since the session started (matches PerfSampleDto.T).</param>
/// <param name="GpuClockMhz">NVIDIA graphics clock (NVML), read-only.</param>
/// <param name="ThrottleFlags">VYSTRAL throttle flags (see Vystral.Windows.Monitoring.Throttle); null when not reported.</param>
/// <param name="Fps">Frames per second over the sample window, from PresentMon (opt-in).</param>
/// <param name="FrameTimeMs">Average frame time over the sample window.</param>
/// <param name="FrameTimeP99Ms">99th-percentile frame time over the sample window.</param>
public sealed record InsightSampleDto(
    int T,
    double? GpuClockMhz,
    int? ThrottleFlags,
    double? Fps,
    double? FrameTimeMs,
    double? FrameTimeP99Ms);
