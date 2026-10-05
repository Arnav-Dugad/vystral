using Vystral.Windows.Integrations;

namespace Vystral.Windows.Monitoring;

/// <summary>The graphics card a session ran on and its driver version, as the vendor writes it (NVIDIA "572.16").</summary>
public sealed record GpuIdentity(string? Name, string? Driver);

/// <summary>
/// Read-only GPU driver lookup. NVIDIA's NVML (already loaded by the sampler) gives the marketing
/// version directly; otherwise the display adapter's entry in the device class key is read from the
/// registry (readable without admin). No WMI, no driver tools, nothing is written.
/// </summary>
public static class GpuDriverProbe
{
    /// <summary>Display adapters device class.</summary>
    public const string ClassKey = @"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

    private static readonly string[] Virtual = ["Microsoft Basic", "Remote Display", "Virtual", "Indirect Display", "Parsec", "Meta Display"];

    /// <summary>NVML identity when available, else the registry; null when neither is readable.</summary>
    public static GpuIdentity? Read(PerfSampler? sampler, IRegistryReader registry)
    {
        GpuIdentity? nvml = null;
        try { nvml = sampler?.ReadGpuIdentity(); }
        catch (Exception ex) { Services.Log.Warn("gpu", "NVML identity unavailable", ex: ex); }
        if (nvml?.Driver is not null) return nvml;
        GpuIdentity? reg = null;
        try { reg = FromRegistry(registry); }
        catch (Exception ex) { Services.Log.Warn("gpu", "Display adapter registry unreadable", ex: ex); }
        return reg ?? nvml;
    }

    /// <summary>
    /// Picks the most likely gaming GPU from the display adapter class key (NVIDIA, then AMD, then anything
    /// else that isn't a virtual/basic adapter) and returns its name and driver version.
    /// </summary>
    public static GpuIdentity? FromRegistry(IRegistryReader registry)
    {
        var candidates = new List<(int Rank, string Name, string Version)>();
        foreach (var sub in registry.GetSubKeyNames(Hive.LocalMachine, ClassKey))
        {
            if (sub.Length != 4 || !sub.All(char.IsAsciiDigit)) continue;
            var path = $@"{ClassKey}\{sub}";
            var desc = registry.GetString(Hive.LocalMachine, path, "DriverDesc");
            var version = registry.GetString(Hive.LocalMachine, path, "DriverVersion");
            if (desc is null || version is null || Virtual.Any(v => desc.Contains(v, StringComparison.OrdinalIgnoreCase))) continue;
            var provider = registry.GetString(Hive.LocalMachine, path, "ProviderName") ?? "";
            var rank = IsNvidia(provider, desc) ? 0 : IsAmd(provider, desc) ? 1 : 2;
            candidates.Add((rank, desc.Trim(), rank == 0 ? NvidiaVersion(version) ?? version : version));
        }
        var best = candidates.OrderBy(c => c.Rank).FirstOrDefault();
        return best.Name is null ? null : new GpuIdentity(best.Name, best.Version);
    }

    /// <summary>
    /// NVIDIA's version from the Windows driver version: the last five digits of the last two fields,
    /// e.g. 32.0.15.7216 → 572.16. Null when the input doesn't look like a Windows driver version.
    /// </summary>
    public static string? NvidiaVersion(string windowsVersion)
    {
        var parts = windowsVersion.Trim().Split('.');
        if (parts.Length != 4 || parts.Any(p => p.Length == 0 || !p.All(char.IsAsciiDigit))) return null;
        var digits = parts[2] + parts[3].PadLeft(4, '0');
        if (digits.Length < 5) return null;
        var last = digits[^5..];
        return $"{int.Parse(last[..3])}.{last[3..]}";
    }

    private static bool IsNvidia(string provider, string desc) =>
        provider.Contains("NVIDIA", StringComparison.OrdinalIgnoreCase) || desc.Contains("NVIDIA", StringComparison.OrdinalIgnoreCase);

    private static bool IsAmd(string provider, string desc) =>
        provider.Contains("Advanced Micro Devices", StringComparison.OrdinalIgnoreCase) || provider.Equals("AMD", StringComparison.OrdinalIgnoreCase) ||
        desc.Contains("Radeon", StringComparison.OrdinalIgnoreCase);
}
