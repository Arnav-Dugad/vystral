using System.Diagnostics;
using Vystral.Core.Contracts;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Windows.Bridge;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;

namespace Vystral.Windows.Launch;

public sealed record LaunchStateDto(
    string Ticket,
    string GameId,
    string InstallationId,
    string Platform,
    string Phase,          // validating | starting | waiting | running | notDetected | ended | failed
    string? Message,
    string? SessionId = null,
    int? DurationSeconds = null,
    string? PerfSummary = null,
    string? StartedAt = null,
    // ---- Track B additions (append only) ----
    /// <summary>Median "launch accepted → game detected" time of the last 3+ launches of this installation; null until learned.</summary>
    int? ExpectedDetectMs = null,
    /// <summary>One-click fixes for a failed launch (phase "failed" only). Run with bridge 'launch.fix' {ticket, actionId}.</summary>
    IReadOnlyList<LaunchFixDto>? Actions = null,
    /// <summary>When the store/OS accepted the launch (ISO 8601). Progress = (now − AcceptedAt) / ExpectedDetectMs.</summary>
    string? AcceptedAt = null);

/// <summary>How the current session's frame rate can be captured: the verified PresentMon exe, or why not.</summary>
public sealed record FpsCapturePlan(string? ExePath, string Status);

/// <summary>Learns how long each installation takes to start.</summary>
public static class LaunchTiming
{
    public const int MinLaunches = 3;
    public const int Window = 5;
    /// <summary>Detections slower than this (store updates, the user waiting in a launcher) aren't learned from.</summary>
    public const int MaxLearnMs = 120_000;

    /// <summary>Median of the most recent launches (newest first), or null with fewer than <see cref="MinLaunches"/>.</summary>
    public static int? Expected(IReadOnlyList<int> recentNewestFirst)
    {
        var v = recentNewestFirst.Take(Window).Where(x => x > 0).OrderBy(x => x).ToList();
        if (v.Count < MinLaunches) return null;
        var m = v.Count / 2;
        return v.Count % 2 == 1 ? v[m] : (v[m - 1] + v[m]) / 2;
    }
}

/// <summary>
/// Owns the launch → detect → track → end lifecycle. A launch is only reported as running once
/// a game process is actually observed. Nothing is ever relaunched automatically.
/// </summary>
public sealed class SessionService : IDisposable
{
    private static readonly TimeSpan DetectionWindow = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan SlowWatchWindow = TimeSpan.FromMinutes(10);
    private const int MaxCaptureRestarts = 6;

    private readonly LibraryRepository _repo;
    private readonly IReadOnlyDictionary<PlatformId, IPlatformAdapter> _adapters;
    private readonly SettingsService _settings;
    private readonly IEventSink _events;
    private readonly Lock _lock = new();
    private CancellationTokenSource? _watchCts;
    private LaunchStateDto? _current;
    private PreflightEventDto? _lastPreflight;
    /// <summary>Processes of the game currently being tracked (for "switch to the game"); empty when none.</summary>
    private volatile int[] _trackedPids = [];

    public SessionService(LibraryRepository repo, IEnumerable<IPlatformAdapter> adapters, SettingsService settings, IEventSink events)
    {
        _repo = repo;
        _adapters = adapters.ToDictionary(a => a.Platform);
        _settings = settings;
        _events = events;
    }

    public LaunchStateDto? Current
    {
        get { lock (_lock) return _current; }
    }

    /// <summary>The last pre-flight result (so a UI that subscribed late can still show it).</summary>
    public PreflightEventDto? LastPreflight
    {
        get { lock (_lock) return _lastPreflight; }
    }

    /// <summary>Fix plans attached to recent failures; 'launch.fix' only runs what is registered here.</summary>
    public LaunchFixRegistry Fixes { get; } = new();

    /// <summary>Builds the pre-flight checks for a launch. Set by the backend; null disables pre-flight.</summary>
    public Func<Installation, IReadOnlyList<IPreflightCheck>>? PreflightChecks { get; set; }

    /// <summary>Decides whether frame rate can be captured for the next session. Null means "off".</summary>
    public Func<FpsCapturePlan>? FpsCapture { get; set; }

    /// <summary>Track F: the GPU and driver a session runs on (read once at session start). Null skips it.</summary>
    public Func<PerfSampler?, GpuIdentity?>? GpuIdentity { get; set; }

    /// <summary>Track F: creates the background-app tracker for a session (snapshots every ~30 s). Null, or returning null, skips it.</summary>
    public Func<BackgroundAppTracker?>? BackgroundApps { get; set; }

