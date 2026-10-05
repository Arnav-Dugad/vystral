namespace Vystral.Windows.Services.Rollback;

/// <summary>A version VYSTRAL won't update to again, because it didn't start on this PC.</summary>
public sealed record BlockedVersion(string Version, string At, string Reason);

/// <summary>The last automatic rollback, kept so the version we returned to can explain it once.</summary>
public sealed record RollbackRecord(string From, string To, string At, bool Notified = false);

/// <summary>
/// Everything the startup guard remembers between runs (update/startup.json in the data folder).
/// Written very early in every start, before the interface exists, so it must stay tiny.
/// </summary>
public sealed record StartupLedger
{
    /// <summary>The version the counters below describe.</summary>
    public string? Version { get; init; }
    /// <summary>A start of <see cref="Version"/> began and hasn't yet been confirmed or ended cleanly.</summary>
    public bool Pending { get; init; }
    /// <summary>Starts of <see cref="Version"/> in a row that never reached "started successfully".</summary>
    public int ConsecutiveFailures { get; init; }
    /// <summary>This version has started successfully at least once since it was installed.</summary>
    public bool EverSucceeded { get; init; }
    /// <summary>The most recent other version that started successfully: the rollback target.</summary>
    public string? LastGoodVersion { get; init; }
    public IReadOnlyList<BlockedVersion> Blocked { get; init; } = [];
    /// <summary>Versions VYSTRAL already rolled back from once. Never twice: no loops.</summary>
    public IReadOnlyList<string> RolledBackFrom { get; init; } = [];
    public RollbackRecord? LastRollback { get; init; }
}

/// <summary>What the process should do right after Velopack's startup hooks.</summary>
public enum StartAction { Proceed, RollBack }

public sealed record StartContext(
    string? CurrentVersion,
    bool IsInstalled,
    bool SafeMode,
    /// <summary>The version of the preserved previous package (already verified on disk), if any.</summary>
    string? PreservedVersion,
    DateTimeOffset Now);

public sealed record StartDecision(StartAction Action, string Reason, string? TargetVersion = null);

/// <summary>
/// The silent-rollback state machine, kept pure so every path is unit-tested.
///
/// A start "succeeds" when the interface reports ready and keeps running for
/// <see cref="SuccessDelay"/>. A start that never got there (a crash, a hang the user killed,
/// a WebView that never loaded) is a failure, discovered at the next start. When a version that
/// has never started successfully fails twice in a row, its third start rolls back to the last
/// version that did start (its package was preserved before the update downloaded), and that
/// version is skipped by automatic updates until a newer one is released.
///
/// Never in development or portable builds, never in safe mode, at most once per version.
/// </summary>
public static class StartupGuard
{
    public const int FailuresBeforeRollback = 2;
    public static readonly TimeSpan SuccessDelay = TimeSpan.FromSeconds(20);
    private const int MaxBlocked = 8;
    private const int MaxRolledBack = 16;

    public static (StartupLedger Next, StartDecision Decision) OnStart(StartupLedger ledger, StartContext ctx)
    {
        if (!ctx.IsInstalled || ctx.CurrentVersion is null)
            return (ledger, new StartDecision(StartAction.Proceed, "notInstalled"));
        // Safe mode is the user's own recovery path: it neither counts as an attempt nor rolls back.
        if (ctx.SafeMode)
            return (ledger, new StartDecision(StartAction.Proceed, "safeMode"));

        var current = ctx.CurrentVersion;
        var next = ledger;
        if (!SameVersion(ledger.Version, current))
        {
            // A different version is starting: the one we came from is the rollback target if it ever worked.
            var lastGood = ledger.Version is not null && ledger.EverSucceeded ? ledger.Version : ledger.LastGoodVersion;
            if (lastGood is not null && SameVersion(lastGood, current)) lastGood = null;
            next = ledger with
            {
                Version = current,
                Pending = false,
                ConsecutiveFailures = 0,
                EverSucceeded = false,
                LastGoodVersion = lastGood,
            };
        }
        else if (ledger.LastRollback is { Notified: false } pendingRollback && SameVersion(pendingRollback.From, current))
        {
            // The last start of this version decided to roll back, yet this version is starting again:
            // the apply didn't happen (Update.exe failed and restarted it). Run it normally; never retry.
            next = OnRollbackFailed(ledger, current) with { Pending = false };
        }
        else if (ledger.Pending)
        {
            // The previous start of this version never confirmed success: it failed.
            next = ledger with { ConsecutiveFailures = ledger.ConsecutiveFailures + 1, Pending = false };
        }

        var reason = RollbackBlocker(next, ctx);
        if (reason is null)
        {
            var target = next.LastGoodVersion!;
            var at = ctx.Now.ToString("O");
            next = next with
            {
                Pending = false,
                Blocked = [.. next.Blocked.Where(b => !SameVersion(b.Version, current)).TakeLast(MaxBlocked - 1),
                           new BlockedVersion(current, at, $"Didn't start correctly {next.ConsecutiveFailures} times in a row")],
                RolledBackFrom = [.. next.RolledBackFrom.TakeLast(MaxRolledBack - 1), current],
                LastRollback = new RollbackRecord(current, target, at),
            };
            return (next, new StartDecision(StartAction.RollBack, "failedStarts", target));
        }

        return (next with { Pending = true }, new StartDecision(StartAction.Proceed, reason));
    }

