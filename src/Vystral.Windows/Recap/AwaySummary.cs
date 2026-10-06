using System.Text.Json;
using Vystral.Core.Data;
using Vystral.Core.Domain;

namespace Vystral.Windows.Recap;

// ---------- Bridge DTOs (camelCase; mirrored in ui/src/bridge/types.recap.ts) ----------

public sealed record RecapPerfDto(double? FpsAvg, double? Fps1Low, double? PeakTempC, double? GpuAvg, double? CpuAvg, bool HasMetrics);

public sealed record AwaySessionDto(string Id, string GameId, string Title, string Source, string Start, string End, int DurationSeconds, RecapPerfDto Perf);

public sealed record AwayGameDto(string GameId, string Title, int Sessions, int Seconds, string LastEnd);

public sealed record RecapAchievementDto(string GameId, string SessionId, string ApiName, string Name, string? Description, string UnlockedAt,
    double? GlobalPercent, string? Icon);

/// <summary>
/// "While you were away": sessions VYSTRAL noticed without launching them (background tracker while it was
/// closed, or detected while it was open) that ended after the user last opened Home.
/// </summary>
public sealed record AwaySummaryDto(
    string Since, string Until, int TotalSeconds, IReadOnlyList<AwayGameDto> Games, IReadOnlyList<AwaySessionDto> Sessions,
    AwaySessionDto? Best, AwaySessionDto? BestFps, IReadOnlyList<RecapAchievementDto> Achievements,
    // Steam games among them whose achievements were never fetched (so unlocks can't be shown).
    int GamesWithoutAchievementData);

/// <summary>Pure "away" logic (unit-tested): which sessions count and how they are summarised.</summary>
public static class AwaySummary
{
    /// <summary>Sessions shorter than this are left out (the detector already drops ones under a minute).</summary>
    public const int MinSeconds = 60;

    /// <summary>Unlocks reported a little after the session ended still belong to it (Steam's clock vs ours).</summary>
    public static readonly TimeSpan UnlockSlack = TimeSpan.FromMinutes(2);

    public static readonly string[] Sources = [SessionSources.Background, SessionSources.Detected];

    /// <summary>The sessions that count: noticed (not launched) by VYSTRAL, ended in (since, until], at least a minute long.</summary>
    public static IReadOnlyList<RecapSessionRow> Select(IEnumerable<RecapSessionRow> rows, DateTimeOffset since, DateTimeOffset until) =>
        rows.Where(r => Sources.Contains(r.Source) && r.End > since && r.End <= until && r.DurationSeconds >= MinSeconds)
            .GroupBy(r => r.Id).Select(g => g.First())
            .OrderByDescending(r => r.Start).ToList();

    public static AwaySummaryDto? Build(IEnumerable<RecapSessionRow> rows, DateTimeOffset since, DateTimeOffset until,
        Func<RecapSessionRow, IReadOnlyList<RecapAchievementDto>> unlocks, Func<string, bool> achievementDataKnown)
    {
        var sessions = Select(rows, since, until);
        if (sessions.Count == 0) return null;
        var dtos = sessions.Select(ToDto).ToList();
        var games = sessions.GroupBy(s => s.GameId)
            .Select(g => new AwayGameDto(g.Key, g.First().Title, g.Count(), g.Sum(s => s.DurationSeconds), g.Max(s => s.End).ToString("O")))
            .OrderByDescending(g => g.Seconds).ThenBy(g => g.Title, StringComparer.CurrentCulture).ToList();
        var best = dtos.OrderByDescending(d => d.DurationSeconds).ThenByDescending(d => d.Start, StringComparer.Ordinal).First();
        var bestFps = dtos.Where(d => d.Perf.FpsAvg is not null).OrderByDescending(d => d.Perf.FpsAvg).FirstOrDefault();
        var achievements = sessions.SelectMany(unlocks).DistinctBy(a => (a.GameId, a.ApiName))
            .OrderByDescending(a => a.UnlockedAt, StringComparer.Ordinal).ToList();
        var unknown = sessions.Where(s => s.SteamAppId is not null).Select(s => s.SteamAppId!).Distinct().Count(a => !achievementDataKnown(a));
        return new AwaySummaryDto(since.ToString("O"), until.ToString("O"), sessions.Sum(s => s.DurationSeconds), games, dtos, best, bestFps, achievements, unknown);
    }

    public static AwaySessionDto ToDto(RecapSessionRow r) =>
        new(r.Id, r.GameId, r.Title, r.Source, r.Start.ToString("O"), r.End.ToString("O"), r.DurationSeconds, ParsePerf(r.PerfSummaryJson));

    /// <summary>Reads the few numbers a recap shows from a stored perf summary; anything malformed counts as missing.</summary>
    public static RecapPerfDto ParsePerf(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new RecapPerfDto(null, null, null, null, null, false);
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 8 });
            var o = doc.RootElement;
            if (o.ValueKind != JsonValueKind.Object) return new RecapPerfDto(null, null, null, null, null, false);
            double? N(string name, double max) =>
                o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) && double.IsFinite(d) && d >= 0 && d <= max
                    ? Math.Round(d, 1) : null;
            var peak = N("peakTempC", 150) ?? N("gpuTempMaxC", 150);
            return new RecapPerfDto(N("fpsAvg", 2000), N("fps1Low", 2000), peak, N("gpuAvg", 100), N("cpuAvg", 100), true);
        }
        catch (JsonException)
        {
            return new RecapPerfDto(null, null, null, null, null, false);
        }
    }

    /// <summary>Parses the stored "last seen" marker; anything unreadable or in the future is treated as missing.</summary>
    public static DateTimeOffset? ParseSeen(string? raw, DateTimeOffset now) =>
        raw is not null && DateTimeOffset.TryParse(raw, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var at) &&
        at <= now.AddMinutes(5) ? at : null;
}
