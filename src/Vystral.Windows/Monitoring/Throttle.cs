namespace Vystral.Windows.Monitoring;

/// <summary>
/// Why the GPU was running below its maximum clock, in VYSTRAL's own stable encoding (stored in
/// perf_samples.throttle_flags). Decoded from NVML's read-only clock-event reasons.
/// </summary>
[Flags]
public enum ThrottleFlags
{
    None = 0,
    /// <summary>The driver lowered clocks because the GPU (or memory) is too hot.</summary>
    ThermalSoftware = 1 << 0,
    /// <summary>The hardware forced a large clock cut because it is too hot.</summary>
    ThermalHardware = 1 << 1,
    /// <summary>The GPU hit its power limit (normal under heavy load, especially on laptops).</summary>
    PowerCap = 1 << 2,
    /// <summary>An external power-brake signal (e.g. the power supply or laptop EC) slowed the GPU.</summary>
    PowerBrake = 1 << 3,
}

public static class Throttle
{
    // nvmlClocksEventReasons / nvmlClocksThrottleReasons bit values (nvml.h).
    public const ulong NvmlGpuIdle = 0x1;
    public const ulong NvmlSwPowerCap = 0x4;
    public const ulong NvmlHwSlowdown = 0x8;
    public const ulong NvmlSwThermalSlowdown = 0x20;
    public const ulong NvmlHwThermalSlowdown = 0x40;
    public const ulong NvmlHwPowerBrakeSlowdown = 0x80;

    public const ThrottleFlags Thermal = ThrottleFlags.ThermalSoftware | ThrottleFlags.ThermalHardware;

    /// <summary>Thermal throttling for at least this long earns a note on the session.</summary>
    public const int NoteThresholdSeconds = 30;

    public static ThrottleFlags FromNvml(ulong reasons)
    {
        var f = ThrottleFlags.None;
        if ((reasons & NvmlSwThermalSlowdown) != 0) f |= ThrottleFlags.ThermalSoftware;
        if ((reasons & NvmlHwThermalSlowdown) != 0) f |= ThrottleFlags.ThermalHardware;
        if ((reasons & NvmlSwPowerCap) != 0) f |= ThrottleFlags.PowerCap;
        if ((reasons & NvmlHwPowerBrakeSlowdown) != 0) f |= ThrottleFlags.PowerBrake;
        // HW_SLOWDOWN alone (older drivers don't split it) means "thermal or power brake";
        // count it as hardware thermal only when no more specific reason is present.
        if ((reasons & NvmlHwSlowdown) != 0 && (reasons & (NvmlHwThermalSlowdown | NvmlHwPowerBrakeSlowdown)) == 0)
            f |= ThrottleFlags.ThermalHardware;
        return f;
    }

    public static bool IsThermal(int? flags) => flags is int f && (((ThrottleFlags)f) & Thermal) != 0;
    public static bool IsPowerLimited(int? flags) => flags is int f && (((ThrottleFlags)f) & (ThrottleFlags.PowerCap | ThrottleFlags.PowerBrake)) != 0;

    /// <summary>Stable reason keys for the UI ("thermal", "power"), in a fixed order.</summary>
    public static IReadOnlyList<string> ReasonKeys(ThrottleFlags flags)
    {
        var list = new List<string>(2);
        if ((flags & Thermal) != 0) list.Add("thermal");
        if ((flags & (ThrottleFlags.PowerCap | ThrottleFlags.PowerBrake)) != 0) list.Add("power");
        return list;
    }

    /// <summary>"4m 12s", "1h 03m", "45s".</summary>
    public static string FormatDuration(int seconds)
    {
        seconds = Math.Max(0, seconds);
        if (seconds >= 3600) return $"{seconds / 3600}h {seconds % 3600 / 60:00}m";
        if (seconds >= 60) return $"{seconds / 60}m {seconds % 60}s";
        return $"{seconds}s";
    }

    public static string ThermalNote(int seconds) =>
        $"Your GPU got hot and slowed down for {FormatDuration(seconds)} — check airflow, a laptop stand, or a lower power profile in your laptop's performance app (for example Armoury Crate).";
}
