namespace Vystral.Core.Subscriptions;

/// <summary>A finished session as the value card sees it.</summary>
public sealed record ValueSession(string GameId, string Source, DateTimeOffset Start, int DurationSeconds);

/// <summary>Time this month that one plan accounts for (a game in two plans counts in both rows, once in the total).</summary>
public sealed record PlanHours(string Plan, long Seconds, int Games);

public sealed record ValueResult(long Seconds, int Games, int Sessions, IReadOnlyList<PlanHours> Plans, IReadOnlyList<(string GameId, long Seconds)> Top,
    double? CostPerHour, string? CostNote);

/// <summary>
/// Track V: the subscription value card's numbers, from sessions VYSTRAL observed this month. A session counts when
/// its game is in one of the user's plans (as matched from the public lists), when it was an Xbox Cloud Gaming stream
/// and the Game Pass tier includes cloud, or when it was a GeForce NOW stream and the user has a membership. Cost per
/// hour is only shown when the user typed what they pay, and only once there's at least an hour to divide by.
/// </summary>
public static class SubscriptionValue
{
    public const string GeForceNowRow = "geforce-now";
    public const long MinSecondsForCost = 3600;

    public static ValueResult Compute(IEnumerable<ValueSession> sessions, IReadOnlyDictionary<string, IReadOnlyList<string>> gamePlans,
        IReadOnlyList<string> plans, bool gfnMember, DateTimeOffset monthStart, DateTimeOffset now, double price)
    {
        var gamePass = SubscriptionPlans.GamePassTier(plans);
        var cloudPlan = gamePass is not null && SubscriptionPlans.IncludesXboxCloud(gamePass) ? gamePass : null;
        var perGame = new Dictionary<string, long>(StringComparer.Ordinal);
        var perPlan = new Dictionary<string, (long Seconds, HashSet<string> Games)>(StringComparer.Ordinal);
        var counted = 0;
        foreach (var s in sessions)
        {
            var start = s.Start < monthStart ? monthStart : s.Start;
            var end = s.Start.AddSeconds(Math.Max(0, s.DurationSeconds));
            if (end > now) end = now;
            var seconds = (long)Math.Max(0, (end - start).TotalSeconds);
            if (seconds <= 0) continue;

            var rows = new List<string>();
            if (gamePlans.TryGetValue(s.GameId, out var inPlans)) rows.AddRange(inPlans.Where(plans.Contains));
            if (s.Source == Domain.SessionSources.CloudXbox && cloudPlan is not null && !rows.Contains(cloudPlan)) rows.Add(cloudPlan);
            if (s.Source == Domain.SessionSources.CloudGfn && gfnMember) rows.Add(GeForceNowRow);
            if (rows.Count == 0) continue;

            counted++;
            perGame[s.GameId] = perGame.GetValueOrDefault(s.GameId) + seconds;
            foreach (var row in rows.Distinct())
            {
                var (secs, games) = perPlan.TryGetValue(row, out var v) ? v : (0, new HashSet<string>(StringComparer.Ordinal));
                games.Add(s.GameId);
                perPlan[row] = (secs + seconds, games);
            }
        }
        var total = perGame.Values.Sum();
        double? cost = null;
        string? note = null;
        if (price > 0)
        {
            if (total >= MinSecondsForCost) cost = Math.Round(price / (total / 3600.0), 2);
            else note = total == 0 ? "none" : "underHour";
        }
        var order = plans.Append(GeForceNowRow).ToList();
        return new ValueResult(total, perGame.Count, counted,
            perPlan.OrderBy(p => order.IndexOf(p.Key)).Select(p => new PlanHours(p.Key, p.Value.Seconds, p.Value.Games.Count)).ToList(),
            perGame.OrderByDescending(p => p.Value).ThenBy(p => p.Key, StringComparer.Ordinal).Take(3).Select(p => (p.Key, p.Value)).ToList(),
            cost, note);
    }

    /// <summary>The first instant of the calendar month <paramref name="now"/> falls in, in <paramref name="zone"/>.</summary>
    public static DateTimeOffset MonthStart(DateTimeOffset now, TimeZoneInfo zone)
    {
        var local = TimeZoneInfo.ConvertTime(now, zone);
        var first = new DateTime(local.Year, local.Month, 1, 0, 0, 0, DateTimeKind.Unspecified);
        return new DateTimeOffset(first, zone.GetUtcOffset(first));
    }
}
