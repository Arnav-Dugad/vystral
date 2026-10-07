namespace Vystral.Core.Health;

// Track X: "something new needs a look" on Home. A background re-check of the library health report is diffed against the
// issues seen last time; a new problem or warning is announced once, ever, and then only lives on the Health page.

/// <summary>What the watcher remembers between checks (ui-state/health-watch.json).</summary>
/// <param name="Known">Issue ids present at the last check.</param>
/// <param name="Announced">Issue ids already shown on Home, with when (ISO 8601). Never shown again while remembered.</param>
/// <param name="Pending">Announced issues the user hasn't dismissed or acted on yet (still present).</param>
/// <param name="Baselined">False until the first check: that check only records what's there, so nothing old nags.</param>
public sealed record HealthWatchState(
    IReadOnlyList<string> Known,
    IReadOnlyDictionary<string, string> Announced,
    IReadOnlyList<string> Pending,
    bool Baselined)
{
    public static readonly HealthWatchState Empty = new([], new Dictionary<string, string>(), [], false);
}

public static class HealthNews
{
    /// <summary>An issue that comes back after this long is treated as new again (a drive unplugged months later).</summary>
    public static readonly TimeSpan ForgetAnnouncedAfter = TimeSpan.FromDays(120);
    public const int MaxIds = 4000;
    public const int MaxPending = 20;

    /// <summary>Only things that stop a game or waste space are worth interrupting Home for; "nice to fix" notes never are.</summary>
    public static bool Worth(HealthIssueDto issue) => issue.Severity is "problem" or "warning";

    /// <summary>
    /// Compares a fresh report with the last one. Returns the next state and the ids announced for the first time now.
    /// Pending issues that are gone (fixed, dismissed on the Health page, drive back) drop out on their own.
    /// </summary>
    public static (HealthWatchState Next, IReadOnlyList<string> Fresh) Diff(IReadOnlyList<HealthIssueDto> issues, HealthWatchState? state, DateTimeOffset now)
    {
        var current = issues.Select(i => i.Id).Distinct(StringComparer.Ordinal).Take(MaxIds).ToList();
        if (state is null || !state.Baselined)
            return (new HealthWatchState(current, new Dictionary<string, string>(StringComparer.Ordinal), [], true), []);

        var known = state.Known.ToHashSet(StringComparer.Ordinal);
        var announced = state.Announced
            .Where(p => !DateTimeOffset.TryParse(p.Value, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var at)
                        || now - at < ForgetAnnouncedAfter)
            .ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal);

        var fresh = issues.Where(i => Worth(i) && !known.Contains(i.Id) && !announced.ContainsKey(i.Id))
            .Select(i => i.Id).Distinct(StringComparer.Ordinal).ToList();
        foreach (var id in fresh) announced[id] = now.ToString("O");
        while (announced.Count > MaxIds)
            announced.Remove(announced.OrderBy(p => p.Value, StringComparer.Ordinal).First().Key);

        var present = current.ToHashSet(StringComparer.Ordinal);
        var pending = state.Pending.Where(present.Contains).Concat(fresh).Distinct(StringComparer.Ordinal).ToList();
        pending = Order(pending, issues).Take(MaxPending).Select(i => i.Id).ToList();
        return (new HealthWatchState(current, announced, pending, true), fresh);
    }

    /// <summary>The user dismissed the card, opened the Health page or used the fix: those ids stop being pending (they stay announced).</summary>
    public static HealthWatchState Acknowledge(HealthWatchState state, IEnumerable<string> ids)
    {
        var drop = ids.ToHashSet(StringComparer.Ordinal);
        return state with { Pending = state.Pending.Where(id => !drop.Contains(id)).ToList() };
    }

    /// <summary>Pending issues as DTOs, most serious first, then in the report's own order.</summary>
    public static IReadOnlyList<HealthIssueDto> Order(IEnumerable<string> pending, IReadOnlyList<HealthIssueDto> issues)
    {
        var wanted = pending.ToHashSet(StringComparer.Ordinal);
        return issues.Select((issue, index) => (issue, index))
            .Where(x => wanted.Contains(x.issue.Id))
            .OrderBy(x => x.issue.Severity == "problem" ? 0 : x.issue.Severity == "warning" ? 1 : 2)
            .ThenBy(x => x.index)
            .Select(x => x.issue)
            .ToList();
    }
}
