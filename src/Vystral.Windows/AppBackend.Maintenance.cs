using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using Vystral.Windows.Services.Maintenance;
using Vystral.Windows.Services.Startup;

namespace Vystral.Windows;

public sealed record FirstPaintSaveParams(JsonElement Snapshot);
public sealed record StartupMarksParams(double TimeOrigin, Dictionary<string, double> Marks);
public sealed record SelfCheckEchoParams(string Nonce, string Probe);

// Track AA: startup speed (first-paint snapshot, startup timings), the after-update self-check, monthly database compaction.
public sealed partial class AppBackend
{
    /// <summary>Text with quotes, markup, non-Latin letters, an emoji and a line separator: what JSON round trips break on.</summary>
    internal const string SelfCheckProbe = "VYSTRAL ✓ “quotes” <b>&amp;</b> Ünïcødé 日本語 🎮 \u2028 end";
    private const string AutoCompactSetting = "data.autoCompact";

    private FirstPaintStore? _firstPaint;
    private SelfCheckStore? _selfChecks;
    private DatabaseCompactor? _compactor;
    private Timer? _maintenanceTimer;
    private readonly ConcurrentDictionary<string, TaskCompletionSource<bool>> _echoes = new(StringComparer.Ordinal);
    private SelfCheckReport? _lastSelfCheck;
    private volatile bool _selfCheckRunning;
    /// <summary>A real self-check failure this start: it must not be confirmed as a successful start.</summary>
    private volatile bool _selfCheckHardFailure;

    /// <summary>The first-paint cache (read by the host before the page loads).</summary>
    public FirstPaintStore FirstPaint => _firstPaint ??= new FirstPaintStore(Paths.Root);