    /// <summary>Why this start doesn't roll back (null when it should).</summary>
    internal static string? RollbackBlocker(StartupLedger l, StartContext ctx)
    {
        var current = ctx.CurrentVersion!;
        if (l.ConsecutiveFailures < FailuresBeforeRollback) return "healthy";
        if (l.EverSucceeded) return "startedBefore"; // it worked before: not the update's fault
        if (l.RolledBackFrom.Any(v => SameVersion(v, current))) return "alreadyRolledBack";
        if (l.LastGoodVersion is null) return "noKnownGoodVersion";
        if (AppVersion.Compare(l.LastGoodVersion, current) >= 0) return "notADowngrade";
        if (ctx.PreservedVersion is null) return "noPreservedPackage";
        if (!SameVersion(ctx.PreservedVersion, l.LastGoodVersion)) return "preservedPackageMismatch";
        return null;
    }

    /// <summary>The interface reported ready and stayed up for <see cref="SuccessDelay"/>.</summary>
    public static StartupLedger OnStartSucceeded(StartupLedger l, string? currentVersion) =>
        currentVersion is null || !SameVersion(l.Version, currentVersion) ? l : l with { Pending = false, ConsecutiveFailures = 0, EverSucceeded = true };

    /// <summary>
    /// VYSTRAL closed normally. After the interface was ready that isn't a failed start (it is
    /// just not proof of success either); before it, the start never worked, so it stays pending.
    /// </summary>
    public static StartupLedger OnCleanExit(StartupLedger l, string? currentVersion, bool uiWasReady) =>
        uiWasReady && currentVersion is not null && SameVersion(l.Version, currentVersion) ? l with { Pending = false } : l;

    /// <summary>The rollback couldn't be applied: start this version normally, and don't try again for it.</summary>
    public static StartupLedger OnRollbackFailed(StartupLedger l, string current) => l with
    {
        Pending = true,
        LastRollback = null,
        Blocked = [.. l.Blocked.Where(b => !SameVersion(b.Version, current))],
    };

    /// <summary>The notice the version we returned to should show once, if any.</summary>
    public static RollbackRecord? PendingNotice(StartupLedger l, string? currentVersion) =>
        l.LastRollback is { Notified: false } r && currentVersion is not null && SameVersion(r.To, currentVersion) ? r : null;

    public static StartupLedger MarkNoticeShown(StartupLedger l) =>
        l.LastRollback is { } r ? l with { LastRollback = r with { Notified = true } } : l;

    /// <summary>Automatic updates skip a blocked version (a newer release is offered normally).</summary>
    public static bool IsBlocked(StartupLedger l, string version) => l.Blocked.Any(b => SameVersion(b.Version, version));

    private static bool SameVersion(string? a, string? b) => a is not null && b is not null && AppVersion.Compare(a, b) == 0;
}

/// <summary>Minimal SemVer ordering (major.minor.patch, a pre-release sorts before its release).</summary>
public static class AppVersion
{
    public static int Compare(string a, string b)
    {
        var (na, pa) = Parse(a);
        var (nb, pb) = Parse(b);
        for (var i = 0; i < 3; i++)
        {
            var c = na[i].CompareTo(nb[i]);
            if (c != 0) return c;
        }
        if (pa == pb) return 0;
        if (pa is null) return 1;
        if (pb is null) return -1;
        return string.CompareOrdinal(pa, pb);
    }

    public static bool IsValid(string? v) => v is not null && v.Length <= 40 &&
        System.Text.RegularExpressions.Regex.IsMatch(v, @"^\d{1,5}\.\d{1,5}\.\d{1,5}(-[0-9A-Za-z.\-]{1,24})?\z");

    private static (int[] Numbers, string? Pre) Parse(string v)
    {
        var plus = v.IndexOf('+');
        if (plus >= 0) v = v[..plus];
        var dash = v.IndexOf('-');
        var pre = dash >= 0 ? v[(dash + 1)..] : null;
        var core = (dash >= 0 ? v[..dash] : v).Split('.');
        var n = new int[3];
        for (var i = 0; i < 3 && i < core.Length; i++) int.TryParse(core[i], out n[i]);
        return (n, string.IsNullOrEmpty(pre) ? null : pre);
    }
}
