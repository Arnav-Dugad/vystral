using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Windows.Launch;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;

namespace Vystral.Windows.Tracking;

/// <summary>
/// Notices installed games that were started outside VYSTRAL and records them through
/// <see cref="SessionService"/>, exactly like a launch. The same class runs in the app (while it is open)
/// and in the background tracker (while it is closed); only the process that owns tracking runs it
/// (see <see cref="TrackerSignals"/>).
/// <para>
/// Idle cost: every <see cref="PollInterval"/> (<see cref="SavingPollInterval"/> on battery or energy saver)
/// it looks only at the process owning the foreground window and at the processes matched last time, each
/// with one handle-free path query; a full system snapshot (about 10 ms of CPU with ~400 processes) runs
/// once every <see cref="IdleFullScanInterval"/>. While a session runs, every 2 s step takes a full snapshot,
/// which (unlike a path query) skips processes that have exited but are still referenced, so the session ends
/// when the game really closed. Nothing is opened, read or injected.
/// </para>
/// </summary>
public sealed class ExternalTracker : IDisposable
{
    public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(4);
    public static readonly TimeSpan SavingPollInterval = TimeSpan.FromSeconds(15);
    public static readonly TimeSpan TargetsMaxAge = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan IdleFullScanInterval = TimeSpan.FromSeconds(60);

    private readonly LibraryRepository _repo;
    private readonly SessionService _sessions;
    private readonly Func<IReadOnlyList<string>> _clientDirs;
    private readonly Lazy<IRunningProcessSource> _processes;
    private readonly TrackerFiles _files;
    private readonly IPowerStatus _power;
    private readonly GameDetector _detector = new();
    private readonly Lock _lock = new();
    private GameMatcher _matcher = new([]);
    private DateTimeOffset _targetsLoaded = DateTimeOffset.MinValue;
    private volatile bool _targetsDirty = true;
    private DateTimeOffset _lastFullScan = DateTimeOffset.MinValue;
    /// <summary>Every process matched by the last observation (candidates, the active game, ignored-until-exit games).</summary>
    private HashSet<int> _watched = [];

    public ExternalTracker(LibraryRepository repo, SessionService sessions, Func<IReadOnlyList<string>> clientDirs,
        Func<IRunningProcessSource> processes, TrackerFiles files, IPowerStatus power)
    {
        _repo = repo;
        _sessions = sessions;
        _clientDirs = clientDirs;
        _processes = new Lazy<IRunningProcessSource>(processes);
        _files = files;
        _power = power;
        _sessions.Heartbeat += OnHeartbeat;
        _sessions.SessionClosed += OnSessionClosed;
        _sessions.TrackingStopped += OnTrackingStopped;
    }

    /// <summary>When the last idle poll ran (null before the first).</summary>
    public DateTimeOffset? LastPoll { get; private set; }

    /// <summary>Number of installed games currently watched.</summary>
    public int TargetCount => _matcher.Targets.Count;

    /// <summary>Reloads the watched games on the next poll (library changed, a game was ignored).</summary>
    public void InvalidateTargets() => _targetsDirty = true;

