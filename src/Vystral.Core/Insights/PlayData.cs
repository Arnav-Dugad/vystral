using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Contracts;

namespace Vystral.Core.Insights;

// Track Y: play data and insights. Pure and unit-tested: hardware history (driver and display changes),
// the energy estimate, and controller battery history. Nothing here reads hardware or the database.

// ======================================================================== hardware history

/// <summary>The primary display when a session started. Any field can be unknown.</summary>
public sealed record SessionDisplay(int? Width, int? Height, int? RefreshHz, bool? Hdr)
{
    /// <summary>"2560 × 1440 · 165 Hz", or null when nothing is known.</summary>
    public string? Mode => Label(Width, Height, RefreshHz);

    public static string? Label(int? width, int? height, int? hz)
    {
        var res = width is > 0 && height is > 0 ? $"{width} × {height}" : null;
        var rate = hz is > 1 ? $"{hz} Hz" : null;
        return res is null ? rate : rate is null ? res : $"{res} · {rate}";
    }

    /// <summary>Clamps implausible values to null so bad readings never show up as a "change".</summary>
    public static SessionDisplay Sanitize(int? width, int? height, int? hz, bool? hdr) => new(
        width is >= 320 and <= 16384 ? width : null,
        height is >= 200 and <= 16384 ? height : null,
        hz is >= 20 and <= 1000 ? hz : null,
        hdr);
}

public sealed record HardwareSessionRow(
    string SessionId, string GameId, DateTimeOffset Start, int DurationSeconds,
    string? GpuDriver, string? GpuName, int? Width, int? Height, int? RefreshHz, bool? Hdr);

public static class HardwareHistory
{
    /// <summary>
    /// Sessions oldest first, with a change wherever a known value differs from the last known one.
    /// Sessions that didn't record a value neither start nor break a stretch.
    /// </summary>
    public static HardwareHistoryDto Build(IReadOnlyList<HardwareSessionRow> rows, int maxSessions = 1500)
    {
        var ordered = rows.OrderBy(r => r.Start).ToList();
        var changes = new List<HardwareChangeDto>();
        var spans = new List<HardwareSpanDto>();
        string? driver = null, gpu = null, display = null;
        bool? hdr = null;
        // Open spans per lane: value, first start, last start, count.
        (string Value, DateTimeOffset From, DateTimeOffset To, int N)? dSpan = null, mSpan = null;

        foreach (var r in ordered)
        {
            var at = r.Start.ToString("O", CultureInfo.InvariantCulture);
            if (Clean(r.GpuDriver) is { } d)
            {
                if (driver is not null && !string.Equals(driver, d, StringComparison.OrdinalIgnoreCase))
                {
                    changes.Add(new("driver", at, r.SessionId, driver, d));
                    Close(ref dSpan, "driver", spans);
                }
                driver = d;
                dSpan = dSpan is { } s ? s with { To = r.Start, N = s.N + 1 } : (d, r.Start, r.Start, 1);
            }
            if (Clean(r.GpuName) is { } g)
            {
                if (gpu is not null && !string.Equals(gpu, g, StringComparison.OrdinalIgnoreCase)) changes.Add(new("gpu", at, r.SessionId, gpu, g));
                gpu = g;
            }
            if (SessionDisplay.Label(r.Width, r.Height, r.RefreshHz) is { } m)
            {
                if (display is not null && display != m)
                {
                    changes.Add(new("display", at, r.SessionId, display, m));
                    Close(ref mSpan, "display", spans);
                }
                display = m;
                mSpan = mSpan is { } s ? s with { To = r.Start, N = s.N + 1 } : (m, r.Start, r.Start, 1);
            }
            if (r.Hdr is { } h)
            {
                if (hdr is not null && hdr != h) changes.Add(new("hdr", at, r.SessionId, hdr.Value ? "HDR on" : "HDR off", h ? "HDR on" : "HDR off"));
                hdr = h;
            }
        }
        Close(ref dSpan, "driver", spans);
        Close(ref mSpan, "display", spans);

        var sessions = ordered.Skip(Math.Max(0, ordered.Count - maxSessions)).Select(r => new HardwareSessionDto(
            r.SessionId, r.GameId, r.Start.ToString("O", CultureInfo.InvariantCulture), r.DurationSeconds,
            Clean(r.GpuDriver), Clean(r.GpuName), r.Width, r.Height, r.RefreshHz, r.Hdr)).ToList();
        return new HardwareHistoryDto(sessions, changes, spans,
            ordered.Count(r => Clean(r.GpuDriver) is not null),
            ordered.Count(r => SessionDisplay.Label(r.Width, r.Height, r.RefreshHz) is not null));
    }