    /// <summary>Raised when a session moves to running or ends; the host uses it to enter/leave Performance Mode.</summary>
    public event Action<LaunchStateDto>? StateChanged;

    /// <summary>Raised for each performance sample of the running session (used by the Pulse window).</summary>
    public event Action<PerfSampleDto>? Sampled;

    public LaunchStateDto Launch(string gameId, string? installationId)
    {
        var ticket = LibraryRepository.NewId();
        lock (_lock)
        {
            if (_current is { Phase: "starting" or "waiting" or "running" } busy)
                return Fail(ticket, gameId, installationId ?? "", "", busy.Phase == "running"
                    ? "A game started from VYSTRAL is still running. Close it first, or stop tracking it."
                    : "Another game is still starting.");
        }

        var game = _repo.GetGame(gameId);
        if (game is null) return Fail(ticket, gameId, installationId ?? "", "", "This game is no longer in your library.");

        var installs = _repo.GetInstallations(gameId);
        var inst = installationId is not null
            ? installs.FirstOrDefault(i => i.Id == installationId)
            : installs.FirstOrDefault(i => i.Id == game.PreferredInstallationId && i.State == InstallState.Installed)
              ?? installs.Where(i => i.State == InstallState.Installed).OrderByDescending(i => i.ImportedLastPlayed).FirstOrDefault();

        if (inst is null)
        {
            var missing = installs.FirstOrDefault(i => i.State == InstallState.Missing);
            return Fail(ticket, gameId, "", missing?.Platform.Key() ?? "", missing is not null
                ? $"{game.Title} wasn't found during the last scan of {missing.Platform.DisplayName()}. Reinstall it there, or rescan your library."
                : $"{game.Title} isn't installed on this PC.",
                missing is null ? [] : [.. RescanPlans(missing.Platform), .. StorePagePlans(missing)]);
        }
        if (inst.State != InstallState.Installed)
            return Fail(ticket, gameId, inst.Id, inst.Platform.Key(),
                $"{game.Title} wasn't found during the last scan of {inst.Platform.DisplayName()}. Reinstall it there, or rescan your library.",
                [.. RescanPlans(inst.Platform), .. StorePagePlans(inst)]);

        int? expected = null;
        try { expected = LaunchTiming.Expected(_repo.GetRecentDetectMs(inst.Id, LaunchTiming.Window)); }
        catch (Exception ex) { Log.Warn("launch", "Launch timing unavailable", ex: ex); }

        var baseState = new LaunchStateDto(ticket, gameId, inst.Id, inst.Platform.Key(), "validating", null, ExpectedDetectMs: expected);
        Emit(baseState);

        var userArgs = _repo.GetUserLaunchArgs(inst.Id);
        var valid = LaunchValidator.Validate(inst, userArgs);
        if (!valid.Ok) return Fail(baseState, valid.Problem!, [.. FolderPlans(inst)]);

        AdapterStatus? clientStatus = null;
        if (_adapters.TryGetValue(inst.Platform, out var adapter))
        {
            clientStatus = SafeStatus(adapter);
            if (inst.ClientRequired && clientStatus?.Status == ClientStatus.NotInstalled)
                return Fail(baseState,
                    $"{game.Title} needs {inst.Platform.DisplayName()}, which isn't installed. Install {inst.Platform.DisplayName()} and try again.",
                    LaunchFixes.DownloadPage(inst.Platform) is { } page ? [new LaunchFixPlan(LaunchFixes.InstallClient, inst.Platform, Uri: page)] : []);
        }

        if (inst.InstallPath is not null && !Directory.Exists(inst.InstallPath))
            return Fail(baseState,
                $"The install folder {inst.InstallPath} is missing. If it's on an external drive, connect it and try again.",
                [.. RescanPlans(inst.Platform), .. StorePagePlans(inst)]);

        Emit(baseState with { Phase = "starting", Message = inst.ClientRequired ? $"Starting via {inst.Platform.DisplayName()}…" : "Starting…" });
        StartPreflight(ticket, inst);

        var steamExe = inst.Platform == PlatformId.Steam ? clientStatus?.ClientPath : null;
        var start = ProcessLauncher.Start(inst, userArgs, steamExe);
        _repo.Audit("game.launch", $"{inst.Platform.Key()}:{inst.PlatformGameId} ({(start.Started ? "accepted" : start.Error)})");
        if (!start.Started)
        {
            List<LaunchFixPlan> plans = [];
            if (inst.ClientRequired && clientStatus is { Status: ClientStatus.Available, ClientPath: { } exe } && LaunchFixes.IsSafeClientExe(exe))
                plans.Add(new LaunchFixPlan(LaunchFixes.StartClient, inst.Platform, ExePath: exe));
            plans.AddRange(StorePagePlans(inst));
            plans.AddRange(FolderPlans(inst));
            return Fail(baseState, start.Error ?? "The game didn't start.", plans);
        }

        var accepted = Stopwatch.StartNew();
        var waiting = baseState with
        {
            Phase = "waiting",
            Message = inst.ClientRequired ? $"Waiting for {inst.Platform.DisplayName()} to start the game…" : "Waiting for the game window…",
            AcceptedAt = DateTimeOffset.UtcNow.ToString("O"),
        };
        Emit(waiting);

        var excluded = _adapters.Values.Select(SafeStatus)
            .Where(s => s?.ClientPath is not null)
            .Select(s => Path.GetDirectoryName(s!.ClientPath!)!)
            .Where(d => inst.InstallPath is null || !Path.GetFullPath(inst.InstallPath).StartsWith(Path.GetFullPath(d), StringComparison.OrdinalIgnoreCase))
            .ToList();

        var cts = new CancellationTokenSource();
        lock (_lock)
        {
            _watchCts?.Cancel();
            _watchCts = cts;
        }
        _ = Task.Run(() => WatchAsync(waiting, inst, start.ProcessId, excluded, accepted, cts.Token));
        return waiting;
    }

