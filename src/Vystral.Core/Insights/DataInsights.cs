using System.Text.Json;
using Vystral.Core.Contracts;
using Vystral.Core.Data;

namespace Vystral.Core.Insights;

/// <summary>The few frame-rate and load figures the insights need from a stored perf summary.</summary>
public readonly record struct PerfFields(double? FpsAvg, double? Fps1Low, double? FrameTimeP99Ms, int? StutterCount, double? CpuAvg)
{
    public bool HasFps => FpsAvg is > 0 && Fps1Low is > 0;

    /// <summary>Reads perf_summary_json (camelCase, written by PerfSampler.ToJson). Malformed JSON gives empty fields.</summary>
    public static PerfFields Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return default;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return default;
            return new PerfFields(Num(r, "fpsAvg"), Num(r, "fps1Low"), Num(r, "frameTimeP99Ms"),
                Num(r, "stutterCount") is double s ? (int)s : null, Num(r, "cpuAvg"));
        }
        catch (JsonException)
        {
            return default;
        }
    }

    private static double? Num(JsonElement o, string name) =>
        o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) && double.IsFinite(d) ? d : null;
}

// ======================================================================== achievements

/// <summary>Per-app achievement counts used for the near-completion shelf.</summary>
public sealed record AchievementProgressRow(
    string AppId, string? GameId, string GameTitle, int Total, int Unlocked, string? LastUnlockAt,
    string? RarestLockedName, double? RarestLockedPercent, bool RarestLockedHidden);

public static class AchievementInsights
{
    /// <summary>≤ 5% of players: "rare".</summary>
    public const double RarePercent = 5;
    /// <summary>≤ 1% of players: "ultra rare".</summary>
    public const double UltraRarePercent = 1;
    /// <summary>Games at or above this share of unlocks (but not complete) are "nearly done".</summary>
    public const double NearCompletionFraction = 0.7;
    /// <summary>Unlock times may be stamped a little before VYSTRAL saw the game process (detection lag, clock skew).</summary>
    public static readonly TimeSpan StartTolerance = TimeSpan.FromSeconds(30);

    private static readonly double[] Thresholds = [1, 2, 5, 10];

    /// <summary>
    /// Achievements unlocked during a session: achieved now, not achieved in the cache taken before the
    /// refresh, and stamped by Steam at or after the session start. Anything unlocked before the session
    /// (for example while the cache was stale) is never reported. Rarest first.
    /// </summary>
    public static IReadOnlyList<SteamAchievementRow> NewlyUnlocked(IReadOnlySet<string> achievedBefore, IReadOnlyList<SteamAchievementRow> after, DateTimeOffset sessionStart) =>
        after.Where(a => a.Achieved && !achievedBefore.Contains(a.ApiName) && a.UnlockTime is { } t && t >= sessionStart - StartTolerance)
            .OrderBy(a => a.GlobalPercent ?? double.MaxValue).ThenBy(a => a.SortOrder)
            .ToList();

    /// <summary>
    /// For a toast like "1 is rarer than 2%": the smallest of 1/2/5/10 % that the rarest unlock is below,
    /// and how many unlocks are below it. (null, 0) when nothing is below 10% or rarity is unknown.
    /// </summary>
    public static (double? Threshold, int Count) RareSummary(IEnumerable<double?> percents)
    {
        var known = percents.Where(p => p is >= 0).Select(p => p!.Value).ToList();
        if (known.Count == 0) return (null, 0);
        var rarest = known.Min();
        foreach (var t in Thresholds)
            if (rarest < t) return (t, known.Count(p => p < t));
        return (null, 0);
    }