    private static void Close(ref (string Value, DateTimeOffset From, DateTimeOffset To, int N)? span, string lane, List<HardwareSpanDto> spans)
    {
        if (span is not { } s) return;
        spans.Add(new HardwareSpanDto(lane, s.Value, s.From.ToString("O", CultureInfo.InvariantCulture), s.To.ToString("O", CultureInfo.InvariantCulture), s.N));
        span = null;
    }

    private static string? Clean(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}

// ======================================================================== energy estimate

public sealed record EnergySessionRow(string SessionId, string GameId, DateTimeOffset Start, int DurationSeconds, string? PerfJson, string? GpuName);

/// <summary>The power figures one estimate uses.</summary>
public sealed record PowerProfile(
    string? GpuName, string GpuClass, double GpuWatts, bool GpuKnown,
    string? CpuName, double CpuWatts, bool CpuKnown, double BaseWatts, bool Laptop, double? ManualWatts);

/// <summary>
/// Opt-in, clearly labelled energy estimate. Whole-PC power while a game runs is modelled as
///   P = base + GPU typical board power × (0.2 + 0.8 × GPU load) + CPU typical power × (0.25 + 0.75 × CPU load)
/// or, when the user entered their PC's full-load wattage W,
///   P = W × (0.3 + 0.7 × (0.75 × GPU load + 0.25 × CPU load)).
/// P is linear in the loads, so integrating it over the session's evenly spaced samples equals the
/// session's duration × P(average loads): the stored per-session averages give the exact same answer as
/// replaying every sample. The monitor and speakers aren't included.
/// </summary>
public static partial class EnergyModel
{
    /// <summary>Load assumed for a missing GPU or CPU reading (the session is then marked partial).</summary>
    public const double TypicalLoad = 0.6;
    public const double DesktopBaseWatts = 50;
    public const double LaptopBaseWatts = 15;
    public const double UnknownDesktopGpuWatts = 200;
    public const double UnknownLaptopGpuWatts = 100;
    public const double IntegratedGpuWatts = 25;
    public const double UnknownCpuWatts = 65;