    /// <summary>User chose to stop waiting for / tracking the current launch. The game itself is not touched.</summary>
    public void StopTracking()
    {
        lock (_lock) _watchCts?.Cancel();
    }

    /// <summary>Brings the running game's main window to the front. False when there is none to show.</summary>
    public bool FocusGame()
    {
        if (Current?.Phase != "running") return false;
        try { return WindowFocus.BringToFront(_trackedPids); }
        catch (Exception ex)
        {
            Log.Warn("launch", "Couldn't bring the game window forward", ex: ex);
            return false;
        }
    }

    // ---------------- pre-flight ----------------

    private void StartPreflight(string ticket, Installation inst)
    {
        var factory = PreflightChecks;
        if (factory is null) return;
        _ = Task.Run(async () =>
        {
            try
            {
                var checks = factory(inst);
                if (checks.Count == 0) return;
                var results = await PreflightRunner.RunAsync(checks, PreflightRunner.DefaultBudget);
                var payload = new PreflightEventDto(ticket, results);
                lock (_lock) _lastPreflight = payload;
                _events.Emit("launch.preflight", payload);
            }
            catch (Exception ex)
            {
                Log.Warn("preflight", "Pre-flight failed", ex: ex);
            }
        });
    }

    // ---------------- fixes ----------------

    private IEnumerable<LaunchFixPlan> RescanPlans(PlatformId platform) =>
        _adapters.ContainsKey(platform) ? [new LaunchFixPlan(LaunchFixes.RescanPlatform, platform)] : [];

    private IEnumerable<LaunchFixPlan> StorePagePlans(Installation inst)
    {
        if (!_adapters.TryGetValue(inst.Platform, out var adapter)) return [];
        string? uri;
        try { uri = adapter.GetClientPageUri(inst.PlatformGameId); }
        catch (Exception ex) { Log.Warn("launch", "Store page lookup failed", ex: ex); return []; }
        return uri is not null && Uri.TryCreate(uri, UriKind.Absolute, out var parsed)
            ? [new LaunchFixPlan(LaunchFixes.OpenStore, inst.Platform, Uri: parsed)]
            : [];
    }

    private static IEnumerable<LaunchFixPlan> FolderPlans(Installation inst) =>
        inst.InstallPath is { } p && Directory.Exists(p) ? [new LaunchFixPlan(LaunchFixes.OpenFolder, inst.Platform, Folder: p)] : [];

    // ---------------- watch ----------------