    /// <summary>Games ≥ 70% complete but not finished, closest to completion first.</summary>
    public static IReadOnlyList<NearCompletionDto> NearCompletion(IEnumerable<AchievementProgressRow> rows, int limit = 12) =>
        rows.Where(r => r.Total > 0 && r.Unlocked < r.Total && (double)r.Unlocked / r.Total >= NearCompletionFraction)
            .OrderBy(r => r.Total - r.Unlocked)
            .ThenByDescending(r => (double)r.Unlocked / r.Total)
            .ThenByDescending(r => r.LastUnlockAt, StringComparer.Ordinal)
            .ThenBy(r => r.GameTitle, StringComparer.OrdinalIgnoreCase)
            .Take(limit)
            .Select(r => new NearCompletionDto(r.AppId, r.GameId, r.GameTitle, r.Unlocked, r.Total, r.Total - r.Unlocked,
                Math.Round((double)r.Unlocked / r.Total, 4), r.RarestLockedHidden ? null : r.RarestLockedName, r.RarestLockedPercent,
                r.RarestLockedHidden, r.LastUnlockAt))
            .ToList();
}

// ======================================================================== GPU driver comparison

/// <summary>A finished tracked session with the GPU it ran on and its frame-rate summary.</summary>
public sealed record DriverSessionRow(
    string SessionId, string GameId, DateTimeOffset Start, int DurationSeconds, string? GpuDriver, string? GpuName, PerfFields Perf);

public static class DriverComparison
{
    /// <summary>Sessions shorter than this are mostly menus and loading screens and are left out of FPS comparisons.</summary>
    public const int MinSessionSeconds = 120;
    /// <summary>Fewer sessions than this on either side earns a "small sample" warning.</summary>
    public const int SmallSample = 3;

    public static DriverInsightDto Build(IReadOnlyList<DriverSessionRow> sessions)
    {
        var withDriver = sessions.Where(s => !string.IsNullOrWhiteSpace(s.GpuDriver)).OrderBy(s => s.Start).ToList();
        var drivers = withDriver.GroupBy(s => s.GpuDriver!, StringComparer.OrdinalIgnoreCase)
            .Select(g => new DriverVersionDto(g.Key, g.Select(x => x.GpuName).LastOrDefault(n => n is not null),
                g.Min(x => x.Start).ToString("O"), g.Max(x => x.Start).ToString("O"), g.Count()))
            .OrderBy(d => d.FirstSeen, StringComparer.Ordinal)
            .ToList();
        var firstSeen = drivers.ToDictionary(d => d.Version, d => d.FirstSeen, StringComparer.OrdinalIgnoreCase);

        var games = new List<DriverGameComparisonDto>();
        var withoutFps = 0;
        foreach (var game in withDriver.GroupBy(s => s.GameId, StringComparer.Ordinal))
        {
            var byDriver = game.GroupBy(s => s.GpuDriver!, StringComparer.OrdinalIgnoreCase)
                .OrderBy(g => g.Min(x => x.Start)).ToList();
            if (byDriver.Count < 2) continue;
            var usable = byDriver
                .Select(g => (Version: g.Key, Sessions: g.Where(x => x.Perf.HasFps && x.DurationSeconds >= MinSessionSeconds).ToList()))
                .Where(g => g.Sessions.Count > 0)
                .ToList();
            if (usable.Count < 2)
            {
                withoutFps++;
                continue;
            }
            var before = Side(usable[^2].Version, usable[^2].Sessions);
            var after = Side(usable[^1].Version, usable[^1].Sessions);
            games.Add(new DriverGameComparisonDto(game.Key, before, after,
                firstSeen.GetValueOrDefault(after.Version) ?? after.From,
                before.Sessions < SmallSample || after.Sessions < SmallSample,
                before.GpuName is not null && after.GpuName is not null && !string.Equals(before.GpuName, after.GpuName, StringComparison.OrdinalIgnoreCase)));
        }

        return new DriverInsightDto(drivers,
            games.OrderByDescending(g => g.ChangedAt, StringComparer.Ordinal).ToList(),
            withDriver.Count,
            sessions.Count(s => s.Perf.HasFps),
            withoutFps);
    }