    // Typical total board power (desktop) by exact model; values are vendor reference figures, rounded.
    private static readonly (Regex Pattern, double Watts)[] DesktopGpus =
    [
        (G(@"RTX\s*5090"), 575), (G(@"RTX\s*5080"), 360), (G(@"RTX\s*5070\s*Ti"), 300), (G(@"RTX\s*5070"), 250),
        (G(@"RTX\s*5060\s*Ti"), 180), (G(@"RTX\s*5060"), 145), (G(@"RTX\s*5050"), 130),
        (G(@"RTX\s*4090"), 450), (G(@"RTX\s*4080"), 320), (G(@"RTX\s*4070\s*Ti"), 285), (G(@"RTX\s*4070\s*SUPER"), 220), (G(@"RTX\s*4070"), 200),
        (G(@"RTX\s*4060\s*Ti"), 160), (G(@"RTX\s*4060"), 115),
        (G(@"RTX\s*3090\s*Ti"), 450), (G(@"RTX\s*3090"), 350), (G(@"RTX\s*3080\s*Ti"), 350), (G(@"RTX\s*3080"), 320), (G(@"RTX\s*3070\s*Ti"), 290),
        (G(@"RTX\s*3070"), 220), (G(@"RTX\s*3060\s*Ti"), 200), (G(@"RTX\s*3060"), 170), (G(@"RTX\s*3050"), 130),
        (G(@"RTX\s*2080\s*Ti"), 250), (G(@"RTX\s*2080"), 215), (G(@"RTX\s*2070"), 175), (G(@"RTX\s*2060"), 160),
        (G(@"GTX\s*16[56]0\s*(Ti|SUPER)"), 125), (G(@"GTX\s*1660"), 120), (G(@"GTX\s*1650"), 75),
        (G(@"GTX\s*1080\s*Ti"), 250), (G(@"GTX\s*1080"), 180), (G(@"GTX\s*1070"), 150), (G(@"GTX\s*1060"), 120), (G(@"GTX\s*1050"), 75),
        (G(@"RX\s*9070\s*XT"), 304), (G(@"RX\s*9070"), 220), (G(@"RX\s*9060"), 160),
        (G(@"RX\s*7900\s*XTX"), 355), (G(@"RX\s*7900\s*XT"), 315), (G(@"RX\s*7900"), 260), (G(@"RX\s*7800"), 263), (G(@"RX\s*7700"), 245), (G(@"RX\s*7600"), 165),
        (G(@"RX\s*69[05]0"), 320), (G(@"RX\s*6800\s*XT"), 300), (G(@"RX\s*6800"), 250), (G(@"RX\s*67[05]0"), 230), (G(@"RX\s*66[05]0"), 170),
        (G(@"RX\s*6500"), 107), (G(@"RX\s*6400"), 53), (G(@"RX\s*5[67]00"), 200),
        (G(@"Arc.*\bA7[57]0"), 225), (G(@"Arc.*\bA580"), 185), (G(@"Arc.*\bA380"), 75), (G(@"Arc.*\bB580"), 190), (G(@"Arc.*\bB570"), 150),
    ];

