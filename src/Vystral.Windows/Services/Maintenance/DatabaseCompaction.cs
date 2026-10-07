using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;
using Vystral.Core.Data;

namespace Vystral.Windows.Services.Maintenance;

/// <summary>What the last compaction did (<c>maintenance/compaction.json</c> in the data folder).</summary>
public sealed record CompactionState
{
    /// <summary>When the database was last compacted successfully (ISO 8601).</summary>
    public string? LastRunAt { get; init; }
    public long? BeforeBytes { get; init; }
    public long? AfterBytes { get; init; }
    public int? DurationMs { get; init; }
    /// <summary>The last time a compaction was tried and didn't happen (busy, failed), for the retry back-off.</summary>
    public string? LastAttemptAt { get; init; }
    /// <summary>"compacted", "busy" or "failed".</summary>
    public string? LastOutcome { get; init; }
}

/// <summary>The conditions at the moment of deciding.</summary>
public sealed record CompactionContext(
    DateTimeOffset Now,
    bool AutoEnabled,
    bool OnAcPower,
    TimeSpan UserIdle,
    bool GameRunning,
    /// <summary>The background tracker (not this app) may be using the database.</summary>
    bool TrackerActive,
    bool SafeMode,
    long DatabaseBytes,
    long FreeBytes,
    bool Manual);

[JsonConverter(typeof(JsonStringEnumConverter<CompactionBlock>))]
public enum CompactionBlock { None, Disabled, SafeMode, TrackerActive, GameRunning, NotDue, OnBattery, NotIdle, LowDisk, RetryLater, Running }

public sealed record CompactionDecision(bool Run, CompactionBlock Reason);

/// <summary>
/// When the monthly quiet VACUUM runs. Pure, so each rule is unit-tested. Automatic runs need all of:
/// the setting on, not safe mode, the app owning the database (not the background tracker), no game,
/// a month since the last compaction, mains power, ten idle minutes, and free disk space of at least twice
/// the database (VACUUM writes a full new copy before it replaces the old one). "Compact now" skips the
/// schedule, power and idle rules but never the game, tracker or disk-space ones.
/// </summary>
public static class CompactionPolicy
{
    public static readonly TimeSpan Interval = TimeSpan.FromDays(30);
    public static readonly TimeSpan IdleNeeded = TimeSpan.FromMinutes(10);
    /// <summary>After a busy or failed attempt, wait this long before trying again automatically.</summary>
    public static readonly TimeSpan RetryAfter = TimeSpan.FromHours(6);
    public const double SpaceFactor = 2.0;

    public static CompactionDecision Decide(CompactionState s, CompactionContext c)
    {
        if (c.TrackerActive) return new(false, CompactionBlock.TrackerActive);
        if (c.GameRunning) return new(false, CompactionBlock.GameRunning);
        if (c.FreeBytes < c.DatabaseBytes * SpaceFactor) return new(false, CompactionBlock.LowDisk);
        if (c.Manual) return new(true, CompactionBlock.None);

        if (!c.AutoEnabled) return new(false, CompactionBlock.Disabled);
        if (c.SafeMode) return new(false, CompactionBlock.SafeMode);
        if (NextDue(s) is { } due && c.Now < due) return new(false, CompactionBlock.NotDue);
        if (Parse(s.LastAttemptAt) is { } attempt && s.LastOutcome is "busy" or "failed" && c.Now - attempt < RetryAfter)
            return new(false, CompactionBlock.RetryLater);
        if (!c.OnAcPower) return new(false, CompactionBlock.OnBattery);
        if (c.UserIdle < IdleNeeded) return new(false, CompactionBlock.NotIdle);
        return new(true, CompactionBlock.None);
    }

    /// <summary>When the next automatic compaction is due (null: now, it has never run).</summary>
    public static DateTimeOffset? NextDue(CompactionState s) => Parse(s.LastRunAt) is { } last ? last + Interval : null;

    public static CompactionState Succeeded(CompactionState s, DateTimeOffset at, long before, long after, int ms) => s with
    {
        LastRunAt = at.ToString("O"), BeforeBytes = before, AfterBytes = after, DurationMs = ms,
        LastAttemptAt = at.ToString("O"), LastOutcome = "compacted",
    };

    public static CompactionState Attempted(CompactionState s, DateTimeOffset at, string outcome) => s with
    {
        LastAttemptAt = at.ToString("O"), LastOutcome = outcome,
    };

    private static DateTimeOffset? Parse(string? iso) => iso is not null && DateTimeOffset.TryParse(iso, out var d) ? d : null;
}

/// <summary>The result of one compaction attempt, as the interface shows it.</summary>
public sealed record CompactionResult(string Outcome, CompactionBlock Reason, long BeforeBytes, long AfterBytes, int DurationMs);