    private static DriverSideDto Side(string version, IReadOnlyList<DriverSessionRow> list) => new(
        version,
        list.Select(x => x.GpuName).LastOrDefault(n => n is not null),
        list.Count,
        Median(list.Select(x => x.Perf.FpsAvg)),
        Median(list.Select(x => x.Perf.Fps1Low)),
        Median(list.Select(x => x.Perf.FrameTimeP99Ms)),
        list.Min(x => x.Start).ToString("O"),
        list.Max(x => x.Start).ToString("O"));

    /// <summary>Median of the known values, rounded to 0.1; null when there are none.</summary>
    public static double? Median(IEnumerable<double?> values)
    {
        var v = values.Where(x => x is double d && double.IsFinite(d)).Select(x => x!.Value).Order().ToList();
        if (v.Count == 0) return null;
        var m = v.Count / 2;
        return Math.Round(v.Count % 2 == 1 ? v[m] : (v[m - 1] + v[m]) / 2, 1);
    }
}

// ======================================================================== background apps

/// <summary>Per-session aggregate for one background app (executable file name).</summary>
public sealed record BackgroundAppSample(string Name, int Samples, double? AvgMb, double? MaxMb, double? AvgCpu);

/// <summary>A session that had background-app snapshots.</summary>
public sealed record ImpactSessionRow(
    string SessionId, string GameId, DateTimeOffset Start, int DurationSeconds, int Snapshots, PerfFields Perf, double? MemLoadAvg, double? MemLoadMax);

public sealed record BackgroundAppRow(string SessionId, string Name, int Samples, double? AvgMb, double? MaxMb, double? AvgCpu);

public static class BackgroundImpact
{
    /// <summary>FPS mode needs at least this many sessions with both frame-rate data and snapshots.</summary>
    public const int MinFpsSessions = 6;
    /// <summary>Rough and clean groups each need at least this many sessions before anything is suggested.</summary>
    public const int MinGroup = 3;
    /// <summary>1% low below this share of the average frame rate counts as rough.</summary>
    public const double LowRatio = 0.5;
    /// <summary>Stutters per minute at or above this count as rough.</summary>
    public const double StuttersPerMinute = 1;
    /// <summary>Average CPU load at or above this (percent) counts as contention.</summary>
    public const double CpuContention = 85;
    /// <summary>Peak memory load at or above this (percent) counts as memory pressure.</summary>
    public const double MemoryPressure = 90;

    public static readonly IReadOnlyList<string> AlwaysExcluded = ["vystral.exe", "msedgewebview2.exe"];

    public static bool IsRough(ImpactSessionRow s, string mode) => mode switch
    {
        "fps" => s.Perf.HasFps && (s.Perf.Fps1Low!.Value < LowRatio * s.Perf.FpsAvg!.Value
                                   || (s.Perf.StutterCount is int n && s.DurationSeconds > 0 && n / (s.DurationSeconds / 60.0) >= StuttersPerMinute)
                                   || s.Perf.CpuAvg >= CpuContention),
        "memory" => s.MemLoadMax >= MemoryPressure,
        _ => false,
    };

    public static string ModeFor(IReadOnlyList<ImpactSessionRow> sessions)
    {
        if (sessions.Count(s => s.Perf.HasFps) >= MinFpsSessions) return "fps";
        return sessions.Any(s => s.MemLoadMax is not null) ? "memory" : "none";
    }

