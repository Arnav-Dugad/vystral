using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Launch;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Tracking;

/// <summary>
/// The launch slot (one launch or session at a time, even when two requests race), stale states from a
/// superseded watcher, and playtime that excludes system sleep. No process is started: the launcher is faked.
/// </summary>
public sealed class SessionLifecycleTests : IDisposable
{
    private readonly TestDb _t = new();
    private readonly SettingsService _settings;
    private readonly Events _events = new();
    private int _starts;

    public SessionLifecycleTests()
    {
        _settings = new SettingsService(_t.Repo);
        _settings.Set("performance.collectMetrics", System.Text.Json.Nodes.JsonValue.Create(false));
    }

    public void Dispose() => _t.Dispose();

    /// <summary>A manual game whose exe exists but never runs (so it is never detected).</summary>
    private string AddGame(string name)
    {
        var exe = _t.Dir.Write(Path.Combine(name, "game.exe"), "not a real program");
        return _t.Repo.AddManualGame(name, exe, null);
    }

    private SessionService Service(TimeSpan? detection = null)
    {
        var s = new SessionService(_t.Repo, [], _settings, _events)
        {
            Starter = (_, _, _) =>
            {
                Interlocked.Increment(ref _starts);
                return new LaunchStartResult(true, null, null);
            },
        };
        if (detection is { } d) s.DetectionWindow = d;
        return s;
    }