    private async Task WatchAsync(LaunchStateDto state, Installation inst, int? knownPid, List<string> excluded, Stopwatch accepted, CancellationToken ct)
    {
        try
        {
            var hints = inst.ProcessHints.ToHashSet(StringComparer.OrdinalIgnoreCase);
            var started = DateTimeOffset.UtcNow;
            List<int> pids = [];
            var notified = false;

            // Phase 1: wait for a game process to appear.
            while (!ct.IsCancellationRequested)
            {
                var found = ProcessScanner.FindUnder(ProcessScanner.Snapshot(), inst.InstallPath, hints, excluded);
                pids = found.Select(p => p.Id).ToList();
                if (knownPid is int pid && ProcessScanner.IsAlive(pid) && inst.InstallPath is not null &&
                    ProcessScanner.TryGetImagePath(pid) is { } path && path.StartsWith(inst.InstallPath, StringComparison.OrdinalIgnoreCase) &&
                    !pids.Contains(pid))
                    pids.Add(pid);
                if (pids.Count > 0) break;

                var elapsed = DateTimeOffset.UtcNow - started;
                if (elapsed > DetectionWindow && !notified)
                {
                    notified = true;
                    Emit(state with
                    {
                        Phase = "notDetected",
                        Message = "VYSTRAL hasn't seen the game start yet. It may still be updating or waiting in the store app. You can keep waiting or stop tracking; VYSTRAL won't relaunch it.",
                    });
                }
                if (elapsed > SlowWatchWindow)
                {
                    Emit(state with { Phase = "ended", Message = "Stopped waiting for the game. No session was recorded." });
                    return;
                }
                await Task.Delay(elapsed > DetectionWindow ? 5000 : 1500, ct);
            }
            if (ct.IsCancellationRequested)
            {
                Emit(state with { Phase = "ended", Message = "Stopped tracking. The game was not affected." });
                return;
            }

            // Phase 2: running.
            var detectMs = (int)accepted.ElapsedMilliseconds;
            var sessionStart = DateTimeOffset.UtcNow;
            var sessionId = _repo.StartSession(inst.GameId, inst.Id, sessionStart);
            if (detectMs <= LaunchTiming.MaxLearnMs)
            {
                try { _repo.SetSessionDetectMs(sessionId, detectMs); }
                catch (Exception ex) { Log.Warn("session", "Couldn't record launch timing", ex: ex); }
            }
            _trackedPids = [.. pids];
            Emit(state with { Phase = "running", Message = null, SessionId = sessionId, StartedAt = sessionStart.ToString("O") });

            var collect = _settings.GetBool("performance.collectMetrics");
            using var sampler = collect ? new PerfSampler() : null;
            var fps = collect ? new FpsSession(SafeFpsPlan()) : null;
            if (sampler is not null) RecordGpu(sessionId, sampler);
            using var backgroundOwner = sampler is not null ? SafeBackgroundTracker() : null;
            var background = backgroundOwner;
            var tick = 0;
            var samples = new List<PerfSampleDto>();
            var extras = new List<InsightSampleDto>();
            var pending = new List<PerfSampleDto>();
            var pendingExtras = new List<InsightSampleDto>();
            var lastSeenAlive = DateTimeOffset.UtcNow;
            var lastFlush = DateTimeOffset.UtcNow;
            var lastRescan = DateTimeOffset.UtcNow;

            try
            {
                fps?.Update(pids);
                while (!ct.IsCancellationRequested)
                {
                    await Task.Delay(2000, ct).ContinueWith(_ => { }, TaskScheduler.Default);
                    var now = DateTimeOffset.UtcNow;
                    pids = pids.Where(ProcessScanner.IsAlive).ToList();
                    if (pids.Count == 0 || now - lastRescan > TimeSpan.FromSeconds(10))
                    {
                        // Games often hand off to a second process (launcher → game); rescan to follow it.
                        pids = ProcessScanner.FindUnder(ProcessScanner.Snapshot(), inst.InstallPath, hints, excluded).Select(p => p.Id).ToList();
                        lastRescan = now;
                    }
                    _trackedPids = [.. pids];
                    if (pids.Count > 0) lastSeenAlive = now;
                    else if (now - lastSeenAlive > TimeSpan.FromSeconds(8)) break;

                    if (sampler is not null)
                    {
                        var t = (int)(now - sessionStart).TotalMilliseconds;
                        var sample = sampler.Sample(t);
                        samples.Add(sample);
                        pending.Add(sample);

                        fps?.Update(pids);
                        var (clock, flags) = sampler.ReadGpuState();
                        var window = fps?.Drain();
                        var extra = new InsightSampleDto(t, clock, flags, window?.Fps, window?.FrameTimeMs, window?.FrameTimeP99Ms);
                        if (clock is not null || flags is not null || window is not null)
                        {
                            extras.Add(extra);
                            pendingExtras.Add(extra);
                        }

                        try { Sampled?.Invoke(sample); } catch (Exception ex) { Log.Warn("session", "Sample handler failed", ex: ex); }
                        // Track F: one handle-free process snapshot every ~30 s (the first one is the CPU baseline).
                        if (background is not null && tick++ % BackgroundAppTracker.EveryTicks == 0)
                        {
                            try { background.Snapshot(pids); }
                            catch (Exception ex) { Log.Warn("session", "Background-app snapshot failed", ex: ex); background = null; }
                        }
                        if (now - lastFlush > TimeSpan.FromSeconds(30))
                        {
                            Flush(sessionId, pending, pendingExtras);
                            FlushBackground(sessionId, background);
                            lastFlush = now;
                        }
                    }
                }
            }
            finally
            {
                if (fps is not null) await fps.StopAsync();
            }

            _trackedPids = [];
            Flush(sessionId, pending, pendingExtras);
            FlushBackground(sessionId, background);
            var end = lastSeenAlive;
            var duration = (int)Math.Max(0, (end - sessionStart).TotalSeconds);
            string? summary = null;
            if (sampler is not null)
            {
                var frames = fps?.Summarize();
                summary = PerfSampler.ToJson(PerfSampler.Summarize(samples, extras, frames, fps?.Status(frames) ?? PerfSampler.FpsUnavailable));
            }
            _repo.EndSession(sessionId, end, duration, summary);
            Emit(state with
            {
                Phase = "ended",
                Message = ct.IsCancellationRequested ? "Stopped tracking. The session so far was saved." : null,
                SessionId = sessionId,
                DurationSeconds = duration,
                PerfSummary = summary,
                StartedAt = sessionStart.ToString("O"),
            });
        }
        catch (OperationCanceledException)
        {
            Emit(state with { Phase = "ended", Message = "Stopped tracking. The game was not affected." });
        }
        catch (Exception ex)
        {
            Log.Error("session", "Session watcher failed", ex);
            Emit(state with { Phase = "ended", Message = "VYSTRAL lost track of this session. The game was not affected." });
        }
    }

