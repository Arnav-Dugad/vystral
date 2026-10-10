using System.Globalization;
using System.Text.Json.Nodes;
using Vystral.Core.Contracts;

namespace Vystral.Windows.Ai.Assistant;

/// <summary>Track D3: one week of play (Monday–Sunday, local time), computed on this PC for the weekly recap.</summary>
public sealed record WeeklyRecapFacts(
    DateOnly Monday,
    long TotalSeconds,
    int Sessions,
    int DaysPlayed,
    IReadOnlyList<(string GameId, string Title, long Seconds)> TopGames,
    (string Title, int Seconds, DateOnly Day)? Longest,
    IReadOnlyList<string> FirstTime,
    long PreviousWeekSeconds)
{
    public static WeeklyRecapFacts Compute(IReadOnlyList<GameDto> games, IReadOnlyList<SessionDto> sessions, DateOnly monday, TimeZoneInfo zone)
    {
        var byId = games.Where(g => !g.Hidden).ToDictionary(g => g.Id);
        var parsed = sessions
            .Where(s => s.DurationSeconds > 0 && byId.ContainsKey(s.GameId))
            .Select(s => (S: s, Day: DateTimeOffset.TryParse(s.Start, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t)
                ? DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(t, zone).DateTime) : (DateOnly?)null))
            .Where(x => x.Day is not null)
            .Select(x => (x.S, Day: x.Day!.Value))
            .ToList();
        var sunday = monday.AddDays(6);
        var week = parsed.Where(x => x.Day >= monday && x.Day <= sunday).ToList();
        var prev = parsed.Where(x => x.Day >= monday.AddDays(-7) && x.Day < monday).Sum(x => (long)x.S.DurationSeconds);
        var top = week.GroupBy(x => x.S.GameId)
            .Select(g => (GameId: g.Key, Title: byId[g.Key].Title, Seconds: g.Sum(x => (long)x.S.DurationSeconds)))
            .OrderByDescending(x => x.Seconds).ThenBy(x => x.Title, StringComparer.OrdinalIgnoreCase).Take(5).ToList();
        var longest = week.OrderByDescending(x => x.S.DurationSeconds).Select(x => ((string, int, DateOnly)?)(byId[x.S.GameId].Title, x.S.DurationSeconds, x.Day)).FirstOrDefault();
        var firstDay = parsed.GroupBy(x => x.S.GameId).ToDictionary(g => g.Key, g => g.Min(x => x.Day));
        var firstTime = week.Select(x => x.S.GameId).Distinct().Where(id => firstDay[id] >= monday).Select(id => byId[id].Title).OrderBy(t => t, StringComparer.OrdinalIgnoreCase).ToList();
        return new WeeklyRecapFacts(monday, week.Sum(x => (long)x.S.DurationSeconds), week.Count, week.Select(x => x.Day).Distinct().Count(), top, longest, firstTime, prev);
    }

    public JsonObject ToJson()
    {
        var o = new JsonObject
        {
            ["week"] = $"{Monday:yyyy-MM-dd} to {Monday.AddDays(6):yyyy-MM-dd}",
            ["totalTime"] = AiText.Duration(TotalSeconds),
            ["sessionCount"] = Sessions,
            ["daysPlayed"] = DaysPlayed,
            ["topGames"] = new JsonArray(TopGames.Select(g => (JsonNode)new JsonObject { ["gameId"] = g.GameId, ["title"] = g.Title, ["time"] = AiText.Duration(g.Seconds) }).ToArray()),
            ["previousWeekTotal"] = AiText.Duration(PreviousWeekSeconds),
            ["changeFromPreviousWeek"] = PreviousWeekSeconds == 0
                ? TotalSeconds == 0 ? "no play either week" : "no play the week before"
                : TotalSeconds >= PreviousWeekSeconds ? $"up {AiText.Duration(TotalSeconds - PreviousWeekSeconds)}" : $"down {AiText.Duration(PreviousWeekSeconds - TotalSeconds)}",
            ["firstTimePlayed"] = new JsonArray(FirstTime.Take(6).Select(t => (JsonNode)JsonValue.Create(t)!).ToArray()),
        };
        if (Longest is { } l)
            o["longestSession"] = new JsonObject { ["title"] = l.Title, ["time"] = AiText.Duration(l.Seconds), ["day"] = l.Day.ToString("dddd", CultureInfo.InvariantCulture) };
        return o;
    }
}

