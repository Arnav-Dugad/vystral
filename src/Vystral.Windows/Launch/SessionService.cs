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
    string? AcceptedAt = null,
    // ---- Track H additions (append only) ----
    /// <summary>How VYSTRAL came to track this game: "tracked" (launched from VYSTRAL), "detected" (started outside VYSTRAL
    /// while it was open) or "background" (noticed by the background tracker). See <see cref="Vystral.Core.Domain.SessionSources"/>.</summary>
    string? Source = null);

/// <summary>A running session as the trackers hand it to each other (and as the crash-recovery heartbeat describes it).</summary>
/// <param name="PlayedSeconds">Time actually played so far (system sleep excluded); null when unknown.</param>
public sealed record ActiveSessionInfo(string SessionId, string GameId, string? InstallationId, string Source, DateTimeOffset Start, DateTimeOffset LastSeen,
    int? PlayedSeconds = null);

/// <summary>One step of a running session: its processes now, or that it has ended.</summary>
/// <param name="Keep">For an ended session: whether it is long enough to keep (detected sessions under a minute aren't).</param>
public readonly record struct SessionTick(IReadOnlyList<int> Pids, bool Ended = false, DateTimeOffset LastSeen = default, bool Keep = true);

/// <summary>
/// Follows the processes of a running session. A launch uses the original rules (<c>LaunchedFeed</c>); a game
/// noticed outside VYSTRAL is followed by the game detector (<see cref="Tracking.GameDetector"/>).
/// </summary>
public interface ISessionFeed
{
    /// <summary>Called about every 2 s while the session runs.</summary>
    SessionTick Next(DateTimeOffset now);
    /// <summary>The user stopped tracking (the game may still be running).</summary>
    void Stopped(DateTimeOffset now);
    /// <summary>The session was handed over to another process without ending.</summary>
    void Parked();
}

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
    /// <summary>After this long without seeing the game, the launch shows "notDetected" (tests shorten it).</summary>
    internal TimeSpan DetectionWindow { get; set; } = TimeSpan.FromSeconds(120);
    /// <summary>After this long without seeing the game, VYSTRAL stops waiting (tests shorten it).</summary>
    internal TimeSpan SlowWatchWindow { get; set; } = TimeSpan.FromMinutes(10);
    /// <summary>How the game is started (tests replace it so no process is created).</summary>
    internal Func<Installation, string?, string?, LaunchStartResult> Starter { get; set; } = ProcessLauncher.Start;
    /// <summary>The session clock (tests use a fake one to simulate system sleep).</summary>
    internal Func<DateTimeOffset> Clock { get; set; } = () => DateTimeOffset.UtcNow;
    /// <summary>Time between two steps of a running session.</summary>
    internal TimeSpan TickInterval { get; set; } = TimeSpan.FromSeconds(2);
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
    /// <summary>Track H: the session being recorded right now (for hand-over), or null.</summary>
    private RunningSession? _running;

    private sealed class RunningSession(CancellationTokenSource park)
    {
        public CancellationTokenSource Park { get; } = park;
        public TaskCompletionSource<ActiveSessionInfo?> Parked { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    /// <summary>Detected sessions shorter than this are discarded (a launcher check, an installer, a crash at start).</summary>
    public static readonly TimeSpan MinExternalSession = TimeSpan.FromSeconds(60);

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

    /// <summary>Track H: source recorded for games this process notices on its own ("detected" in the app, "background" in the tracker).</summary>
    public string ExternalSource { get; set; } = Core.Domain.SessionSources.Detected;

    /// <summary>Track H: raised at the start of a session and about every 30 s while it runs (crash-recovery heartbeat).</summary>
    public event Action<ActiveSessionInfo>? Heartbeat;

    /// <summary>Track H: raised when a session was closed (saved or discarded; not when handed over), with its id.</summary>
    public event Action<string>? SessionClosed;

    /// <summary>Track H: raised when the user stopped tracking a running game, with its installation id.</summary>
    public event Action<string>? TrackingStopped;

    /// <summary>
    /// The one "a game is starting or running" rule used everywhere (launch gate, detector, update apply,
    /// enrichment, local AI, haptics, background network work, Performance Mode): a launch being validated,
    /// started or waited for (also after "not detected yet"), or a session being recorded.
    /// </summary>
    public static bool IsActivePhase(string? phase) => phase is "validating" or "starting" or "waiting" or "notDetected" or "running";

    /// <summary>True while a launch is in progress or a session is being recorded (see <see cref="IsActivePhase"/>).</summary>
    public bool IsBusy => IsActivePhase(Current?.Phase);

    public LaunchStateDto Launch(string gameId, string? installationId)
    {
        var ticket = LibraryRepository.NewId();
        var cts = new CancellationTokenSource();
        string? busyMessage = null;
        lock (_lock)
        {
            if (IsBusyLocked())
            {
                busyMessage = BusyMessage(_current!);
            }
            else
            {
                // Reserve the slot before the lock is released: a second launch (or a detected game) now waits
                // for this one, and "Stop waiting" works from the first moment.
                _watchCts?.Cancel();
                _watchCts = cts;
                _current = new LaunchStateDto(ticket, gameId, installationId ?? "", "", "validating", null,
                    Source: Core.Domain.SessionSources.Tracked);
            }
        }
        if (busyMessage is not null)
        {
            cts.Dispose();
            return Fail(ticket, gameId, installationId ?? "", "", busyMessage);
        }

        try
        {
            return LaunchReserved(ticket, gameId, installationId, cts);
        }
        catch (Exception ex)
        {
            // Never leave the slot reserved: that would block every later launch.
            Log.Error("launch", "Launch failed unexpectedly", ex);
            return Fail(ticket, gameId, installationId ?? "", "", "VYSTRAL couldn't start the game. Try again.");
        }
    }

    private static string BusyMessage(LaunchStateDto busy) => busy.Phase switch
    {
        "running" => busy.Source is null or Core.Domain.SessionSources.Tracked
            ? "A game started from VYSTRAL is still running. Close it first, or stop tracking it."
            : "VYSTRAL is tracking a game you started outside it. Close that game first, or stop tracking it.",
        "notDetected" => "VYSTRAL is still waiting for another game to start. Stop waiting for it first.",
        _ => "Another game is still starting.",
    };

    private LaunchStateDto LaunchReserved(string ticket, string gameId, string? installationId, CancellationTokenSource cts)
    {
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

        var baseState = new LaunchStateDto(ticket, gameId, inst.Id, inst.Platform.Key(), "validating", null, ExpectedDetectMs: expected,
            Source: Core.Domain.SessionSources.Tracked);
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
        var start = Starter(inst, userArgs, steamExe);
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
            var running = state with { Phase = "running", Message = null, SessionId = sessionId, StartedAt = sessionStart.ToString("O") };
            await RunSessionAsync(running, inst, sessionId, Core.Domain.SessionSources.Tracked, sessionStart, pids,
                new LaunchedFeed(inst, hints, excluded, pids), adopted: false, ct);
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

    // ---------------- Track H: one recording loop for every session ----------------

    /// <summary>
    /// Starts recording a game VYSTRAL didn't launch (noticed by the game detector), or continues
    /// <paramref name="adopt"/>, a session another VYSTRAL process handed over. Returns null when a launch
    /// or another session is already in progress. Recording is identical to a launch: same samples,
    /// frame-rate capture, background apps and GPU driver, stored in the same tables.
    /// </summary>
    public LaunchStateDto? TrackExternal(Installation inst, IReadOnlyList<int> pids, DateTimeOffset start, ISessionFeed feed, OpenSessionRow? adopt = null)
    {
        var source = adopt?.Source ?? ExternalSource;
        var provisional = new LaunchStateDto(LibraryRepository.NewId(), inst.GameId, inst.Id, inst.Platform.Key(), "running", null,
            StartedAt: start.ToString("O"), Source: source);
        var cts = new CancellationTokenSource();
        lock (_lock)
        {
            if (IsBusyLocked())
            {
                cts.Dispose();
                return null;
            }
            _watchCts?.Cancel();
            _watchCts = cts;
            _current = provisional; // reserve: a launch now waits for this session like for any other
        }

        string sessionId;
        try { sessionId = adopt?.Id ?? _repo.StartSession(inst.GameId, inst.Id, start, source); }
        catch (Exception ex)
        {
            Log.Error("session", "Couldn't start a detected session", ex);
            Emit(provisional with { Phase = "ended", Message = null });
            return null;
        }
        var state = provisional with { SessionId = sessionId };
        lock (_lock) if (_current == provisional) _current = state; // readers see the session id right away
        Log.Info("session", adopt is null ? "Tracking a game started outside VYSTRAL" : "Continuing a handed-over session",
            new { gameId = inst.GameId, installationId = inst.Id, source, sessionId });
        _ = Task.Run(async () =>
        {
            try { await RunSessionAsync(state, inst, sessionId, source, start, [.. pids], feed, adopted: adopt is not null, cts.Token); }
            catch (Exception ex)
            {
                Log.Error("session", "Detected session watcher failed", ex);
                Emit(state with { Phase = "ended", Message = "VYSTRAL lost track of this session. The game was not affected." });
            }
        });
        return state;
    }

    /// <summary>
    /// Stops recording the running session <i>without ending it</i> (everything so far is flushed), so the
    /// other VYSTRAL process can continue it. Returns what was parked, or null when nothing was running.
    /// </summary>
    public async Task<ActiveSessionInfo?> ParkAsync(TimeSpan timeout)
    {
        RunningSession? running;
        lock (_lock) running = _running;
        if (running is null) return null;
        try { running.Park.Cancel(); } catch (ObjectDisposedException) { return null; }
        try { return await running.Parked.Task.WaitAsync(timeout); }
        catch (TimeoutException)
        {
            Log.Warn("session", "Hand-over timed out");
            return null;
        }
    }

    private bool IsBusyLocked() => IsActivePhase(_current?.Phase);

    private async Task RunSessionAsync(LaunchStateDto state, Installation inst, string sessionId, string source, DateTimeOffset sessionStart,
        List<int> pids, ISessionFeed feed, bool adopted, CancellationToken ct)
    {
        using var park = new CancellationTokenSource();
        using var wake = CancellationTokenSource.CreateLinkedTokenSource(ct, park.Token);
        var running = new RunningSession(park);
        lock (_lock) _running = running;
        var lastSeen = Clock();
        // Playtime excludes system sleep. A handed-over session continues from what the other process played.
        var played = adopted && SafePlayedSoFar(sessionId) is int prior
            ? new ActiveTime(lastSeen, prior, lastSeen)
            : new ActiveTime(sessionStart, 0, lastSeen);
        SessionTick? ended = null;
        var parked = false;
        var closed = false;
        ActiveSessionInfo Info() => new(sessionId, inst.GameId, inst.Id, source, sessionStart, lastSeen, played.SecondsAt(lastSeen));

        try
        {
            _trackedPids = [.. pids];
            Emit(state);
            Beat(Info());
            var lastBeat = Clock();
            using var recorder = new Recorder(this, sessionId, sessionStart, adopted);
            try
            {
                recorder.Begin(pids);
                while (!ct.IsCancellationRequested)
                {
                    await Task.Delay(TickInterval, wake.Token).ContinueWith(_ => { }, TaskScheduler.Default);
                    if (park.IsCancellationRequested) { parked = true; break; }
                    if (ct.IsCancellationRequested) break;
                    var now = Clock();
                    played.Tick(now);
                    var tick = feed.Next(now);
                    if (tick.Ended)
                    {
                        ended = tick;
                        break;
                    }
                    pids = [.. tick.Pids];
                    _trackedPids = [.. pids];
                    if (pids.Count > 0) lastSeen = now;
                    recorder.Tick(now, sessionStart, pids);
                    if (now - lastBeat >= TimeSpan.FromSeconds(30))
                    {
                        Beat(Info());
                        lastBeat = now;
                    }
                }
            }
            finally
            {
                await recorder.StopCaptureAsync();
            }

            _trackedPids = [];
            if (parked)
            {
                recorder.Flush();
                var info = Info();
                // The next process continues from the time played so far (see SafePlayedSoFar).
                try { _repo.TouchOpenSession(sessionId, info.PlayedSeconds ?? 0); }
                catch (Exception ex) { Log.Warn("session", "Couldn't record session progress", ex: ex); }
                try { feed.Parked(); } catch (Exception ex) { Log.Warn("session", "Hand-over handler failed", ex: ex); }
                running.Parked.TrySetResult(info);
                Log.Info("session", "Session handed over", new { sessionId, source });
                Emit(state with { Phase = "ended", Message = null, SessionId = null });
                return;
            }

            var stopped = ended is null;
            if (stopped)
            {
                try { feed.Stopped(lastSeen); } catch (Exception ex) { Log.Warn("session", "Stop handler failed", ex: ex); }
                try { TrackingStopped?.Invoke(inst.Id); } catch (Exception ex) { Log.Warn("session", "TrackingStopped handler failed", ex: ex); }
            }
            var end = ended?.LastSeen is { } seen && seen != default ? seen : lastSeen;
            // Time played, not time elapsed: a PC that slept or hibernated with the game open didn't play.
            var duration = played.SecondsAt(end);
            var keep = source == Core.Domain.SessionSources.Tracked || (ended?.Keep ?? end - sessionStart >= MinExternalSession);
            if (!keep)
            {
                _repo.DeleteSession(sessionId);
                closed = true;
                Log.Info("session", "Discarded a detected session shorter than a minute", new { sessionId, duration });
                Emit(state with
                {
                    Phase = "ended",
                    Message = stopped ? "Stopped tracking. Sessions shorter than a minute aren't saved." : null,
                    SessionId = null,
                    DurationSeconds = duration,
                });
                return;
            }
            var summary = recorder.Summarize();
            _repo.EndSession(sessionId, end, duration, summary);
            closed = true;
            Emit(state with
            {
                Phase = "ended",
                Message = stopped ? "Stopped tracking. The session so far was saved." : null,
                SessionId = sessionId,
                DurationSeconds = duration,
                PerfSummary = summary,
                StartedAt = sessionStart.ToString("O"),
            });
        }
        finally
        {
            _trackedPids = [];
            lock (_lock) if (_running == running) _running = null;
            running.Parked.TrySetResult(null);
            // A handed-over (or interrupted) session stays open, and its note stays for recovery; only a closed one is announced.
            if (closed)
            {
                try { SessionClosed?.Invoke(sessionId); } catch (Exception ex) { Log.Warn("session", "SessionClosed handler failed", ex: ex); }
            }
        }
    }

    private long _lastPersistedBeat;

    private void Beat(ActiveSessionInfo info)
    {
        // Persist the running length every ~30 s, so a crash with performance recording off doesn't
        // recover the session as 0 s (recovery otherwise only has the last performance sample).
        var nowTicks = Environment.TickCount64;
        if (nowTicks - Interlocked.Read(ref _lastPersistedBeat) >= 30_000)
        {
            Interlocked.Exchange(ref _lastPersistedBeat, nowTicks);
            var seconds = info.PlayedSeconds ?? (int)Math.Clamp((info.LastSeen - info.Start).TotalSeconds, 0, int.MaxValue);
            try { _repo.TouchOpenSession(info.SessionId, seconds); }
            catch (Exception ex) { Log.Warn("session", "Couldn't record session progress", ex: ex); }
        }
        try { Heartbeat?.Invoke(info); }
        catch (Exception ex) { Log.Warn("session", "Heartbeat handler failed", ex: ex); }
    }

    /// <summary>What a handed-over session recorded as played before the hand-over, or null when unknown.</summary>
    private int? SafePlayedSoFar(string sessionId)
    {
        try { return _repo.GetOpenSessionSeconds(sessionId); }
        catch (Exception ex)
        {
            Log.Warn("session", "Couldn't read the handed-over session's progress", ex: ex);
            return null;
        }
    }

    /// <summary>
    /// Time actually played in a session: wall-clock time minus the gaps between session steps long enough to
    /// be system sleep or hibernation (steps run every ~2 s while the PC is awake, so a gap over
    /// <see cref="SleepGap"/> means the PC wasn't). Counted from <c>origin</c> on top of <c>priorSeconds</c>.
    /// </summary>
    internal sealed class ActiveTime(DateTimeOffset origin, int priorSeconds, DateTimeOffset now)
    {
        public static readonly TimeSpan SleepGap = TimeSpan.FromSeconds(30);
        private readonly List<(DateTimeOffset From, DateTimeOffset To)> _gaps = [];
        private DateTimeOffset _last = now;

        /// <summary>One session step at <paramref name="now"/>.</summary>
        public void Tick(DateTimeOffset now)
        {
            if (now - _last > SleepGap) _gaps.Add((_last, now));
            if (now > _last) _last = now;
        }

        /// <summary>Seconds played from the session start up to <paramref name="end"/>.</summary>
        public int SecondsAt(DateTimeOffset end)
        {
            var seconds = (end - origin).TotalSeconds;
            foreach (var (from, to) in _gaps)
            {
                var a = from < origin ? origin : from;
                var b = to > end ? end : to;
                if (b > a) seconds -= (b - a).TotalSeconds;
            }
            return (int)Math.Clamp(priorSeconds + Math.Max(0, seconds), 0, int.MaxValue);
        }
    }

    /// <summary>
    /// The original launch rules: keep the known processes while they live, rescan the install folder every
    /// 10 s (or when they are all gone) to follow launcher → game hand-offs, and end 8 s after the last one.
    /// </summary>
    private sealed class LaunchedFeed(Installation inst, IReadOnlyCollection<string> hints, List<string> excluded, List<int> pids) : ISessionFeed
    {
        private List<int> _pids = pids;
        private DateTimeOffset _lastSeen = DateTimeOffset.UtcNow;
        private DateTimeOffset _lastRescan = DateTimeOffset.UtcNow;

        public SessionTick Next(DateTimeOffset now)
        {
            _pids = _pids.Where(ProcessScanner.IsAlive).ToList();
            if (_pids.Count == 0 || now - _lastRescan > TimeSpan.FromSeconds(10))
            {
                // Games often hand off to a second process (launcher → game); rescan to follow it.
                _pids = ProcessScanner.FindUnder(ProcessScanner.Snapshot(), inst.InstallPath, hints, excluded).Select(p => p.Id).ToList();
                _lastRescan = now;
            }
            if (_pids.Count > 0) _lastSeen = now;
            else if (now - _lastSeen > TimeSpan.FromSeconds(8)) return new SessionTick([], Ended: true, LastSeen: _lastSeen);
            return new SessionTick(_pids);
        }

        public void Stopped(DateTimeOffset now) { }

        public void Parked() { }
    }

    /// <summary>Everything recorded while a session runs: performance samples, frame rate, GPU state, background apps.</summary>
    private sealed class Recorder : IDisposable
    {
        private readonly SessionService _svc;
        private readonly string _sessionId;
        private readonly PerfSampler? _sampler;
        private readonly FpsSession? _fps;
        private readonly BackgroundAppTracker? _backgroundOwner;
        private BackgroundAppTracker? _background;
        private readonly List<PerfSampleDto> _samples = [];
        private readonly List<InsightSampleDto> _extras = [];
        private readonly List<PerfSampleDto> _pending = [];
        private readonly List<InsightSampleDto> _pendingExtras = [];
        private DateTimeOffset _lastFlush = DateTimeOffset.UtcNow;
        private int _tick;

        public Recorder(SessionService svc, string sessionId, DateTimeOffset start, bool adopted)
        {
            _svc = svc;
            _sessionId = sessionId;
            var collect = svc._settings.GetBool("performance.collectMetrics");
            _sampler = collect ? new PerfSampler() : null;
            _fps = collect ? new FpsSession(svc.SafeFpsPlan()) : null;
            if (_sampler is not null) svc.RecordGpu(sessionId, _sampler);
            if (adopted)
            {
                // A handed-over session: its summary covers the samples recorded before the hand-over too.
                try
                {
                    _samples.AddRange(svc._repo.GetPerfSamples(sessionId));
                    _extras.AddRange(svc._repo.GetInsightSamples(sessionId));
                }
                catch (Exception ex) { Log.Warn("session", "Couldn't read the handed-over session's samples", ex: ex); }
            }
            // Background apps are aggregated in memory; a handed-over session keeps the report of its first part.
            var keepExisting = adopted && SafeHasBackgroundApps(svc, sessionId);
            _backgroundOwner = _sampler is not null && !keepExisting ? svc.SafeBackgroundTracker() : null;
            _background = _backgroundOwner;
        }

        private static bool SafeHasBackgroundApps(SessionService svc, string sessionId)
        {
            try { return svc._repo.HasBackgroundApps(sessionId); }
            catch (Exception) { return true; }
        }

        public void Begin(IReadOnlyList<int> pids) => _fps?.Update(pids);

        public void Tick(DateTimeOffset now, DateTimeOffset sessionStart, IReadOnlyList<int> pids)
        {
            if (_sampler is null) return;
            var t = (int)(now - sessionStart).TotalMilliseconds;
            var sample = _sampler.Sample(t);
            _samples.Add(sample);
            _pending.Add(sample);

            _fps?.Update(pids);
            var (clock, flags) = _sampler.ReadGpuState();
            var window = _fps?.Drain();
            var extra = new InsightSampleDto(t, clock, flags, window?.Fps, window?.FrameTimeMs, window?.FrameTimeP99Ms);
            if (clock is not null || flags is not null || window is not null)
            {
                _extras.Add(extra);
                _pendingExtras.Add(extra);
            }

            try { _svc.Sampled?.Invoke(sample); } catch (Exception ex) { Log.Warn("session", "Sample handler failed", ex: ex); }
            // Track F: one handle-free process snapshot every ~30 s (the first one is the CPU baseline).
            if (_background is not null && _tick++ % BackgroundAppTracker.EveryTicks == 0)
            {
                try { _background.Snapshot(pids); }
                catch (Exception ex) { Log.Warn("session", "Background-app snapshot failed", ex: ex); _background = null; }
            }
            if (now - _lastFlush > TimeSpan.FromSeconds(30))
            {
                Flush();
                _lastFlush = now;
            }
        }

        public void Flush()
        {
            _svc.Flush(_sessionId, _pending, _pendingExtras);
            _svc.FlushBackground(_sessionId, _background);
        }

        public async Task StopCaptureAsync()
        {
            if (_fps is not null) await _fps.StopAsync();
        }

        /// <summary>Flushes what is left and returns the session's summary JSON (null without metrics).</summary>
        public string? Summarize()
        {
            Flush();
            if (_sampler is null) return null;
            var frames = _fps?.Summarize();
            return PerfSampler.ToJson(PerfSampler.Summarize(_samples, _extras, frames, _fps?.Status(frames) ?? PerfSampler.FpsUnavailable));
        }

        public void Dispose()
        {
            _backgroundOwner?.Dispose();
            _sampler?.Dispose();
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

    internal void Emit(LaunchStateDto state)
    {
        lock (_lock)
        {
            if (_current is { } current && current.Ticket != state.Ticket)
            {
                if (state.Phase is not "failed")
                {
                    // Every launch and session reserves _current (its own ticket) before it emits anything, so a
                    // state for another ticket comes from a superseded watcher: it must not touch the current one.
                    Log.Info("session", "Ignored a state from a superseded launch", new { state.Phase });
                    return;
                }
                // A rejected second launch is reported, but doesn't overwrite the active one.
                if (!IsBusyLocked()) _current = state;
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