    private static Regex G(string pattern) => new(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    [GeneratedRegex(@"\b(Laptop|Mobile|Max-Q)\b|\b(RX\s*\d{4}[MS])\b|\bA\d{3}M\b", RegexOptions.IgnoreCase)]
    private static partial Regex LaptopGpu();

    [GeneratedRegex(@"\b(UHD|Iris|HD Graphics|Vega|Radeon\(TM\) Graphics|Radeon Graphics|Radeon\s*\d{3}M|Arc\(TM\) Graphics|Arc Graphics|Adreno)\b|^AMD Radeon\(TM\)\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex IntegratedGpu();

    [GeneratedRegex(@"(?:RTX|GTX)\s*\d{2}(\d)0", RegexOptions.IgnoreCase)]
    private static partial Regex NvidiaTier();

    [GeneratedRegex(@"RX\s*\d\d\d0", RegexOptions.IgnoreCase)]
    private static partial Regex AmdTier();

    [GeneratedRegex(@"\b(?:i[3579]-\d{4,5}|Core(?:\(TM\))?\s*(?:Ultra\s*)?\d\s+\d{3,4}|Ryzen\s*(?:AI\s*)?\d\s+(?:PRO\s+)?\d{3,4})([A-Z0-9]{0,4})\b", RegexOptions.IgnoreCase)]
    private static partial Regex CpuModel();

    /// <summary>Typical board power for a GPU name: (class, watts, laptop, known).</summary>
    public static (string Class, double Watts, bool Laptop, bool Known) GpuPower(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return ("unknown", UnknownDesktopGpuWatts, false, false);
        var n = name.Trim();
        var laptop = LaptopGpu().IsMatch(n);
        if (IntegratedGpu().IsMatch(n) && !Regex.IsMatch(n, @"\b(RTX|GTX|RX)\b|\bArc.*\b[AB]\d{3}", RegexOptions.IgnoreCase))
            return ("integrated", IntegratedGpuWatts, laptop, true);
        if (laptop)
        {
            var tier = Tier(n);
            if (tier is null) return ("laptop", UnknownLaptopGpuWatts, true, false);
            return ("laptop", tier switch { <= 5 => 75, 6 => 100, 7 => 115, 8 => 150, _ => 165 }, true, true);
        }
        foreach (var (pattern, watts) in DesktopGpus)
            if (pattern.IsMatch(n)) return ("desktop", watts, false, true);
        if (Tier(n) is int t) return ("desktop", t switch { <= 5 => 130, 6 => 160, 7 => 220, 8 => 320, _ => 450 }, false, true);
        return ("unknown", UnknownDesktopGpuWatts, false, false);
    }

    private static int? Tier(string n)
    {
        var m = NvidiaTier().Match(n);
        if (m.Success) return m.Groups[1].Value[0] - '0';
        m = AmdTier().Match(n);
        if (!m.Success) return null;
        // RX 7600: generation 7, tier 6. RX 9070: generation 9, tier 7 (the third digit).
        var digits = m.Groups[0].Value.Where(char.IsAsciiDigit).ToArray();
        return digits[0] == '9' ? digits[2] - '0' : digits[1] - '0';
    }

    /// <summary>Typical package power for a CPU name from its model suffix: (watts, laptop, known).</summary>
    public static (double Watts, bool Laptop, bool Known) CpuPower(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return (UnknownCpuWatts, false, false);
        var m = CpuModel().Match(name);
        if (!m.Success) return (UnknownCpuWatts, false, false);
        var suffix = m.Groups[1].Value.ToUpperInvariant();
        // AMD X3D parts, then the first letter family.
        if (suffix.Contains("X3D", StringComparison.Ordinal)) return (120, false, true);
        if (suffix.StartsWith("HX", StringComparison.Ordinal)) return (75, true, true);
        if (suffix.StartsWith("HS", StringComparison.Ordinal)) return (35, true, true);
        if (suffix.StartsWith('H')) return (45, true, true);
        if (suffix.StartsWith('U')) return (20, true, true);
        if (suffix.StartsWith('P')) return (28, true, true);
        if (suffix.StartsWith('V')) return (17, true, true);
        if (suffix.StartsWith('K')) return (125, false, true);
        if (suffix.StartsWith('X')) return (105, false, true);
        return (65, false, true);
    }

    public static PowerProfile Profile(string? gpuName, string? cpuName, double? manualWatts)
    {
        var gpu = GpuPower(gpuName);
        var cpu = CpuPower(cpuName);
        var laptop = gpu.Laptop || cpu.Laptop;
        var gpuWatts = gpu.Known ? gpu.Watts : laptop ? UnknownLaptopGpuWatts : UnknownDesktopGpuWatts;
        double? manual = manualWatts is > 0 and <= 5000 ? manualWatts : null;
        return new PowerProfile(gpuName, gpu.Class, gpuWatts, gpu.Known, cpuName, cpu.Watts, cpu.Known,
            laptop ? LaptopBaseWatts : DesktopBaseWatts, laptop, manual);
    }

    /// <summary>Estimated whole-PC power in watts at the given loads (0–1).</summary>
    public static double Watts(PowerProfile p, double gpuLoad, double cpuLoad)
    {
        var g = Math.Clamp(gpuLoad, 0, 1);
        var c = Math.Clamp(cpuLoad, 0, 1);
        if (p.ManualWatts is { } w) return w * (0.3 + 0.7 * (0.75 * g + 0.25 * c));
        return p.BaseWatts + p.GpuWatts * (0.2 + 0.8 * g) + p.CpuWatts * (0.25 + 0.75 * c);
    }

    /// <summary>Average GPU and CPU load (percent) from a stored perf summary; nulls when not recorded.</summary>
    public static (double? Gpu, double? Cpu) Loads(string? perfJson)
    {
        if (string.IsNullOrWhiteSpace(perfJson)) return (null, null);
        try
        {
            using var doc = JsonDocument.Parse(perfJson);
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return (null, null);
            return (Pct(r, "gpuAvg"), Pct(r, "cpuAvg"));
        }
        catch (JsonException)
        {
            return (null, null);
        }
    }

    private static double? Pct(JsonElement o, string name) =>
        o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) && double.IsFinite(d) && d >= 0 ? Math.Min(d, 100) : null;

    /// <summary>kWh for one session, or null when neither load was recorded. Partial: one load was assumed.</summary>
    public static (double KWh, double AvgWatts, bool Partial)? Session(PowerProfile p, int durationSeconds, double? gpuPct, double? cpuPct)
    {
        if (durationSeconds <= 0 || (gpuPct is null && cpuPct is null)) return null;
        var watts = Watts(p, (gpuPct ?? TypicalLoad * 100) / 100, (cpuPct ?? TypicalLoad * 100) / 100);
        return (watts * durationSeconds / 3600.0 / 1000.0, watts, gpuPct is null || cpuPct is null);
    }

    /// <summary>
    /// Per-session, per-game and per-month (local calendar month in <paramref name="zone"/>) totals. Each
    /// session uses the GPU it recorded, else <paramref name="currentGpu"/>.
    /// </summary>
    public static EnergyReportDto Build(IReadOnlyList<EnergySessionRow> rows, string? currentGpu, string? cpuName, double? manualWatts,
        double? price, string? currency, TimeZoneInfo zone, int maxSessions = 2000)
    {
        var profiles = new Dictionary<string, PowerProfile>(StringComparer.OrdinalIgnoreCase);
        PowerProfile ProfileFor(string? gpu)
        {
            var key = gpu ?? currentGpu ?? "";
            if (!profiles.TryGetValue(key, out var p)) profiles[key] = p = Profile(string.IsNullOrEmpty(key) ? null : key, cpuName, manualWatts);
            return p;
        }

        var sessions = new List<EnergySessionDto>();
        var games = new Dictionary<string, (double KWh, int N, double Hours)>(StringComparer.Ordinal);
        var months = new SortedDictionary<string, (double KWh, int N, double Hours)>(StringComparer.Ordinal);
        int excluded = 0, partial = 0;
        foreach (var r in rows.OrderByDescending(r => r.Start))
        {
            var (gpu, cpu) = Loads(r.PerfJson);
            var est = Session(ProfileFor(string.IsNullOrWhiteSpace(r.GpuName) ? null : r.GpuName.Trim()), r.DurationSeconds, gpu, cpu);
            if (est is not { } e)
            {
                if (r.DurationSeconds > 0) excluded++;
                continue;
            }
            if (e.Partial) partial++;
            var hours = r.DurationSeconds / 3600.0;
            if (sessions.Count < maxSessions)
                sessions.Add(new EnergySessionDto(r.SessionId, r.GameId, r.Start.ToString("O", CultureInfo.InvariantCulture), r.DurationSeconds,
                    Round(e.KWh), Math.Round(e.AvgWatts), e.Partial));
            games[r.GameId] = games.TryGetValue(r.GameId, out var g) ? (g.KWh + e.KWh, g.N + 1, g.Hours + hours) : (e.KWh, 1, hours);
            var local = TimeZoneInfo.ConvertTime(r.Start, zone);
            var month = local.ToString("yyyy-MM", CultureInfo.InvariantCulture);
            months[month] = months.TryGetValue(month, out var m) ? (m.KWh + e.KWh, m.N + 1, m.Hours + hours) : (e.KWh, 1, hours);
        }

        var method = ProfileFor(currentGpu);
        return new EnergyReportDto(true,
            new EnergyMethodDto(method.ManualWatts is null ? "typical" : "manual", method.GpuName, method.GpuClass, method.GpuWatts, method.GpuKnown,
                method.CpuName, method.CpuWatts, method.CpuKnown, method.BaseWatts, method.Laptop, method.ManualWatts, TypicalLoad),
            price is > 0 and <= 1000 ? price : null, string.IsNullOrWhiteSpace(currency) ? null : currency,
            Round(games.Values.Sum(g => g.KWh)), games.Values.Sum(g => g.N), excluded, partial,
            sessions,
            games.Select(kv => new EnergyGameDto(kv.Key, Round(kv.Value.KWh), kv.Value.N, Math.Round(kv.Value.Hours, 2)))
                .OrderByDescending(g => g.KWh).ToList(),
            months.Select(kv => new EnergyMonthDto(kv.Key, Round(kv.Value.KWh), kv.Value.N, Math.Round(kv.Value.Hours, 2))).TakeLast(36).ToList());
    }

    private static double Round(double kwh) => Math.Round(kwh, 4);

    public static EnergyReportDto Disabled { get; } = new(false, null, null, null, 0, 0, 0, 0, [], [], []);
}

// ======================================================================== controller battery

/// <summary>One battery reading. Pad is an opaque hash of the controller's device id.</summary>
public sealed record BatteryReading(string Pad, string Name, int Percent, bool Charging, DateTimeOffset At);

public static class BatteryHistory
{
    /// <summary>Readings are kept about this often while a controller stays connected...</summary>
    public static readonly TimeSpan Every = TimeSpan.FromMinutes(10);
    /// <summary>...plus whenever the level moves by this many points or charging starts or stops.</summary>
    public const int ChangePoints = 5;
    /// <summary>A gap this long between readings means the pad was off or disconnected: drain runs break there.</summary>
    public static readonly TimeSpan Gap = TimeSpan.FromMinutes(25);
    public static readonly TimeSpan Keep = TimeSpan.FromDays(90);
    /// <summary>Below this, the pre-flight card warns.</summary>
    public const int LowPercent = 20;
    /// <summary>Above the low threshold, warn when the usual drain leaves less than this.</summary>
    public const int ShortMinutes = 90;

    public static bool ShouldRecord(BatteryReading? last, BatteryReading now) =>
        last is null
        || now.At - last.At >= Every
        || Math.Abs(now.Percent - last.Percent) >= ChangePoints
        || now.Charging != last.Charging;

    /// <summary>
    /// The usual drain in percentage points per hour: total drop over total time across discharging runs
    /// (consecutive, not charging, no gap, never rising). Null until there are at least 45 minutes and 4
    /// points of discharge to go on, so a fresh pad never shows an invented number.
    /// </summary>
    public static double? DrainPerHour(IReadOnlyList<BatteryReading> readings)
    {
        var ordered = readings.OrderBy(r => r.At).ToList();
        double drop = 0, hours = 0;
        for (var i = 1; i < ordered.Count; i++)
        {
            var a = ordered[i - 1];
            var b = ordered[i];
            if (a.Charging || b.Charging || b.At - a.At > Gap || b.At <= a.At || b.Percent > a.Percent) continue;
            drop += a.Percent - b.Percent;
            hours += (b.At - a.At).TotalHours;
        }
        if (hours < 0.75 || drop < 4) return null;
        return Math.Round(drop / hours, 2);
    }

    public static int? MinutesLeft(int? percent, double? drainPerHour, bool? charging)
    {
        if (percent is not { } p || drainPerHour is not > 0 || charging == true) return null;
        return (int)Math.Round(p / drainPerHour.Value * 60);
    }

    /// <summary>Per-pad series for the chart, newest pad first. Points are capped (thinned evenly, last kept).</summary>
    public static IReadOnlyList<ControllerBatteryDto> Build(IReadOnlyList<BatteryReading> readings, DateTimeOffset since, int maxPoints = 400)
    {
        return readings.GroupBy(r => r.Pad, StringComparer.Ordinal)
            .Select(g =>
            {
                var all = g.OrderBy(r => r.At).ToList();
                var shown = all.Where(r => r.At >= since).ToList();
                var last = all[^1];
                var drain = DrainPerHour(all);
                var points = Thin(shown, maxPoints).Select(r => new BatteryPointDto(r.At.ToString("O", CultureInfo.InvariantCulture), r.Percent, r.Charging)).ToList();
                return new ControllerBatteryDto(g.Key, last.Name, points, last.Percent, last.Charging, last.At.ToString("O", CultureInfo.InvariantCulture),
                    drain, MinutesLeft(last.Percent, drain, last.Charging));
            })
            .Where(p => p.Points.Count > 0)
            .OrderByDescending(p => p.LastSeen, StringComparer.Ordinal)
            .ToList();
    }

    private static IEnumerable<BatteryReading> Thin(List<BatteryReading> list, int max)
    {
        if (list.Count <= max) return list;
        var step = (double)(list.Count - 1) / (max - 1);
        return Enumerable.Range(0, max).Select(i => list[(int)Math.Round(i * step)]);
    }
}
