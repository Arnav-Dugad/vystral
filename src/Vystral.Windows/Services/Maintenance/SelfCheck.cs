using System.Text.Json;
using System.Text.Json.Serialization;
using Vystral.Windows.Services.Rollback;

namespace Vystral.Windows.Services.Maintenance;

[JsonConverter(typeof(JsonStringEnumConverter<CheckOutcome>))]
public enum CheckOutcome { Passed, Failed, Skipped }

/// <summary>One health check after an update.</summary>
/// <param name="CountsTowardRollback">
/// Only failures that a previous version would plausibly not have (the interface can't talk to VYSTRAL,
/// settings can't be read) count as a failed start. Data and environment problems (a damaged database,
/// an unreadable artwork folder) are reported but never roll back: going back a version wouldn't fix them.
/// </param>
public sealed record SelfCheckItem(string Id, string Label, CheckOutcome Outcome, string Detail, bool CountsTowardRollback);

public sealed record SelfCheckReport(string Version, string At, bool Manual, IReadOnlyList<SelfCheckItem> Checks)
{
    public int Passed => Checks.Count(c => c.Outcome == CheckOutcome.Passed);
    public int Total => Checks.Count;
    /// <summary>A real failure that makes this start count as a failed start (never a timeout or a skipped check).</summary>
    public bool HardFailure => !Manual && Checks.Any(c => c.Outcome == CheckOutcome.Failed && c.CountsTowardRollback);
}

/// <summary>What <c>update/self-check.json</c> remembers: the latest reports, newest last.</summary>
public sealed record SelfCheckState
{
    public IReadOnlyList<SelfCheckReport> Reports { get; init; } = [];
}

/// <summary>When the after-update check runs. Pure, so every rule is unit-tested.</summary>
public static class SelfCheckPolicy
{
    /// <summary>A version that keeps failing is checked again on each start, up to this many times.</summary>
    public const int MaxAutomaticRunsPerVersion = 5;
    public const int MaxReports = 8;

    /// <summary>
    /// On the first start of a version (a new install counts), and again on later starts of the same version
    /// while its last automatic check had a real failure, so a version that keeps failing can still be rolled back.
    /// </summary>
    public static bool ShouldRun(SelfCheckState state, string version)
    {
        var mine = state.Reports.Where(r => !r.Manual && SameVersion(r.Version, version)).ToList();
        if (mine.Count == 0) return true;
        if (mine.Count >= MaxAutomaticRunsPerVersion) return false;
        return mine[^1].Checks.Any(c => c.Outcome == CheckOutcome.Failed && c.CountsTowardRollback);
    }

    public static SelfCheckState Add(SelfCheckState state, SelfCheckReport report) =>
        state with { Reports = [.. state.Reports.TakeLast(MaxReports - 1), report] };

    /// <summary>The report Settings shows: the newest one for the running version, else the newest overall.</summary>
    public static SelfCheckReport? Latest(SelfCheckState state, string version) =>
        state.Reports.LastOrDefault(r => SameVersion(r.Version, version)) ?? state.Reports.LastOrDefault();

    private static bool SameVersion(string a, string b) =>
        AppVersion.IsValid(a) && AppVersion.IsValid(b) ? AppVersion.Compare(a, b) == 0 : string.Equals(a, b, StringComparison.Ordinal);
}

/// <summary>Everything the checks look at, behind an interface so the outcomes are testable without a real PC.</summary>
public interface ISelfCheckProbes
{
    /// <summary>Null when the database opened and migrated normally, else the startup problem shown to the user.</summary>
    string? DatabaseStartupProblem { get; }
    int SchemaVersion();
    int LatestSchemaVersion { get; }
    /// <summary>"ok" when healthy.</summary>
    string QuickCheck();
    /// <summary>Reads one cached file (if any) and writes and removes a probe file. Throws on IO or access problems.</summary>
    void ProbeArtCache();
    /// <summary>Loads every setting. Returns the number of settings; throws when they can't be read.</summary>
    int LoadSettings();
    /// <summary>Sends a round trip through the interface; true = echoed exactly, false = echoed wrong, null = no answer in time.</summary>
    Task<bool?> BridgeRoundTripAsync(CancellationToken ct);
    /// <summary>Milliseconds from the process start to the interface's ready signal.</summary>
    double? ReadyAfterMs { get; }
}

/// <summary>Runs the six checks. Each one is isolated: an exception is that check's result, never the caller's problem.</summary>
public static class SelfCheckRunner
{
    public static readonly TimeSpan IntegrityTimeout = TimeSpan.FromSeconds(20);
    public static readonly TimeSpan BridgeTimeout = TimeSpan.FromSeconds(30);

    public static async Task<SelfCheckReport> RunAsync(ISelfCheckProbes probes, string version, bool manual, DateTimeOffset now, CancellationToken ct)
    {
        // The two slow ones run side by side, so the whole check normally takes well under a second.
        var integrity = IntegrityAsync(probes, ct);
        var bridge = BridgeAsync(probes, ct);
        var database = Database(probes);
        var art = ArtCache(probes);
        var settings = Settings(probes);
        var checks = new List<SelfCheckItem> { database, await integrity, await bridge, UiReady(probes), art, settings };
        return new SelfCheckReport(version, now.ToString("O"), manual, checks);
    }