    private void RegisterMaintenanceHandlers()
    {
        _firstPaint ??= new FirstPaintStore(Paths.Root);
        _selfChecks = new SelfCheckStore(Paths.Root);
        _compactor = new DatabaseCompactor(Database, Paths.Root);

        // ---- First paint ----
        Dispatcher.Register<FirstPaintSaveParams>("app.firstPaint.save", (p, _) =>
        {
            try { _firstPaint.Save(p.Snapshot, Version, DateTimeOffset.Now); }
            catch (ArgumentException ex) { throw new BridgeException("invalid", ex.Message); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Losing the snapshot only means the next start paints from live data; never bother the user.
                Log.Warn("startup", "Couldn't save the first-paint snapshot", ex: ex);
                return Task.FromResult<object?>(false);
            }
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register("app.firstPaint.clear", _ =>
        {
            _firstPaint.Clear();
            return Task.FromResult<object?>(true);
        });

        // ---- Startup timings (local log only) ----
        Dispatcher.Register<StartupMarksParams>("app.startupMarks", (p, _) =>
        {
            if (p.Marks is null || p.Marks.Count > StartupTimeline.MaxUiMarks) throw new BridgeException("invalid", "Invalid startup marks.");
            if (StartupTimeline.AddUiMarks(p.TimeOrigin, p.Marks)) StartupTimeline.LogOnce();
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register("diagnostics.startup", _ => Task.FromResult<object?>(StartupTimeline.Snapshot()));

        // ---- After-update self-check ----
        Dispatcher.Register("update.selfCheck.get", _ => Task.FromResult<object?>(SelfCheckDto()));
        Dispatcher.Register("update.selfCheck.run", async ct =>
        {
            if (_selfCheckRunning) throw new BridgeException("busy", "The check is already running.");
            await RunSelfCheckAsync(manual: true, ct);
            return SelfCheckDto();
        });
        Dispatcher.Register<SelfCheckEchoParams>("update.selfCheck.echo", (p, _) =>
        {
            if (p.Nonce is not { Length: 32 } || p.Probe is not { Length: <= 200 }) throw new BridgeException("invalid", "Invalid echo.");
            if (_echoes.TryRemove(p.Nonce, out var pending)) pending.TrySetResult(string.Equals(p.Probe, SelfCheckProbe, StringComparison.Ordinal));
            return Task.FromResult<object?>(true);
        });

        // ---- Database compaction ----
        Dispatcher.Register("data.compaction.get", _ => Task.FromResult<object?>(CompactionDto()));
        Dispatcher.Register("data.compaction.run", _ =>
        {
            var result = RunCompaction(manual: true);
            if (result.Outcome == "skipped")
            {
                throw new BridgeException("busy", result.Reason switch
                {
                    CompactionBlock.GameRunning => "Close your game first: VYSTRAL never compacts while you play.",
                    CompactionBlock.TrackerActive => "The background tracker is using the database right now. Try again in a minute.",
                    CompactionBlock.LowDisk => "There isn't enough free space. Compacting needs free space of at least twice the database's size.",
                    CompactionBlock.Running => "Compaction is already running.",
                    _ => "Compaction can't run right now.",
                });
            }
            return Task.FromResult<object?>(new { result = CompactionResultDto(result), status = CompactionDto() });
        });
        // The schedule is checked every 15 minutes (first after 10); each check is a few cheap system calls.
        _maintenanceTimer = new Timer(_ => MaintenanceTick(), null, TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(15));
    }

    /// <summary>Called once the interface reported ready (from <see cref="OnUiReady"/>).</summary>
    private void OnUiReadyMaintenance()
    {
        StartupTimeline.Mark("appReady");
        _ = Task.Run(async () =>
        {
            try
            {
                // A short pause keeps the first seconds after start for the interface and the scan.
                await Task.Delay(TimeSpan.FromSeconds(2), _life.Token);
                if (!SelfCheckPolicy.ShouldRun(_selfChecks!.Load(), Version)) return;
                await RunSelfCheckAsync(manual: false, _life.Token);
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Warn("selfcheck", "The after-update check couldn't run", ex: ex); }
        });
    }

    private async Task RunSelfCheckAsync(bool manual, CancellationToken ct)
    {
        _selfCheckRunning = true;
        try
        {
            var report = await SelfCheckRunner.RunAsync(new SelfCheckProbes(this), Version, manual, DateTimeOffset.Now, ct);
            _selfChecks!.Add(report);
            _lastSelfCheck = report;
            if (report.HardFailure) _selfCheckHardFailure = true;
            var data = new
            {
                report.Version, report.Manual, passed = report.Passed, total = report.Total, report.HardFailure,
                checks = report.Checks.Select(c => new { c.Id, outcome = c.Outcome.ToString(), c.Detail }),
            };
            if (report.HardFailure) Log.Warn("selfcheck", "After-update check failed; this start won't count as a successful start", data);
            else Log.Info("selfcheck", $"After-update check: {report.Passed} of {report.Total} passed", data);
            _events.Emit("selfcheck.done", SelfCheckDto());
        }
        finally
        {
            _selfCheckRunning = false;
        }
    }

    private object SelfCheckDto()
    {
        var latest = _lastSelfCheck ?? SelfCheckPolicy.Latest(_selfChecks!.Load(), Version);
        return new
        {
            running = _selfCheckRunning,
            currentVersion = Version,
            latest = latest is null ? null : new
            {
                version = latest.Version,
                at = latest.At,
                manual = latest.Manual,
                passed = latest.Passed,
                total = latest.Total,
                checks = latest.Checks.Select(c => new { id = c.Id, label = c.Label, outcome = c.Outcome.ToString().ToLowerInvariant(), detail = c.Detail }),
            },
        };
    }

    /// <summary>The live side of the checks.</summary>
    private sealed class SelfCheckProbes(AppBackend b) : ISelfCheckProbes
    {
        public string? DatabaseStartupProblem => b.StartupProblem;
        public int SchemaVersion() => b.Database.SchemaVersion();
        public int LatestSchemaVersion => Core.Data.Database.LatestVersion;
        public string QuickCheck() => b.Database.QuickCheck();
        public double? ReadyAfterMs => StartupTimeline.Snapshot().TryGetValue("appReady", out var ms) ? ms : null;

        public void ProbeArtCache()
        {
            var dir = b.Paths.ArtCache;
            Directory.CreateDirectory(dir);
            if (Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).FirstOrDefault() is { } file)
            {
                using var s = File.OpenRead(file);
                s.ReadByte();
            }
            var probe = Path.Combine(dir, $".selfcheck-{Guid.NewGuid():N}.tmp");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
        }

        public int LoadSettings()
        {
            _ = b.Repository.GetSettings().Count();
            return b.Settings.GetAll().Count;
        }

        public async Task<bool?> BridgeRoundTripAsync(CancellationToken ct)
        {
            var nonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
            var pending = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            b._echoes[nonce] = pending;
            try
            {
                b._events.Emit("selfcheck.ping", new { nonce, probe = SelfCheckProbe });
                return await pending.Task.WaitAsync(ct);
            }
            catch (OperationCanceledException)
            {
                return null;
            }
            finally
            {
                b._echoes.TryRemove(nonce, out _);
            }
        }
    }

    // ---- Compaction ----

    private void MaintenanceTick()
    {
        try
        {
            if (_compactor is null || _compactor.Running || _life.IsCancellationRequested) return;
            var result = RunCompaction(manual: false);
            if (result.Outcome != "skipped") _events.Emit("data.compaction", CompactionDto());
        }
        catch (Exception ex)
        {
            Log.Warn("compaction", "Scheduled compaction check failed", ex: ex);
        }
    }

    private CompactionResult RunCompaction(bool manual)
    {
        var ctx = new CompactionContext(
            DateTimeOffset.Now,
            Settings.GetBool(AutoCompactSetting),
            MaintenanceEnvironment.OnAcPower(),
            MaintenanceEnvironment.UserIdle(),
            IsGameActive,
            TrackerActive: !_trackerOwned,
            SafeMode,
            Database.SizeOnDisk(),
            MaintenanceEnvironment.FreeBytes(Paths.Database),
            manual);
        return _compactor!.Run(ctx, Path.Combine(Paths.Backups, "pre-compaction.db"));
    }

    private object CompactionDto()
    {
        var s = _compactor!.Load();
        return new
        {
            sizeBytes = Database.SizeOnDisk(),
            running = _compactor.Running,
            autoEnabled = Settings.GetBool(AutoCompactSetting),
            lastRun = s.LastRunAt is null ? null : new { at = s.LastRunAt, beforeBytes = s.BeforeBytes ?? 0, afterBytes = s.AfterBytes ?? 0, durationMs = s.DurationMs ?? 0 },
            lastAttempt = s.LastAttemptAt is null ? null : new { at = s.LastAttemptAt, outcome = s.LastOutcome },
            nextDueAt = CompactionPolicy.NextDue(s)?.ToString("O"),
        };
    }

    private static object CompactionResultDto(CompactionResult r) => new
    {
        outcome = r.Outcome,
        reason = r.Reason == CompactionBlock.None ? null : JsonNamingPolicy.CamelCase.ConvertName(r.Reason.ToString()),
        beforeBytes = r.BeforeBytes,
        afterBytes = r.AfterBytes,
        durationMs = r.DurationMs,
    };

    private void DisposeMaintenance()
    {
        _maintenanceTimer?.Dispose();
        foreach (var e in _echoes.Values) e.TrySetCanceled();
    }
}