    private void Flush(string sessionId, List<PerfSampleDto> pending, List<InsightSampleDto> pendingExtras)
    {
        if (pending.Count > 0) _repo.AddPerfSamples(sessionId, pending);
        // After AddPerfSamples: that call replaces whole rows.
        if (pendingExtras.Count > 0)
        {
            try { _repo.AddInsightSamples(sessionId, pendingExtras); }
            catch (Exception ex) { Log.Warn("session", "Couldn't store throttle/FPS samples", ex: ex); }
        }
        pending.Clear();
        pendingExtras.Clear();
    }

    private void RecordGpu(string sessionId, PerfSampler sampler)
    {
        try
        {
            if (GpuIdentity?.Invoke(sampler) is { } gpu && (gpu.Driver is not null || gpu.Name is not null))
                _repo.SetSessionGpu(sessionId, gpu.Driver, gpu.Name);
        }
        catch (Exception ex) { Log.Warn("session", "Couldn't record the GPU driver", ex: ex); }
    }

    private BackgroundAppTracker? SafeBackgroundTracker()
    {
        try { return BackgroundApps?.Invoke(); }
        catch (Exception ex) { Log.Warn("session", "Background-app tracking unavailable", ex: ex); return null; }
    }

    private void FlushBackground(string sessionId, BackgroundAppTracker? background)
    {
        if (background is not { Dirty: true }) return;
        try { _repo.SaveBackgroundApps(sessionId, background.Results(), background.Snapshots, background.MemLoadAvg, background.MemLoadMax); }
        catch (Exception ex) { Log.Warn("session", "Couldn't store background apps", ex: ex); }
    }

    private FpsCapturePlan SafeFpsPlan()
    {
        try { return FpsCapture?.Invoke() ?? new FpsCapturePlan(null, PerfSampler.FpsUnavailable); }
        catch (Exception ex)
        {
            Log.Warn("fps", "Couldn't prepare frame-rate capture", ex: ex);
            return new FpsCapturePlan(null, "Frame-rate capture couldn't be prepared. FPS is not recorded.");
        }
    }

    /// <summary>
    /// Frame-rate capture for one session: follows the game's main process (largest working set)
    /// across launcher hand-offs, gives up after repeated failures, and always stops PresentMon.
    /// </summary>
    private sealed class FpsSession(FpsCapturePlan plan)
    {
        private readonly FrameStats _stats = new();
        private FrameCapture? _capture;
        private int _restarts;
        private string? _failure;

