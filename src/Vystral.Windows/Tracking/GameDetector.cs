namespace Vystral.Windows.Tracking;

public enum DetectorEvent
{
    /// <summary>Nothing to do (idle, or a game is still being confirmed).</summary>
    None,
    /// <summary>A game was confirmed running: start a session at <see cref="DetectorSignal.Start"/>.</summary>
    Started,
    /// <summary>The active game is still running (or within the end grace period).</summary>
    Running,
    /// <summary>The active game ended at <see cref="DetectorSignal.LastSeen"/>.</summary>
    Ended,
}

public readonly record struct DetectorSignal(
    DetectorEvent Event,
    DetectionTarget? Target = null,
    IReadOnlyList<int>? Pids = null,
    DateTimeOffset Start = default,
    DateTimeOffset LastSeen = default,
    bool Keep = false)
{
    public int DurationSeconds => (int)Math.Max(0, (LastSeen - Start).TotalSeconds);
}

/// <summary>
/// The rules for games VYSTRAL didn't launch, as a pure state machine fed with snapshots (so it is
/// tested without real processes):
/// <list type="bullet">
/// <item>A game counts as started once its own executable (not a crash handler or installer) is seen in
/// <see cref="ConfirmPolls"/> consecutive polls; the session starts when it was first seen.</item>
/// <item>Any process in the game's folder keeps it running, so launcher → game hand-offs continue the same session.</item>
/// <item>It ends <see cref="EndGrace"/> after the last process disappears (the same grace as a launch).</item>
/// <item>Sessions shorter than <see cref="MinSession"/> are not kept.</item>
/// <item>One game is tracked at a time; another game already running starts its own session when the first ends.</item>
/// <item>A game whose tracking the user stopped is ignored until it has exited.</item>
/// </list>
/// </summary>
public sealed class GameDetector
{
    public static readonly TimeSpan EndGrace = TimeSpan.FromSeconds(8);
    public static readonly TimeSpan MinSession = TimeSpan.FromSeconds(60);
    public const int ConfirmPolls = 2;

    private readonly Dictionary<string, (DateTimeOffset First, int Polls)> _candidates = new(StringComparer.Ordinal);
    private readonly HashSet<string> _suppressed = new(StringComparer.Ordinal);
    private Active? _active;

    private sealed record Active(DetectionTarget Target, DateTimeOffset Start, DateTimeOffset LastSeen);

    public DetectionTarget? ActiveTarget => _active?.Target;

    public DetectorSignal Observe(DateTimeOffset now, IReadOnlyList<GameMatch> matches)
    {
        var byId = new Dictionary<string, GameMatch>(StringComparer.Ordinal);
        foreach (var m in matches) byId.TryAdd(m.Target.InstallationId, m);

        // A stopped game is ignored until it is gone.
        _suppressed.RemoveWhere(id => !byId.ContainsKey(id));

        // Candidates: confirmed only while the game's own executable is running.
        foreach (var id in _candidates.Keys.ToList())
            if (!byId.TryGetValue(id, out var m) || !m.HasPrimary) _candidates.Remove(id);
        foreach (var m in matches)
        {
            if (!m.HasPrimary || _suppressed.Contains(m.Target.InstallationId) || _active?.Target.InstallationId == m.Target.InstallationId) continue;
            _candidates[m.Target.InstallationId] = _candidates.TryGetValue(m.Target.InstallationId, out var c) ? (c.First, c.Polls + 1) : (now, 1);
        }

        if (_active is { } active)
        {
            if (byId.TryGetValue(active.Target.InstallationId, out var running) && running.Pids.Count > 0)
            {
                _active = active with { LastSeen = now };
                return new DetectorSignal(DetectorEvent.Running, active.Target, running.Pids, active.Start, now);
            }
            if (now - active.LastSeen <= EndGrace)
                return new DetectorSignal(DetectorEvent.Running, active.Target, [], active.Start, active.LastSeen);
            _active = null;
            return Ended(active);
        }

        var next = _candidates
            .Where(kv => kv.Value.Polls >= ConfirmPolls && byId.ContainsKey(kv.Key))
            .Select(kv => (Match: byId[kv.Key], kv.Value.First))
            .OrderBy(x => x.First).ThenByDescending(x => x.Match.Target.Depth).ThenBy(x => x.Match.Target.InstallationId, StringComparer.Ordinal)
            .FirstOrDefault();
        if (next.Match is null) return default;
        _candidates.Remove(next.Match.Target.InstallationId);
        _active = new Active(next.Match.Target, next.First, now);
        return new DetectorSignal(DetectorEvent.Started, next.Match.Target, next.Match.Pids, next.First, now);
    }

    /// <summary>The user stopped tracking: ends the active session now and ignores that game until it exits.</summary>
    public DetectorSignal Stop(DateTimeOffset now)
    {
        if (_active is not { } active) return default;
        _active = null;
        _suppressed.Add(active.Target.InstallationId);
        _candidates.Remove(active.Target.InstallationId);
        return Ended(active with { LastSeen = Max(active.LastSeen, now) });
    }

    /// <summary>Ignores a game until it exits (e.g. the user stopped tracking a game VYSTRAL launched).</summary>
    public void Suppress(string installationId)
    {
        _suppressed.Add(installationId);
        _candidates.Remove(installationId);
    }

    /// <summary>
    /// Hands the active session to another process: returns it without ending it and forgets it here.
    /// Null when nothing is active.
    /// </summary>
    public (DetectionTarget Target, DateTimeOffset Start, DateTimeOffset LastSeen)? Pause()
    {
        if (_active is not { } active) return null;
        _active = null;
        _candidates.Clear();
        return (active.Target, active.Start, active.LastSeen);
    }

    /// <summary>Continues a session started elsewhere (handed over, or recovered).</summary>
    public void Resume(DetectionTarget target, DateTimeOffset start, DateTimeOffset lastSeen)
    {
        _active = new Active(target, start, lastSeen);
        _candidates.Remove(target.InstallationId);
    }

    /// <summary>Forgets everything (the tracker stopped owning tracking).</summary>
    public void Reset()
    {
        _active = null;
        _candidates.Clear();
        _suppressed.Clear();
    }

    private static DetectorSignal Ended(Active a) =>
        new(DetectorEvent.Ended, a.Target, [], a.Start, a.LastSeen, Keep: a.LastSeen - a.Start >= MinSession);

    private static DateTimeOffset Max(DateTimeOffset a, DateTimeOffset b) => a > b ? a : b;
}
