using Vystral.Windows.Launch;
using Vystral.Windows.Tracking;
using Xunit;

namespace Vystral.Tests.Tracking;

/// <summary>The detector's rules, fed with fake snapshots (no real processes).</summary>
public sealed class GameDetectorTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 5, 20, 0, 0, TimeSpan.Zero);

    private static readonly DetectionTarget Ashen = Target(1, @"D:\Games\Ashen Crown\");
    private static readonly DetectionTarget Tide = Target(2, @"D:\Games\Tidebreak\");

    internal static DetectionTarget Target(int n, string root) =>
        new(n.ToString("x32"), (n + 100).ToString("x32"), $"Game {n}", root, new HashSet<string>(), []);

    private static readonly GameMatcher Matcher = new([Ashen, Tide]);

    private static IReadOnlyList<GameMatch> Snap(params (int Pid, string Path)[] processes) =>
        Matcher.Match(processes.Select(p => new RunningProcess(p.Pid, p.Path)).ToList());

    private static DateTimeOffset At(double seconds) => T0.AddSeconds(seconds);

    [Fact]
    public void A_game_starts_after_two_polls_and_the_session_starts_when_it_was_first_seen()
    {
        var d = new GameDetector();
        var game = (100, @"D:\Games\Ashen Crown\Ashen.exe");

        Assert.Equal(DetectorEvent.None, d.Observe(At(0), Snap(game)).Event);
        var started = d.Observe(At(4), Snap(game));

        Assert.Equal(DetectorEvent.Started, started.Event);
        Assert.Equal(Ashen.InstallationId, started.Target!.InstallationId);
        Assert.Equal(At(0), started.Start);
        Assert.Equal([100], started.Pids);
        Assert.Same(Ashen, d.ActiveTarget);
    }

    [Fact]
    public void Nothing_starts_when_nothing_matches()
    {
        var d = new GameDetector();
        Assert.Equal(DetectorEvent.None, d.Observe(At(0), Snap((5, @"C:\Windows\explorer.exe"))).Event);
        Assert.Equal(DetectorEvent.None, d.Observe(At(4), Snap((5, @"C:\Windows\explorer.exe"))).Event);
        Assert.Null(d.ActiveTarget);
    }

    [Fact]
    public void A_blip_seen_in_one_poll_never_starts_a_session()
    {
        var d = new GameDetector();
        d.Observe(At(0), Snap((100, @"D:\Games\Ashen Crown\Ashen.exe")));
        Assert.Equal(DetectorEvent.None, d.Observe(At(4), Snap()).Event);
        Assert.Equal(DetectorEvent.None, d.Observe(At(8), Snap((100, @"D:\Games\Ashen Crown\Ashen.exe"))).Event); // counting restarts
    }

    [Fact]
    public void A_session_shorter_than_a_minute_ends_but_is_not_kept()
    {
        var d = new GameDetector();
        var game = (100, @"D:\Games\Ashen Crown\Ashen.exe");
        d.Observe(At(0), Snap(game));
        d.Observe(At(4), Snap(game));
        d.Observe(At(30), Snap(game));

        Assert.Equal(DetectorEvent.Running, d.Observe(At(34), Snap()).Event); // within the 8 s grace
        var ended = d.Observe(At(40), Snap());

        Assert.Equal(DetectorEvent.Ended, ended.Event);
        Assert.Equal(At(30), ended.LastSeen);
        Assert.Equal(30, ended.DurationSeconds);
        Assert.False(ended.Keep);
        Assert.Null(d.ActiveTarget);
    }

    [Fact]
    public void A_session_ends_after_the_grace_period_and_is_kept_when_long_enough()
    {
        var d = new GameDetector();
        var game = (100, @"D:\Games\Ashen Crown\Ashen.exe");
        d.Observe(At(0), Snap(game));
        d.Observe(At(4), Snap(game));
        Assert.Equal(DetectorEvent.Running, d.Observe(At(600), Snap(game)).Event);

        Assert.Equal(DetectorEvent.Running, d.Observe(At(606), Snap()).Event);
        var ended = d.Observe(At(609), Snap());

        Assert.Equal(DetectorEvent.Ended, ended.Event);
        Assert.Equal(600, ended.DurationSeconds);
        Assert.True(ended.Keep);
    }

    [Fact]
    public void A_launcher_handing_off_to_the_game_continues_the_same_session()
    {
        var d = new GameDetector();
        var launcher = (100, @"D:\Games\Ashen Crown\Launcher\AshenLauncher.exe");
        var game = (220, @"D:\Games\Ashen Crown\Binaries\Win64\Ashen-Win64-Shipping.exe");
        d.Observe(At(0), Snap(launcher));
        var started = d.Observe(At(4), Snap(launcher));
        Assert.Equal(DetectorEvent.Started, started.Event);

        // The launcher exits, the game appears a few seconds later (within the grace period).
        Assert.Equal(DetectorEvent.Running, d.Observe(At(8), Snap()).Event);
        var running = d.Observe(At(12), Snap(game));
        Assert.Equal(DetectorEvent.Running, running.Event);
        Assert.Equal([220], running.Pids);
        Assert.Equal(At(0), running.Start);

        d.Observe(At(300), Snap(game));
        d.Observe(At(304), Snap());
        var ended = d.Observe(At(310), Snap());
        Assert.Equal(DetectorEvent.Ended, ended.Event);
        Assert.Equal(300, ended.DurationSeconds);
    }

    [Fact]
    public void A_crash_handler_alone_never_starts_a_session_but_keeps_one_alive()
    {
        var d = new GameDetector();
        var handler = (300, @"D:\Games\Ashen Crown\UnityCrashHandler64.exe");
        d.Observe(At(0), Snap(handler));
        Assert.Equal(DetectorEvent.None, d.Observe(At(4), Snap(handler)).Event);
        Assert.Equal(DetectorEvent.None, d.Observe(At(8), Snap(handler)).Event);

        var game = (100, @"D:\Games\Ashen Crown\Ashen.exe");
        d.Observe(At(12), Snap(game, handler));
        Assert.Equal(DetectorEvent.Started, d.Observe(At(16), Snap(game, handler)).Event);
        // The game exits; its crash handler lingers: still the same session.
        Assert.Equal(DetectorEvent.Running, d.Observe(At(100), Snap(handler)).Event);
        Assert.Equal(DetectorEvent.Running, d.Observe(At(120), Snap(handler)).Event);
    }

    [Fact]
    public void Two_games_one_at_a_time_and_the_second_starts_when_it_was_first_seen()
    {
        var d = new GameDetector();
        var a = (100, @"D:\Games\Ashen Crown\Ashen.exe");
        var b = (200, @"D:\Games\Tidebreak\Tidebreak.exe");
        d.Observe(At(0), Snap(a));
        Assert.Equal(Ashen.InstallationId, d.Observe(At(4), Snap(a)).Target!.InstallationId);

        // The second game starts while the first runs: noted, not tracked yet.
        Assert.Equal(DetectorEvent.Running, d.Observe(At(60), Snap(a, b)).Event);
        Assert.Equal(DetectorEvent.Running, d.Observe(At(64), Snap(a, b)).Event);
        Assert.Same(Ashen, d.ActiveTarget);

        // The first game closes.
        d.Observe(At(200), Snap(a, b));
        d.Observe(At(204), Snap(b));
        var ended = d.Observe(At(210), Snap(b));
        Assert.Equal(DetectorEvent.Ended, ended.Event);
        Assert.Equal(Ashen.InstallationId, ended.Target!.InstallationId);

        var second = d.Observe(At(214), Snap(b));
        Assert.Equal(DetectorEvent.Started, second.Event);
        Assert.Equal(Tide.InstallationId, second.Target!.InstallationId);
        Assert.Equal(At(60), second.Start);
    }

    [Fact]
    public void When_two_games_appear_together_the_one_seen_first_wins()
    {
        var d = new GameDetector();
        var a = (100, @"D:\Games\Ashen Crown\Ashen.exe");
        var b = (200, @"D:\Games\Tidebreak\Tidebreak.exe");
        d.Observe(At(0), Snap(b));
        d.Observe(At(4), Snap(a, b)); // b confirmed here
        Assert.Same(Tide, d.ActiveTarget);
    }

    [Fact]
    public void Stopping_ends_the_session_now_and_ignores_the_game_until_it_exits()
    {
        var d = new GameDetector();
        var game = (100, @"D:\Games\Ashen Crown\Ashen.exe");
        d.Observe(At(0), Snap(game));
        d.Observe(At(4), Snap(game));
        d.Observe(At(120), Snap(game));

        var stopped = d.Stop(At(122));
        Assert.Equal(DetectorEvent.Ended, stopped.Event);
        Assert.Equal(122, stopped.DurationSeconds);
        Assert.True(stopped.Keep);

        // Still running: not picked up again.
        for (var t = 126; t < 200; t += 4) Assert.Equal(DetectorEvent.None, d.Observe(At(t), Snap(game)).Event);

        // It exits and is started again later: a new session.
        d.Observe(At(204), Snap());
        d.Observe(At(300), Snap(game));
        var again = d.Observe(At(304), Snap(game));
        Assert.Equal(DetectorEvent.Started, again.Event);
        Assert.Equal(At(300), again.Start);
    }

    [Fact]
    public void A_suppressed_game_stays_ignored_until_it_exits()
    {
        var d = new GameDetector();
        var game = (100, @"D:\Games\Ashen Crown\Ashen.exe");
        d.Suppress(Ashen.InstallationId);
        d.Observe(At(0), Snap(game));
        Assert.Equal(DetectorEvent.None, d.Observe(At(4), Snap(game)).Event);
        d.Observe(At(8), Snap());
        d.Observe(At(12), Snap(game));
        Assert.Equal(DetectorEvent.Started, d.Observe(At(16), Snap(game)).Event);
    }

    [Fact]
    public void Pause_hands_the_session_over_without_ending_it_and_Resume_continues_it()
    {
        var d = new GameDetector();
        var game = (100, @"D:\Games\Ashen Crown\Ashen.exe");
        d.Observe(At(0), Snap(game));
        d.Observe(At(4), Snap(game));
        d.Observe(At(90), Snap(game));

        var parked = d.Pause();
        Assert.NotNull(parked);
        Assert.Equal(At(0), parked!.Value.Start);
        Assert.Equal(At(90), parked.Value.LastSeen);
        Assert.Null(d.ActiveTarget);

        // The other process continues it with its own detector.
        var other = new GameDetector();
        other.Resume(parked.Value.Target, parked.Value.Start, At(95));
        var running = other.Observe(At(97), Snap(game));
        Assert.Equal(DetectorEvent.Running, running.Event);
        Assert.Equal(At(0), running.Start);
        other.Observe(At(200), Snap(game));
        other.Observe(At(204), Snap());
        Assert.Equal(200, other.Observe(At(210), Snap()).DurationSeconds);
    }

    [Fact]
    public void Pause_with_nothing_active_returns_null()
    {
        Assert.Null(new GameDetector().Pause());
        Assert.Equal(DetectorEvent.None, new GameDetector().Stop(At(0)).Event);
    }
}
