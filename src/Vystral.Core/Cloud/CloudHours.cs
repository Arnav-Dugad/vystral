namespace Vystral.Core.Cloud;

/// <summary>
/// GeForce NOW membership limits, as published. Kept in one small table with the date and sources so they can be
/// updated when NVIDIA changes them; VYSTRAL never claims "unlimited".
/// Sources (checked 2026-10-05): https://www.nvidia.com/en-us/geforce-now/faq/ (100 hours a month for Performance and
/// Ultimate from 2026-01-01, up to 15 unused hours roll over) and https://www.nvidia.com/en-us/geforce-now/memberships/
/// (session length: Free 1 h, Performance 6 h, Ultimate 8 h; reported by several secondary sources).
/// </summary>
public sealed record GfnPlan(string Id, string Label, int? SessionHours, int? MonthlyHours, int RolloverHours, string Note)
{
    public const string AsOf = "2026-10-05";

    public static readonly IReadOnlyList<GfnPlan> All =
    [
        new("none", "Not a member", null, null, 0, "Pick your membership to see session and monthly limits."),
        new("free", "Free", 1, null, 0, "Sessions end after 1 hour. There may be a queue at busy times."),
        new("performance", "Performance", 6, 100, 15, "100 hours a month, up to 15 unused hours roll over, sessions up to 6 hours."),
        new("ultimate", "Ultimate", 8, 100, 15, "100 hours a month, up to 15 unused hours roll over, sessions up to 8 hours."),
        new("daypass", "Day pass", null, null, 0, "A day pass lasts 24 hours from purchase. Session length follows the pass’s tier."),
    ];

    public static GfnPlan For(string? id) => All.FirstOrDefault(p => p.Id == id) ?? All[0];
}

/// <summary>One finished or running cloud session, as the meter needs it.</summary>
public readonly record struct CloudSpan(DateTimeOffset Start, DateTimeOffset End);

/// <summary>
/// The hours meter. <see cref="Level"/>: "none" (no monthly limit for this plan), "ok", "near" (80% or more used)
/// or "reached". Everything is an estimate from sessions VYSTRAL saw: play on other devices isn't counted.
/// </summary>
public sealed record CloudMeter(
    string Plan, string PlanLabel, DateTimeOffset CycleStart, DateTimeOffset NextReset, long UsedSeconds, long? LimitSeconds, long? LeftSeconds,
    double? Fraction, string Level, int RolloverHours, long? SessionLimitSeconds, long? SessionElapsedSeconds, long? SessionLeftSeconds, string SessionLevel, int Sessions);

public static class CloudHours
{
    public const double NearFraction = 0.8;
    /// <summary>A running session is "near" its end with this much time left.</summary>
    public static readonly TimeSpan SessionNear = TimeSpan.FromMinutes(15);

    /// <summary>
    /// The start of the current cycle: the most recent reset day (clamped to the month's length, so 31 means
    /// "the last day" in short months) at local midnight, on or before <paramref name="now"/>.
    /// </summary>
    public static DateTimeOffset CycleStart(DateTimeOffset now, int resetDay, TimeZoneInfo tz)
    {
        resetDay = Math.Clamp(resetDay, 1, 31);
        var local = TimeZoneInfo.ConvertTime(now, tz);
        var date = new DateOnly(local.Year, local.Month, Math.Min(resetDay, DateTime.DaysInMonth(local.Year, local.Month)));
        if (date > DateOnly.FromDateTime(local.DateTime))
        {
            var prev = new DateOnly(local.Year, local.Month, 1).AddMonths(-1);
            date = new DateOnly(prev.Year, prev.Month, Math.Min(resetDay, DateTime.DaysInMonth(prev.Year, prev.Month)));
        }
        return AtMidnight(date, tz);
    }

    /// <summary>The next reset after <paramref name="cycleStart"/>.</summary>
    public static DateTimeOffset NextReset(DateTimeOffset cycleStart, int resetDay, TimeZoneInfo tz)
    {
        resetDay = Math.Clamp(resetDay, 1, 31);
        var local = TimeZoneInfo.ConvertTime(cycleStart, tz);
        var next = new DateOnly(local.Year, local.Month, 1).AddMonths(1);
        return AtMidnight(new DateOnly(next.Year, next.Month, Math.Min(resetDay, DateTime.DaysInMonth(next.Year, next.Month))), tz);
    }

    /// <summary>Seconds of <paramref name="spans"/> that fall between <paramref name="from"/> and <paramref name="to"/> (overlaps are counted once per span).</summary>
    public static long SecondsIn(IEnumerable<CloudSpan> spans, DateTimeOffset from, DateTimeOffset to)
    {
        long total = 0;
        foreach (var s in spans)
        {
            var a = s.Start > from ? s.Start : from;
            var b = s.End < to ? s.End : to;
            if (b > a) total += (long)(b - a).TotalSeconds;
        }
        return total;
    }

    public static CloudMeter Compute(string? planId, int resetDay, DateTimeOffset now, TimeZoneInfo tz, IReadOnlyList<CloudSpan> finished, DateTimeOffset? runningSince)
    {
        var plan = GfnPlan.For(planId);
        var start = CycleStart(now, resetDay, tz);
        var spans = runningSince is { } r && r < now ? finished.Append(new CloudSpan(r, now)) : finished;
        var used = SecondsIn(spans, start, now);
        var sessions = spans.Count(s => s.End > start);
        long? limit = plan.MonthlyHours is { } h ? h * 3600L : null;
        long? left = limit is { } l ? Math.Max(0, l - used) : null;
        double? fraction = limit is { } lim && lim > 0 ? Math.Min(1, used / (double)lim) : null;
        var level = fraction switch
        {
            null => "none",
            >= 1 => "reached",
            >= NearFraction => "near",
            _ => "ok",
        };

        long? sessionLimit = plan.SessionHours is { } sh ? sh * 3600L : null;
        long? elapsed = runningSince is { } since && since <= now ? (long)(now - since).TotalSeconds : null;
        long? sessionLeft = sessionLimit is { } sl && elapsed is { } e ? Math.Max(0, sl - e) : null;
        var sessionLevel = sessionLeft switch
        {
            null => "none",
            0 => "reached",
            var x when x <= (long)SessionNear.TotalSeconds => "near",
            _ => "ok",
        };
        return new CloudMeter(plan.Id, plan.Label, start, NextReset(start, resetDay, tz), used, limit, left, fraction, level, plan.RolloverHours,
            sessionLimit, elapsed, sessionLeft, sessionLevel, sessions);
    }

    private static DateTimeOffset AtMidnight(DateOnly date, TimeZoneInfo tz)
    {
        var dt = date.ToDateTime(TimeOnly.MinValue, DateTimeKind.Unspecified);
        // A midnight skipped by a DST change becomes the first valid minute after it.
        while (tz.IsInvalidTime(dt)) dt = dt.AddMinutes(30);
        return new DateTimeOffset(dt, tz.GetUtcOffset(dt));
    }
}