    internal static SelfCheckItem Database(ISelfCheckProbes p)
    {
        const string id = "database", label = "Library database opens and is up to date";
        try
        {
            if (p.DatabaseStartupProblem is { } problem)
                return new(id, label, CheckOutcome.Failed, "It couldn't be upgraded, so VYSTRAL started with a fresh one and kept the old file in backups.", false);
            var v = p.SchemaVersion();
            return v == p.LatestSchemaVersion
                ? new(id, label, CheckOutcome.Passed, $"Schema version {v}.", false)
                : new(id, label, CheckOutcome.Failed, $"Schema version {v}, expected {p.LatestSchemaVersion}.", false);
        }
        catch (Exception ex)
        {
            return new(id, label, CheckOutcome.Failed, $"It couldn't be opened ({ex.GetType().Name}).", false);
        }
    }

    internal static async Task<SelfCheckItem> IntegrityAsync(ISelfCheckProbes p, CancellationToken ct)
    {
        const string id = "integrity", label = "Database integrity check";
        try
        {
            var work = Task.Run(p.QuickCheck, ct);
            var done = await Task.WhenAny(work, Task.Delay(IntegrityTimeout, ct));
            // Slowness is never a failure: a big library on a busy disk simply gets checked next time.
            if (done != work) return new(id, label, CheckOutcome.Skipped, "Took too long this time; it will be checked again.", false);
            var result = await work;
            return result == "ok"
                ? new(id, label, CheckOutcome.Passed, "No problems found.", false)
                : new(id, label, CheckOutcome.Failed, "SQLite reported damage: " + Truncate(result, 160), false);
        }
        catch (OperationCanceledException)
        {
            return new(id, label, CheckOutcome.Skipped, "VYSTRAL was closing.", false);
        }
        catch (Exception ex)
        {
            return new(id, label, CheckOutcome.Failed, $"The check couldn't run ({ex.GetType().Name}).", false);
        }
    }

    internal static async Task<SelfCheckItem> BridgeAsync(ISelfCheckProbes p, CancellationToken ct)
    {
        const string id = "bridge", label = "Interface and VYSTRAL talk to each other";
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(BridgeTimeout);
            var ok = await p.BridgeRoundTripAsync(timeout.Token);
            return ok switch
            {
                true => new(id, label, CheckOutcome.Passed, "A message went to the interface and came back unchanged.", true),
                false => new(id, label, CheckOutcome.Failed, "A message came back changed.", true),
                null => new(id, label, CheckOutcome.Skipped, "The interface didn't answer in time (it may have been busy).", true),
            };
        }
        catch (OperationCanceledException)
        {
            return new(id, label, CheckOutcome.Skipped, "The interface didn't answer in time (it may have been busy).", true);
        }
        catch (Exception ex)
        {
            return new(id, label, CheckOutcome.Failed, $"The round trip failed ({ex.GetType().Name}).", true);
        }
    }

    internal static SelfCheckItem UiReady(ISelfCheckProbes p)
    {
        const string id = "uiReady", label = "Interface finished starting";
        return p.ReadyAfterMs is { } ms
            ? new(id, label, CheckOutcome.Passed, $"Ready {ms / 1000:0.0} s after VYSTRAL started.", true)
            : new(id, label, CheckOutcome.Passed, "Ready.", true);
    }

    internal static SelfCheckItem ArtCache(ISelfCheckProbes p)
    {
        const string id = "artCache", label = "Artwork cache readable";
        try
        {
            p.ProbeArtCache();
            return new(id, label, CheckOutcome.Passed, "Covers can be read and saved.", false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            return new(id, label, CheckOutcome.Failed, $"The artwork folder can't be used ({ex.GetType().Name}). Covers fall back to generated ones.", false);
        }
    }

    internal static SelfCheckItem Settings(ISelfCheckProbes p)
    {
        const string id = "settings", label = "Settings load";
        try
        {
            var n = p.LoadSettings();
            return n > 0
                ? new(id, label, CheckOutcome.Passed, $"{n} settings read.", true)
                : new(id, label, CheckOutcome.Failed, "No settings could be read.", true);
        }
        catch (Exception ex)
        {
            return new(id, label, CheckOutcome.Failed, $"They couldn't be read ({ex.GetType().Name}).", true);
        }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max] + "…";
}

/// <summary>Reads and writes <c>update/self-check.json</c> (the update area, next to the rollback ledger).</summary>
public sealed class SelfCheckStore(string dataRoot)
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private readonly Lock _lock = new();
    public string FilePath => Path.Combine(dataRoot, "update", "self-check.json");

    public SelfCheckState Load()
    {
        lock (_lock)
        {
            try
            {
                if (!File.Exists(FilePath)) return new SelfCheckState();
                return JsonSerializer.Deserialize<SelfCheckState>(File.ReadAllText(FilePath), Json) ?? new SelfCheckState();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or NotSupportedException)
            {
                Log.Warn("selfcheck", "Self-check history unreadable; starting a new one", ex: ex);
                return new SelfCheckState();
            }
        }
    }

    public void Add(SelfCheckReport report)
    {
        lock (_lock)
        {
            var next = SelfCheckPolicy.Add(Load(), report);
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                var tmp = FilePath + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(next, Json));
                File.Move(tmp, FilePath, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Log.Warn("selfcheck", "Couldn't save the self-check result", ex: ex);
            }
        }
    }
}