        public void Update(IReadOnlyList<int> pids)
        {
            if (plan.ExePath is null || _failure is not null || pids.Count == 0) return;
            try
            {
                if (_capture is not null)
                {
                    if (!_capture.HasExited && pids.Contains(_capture.TargetPid)) return;
                    if (_capture.Failure() is { } f && _stats.Frames == 0) { _failure = f; Stop(); return; }
                    Stop();
                }
                if (_restarts++ >= MaxCaptureRestarts) return;
                var target = MainProcess(pids);
                if (target is null) return;
                if (!PresentMonInstaller.VerifyFile(plan.ExePath, PresentMonRelease.Pinned.Sha256))
                {
                    _failure = "PresentMon's file changed after it was downloaded, so VYSTRAL didn't run it. Reinstall frame-rate capture in Settings.";
                    return;
                }
                _capture = FrameCapture.Start(plan.ExePath, target.Value, _stats);
                Log.Info("fps", $"Frame capture started for pid {target}");
            }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or IOException)
            {
                _failure = "PresentMon couldn't be started. FPS is not recorded.";
                Log.Warn("fps", "PresentMon start failed", ex: ex);
            }
        }

        public FrameWindow? Drain() => _stats.DrainWindow();

        public FrameSummary? Summarize() => _stats.Summarize();

        public string Status(FrameSummary? frames)
        {
            if (frames is not null) return $"Measured with Intel PresentMon {PresentMonRelease.Pinned.Version}. Frame time is the time between the game's presented frames.";
            if (plan.ExePath is null) return plan.Status;
            return _failure ?? "PresentMon ran but didn't see any frames from the game, so FPS wasn't recorded. Some games present frames from a helper process VYSTRAL can't identify.";
        }

        public async Task StopAsync()
        {
            var c = _capture;
            _capture = null;
            if (c is null) return;
            await c.StopAsync();
            c.Dispose();
        }

        private void Stop()
        {
            var c = _capture;
            _capture = null;
            if (c is null) return;
            _ = Task.Run(async () =>
            {
                try { await c.StopAsync(); } finally { c.Dispose(); }
            });
        }

        private static int? MainProcess(IReadOnlyList<int> pids)
        {
            int? best = null;
            long bestWs = -1;
            foreach (var pid in pids)
            {
                try
                {
                    using var p = Process.GetProcessById(pid);
                    if (p.WorkingSet64 > bestWs) { bestWs = p.WorkingSet64; best = pid; }
                }
                catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { }
            }
            return best;
        }
    }

    private static AdapterStatus? SafeStatus(IPlatformAdapter adapter)
    {
        try { return adapter.GetStatus(); }
        catch (Exception ex)
        {
            Log.Warn("session", $"Status check failed for {adapter.Platform}", ex: ex);
            return null;
        }
    }

    private LaunchStateDto Fail(LaunchStateDto baseState, string message, IReadOnlyList<LaunchFixPlan> plans) =>
        Fail(baseState.Ticket, baseState.GameId, baseState.InstallationId, baseState.Platform, message, plans, baseState.ExpectedDetectMs);

    private LaunchStateDto Fail(string ticket, string gameId, string installationId, string platform, string message,
        IReadOnlyList<LaunchFixPlan>? plans = null, int? expected = null)
    {
        // De-duplicate by id: each action appears once.
        var unique = (plans ?? []).GroupBy(p => p.Id).Select(g => g.First()).ToList();
        Fixes.Attach(ticket, unique);
        var state = new LaunchStateDto(ticket, gameId, installationId, platform, "failed", message,
            ExpectedDetectMs: expected, Actions: unique.Count == 0 ? null : unique.Select(LaunchFixes.ToDto).ToList());
        Log.Warn("launch", message, new { gameId, installationId });
        Emit(state);
        return state;
    }

    private void Emit(LaunchStateDto state)
    {
        lock (_lock)
        {
            if (state.Phase is "failed" && _current is { Phase: "starting" or "waiting" or "running" } && _current.Ticket != state.Ticket)
            {
                // A rejected second launch must not overwrite the active one.
            }
            else
            {
                _current = state;
            }
        }
        _events.Emit("launch.state", state);
        try { StateChanged?.Invoke(state); }
        catch (Exception ex) { Log.Error("session", "StateChanged handler failed", ex); }
    }

    public void Dispose() => _watchCts?.Cancel();
}
