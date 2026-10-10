using System.Globalization;

namespace Vystral.Core.Health;

/// <summary>
/// One start of VYSTRAL. <see cref="Outcome"/>: "pending" (started, not yet steady), "ok" (the interface was ready and
/// VYSTRAL stayed up), "failed" (it never got there: found still pending at the next start), "unexpected" (it was
/// steady, but didn't close cleanly — a crash, a forced end or a power cut).
/// </summary>
public sealed record StartRecord(string At, string Version, string Outcome);

/// <summary>Something worth showing in the history: a failed start, an unexpected close, a rollback or a failed self-check.</summary>
public sealed record StreakIncident(string At, string Kind, string Version, string Text);

public sealed record StreakDay(string Day, int Starts, int Failed, int Unexpected);

/// <summary>The About page's streak card.</summary>
public sealed record StreakSummary(
    int Days, string? Since, bool SinceHistoryBegan, int StartsCounted, int FailedStarts, int UnexpectedCloses,
    StreakIncident? LastIncident, IReadOnlyList<StreakIncident> Incidents, IReadOnlyList<StreakDay> Recent);

/// <summary>
/// Track D6: the crash-free streak. Pure: the caller supplies the start history (written by the app around
/// <c>StartupProtection</c>'s success rule), the self-check reports and the last rollback, and the clock.
/// The streak counts whole local days since the last failed start, or since the history began when there was none
/// (said so, never implied to be longer).
/// </summary>
public static class StartStreak
{
    public const int MaxRecords = 200;
    public const int RecentDays = 30;
    public const int MaxIncidents = 8;

    public const string Pending = "pending", Ok = "ok", Failed = "failed", Unexpected = "unexpected";

    /// <summary>At start: any start still pending never became steady, so it failed; then this start is added as pending.</summary>
    public static List<StartRecord> BeginStart(IEnumerable<StartRecord> history, string version, DateTimeOffset now, bool previousClosedUncleanly)
    {
        var list = Clean(history).ToList();
        for (var i = 0; i < list.Count; i++)
            if (list[i].Outcome == Pending) list[i] = list[i] with { Outcome = Failed };
        // The crash marker: the previous run was steady but never ran its clean-exit path.
        if (previousClosedUncleanly && list.Count > 0 && list[^1].Outcome == Ok) list[^1] = list[^1] with { Outcome = Unexpected };
        list.Add(new StartRecord(now.ToString("O", CultureInfo.InvariantCulture), Ver(version), Pending));
        return Trim(list);
    }

    /// <summary>The newest pending start became steady (the same moment <c>StartupProtection.MarkSucceeded</c> runs).</summary>
    public static List<StartRecord> MarkSteady(IEnumerable<StartRecord> history)
    {
        var list = Clean(history).ToList();
        for (var i = list.Count - 1; i >= 0; i--)
            if (list[i].Outcome == Pending) { list[i] = list[i] with { Outcome = Ok }; break; }
        return list;
    }

    /// <summary>A clean exit after the interface was ready is a good start even if it was shorter than the steady delay.</summary>
    public static List<StartRecord> MarkCleanExit(IEnumerable<StartRecord> history, bool uiReady)
    {
        var list = Clean(history).ToList();
        if (uiReady && list.Count > 0 && list[^1].Outcome == Pending) list[^1] = list[^1] with { Outcome = Ok };
        return list;
    }

    public static StreakSummary Summarize(IEnumerable<StartRecord> history, IEnumerable<StreakIncident> otherIncidents, DateTimeOffset now, TimeZoneInfo zone)
    {
        var starts = Clean(history).Select(r => (Rec: r, At: Parse(r.At))).Where(x => x.At is not null).Select(x => (x.Rec, At: x.At!.Value)).OrderBy(x => x.At).ToList();
        var incidents = new List<StreakIncident>();
        foreach (var (r, at) in starts)
        {
            if (r.Outcome == Failed) incidents.Add(new StreakIncident(r.At, "failedStart", r.Version, $"VYSTRAL {r.Version} didn’t finish starting"));
            else if (r.Outcome == Unexpected) incidents.Add(new StreakIncident(r.At, "unexpectedClose", r.Version, $"VYSTRAL {r.Version} closed unexpectedly"));
        }
        foreach (var i in otherIncidents ?? [])
            if (i is not null && Parse(i.At) is { } t && t <= now) incidents.Add(i with { Text = Clip(i.Text) });
        incidents = incidents.OrderByDescending(i => Parse(i.At)).ToList();

        var lastFailure = starts.LastOrDefault(x => x.Rec.Outcome == Failed);
        var today = Local(now, zone);
        DateOnly? sinceDay = lastFailure.Rec is not null ? Local(lastFailure.At, zone) : starts.Count > 0 ? Local(starts[0].At, zone) : null;
        var days = sinceDay is { } d ? Math.Max(0, today.DayNumber - d.DayNumber) : 0;

        var recent = new List<StreakDay>(RecentDays);
        for (var i = RecentDays - 1; i >= 0; i--)
        {
            var day = today.AddDays(-i);
            var on = starts.Where(x => Local(x.At, zone) == day).ToList();
            recent.Add(new StreakDay(day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), on.Count, on.Count(x => x.Rec.Outcome == Failed), on.Count(x => x.Rec.Outcome == Unexpected)));
        }

        return new StreakSummary(
            days,
            sinceDay?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            lastFailure.Rec is null,
            starts.Count(x => x.Rec.Outcome != Pending),
            starts.Count(x => x.Rec.Outcome == Failed),
            starts.Count(x => x.Rec.Outcome == Unexpected),
            incidents.FirstOrDefault(),
            incidents.Take(MaxIncidents).ToList(),
            recent);
    }

    private static IEnumerable<StartRecord> Clean(IEnumerable<StartRecord>? history) =>
        (history ?? []).Where(r => r is not null && Parse(r.At) is not null && r.Outcome is Pending or Ok or Failed or Unexpected)
            .Select(r => r with { Version = Ver(r.Version) });

    private static List<StartRecord> Trim(List<StartRecord> list) => list.Count <= MaxRecords ? list : list.Skip(list.Count - MaxRecords).ToList();

    private static string Ver(string? v) => v is { Length: > 0 and <= 32 } && v.All(c => char.IsAsciiDigit(c) || c is '.' or '-' || char.IsAsciiLetter(c)) ? v : "?";

    private static string Clip(string? t) => string.IsNullOrWhiteSpace(t) ? "" : t.Length <= 160 ? t : t[..159] + "…";

    private static DateTimeOffset? Parse(string? s) =>
        s is { Length: <= 40 } && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var t) ? t : null;

    private static DateOnly Local(DateTimeOffset t, TimeZoneInfo zone) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(t, zone).DateTime);
}