    public static BackgroundImpactDto Analyze(IReadOnlyList<ImpactSessionRow> allSessions, IReadOnlyList<BackgroundAppRow> apps,
        IReadOnlyCollection<string> hidden, bool collecting)
    {
        var hiddenSet = hidden.Select(h => h.ToLowerInvariant()).ToHashSet(StringComparer.Ordinal);
        var withSnapshots = allSessions.Where(s => s.Snapshots > 0).ToList();
        var mode = ModeFor(withSnapshots);
        // In FPS mode only sessions with frame-rate data are classified; in memory mode, those with a memory reading.
        var sessions = mode switch
        {
            "fps" => withSnapshots.Where(s => s.Perf.HasFps).ToList(),
            "memory" => withSnapshots.Where(s => s.MemLoadMax is not null).ToList(),
            _ => withSnapshots,
        };
        var rough = sessions.Where(s => IsRough(s, mode)).Select(s => s.SessionId).ToHashSet(StringComparer.Ordinal);
        var ids = sessions.Select(s => s.SessionId).ToHashSet(StringComparer.Ordinal);
        var roughCount = rough.Count;
        var cleanCount = sessions.Count - roughCount;
        var enough = mode != "none" && roughCount >= MinGroup && cleanCount >= MinGroup;

        var stats = apps
            .Where(a => ids.Contains(a.SessionId) && !hiddenSet.Contains(a.Name.ToLowerInvariant())
                        && !AlwaysExcluded.Contains(a.Name.ToLowerInvariant()))
            .GroupBy(a => a.Name, StringComparer.OrdinalIgnoreCase)
            .Select(g =>
            {
                var perSession = g.GroupBy(a => a.SessionId, StringComparer.Ordinal).Select(x => x.First()).ToList();
                var inRough = perSession.Count(a => rough.Contains(a.SessionId));
                var inClean = perSession.Count - inRough;
                double? roughPresence = roughCount > 0 ? (double)inRough / roughCount : null;
                double? cleanPresence = cleanCount > 0 ? (double)inClean / cleanCount : null;
                var samples = perSession.Sum(a => a.Samples);
                return (Stat: new BackgroundAppStatDto(
                        g.First().Name,
                        DisplayName(g.First().Name),
                        perSession.Count,
                        Math.Round((double)perSession.Count / Math.Max(1, sessions.Count), 3),
                        roughPresence is null ? null : Math.Round(roughPresence.Value, 3),
                        cleanPresence is null ? null : Math.Round(cleanPresence.Value, 3),
                        roughPresence is null || cleanPresence is null ? null : Math.Round(roughPresence.Value - cleanPresence.Value, 3),
                        Weighted(perSession.Select(a => (a.AvgMb, a.Samples)), samples),
                        perSession.Max(a => a.MaxMb) is double mx ? Math.Round(mx) : null,
                        Weighted(perSession.Select(a => (a.AvgCpu, a.Samples)), samples, 1)),
                    InRough: inRough);
            })
            .ToList();

        var suspects = enough
            ? stats.Where(s => s.InRough >= 2 && s.Stat.RoughPresence >= 0.4 && s.Stat.Lift >= 0.2)
                .OrderByDescending(s => s.Stat.Lift).ThenByDescending(s => s.Stat.AvgMb ?? 0).ThenBy(s => s.Stat.Name, StringComparer.OrdinalIgnoreCase)
                .Take(6).Select(s => s.Stat).ToList()
            : [];
        var common = stats.Select(s => s.Stat)
            .OrderByDescending(s => s.Presence).ThenByDescending(s => s.AvgMb ?? 0).ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
            .Take(8).ToList();

        return new BackgroundImpactDto(mode, sessions.Count, roughCount, cleanCount, enough, suspects, common,
            hiddenSet.Order(StringComparer.Ordinal).ToList(), collecting);
    }

    /// <summary>"Discord.exe" → "Discord".</summary>
    public static string DisplayName(string name) =>
        name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && name.Length > 4 ? name[..^4] : name;

    private static double? Weighted(IEnumerable<(double? Value, int Weight)> values, int totalWeight, int digits = 0)
    {
        double sum = 0;
        var weight = 0;
        foreach (var (v, w) in values)
        {
            if (v is not double d || !double.IsFinite(d)) continue;
            sum += d * Math.Max(1, w);
            weight += Math.Max(1, w);
        }
        return weight == 0 || totalWeight == 0 ? null : Math.Round(sum / weight, digits);
    }
}