    /// <summary>Polls until cancelled. Skips polls while a launch or session is in progress (the session follows its game itself).</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { PollOnce(DateTimeOffset.UtcNow); }
            catch (Exception ex) { Log.Warn("tracker", "Detection poll failed", ex: ex); }
            try { await Task.Delay(_power.Saving ? SavingPollInterval : PollInterval, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>One idle poll. Starts a session when the detector confirms a game.</summary>
    public LaunchStateDto? PollOnce(DateTimeOffset now)
    {
        if (_sessions.IsBusy) return null;
        var reloaded = EnsureTargets(now);
        LastPoll = now;
        if (_matcher.Targets.Count == 0) return null;
        DetectorSignal signal;
        lock (_lock)
        {
            var snapshot = Observe(now, reloaded ? TimeSpan.Zero : IdleFullScanInterval, out _);
            signal = _detector.Observe(now, Match(snapshot));
        }
        if (signal is not { Event: DetectorEvent.Started, Target: { } target }) return null;

        var inst = _repo.GetInstallation(target.InstallationId);
        var started = inst is null ? null : _sessions.TrackExternal(inst, signal.Pids ?? [], signal.Start, new Feed(this));
        if (started is null)
        {
            // A launch got there first (or the game left the library): forget it; it is re-detected if still running.
            lock (_lock) _detector.Pause();
        }
        return started;
    }

    // ---------------- ownership ----------------

    /// <summary>
    /// Called when this process becomes the tracker: continues the session the other process handed over
    /// (or recorded a heartbeat for) if its game is still running, otherwise ends it where it was last seen,
    /// and closes any other session left open by a crash.
    /// </summary>
    public void TakeOver(DateTimeOffset now)
    {
        var note = _files.ReadSession();
        var keepOpen = new List<string>();
        Dictionary<string, DateTimeOffset>? lastSeen = null;
        if (note is not null)
        {
            var open = _repo.GetOpenSession(note.SessionId);
            if (open is null) _files.ClearSession(note.SessionId);
            else if (TryAdopt(open, now)) keepOpen.Add(open.Id);
            else
            {
                CloseAt(open, note.LastSeen);
                lastSeen = new() { [note.SessionId] = note.LastSeen };
            }
        }
        var recovered = _repo.RecoverOpenSessions(keepOpen, lastSeen);
        if (recovered > 0) Log.Info("tracker", $"Closed {recovered} session(s) left open by an interrupted tracker");
    }

    /// <summary>Hands the running session to the other process (it stays open in the database). False when none was running.</summary>
    public async Task<bool> ParkAsync(TimeSpan timeout)
    {
        var info = await _sessions.ParkAsync(timeout);
        if (info is null) return false;
        _files.WriteSession(new TrackerSessionNote(info.SessionId, info.GameId, info.InstallationId, info.Source, info.Start, info.LastSeen,
            Environment.ProcessId, Parked: true));
        return true;
    }

    private bool TryAdopt(OpenSessionRow open, DateTimeOffset now)
    {
        if (open.InstallationId is null) return false;
        var inst = _repo.GetInstallation(open.InstallationId);
        if (inst is null) return false;
        var target = GameMatcher.BuildTargets([inst], SafeClientDirs(), new HashSet<string>()).FirstOrDefault();
        if (target is null) return false;
        var pids = GameMatcher.PidsFor(target, _processes.Value.Snapshot());
        if (pids.Count == 0) return false;
        lock (_lock)
        {
            _detector.Resume(target, open.Start, now);
            _watched = [.. pids];
        }
        if (_sessions.TrackExternal(inst, pids, open.Start, new Feed(this), adopt: open) is not null) return true;
        lock (_lock) _detector.Pause();
        return false;
    }

    /// <summary>The game of a handed-over session is no longer running: end it where it was last seen.</summary>
    private void CloseAt(OpenSessionRow open, DateTimeOffset lastSeen)
    {
        var end = lastSeen < open.Start ? open.Start : lastSeen;
        var duration = (int)Math.Max(0, (end - open.Start).TotalSeconds);
        if (open.Source != SessionSources.Tracked && end - open.Start < SessionService.MinExternalSession)
        {
            _repo.DeleteSession(open.Id);
        }
        else
        {
            string? summary = null;
            try
            {
                var samples = _repo.GetPerfSamples(open.Id);
                if (samples.Count > 0)
                    summary = PerfSampler.ToJson(PerfSampler.Summarize(samples, _repo.GetInsightSamples(open.Id), null,
                        "VYSTRAL stopped watching this game before it closed, so FPS wasn't summarised."));
            }
            catch (Exception ex) { Log.Warn("tracker", "Couldn't summarise a recovered session", ex: ex); }
            _repo.EndSession(open.Id, end, duration, summary);
        }
        _files.ClearSession(open.Id);
        Log.Info("tracker", "Closed a handed-over session whose game had exited", new { sessionId = open.Id, duration });
    }

    // ---------------- targets ----------------

    private bool EnsureTargets(DateTimeOffset now)
    {
        if (!_targetsDirty && now - _targetsLoaded < TargetsMaxAge) return false;
        var ignored = _files.ReadIgnored();
        var targets = GameMatcher.BuildTargets(_repo.GetDetectableInstallations(), SafeClientDirs(), ignored);
        _matcher = new GameMatcher(targets);
        _targetsLoaded = now;
        _targetsDirty = false;
        return true;
    }

    /// <summary>
    /// The processes to look at now: a full snapshot when one is due, otherwise only the foreground window's
    /// process and the processes matched last time (a game being confirmed, the running game, a stopped one).
    /// Callers hold <see cref="_lock"/>.
    /// </summary>
    private IReadOnlyList<RunningProcess> Observe(DateTimeOffset now, TimeSpan fullEvery, out bool full)
    {
        var source = _processes.Value;
        full = now - _lastFullScan >= fullEvery || now < _lastFullScan;
        if (full)
        {
            _lastFullScan = now;
            return source.Snapshot();
        }
        var list = new List<RunningProcess>(_watched.Count + 1);
        var seen = new HashSet<int>();
        if (source.ForegroundPid() is int fg && seen.Add(fg) && source.Query(fg) is { } front) list.Add(front);
        foreach (var pid in _watched)
            if (seen.Add(pid) && source.Query(pid) is { } p) list.Add(p);
        return list;
    }

    /// <summary>Matches a snapshot (plus the active game, as a launch finds it) and remembers the matched processes.</summary>
    private IReadOnlyList<GameMatch> Match(IReadOnlyList<RunningProcess> snapshot)
    {
        var matches = _matcher.Match(snapshot).ToList();
        if (_detector.ActiveTarget is { } t && !_matcher.Targets.Any(x => x.InstallationId == t.InstallationId))
        {
            // Hidden, ignored or removed after it started: still followed until it ends.
            var pids = GameMatcher.PidsFor(t, snapshot);
            if (pids.Count > 0) matches.Add(new GameMatch(t, pids, true));
        }
        _watched = matches.SelectMany(m => m.Pids).ToHashSet();
        return matches;
    }

    private IReadOnlyList<string> SafeClientDirs()
    {
        try { return _clientDirs(); }
        catch (Exception ex)
        {
            Log.Warn("tracker", "Store client folders unavailable", ex: ex);
            return [];
        }
    }

    // ---------------- session events ----------------

    private void OnHeartbeat(ActiveSessionInfo info) =>
        _files.WriteSession(new TrackerSessionNote(info.SessionId, info.GameId, info.InstallationId, info.Source, info.Start, info.LastSeen,
            Environment.ProcessId, Parked: false));

    private void OnSessionClosed(string sessionId) => _files.ClearSession(sessionId);

    private void OnTrackingStopped(string installationId)
    {
        lock (_lock) _detector.Suppress(installationId);
    }

    /// <summary>Follows a detected session with the same detector (and so the same rules) that started it.</summary>
    private sealed class Feed(ExternalTracker owner) : ISessionFeed
    {
        public SessionTick Next(DateTimeOffset now)
        {
            DetectorSignal s;
            lock (owner._lock)
            {
                if (owner._detector.ActiveTarget is null) return new SessionTick([], Ended: true, LastSeen: now, Keep: true);
                // A full snapshot each step: it follows launcher → game hand-offs and never mistakes an exited
                // (but still referenced) process for a running game.
                s = owner._detector.Observe(now, owner.Match(owner.Observe(now, TimeSpan.Zero, out _)));
            }
            return s.Event == DetectorEvent.Ended
                ? new SessionTick([], Ended: true, LastSeen: s.LastSeen, Keep: s.Keep)
                : new SessionTick(s.Pids ?? []);
        }

        public void Stopped(DateTimeOffset now)
        {
            lock (owner._lock) owner._detector.Stop(now);
        }

        public void Parked()
        {
            lock (owner._lock) owner._detector.Pause();
        }
    }

    public void Dispose()
    {
        _sessions.Heartbeat -= OnHeartbeat;
        _sessions.SessionClosed -= OnSessionClosed;
        _sessions.TrackingStopped -= OnTrackingStopped;
        if (_processes.IsValueCreated) (_processes.Value as IDisposable)?.Dispose();
    }
}
