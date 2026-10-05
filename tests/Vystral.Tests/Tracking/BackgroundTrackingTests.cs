using Dapper;
using Vystral.Core.Contracts;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Launch;
using Vystral.Windows.Services;
using Vystral.Windows.Tracking;
using Xunit;

namespace Vystral.Tests.Tracking;

/// <summary>
/// The detector driving the real session recorder on a temp database: detect, hand over between two
/// "processes", continue, stop; crash recovery; and two processes writing one database at once.
/// </summary>
public sealed class BackgroundTrackingTests : IDisposable
{
    private readonly TestDb _t = new();
    private readonly FakeProcesses _processes = new();
    private readonly TrackerFiles _files;
    private readonly string _gameId;
    private readonly string _installationId;
    private const string GameExe = @"D:\Games\Ashen Crown\Ashen.exe";

    public BackgroundTrackingTests()
    {
        _files = new TrackerFiles(_t.Dir.Path);
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "10", "Ashen Crown", installPath: @"D:\Games\Ashen Crown"))]);
        var inst = Assert.Single(_t.Repo.GetDetectableInstallations());
        _gameId = inst.GameId;
        _installationId = inst.Id;
    }

    public void Dispose() => _t.Dispose();

    private (SessionService Sessions, ExternalTracker Tracker, EventLog Events) Process(string source)
    {
        var settings = new SettingsService(_t.Repo);
        settings.Set("performance.collectMetrics", System.Text.Json.Nodes.JsonValue.Create(false));
        var events = new EventLog();
        var sessions = new SessionService(_t.Repo, [], settings, events) { ExternalSource = source };
        var tracker = new ExternalTracker(_t.Repo, sessions, () => [], () => _processes, _files, new NoPowerSaving());
        return (sessions, tracker, events);
    }

    private List<string> SessionIds()
    {
        using var conn = _t.Db.Open();
        return conn.Query<string>("SELECT id FROM sessions").ToList();
    }

    private static async Task Until(Func<bool> condition, int timeoutMs = 5000)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (!condition())
        {
            if (Environment.TickCount64 > deadline) throw new TimeoutException("Condition not met in time.");
            await Task.Delay(20);
        }
    }

    [Fact]
    public async Task A_game_started_outside_VYSTRAL_is_detected_handed_over_continued_and_saved()
    {
        var app = Process(SessionSources.Detected);
        var start = DateTimeOffset.UtcNow.AddMinutes(-10);
        _processes.Running = [new RunningProcess(4100, GameExe)];

        Assert.Null(app.Tracker.PollOnce(start));
        var running = app.Tracker.PollOnce(start.AddSeconds(4));

        Assert.NotNull(running);
        Assert.Equal("running", running!.Phase);
        Assert.Equal(SessionSources.Detected, running.Source);
        Assert.Equal(_gameId, running.GameId);
        var sessionId = running.SessionId!;
        Assert.Equal(SessionSources.Detected, _t.Repo.GetOpenSession(sessionId)!.Source);
        Assert.True(app.Sessions.IsBusy);
        await Until(() => _files.ReadSession()?.SessionId == sessionId); // heartbeat

        // The app closes while the game runs: the session is parked, not ended.
        Assert.True(await app.Tracker.ParkAsync(TimeSpan.FromSeconds(5)));
        var note = _files.ReadSession()!;
        Assert.True(note.Parked);
        Assert.Equal(sessionId, note.SessionId);
        Assert.NotNull(_t.Repo.GetOpenSession(sessionId));
        await Until(() => app.Sessions.Current?.Phase == "ended");
        Assert.Null(app.Sessions.Current!.SessionId); // no "session saved" for a hand-over

        // The background tracker takes over and continues the same session.
        var helper = Process(SessionSources.Background);
        helper.Tracker.TakeOver(DateTimeOffset.UtcNow);
        await Until(() => helper.Sessions.Current is { Phase: "running", SessionId: not null });
        Assert.Equal(sessionId, helper.Sessions.Current!.SessionId);
        Assert.Equal(SessionSources.Detected, helper.Sessions.Current.Source); // keeps how it began
        Assert.Single(SessionIds());

        // The user stops tracking: saved (10 minutes), and the still-running game isn't picked up again.
        helper.Sessions.StopTracking();
        await Until(() => helper.Sessions.Current?.Phase == "ended");
        var saved = Assert.Single(_t.Repo.ListSessions(null, 10));
        Assert.Equal(sessionId, saved.Id);
        Assert.InRange(saved.DurationSeconds, 595, 700);
        Assert.Null(_files.ReadSession());
        Assert.Contains(helper.Events.States, s => s is { Phase: "ended", SessionId: not null, Message: not null });

        var now = DateTimeOffset.UtcNow;
        Assert.Null(helper.Tracker.PollOnce(now));
        Assert.Null(helper.Tracker.PollOnce(now.AddSeconds(4)));
        Assert.Single(_t.Repo.ListSessions(null, 10));

        // Library totals count it like any VYSTRAL session.
        var game = Assert.Single(_t.Repo.LoadSnapshot((_, _) => null).Games);
        Assert.Equal(1, game.SessionCount);
        Assert.Equal(saved.DurationSeconds, game.TrackedSeconds);
    }

    [Fact]
    public async Task Idle_polls_look_only_at_the_foreground_and_watched_processes_between_full_scans()
    {
        var app = Process(SessionSources.Detected);
        var t0 = DateTimeOffset.UtcNow.AddMinutes(-5);
        Assert.Null(app.Tracker.PollOnce(t0)); // first poll loads the library and takes a full snapshot
        Assert.Equal(1, _processes.FullSnapshots);
        Assert.Null(app.Tracker.PollOnce(t0.AddSeconds(4)));
        Assert.Null(app.Tracker.PollOnce(t0.AddSeconds(8)));
        Assert.Equal(1, _processes.FullSnapshots);

        // The game starts and takes the foreground: confirmed without another full snapshot.
        _processes.Running = [new RunningProcess(4100, GameExe), new RunningProcess(77, @"C:\Windows\explorer.exe")];
        _processes.Foreground = 4100;
        Assert.Null(app.Tracker.PollOnce(t0.AddSeconds(12)));
        _processes.Foreground = 77; // alt-tabbed away: still followed as a watched process
        var running = app.Tracker.PollOnce(t0.AddSeconds(16));
        Assert.NotNull(running);
        Assert.Equal(t0.AddSeconds(12).ToString("O"), running!.StartedAt);
        Assert.Equal(1, _processes.FullSnapshots);
        app.Sessions.StopTracking();
        await Until(() => !app.Sessions.IsBusy);
    }

    [Fact]
    public async Task A_game_that_never_takes_the_foreground_is_found_by_the_next_full_scan()
    {
        var app = Process(SessionSources.Detected);
        var t0 = DateTimeOffset.UtcNow.AddMinutes(-5);
        app.Tracker.PollOnce(t0);
        _processes.Running = [new RunningProcess(4100, GameExe)];
        Assert.Null(app.Tracker.PollOnce(t0.AddSeconds(30))); // not in the foreground, not watched yet
        Assert.Null(app.Tracker.PollOnce(t0.AddSeconds(60))); // full scan: first seen
        Assert.Equal(2, _processes.FullSnapshots);
        var running = app.Tracker.PollOnce(t0.AddSeconds(64));
        Assert.NotNull(running);
        Assert.Equal(t0.AddSeconds(60).ToString("O"), running!.StartedAt);
        app.Sessions.StopTracking();
        await Until(() => !app.Sessions.IsBusy);
    }

    [Fact]
    public async Task A_detection_stopped_within_a_minute_is_not_kept()
    {
        var app = Process(SessionSources.Background);
        var now = DateTimeOffset.UtcNow;
        _processes.Running = [new RunningProcess(4100, GameExe)];
        app.Tracker.PollOnce(now);
        var running = app.Tracker.PollOnce(now.AddSeconds(4))!;
        Assert.Equal(SessionSources.Background, running.Source);

        app.Sessions.StopTracking();
        await Until(() => app.Sessions.Current?.Phase == "ended");
        Assert.Null(_t.Repo.GetOpenSession(running.SessionId!));
        Assert.Empty(_t.Repo.ListSessions(null, 10));
        Assert.Equal("Stopped tracking. Sessions shorter than a minute aren't saved.", app.Sessions.Current!.Message);
    }

    [Fact]
    public async Task A_launch_in_progress_is_never_double_counted_by_the_detector()
    {
        var app = Process(SessionSources.Detected);
        var now = DateTimeOffset.UtcNow;
        _processes.Running = [new RunningProcess(4100, GameExe)];
        app.Tracker.PollOnce(now);
        Assert.NotNull(app.Tracker.PollOnce(now.AddSeconds(4)));

        // While a session runs, idle polls do nothing and a second start is refused.
        Assert.Null(app.Tracker.PollOnce(now.AddSeconds(8)));
        var inst = _t.Repo.GetInstallation(_installationId)!;
        Assert.Null(app.Sessions.TrackExternal(inst, [4100], now, new NullFeed()));
        Assert.Single(SessionIds());
        app.Sessions.StopTracking();
        await Until(() => !app.Sessions.IsBusy);
    }

    [Fact]
    public void Taking_over_closes_a_handed_over_session_whose_game_has_exited_at_its_last_sighting()
    {
        var start = DateTimeOffset.UtcNow.AddMinutes(-30);
        var id = _t.Repo.StartSession(_gameId, _installationId, start, SessionSources.Background);
        _files.WriteSession(new TrackerSessionNote(id, _gameId, _installationId, SessionSources.Background, start, start.AddMinutes(25), 1, Parked: true));
        var crashed = _t.Repo.StartSession(_gameId, _installationId, start.AddMinutes(-90), SessionSources.Tracked);
        _processes.Running = []; // the game isn't running any more

        var helper = Process(SessionSources.Background);
        helper.Tracker.TakeOver(DateTimeOffset.UtcNow);

        Assert.False(helper.Sessions.IsBusy);
        Assert.Null(_files.ReadSession());
        var sessions = _t.Repo.ListSessions(null, 10).ToDictionary(s => s.Id);
        Assert.Equal(25 * 60, sessions[id].DurationSeconds);
        Assert.Equal(SessionSources.Background, sessions[id].Source);
        Assert.Equal(0, sessions[crashed].DurationSeconds); // no samples, no note: closed at its start
    }

    [Fact]
    public void Recovery_leaves_the_handed_over_session_open_and_uses_the_heartbeat()
    {
        var start = DateTimeOffset.UtcNow.AddHours(-2);
        var owned = _t.Repo.StartSession(_gameId, _installationId, start, SessionSources.Background);
        var other = _t.Repo.StartSession(_gameId, _installationId, start, SessionSources.Background);

        Assert.Equal(1, _t.Repo.RecoverOpenSessions([owned], new Dictionary<string, DateTimeOffset> { [other] = start.AddMinutes(42) }));
        Assert.NotNull(_t.Repo.GetOpenSession(owned));
        Assert.Equal(42 * 60, _t.Repo.ListSessions(null, 10).Single(s => s.Id == other).DurationSeconds);
    }

    [Fact]
    public void The_status_line_reads_the_latest_noticed_session_and_hidden_games_are_not_watched()
    {
        var start = DateTimeOffset.UtcNow.AddHours(-3);
        var a = _t.Repo.StartSession(_gameId, _installationId, start, SessionSources.Background);
        _t.Repo.EndSession(a, start.AddHours(1), 3600, null);
        var b = _t.Repo.StartSession(_gameId, _installationId, start.AddHours(2), SessionSources.Tracked);
        _t.Repo.EndSession(b, start.AddHours(2.5), 1800, null);

        var last = _t.Repo.LatestSession(SessionSources.Background, SessionSources.Detected)!;
        Assert.Equal(a, last.Id);
        Assert.Equal("Ashen Crown", last.GameTitle);
        Assert.Equal(3600, last.DurationSeconds);
        Assert.Null(_t.Repo.LatestSession("nothing"));

        Assert.True(_t.Repo.DeleteSession(a));
        Assert.False(_t.Repo.DeleteSession(a));

        _t.Repo.UpdateGameFlags(_gameId, hidden: true);
        Assert.Empty(_t.Repo.GetDetectableInstallations());
    }

    [Fact]
    public void Only_observed_sources_can_be_started()
    {
        Assert.Throws<ArgumentException>(() => _t.Repo.StartSession(_gameId, _installationId, DateTimeOffset.UtcNow, "imported"));
    }

    [Fact]
    public async Task Two_processes_write_one_database_at_the_same_time()
    {
        // The app (pooled connections) and the background tracker (unpooled) on the same file, both writing.
        var appRepo = _t.Repo;
        var trackerDb = new Database(_t.Db.FilePath, pooling: false);
        var trackerRepo = new LibraryRepository(trackerDb);

        async Task Writer(LibraryRepository repo, string source, int sessions)
        {
            for (var i = 0; i < sessions; i++)
            {
                var start = DateTimeOffset.UtcNow.AddMinutes(-i);
                var id = repo.StartSession(_gameId, _installationId, start, source);
                repo.AddPerfSamples(id, Enumerable.Range(0, 40).Select(t => new PerfSampleDto(t * 2000, 10, 20, 100, 4000, 60)));
                repo.EndSession(id, start.AddSeconds(80), 80, null);
                await Task.Yield();
            }
        }

        async Task Reader(LibraryRepository repo)
        {
            for (var i = 0; i < 30; i++)
            {
                repo.LoadSnapshot((_, _) => null);
                repo.SetSetting("tracking.background", i % 2 == 0 ? "true" : "false");
                await Task.Yield();
            }
        }

        await Task.WhenAll(
            Task.Run(() => Writer(appRepo, SessionSources.Detected, 25)),
            Task.Run(() => Writer(trackerRepo, SessionSources.Background, 25)),
            Task.Run(() => Reader(appRepo)),
            Task.Run(() => Reader(trackerRepo)));

        var all = _t.Repo.ListSessions(null, 1000);
        Assert.Equal(50, all.Count);
        Assert.Equal(25, all.Count(s => s.Source == SessionSources.Background));
        using var conn = _t.Db.Open();
        Assert.Equal(50 * 40, conn.ExecuteScalar<long>("SELECT COUNT(*) FROM perf_samples"));
        Assert.Equal("ok", _t.Db.CheckIntegrity());
    }

    // ---------------- fakes ----------------

    private sealed class FakeProcesses : IRunningProcessSource
    {
        public IReadOnlyList<RunningProcess> Running { get; set; } = [];
        public int? Foreground { get; set; }
        public int FullSnapshots { get; private set; }
        public int Queries { get; private set; }

        public IReadOnlyList<RunningProcess> Snapshot()
        {
            FullSnapshots++;
            return Running;
        }

        public int? ForegroundPid() => Foreground;

        public RunningProcess? Query(int pid)
        {
            Queries++;
            return Running.FirstOrDefault(p => p.Id == pid);
        }
    }

    private sealed class NoPowerSaving : IPowerStatus
    {
        public bool Saving => false;
    }

    private sealed class NullFeed : ISessionFeed
    {
        public SessionTick Next(DateTimeOffset now) => new([]);
        public void Stopped(DateTimeOffset now) { }
        public void Parked() { }
    }

    private sealed class EventLog : IEventSink
    {
        private readonly List<LaunchStateDto> _states = [];
        public IReadOnlyList<LaunchStateDto> States { get { lock (_states) return [.. _states]; } }

        public void Emit(string eventName, object? payload)
        {
            if (payload is LaunchStateDto s) lock (_states) _states.Add(s);
        }
    }
}