/// <summary>Runs compactions one at a time and remembers the outcome. Never deletes anything.</summary>
public sealed class DatabaseCompactor(Database db, string dataRoot)
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private readonly Lock _lock = new();
    private int _running;

    public string StatePath => Path.Combine(dataRoot, "maintenance", "compaction.json");
    public bool Running => Volatile.Read(ref _running) == 1;

    public CompactionState Load()
    {
        lock (_lock)
        {
            try
            {
                return File.Exists(StatePath) ? JsonSerializer.Deserialize<CompactionState>(File.ReadAllText(StatePath), Json) ?? new() : new();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                Log.Warn("compaction", "Compaction history unreadable; starting over", ex: ex);
                return new();
            }
        }
    }

    private void Save(CompactionState s)
    {
        lock (_lock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(StatePath)!);
                var tmp = StatePath + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(s, Json));
                File.Move(tmp, StatePath, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Log.Warn("compaction", "Couldn't save the compaction result", ex: ex);
            }
        }
    }

    /// <summary>
    /// Decides with <see cref="CompactionPolicy"/> and, if allowed, compacts. A pre-compaction backup is
    /// taken with the existing backup path when there is room for it too (three times the database);
    /// VACUUM itself is atomic either way. A locked database is "busy", tried again later, never an error.
    /// </summary>
    public CompactionResult Run(CompactionContext ctx, string? backupPath)
    {
        var state = Load();
        var decision = CompactionPolicy.Decide(state, ctx);
        if (!decision.Run) return new("skipped", decision.Reason, ctx.DatabaseBytes, ctx.DatabaseBytes, 0);
        if (Interlocked.Exchange(ref _running, 1) == 1) return new("skipped", CompactionBlock.Running, ctx.DatabaseBytes, ctx.DatabaseBytes, 0);
        var before = db.SizeOnDisk();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            if (backupPath is not null && ctx.FreeBytes >= before * (CompactionPolicy.SpaceFactor + 1))
            {
                try { db.BackupTo(backupPath); }
                catch (Exception ex) when (ex is SqliteException or IOException or UnauthorizedAccessException)
                {
                    Log.Warn("compaction", "Pre-compaction backup failed; compacting anyway (VACUUM is atomic)", ex: ex);
                }
            }
            db.Compact();
            var after = db.SizeOnDisk();
            var ms = (int)clock.ElapsedMilliseconds;
            Save(CompactionPolicy.Succeeded(state, ctx.Now, before, after, ms));
            Log.Info("compaction", "Database compacted", new { before, after, ms, ctx.Manual });
            return new("compacted", CompactionBlock.None, before, after, ms);
        }
        catch (SqliteException ex) when (ex.SqliteErrorCode is 5 or 6) // SQLITE_BUSY, SQLITE_LOCKED
        {
            Save(CompactionPolicy.Attempted(state, ctx.Now, "busy"));
            Log.Info("compaction", "Database was busy; compaction will be tried again later", new { ex.SqliteErrorCode });
            return new("busy", CompactionBlock.RetryLater, before, before, (int)clock.ElapsedMilliseconds);
        }
        catch (Exception ex) when (ex is SqliteException or IOException or UnauthorizedAccessException)
        {
            Save(CompactionPolicy.Attempted(state, ctx.Now, "failed"));
            Log.Warn("compaction", "Compaction failed; the database is unchanged", ex: ex);
            return new("failed", CompactionBlock.RetryLater, before, db.SizeOnDisk(), (int)clock.ElapsedMilliseconds);
        }
        finally
        {
            Volatile.Write(ref _running, 0);
        }
    }
}

/// <summary>Windows facts the compaction schedule needs: mains power, how long the user has been away, free space.</summary>
public static class MaintenanceEnvironment
{
    /// <summary>On mains power with battery/energy saver off. Unknown counts as not on mains power.</summary>
    public static bool OnAcPower()
    {
        if (!GetSystemPowerStatus(out var s)) return false;
        return s.ACLineStatus == 1 && s.SystemStatusFlag == 0;
    }

    /// <summary>Time since the last keyboard, mouse or touch input in this session.</summary>
    public static TimeSpan UserIdle()
    {
        var info = new LastInputInfo { cbSize = (uint)Marshal.SizeOf<LastInputInfo>() };
        if (!GetLastInputInfo(ref info)) return TimeSpan.Zero;
        var idleMs = unchecked((uint)Environment.TickCount - info.dwTime);
        return TimeSpan.FromMilliseconds(idleMs);
    }

    public static long FreeBytes(string path)
    {
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(path));
            return root is null ? 0 : new DriveInfo(root).AvailableFreeSpace;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return 0;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SystemPowerStatus
    {
        public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
        public int BatteryLifeTime, BatteryFullLifeTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemPowerStatus(out SystemPowerStatus status);

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LastInputInfo plii);
}