/// <summary>
/// Track D3: "Explain this stutter". Reads one session's frame-time summary and its per-second samples and finds the worst
/// moments and what the system was doing then. Purely descriptive: it names likely causes as facts for the model to word,
/// and suggests nothing VYSTRAL would change (it never changes settings).
/// </summary>
public sealed record StutterAnalysis(
    bool HasFrameData,
    JsonObject Stats,
    IReadOnlyList<StutterSpike> Spikes,
    IReadOnlyList<string> Signals)
{
    public static StutterAnalysis Analyze(JsonObject? summary, JsonArray samples, JsonArray insight, int durationSeconds)
    {
        static double? N(JsonNode? n, string name) =>
            n is JsonObject o && o[name] is JsonValue v && v.TryGetValue<double>(out var d) && double.IsFinite(d) ? d : null;

        var stats = new JsonObject
        {
            ["fpsAvg"] = Round(N(summary, "fpsAvg")),
            ["fps1Low"] = Round(N(summary, "fps1Low")),
            ["fps01Low"] = Round(N(summary, "fps01Low")),
            ["frameTimeMedianMs"] = Round(N(summary, "frameTimeP50Ms"), 1),
            ["frameTimeP99Ms"] = Round(N(summary, "frameTimeP99Ms"), 1),
            ["stutterCount"] = N(summary, "stutterCount"),
            ["frames"] = N(summary, "frameCount"),
            ["thermalThrottleSeconds"] = N(summary, "throttledSeconds"),
            ["powerLimitSeconds"] = N(summary, "powerLimitedSeconds"),
            ["peakGpuTempC"] = Round(N(summary, "peakTempC")),
            ["frameRateSource"] = summary?["fpsSource"] is JsonValue fs && fs.TryGetValue<string>(out var src) ? AiText.Clean(src, 40) : null,
        };

        var frames = insight.OfType<JsonObject>()
            .Select(o => (T: N(o, "t") ?? -1, Ft: N(o, "frameTimeMs"), P99: N(o, "frameTimeP99Ms"), Flags: (int)(N(o, "throttleFlags") ?? 0)))
            .Where(x => x.T >= 0 && (x.Ft is > 0 || x.P99 is > 0)).Take(20_000).ToList();
        var perf = samples.OfType<JsonObject>()
            .Select(o => (T: N(o, "t") ?? -1, Cpu: N(o, "cpu"), Gpu: N(o, "gpu"), Ram: N(o, "ramMb"), Vram: N(o, "gpuMemMb"), Temp: N(o, "gpuTempC")))
            .Where(x => x.T >= 0).Take(20_000).ToList();
        var hasFrames = frames.Count > 0 || N(summary, "frameTimeP99Ms") is not null;

        var spikes = new List<StutterSpike>();
        if (frames.Count >= 5)
        {
            var typical = Median(frames.Select(f => f.Ft ?? f.P99 ?? 0).Where(x => x > 0).ToList());
            var threshold = Math.Max(typical * 2, typical + 12);
            var raw = frames.Select(f => (f.T, Ms: Math.Max(f.P99 ?? 0, f.Ft ?? 0), f.Flags)).Where(f => f.Ms >= threshold)
                .OrderByDescending(f => f.Ms).ToList();
            foreach (var f in raw)
            {
                if (spikes.Any(s => Math.Abs(s.T - f.T) < 4)) continue; // one moment per few seconds
                var near = perf.Where(p => Math.Abs(p.T - f.T) <= 3).OrderBy(p => Math.Abs(p.T - f.T)).FirstOrDefault();
                var found = perf.Count > 0 && Math.Abs(near.T - f.T) <= 3;
                spikes.Add(new StutterSpike(f.T, Math.Round(f.Ms, 1), found ? near.Cpu : null, found ? near.Gpu : null, found ? near.Ram : null,
                    found ? near.Vram : null, found ? near.Temp : null, (f.Flags & 3) != 0, (f.Flags & 12) != 0));
                if (spikes.Count == 6) break;
            }
            spikes.Sort((a, b) => a.T.CompareTo(b.T));
            stats["typicalFrameTimeMs"] = Math.Round(typical, 1);
            stats["spikeThresholdMs"] = Math.Round(threshold, 1);
            stats["secondsWithSpikes"] = raw.Count;
        }

        var signals = new List<string>();
        if (!hasFrames)
            signals.Add("No frame-time data was recorded for this session (frame-rate capture was off or unavailable), so only system load can be described.");
        if (spikes.Count > 0)
        {
            int Count(Func<StutterSpike, bool> p) => spikes.Count(p);
            var withCpu = Count(s => s.Cpu is not null);
            if (Count(s => s.Cpu >= 85) is var cpuHigh and > 0 && cpuHigh * 2 >= withCpu)
                signals.Add($"CPU load was 85% or more during {cpuHigh} of {spikes.Count} spikes, which points at the processor (game logic, streaming or background work).");
            if (Count(s => s.Gpu >= 95) is var gpuHigh and > 0 && gpuHigh * 2 >= Count(s => s.Gpu is not null))
                signals.Add($"The GPU was at 95% or more during {gpuHigh} of {spikes.Count} spikes, so the graphics card was the limit at those moments.");
            if (Count(s => s.Gpu is < 70) is var gpuIdle and > 0 && gpuIdle * 2 >= Count(s => s.Gpu is not null) && Count(s => s.Gpu is not null) > 0)
                signals.Add($"The GPU was under 70% busy during {gpuIdle} of {spikes.Count} spikes, so it was waiting on something else: shader compilation, loading data from disk, or the CPU.");
            if (Count(s => s.Thermal) is var hot and > 0)
                signals.Add($"The GPU reported thermal throttling during {hot} of {spikes.Count} spikes (it slowed itself down to cool off).");
            if (Count(s => s.Power) is var power and > 0)
                signals.Add($"The GPU hit its power limit during {power} of {spikes.Count} spikes.");
            if (durationSeconds > 600 && Count(s => s.T <= 120) * 2 >= spikes.Count)
                signals.Add("Most spikes happened in the first two minutes, which is typical of shaders being compiled or a level loading.");
            if (spikes.Count >= 3)
            {
                var gaps = spikes.Zip(spikes.Skip(1), (a, b) => b.T - a.T).ToList();
                if (gaps.Max() - gaps.Min() <= 3 && gaps.Average() >= 5)
                    signals.Add($"Spikes repeat about every {Math.Round(gaps.Average())} seconds, which often means a background task waking up on a timer.");
            }
        }
        var vram = perf.Select(p => p.Vram).OfType<double>().ToList();
        if (vram.Count > 0) stats["peakGpuMemoryMb"] = Math.Round(vram.Max());
        var ram = perf.Select(p => p.Ram).OfType<double>().ToList();
        if (ram.Count > 0) stats["peakSystemMemoryUsedMb"] = Math.Round(ram.Max());
        if (N(summary, "throttledSeconds") is >= 30 && !signals.Any(s => s.Contains("thermal", StringComparison.Ordinal)))
            signals.Add($"The GPU throttled for heat for {N(summary, "throttledSeconds")} seconds in this session.");
        if (hasFrames && spikes.Count == 0 && frames.Count >= 5)
            signals.Add("No frame-time spikes stood out: frame pacing was steady across the session.");
        return new StutterAnalysis(hasFrames, stats, spikes, signals);
    }

    private static double? Round(double? d, int digits = 0) => d is { } x ? Math.Round(x, digits) : null;

    internal static double Median(List<double> xs)
    {
        if (xs.Count == 0) return 0;
        xs.Sort();
        return xs.Count % 2 == 1 ? xs[xs.Count / 2] : (xs[xs.Count / 2 - 1] + xs[xs.Count / 2]) / 2;
    }

    public static string Clock(double t)
    {
        var s = (int)Math.Max(0, t);
        return s >= 3600 ? $"{s / 3600}:{s / 60 % 60:00}:{s % 60:00}" : $"{s / 60}:{s % 60:00}";
    }

    public JsonObject ToJson() => new()
    {
        ["frameStats"] = Stats.DeepClone(),
        ["spikes"] = new JsonArray(Spikes.Select(s => (JsonNode)new JsonObject
        {
            ["at"] = Clock(s.T),
            ["frameTimeMs"] = s.Ms,
            ["cpuPercent"] = Round(s.Cpu),
            ["gpuPercent"] = Round(s.Gpu),
            ["gpuTempC"] = Round(s.Temp),
            ["gpuMemoryMb"] = Round(s.Vram),
            ["thermalThrottle"] = s.Thermal,
            ["powerLimit"] = s.Power,
        }).ToArray()),
        ["signals"] = new JsonArray(Signals.Select(x => (JsonNode)JsonValue.Create(x)!).ToArray()),
    };

    public JsonObject ToCard() => new()
    {
        ["kind"] = "stutter",
        ["fpsAvg"] = Stats["fpsAvg"]?.DeepClone(),
        ["fps1Low"] = Stats["fps1Low"]?.DeepClone(),
        ["p99"] = Stats["frameTimeP99Ms"]?.DeepClone(),
        ["stutters"] = Stats["stutterCount"]?.DeepClone(),
        ["spikes"] = new JsonArray(Spikes.Select(s => (JsonNode)new JsonObject { ["at"] = Clock(s.T), ["ms"] = s.Ms }).ToArray()),
        ["signals"] = new JsonArray(Signals.Take(4).Select(x => (JsonNode)JsonValue.Create(x)!).ToArray()),
    };
}

public sealed record StutterSpike(double T, double Ms, double? Cpu, double? Gpu, double? Ram, double? Vram, double? Temp, bool Thermal, bool Power);