    private static async Task Until(Func<bool> condition, int timeoutMs = 8000)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (!condition())
        {
            if (Environment.TickCount64 > deadline) throw new TimeoutException("Condition not met in time.");
            await Task.Delay(20);
        }
    }

    [Fact]
    public async Task Two_launches_at_the_same_moment_start_the_game_once()
    {
        var game = AddGame("Racer");
        using var sessions = Service();
        using var barrier = new Barrier(2);
        LaunchStateDto Launch()
        {
            barrier.SignalAndWait(TestContext.Current.CancellationToken);
            return sessions.Launch(game, null);
        }

        var results = await Task.WhenAll(Task.Run(Launch), Task.Run(Launch));

        Assert.Equal(1, _starts);
        Assert.Single(results, r => r.Phase == "waiting");
        var rejected = Assert.Single(results, r => r.Phase == "failed");
        Assert.Equal("Another game is still starting.", rejected.Message);
        Assert.Equal("waiting", sessions.Current!.Phase); // the rejected one didn't replace it

        sessions.StopTracking();
        await Until(() => !sessions.IsBusy);
    }

    [Fact]
    public async Task A_launch_waiting_after_not_detected_holds_the_slot_and_a_superseded_watcher_cannot_change_the_current_launch()
    {
        var a = AddGame("Alpha");
        var b = AddGame("Beta");
        using var sessions = Service(detection: TimeSpan.FromMilliseconds(100));

        var first = sessions.Launch(a, null);
        await Until(() => sessions.Current?.Phase == "notDetected");

        // While A is still waited for, B is refused (and the refusal doesn't replace A).
        var refused = sessions.Launch(b, null);
        Assert.Equal("failed", refused.Phase);
        Assert.Equal(first.Ticket, sessions.Current!.Ticket);
        Assert.Equal("notDetected", sessions.Current.Phase);
        Assert.Equal(1, _starts);

        // The user stops waiting for A, then launches B.
        sessions.StopTracking();
        await Until(() => sessions.Current?.Phase == "ended");
        var second = sessions.Launch(b, null);
        Assert.Equal("waiting", second.Phase);
        Assert.Equal(2, _starts);

        // A late state from A's (cancelled) watcher must not overwrite B's launch, nor reach the UI.
        var before = _events.Count;
        sessions.Emit(first with { Phase = "ended", Message = "Stopped tracking. The game was not affected." });
        Assert.Equal(second.Ticket, sessions.Current!.Ticket);
        Assert.Equal("waiting", sessions.Current.Phase);
        Assert.Equal(before, _events.Count);

        sessions.StopTracking();
        await Until(() => !sessions.IsBusy);
    }

    [Fact]
    public async Task Stop_waiting_right_after_a_launch_is_never_lost()
    {
        var game = AddGame("Quick");
        using var sessions = Service();
        sessions.Launch(game, null);
        sessions.StopTracking();
        await Until(() => sessions.Current?.Phase == "ended");
        Assert.False(sessions.IsBusy);
    }

    [Fact]
    public async Task System_sleep_while_a_game_is_open_is_not_counted_as_playtime()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "10", "Sleeper", installPath: @"D:\Games\Sleeper"))]);
        var inst = Assert.Single(_t.Repo.GetDetectableInstallations());
        var start = DateTimeOffset.UtcNow.AddHours(-3);
        var clock = start;
        var feed = new SleepyFeed(() => clock, t => clock = t);
        using var sessions = Service();
        sessions.Clock = () => clock;
        sessions.TickInterval = TimeSpan.FromMilliseconds(1);

        var running = sessions.TrackExternal(inst, [4100], start, feed);
        Assert.NotNull(running);
        await Until(() => sessions.Current?.Phase == "ended");

        var saved = Assert.Single(_t.Repo.ListSessions(null, 10));
        // 40 ticks of 2 s were played; the 2-hour gap in the middle was the PC sleeping.
        Assert.InRange(saved.DurationSeconds, 76, 84);
        Assert.True((DateTimeOffset.Parse(saved.End!) - DateTimeOffset.Parse(saved.Start)).TotalHours >= 2); // it did end after the sleep
    }

    [Fact]
    public void Played_time_skips_gaps_longer_than_a_sleep_but_keeps_ordinary_steps()
    {
        var t0 = new DateTimeOffset(2026, 10, 6, 20, 0, 0, TimeSpan.Zero);
        var played = new SessionService.ActiveTime(t0, 0, t0);
        for (var i = 1; i <= 30; i++) played.Tick(t0.AddSeconds(2 * i)); // 60 s awake
        var wake = t0.AddSeconds(60).AddHours(8);                       // a night asleep
        played.Tick(wake);
        played.Tick(wake.AddSeconds(2));
        played.Tick(wake.AddSeconds(25));                               // a slow step, not a sleep

        Assert.Equal(60 + 25, played.SecondsAt(wake.AddSeconds(25)));
        Assert.Equal(60, played.SecondsAt(t0.AddSeconds(60).AddHours(1))); // ended during the sleep: nothing after it counts
        Assert.Equal(30, played.SecondsAt(t0.AddSeconds(30)));

        // A handed-over session continues from what was played before the hand-over.
        var adopted = new SessionService.ActiveTime(wake, 600, wake);
        adopted.Tick(wake.AddSeconds(2));
        Assert.Equal(610, adopted.SecondsAt(wake.AddSeconds(10)));
    }

    // ---------------- fakes ----------------

    /// <summary>20 steps of 2 s, a 2-hour jump (the PC slept), 20 more steps, then the game ends.</summary>
    private sealed class SleepyFeed(Func<DateTimeOffset> now, Action<DateTimeOffset> set) : ISessionFeed
    {
        private int _step;

        public SessionTick Next(DateTimeOffset at)
        {
            _step++;
            if (_step > 41) return new SessionTick([], Ended: true, LastSeen: at, Keep: true);
            set(now() + (_step == 20 ? TimeSpan.FromHours(2) : TimeSpan.FromSeconds(2)));
            return new SessionTick([4100]);
        }

        public void Stopped(DateTimeOffset at) { }
        public void Parked() { }
    }

    private sealed class Events : IEventSink
    {
        private int _count;
        public int Count => Volatile.Read(ref _count);

        public void Emit(string eventName, object? payload)
        {
            if (eventName == "launch.state") Interlocked.Increment(ref _count);
        }
    }
}
