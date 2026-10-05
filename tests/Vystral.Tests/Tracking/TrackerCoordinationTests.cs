using Vystral.Windows.Tracking;
using Xunit;

namespace Vystral.Tests.Tracking;

/// <summary>
/// The cross-process protocol with real kernel objects under unique names (never the installed app's):
/// one tracker at a time, the app taking over from the background tracker, and asking it to stop.
/// </summary>
public sealed class TrackerCoordinationTests
{
    private static TrackerNames Unique() => new($@"Local\VYSTRAL-test-{Guid.NewGuid():N}");

    [Fact]
    public async Task Only_one_holder_at_a_time_and_release_hands_over()
    {
        var names = Unique();
        using var first = MutexHolder.Acquire(names.Tracker);
        Assert.True(await first.Acquired.WaitAsync(TimeSpan.FromSeconds(5)));

        using var second = MutexHolder.Acquire(names.Tracker);
        await Task.Delay(200);
        Assert.False(second.Acquired.IsCompleted);

        first.Dispose();
        Assert.True(await second.Acquired.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.True(second.IsHeld);
    }

    [Fact]
    public async Task A_holder_that_times_out_reports_false()
    {
        var names = Unique();
        using var owner = MutexHolder.Acquire(names.Tracker);
        await owner.Acquired;
        using var waiter = MutexHolder.Acquire(names.Tracker, TimeSpan.FromMilliseconds(150));
        Assert.False(await waiter.Acquired.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task Exists_reflects_whether_anyone_holds_the_object()
    {
        var names = Unique();
        Assert.False(TrackerSignals.Exists(names.App));
        using (var app = MutexHolder.Acquire(names.App))
        {
            Assert.True(await app.Acquired.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken));
            Assert.True(TrackerSignals.Exists(names.App));
        }
        Assert.False(TrackerSignals.Exists(names.App));
    }

    /// <summary>
    /// The background tracker's side of the protocol in miniature: own the tracker lock, yield when the app
    /// appears (parking its session), wait for the app to exit, take over again.
    /// </summary>
    [Fact]
    public async Task The_app_takes_over_from_the_background_tracker_and_gives_tracking_back_on_exit()
    {
        var names = Unique();
        var log = new List<string>();
        using var stop = TrackerSignals.OpenEvent(names.Stop);
        using var helperOwns = new ManualResetEventSlim();
        using var helperOwnsAgain = new ManualResetEventSlim();

        var helper = new Thread(() =>
        {
            using var yieldEvent = TrackerSignals.OpenEvent(names.Yield);
            var round = 0;
            while (true)
            {
                if (Mutex.TryOpenExisting(names.App, out var app))
                {
                    using (app)
                    {
                        try { if (WaitHandle.WaitAny([app, stop]) == 1) return; }
                        catch (AbandonedMutexException) { }
                        app.ReleaseMutex();
                    }
                }
                using var tracker = new Mutex(false, names.Tracker);
                try { if (WaitHandle.WaitAny([tracker, stop]) == 1) return; }
                catch (AbandonedMutexException) { }
                lock (log) log.Add($"helper owns ({++round})");
                (round == 1 ? helperOwns : helperOwnsAgain).Set();
                var signal = WaitHandle.WaitAny([stop, yieldEvent]);
                lock (log) log.Add(signal == 0 ? "helper stops" : "helper parks session");
                tracker.ReleaseMutex();
                if (signal == 0) return;
            }
        }) { IsBackground = true };
        helper.Start();
        Assert.True(helperOwns.Wait(TimeSpan.FromSeconds(5)));

        // The app starts: holds "app", asks the tracker to yield, then owns "tracker".
        var appLock = MutexHolder.Acquire(names.App);
        Assert.True(await appLock.Acquired.WaitAsync(TimeSpan.FromSeconds(5)));
        TrackerSignals.Set(names.Yield);
        var trackerLock = MutexHolder.Acquire(names.Tracker);
        Assert.True(await trackerLock.Acquired.WaitAsync(TimeSpan.FromSeconds(5)));
        lock (log) log.Add("app owns");

        // The app exits: the background tracker takes over again.
        trackerLock.Dispose();
        appLock.Dispose();
        Assert.True(helperOwnsAgain.Wait(TimeSpan.FromSeconds(5)));

        TrackerSignals.Set(names.Stop);
        Assert.True(helper.Join(TimeSpan.FromSeconds(5)));
        Assert.Equal(["helper owns (1)", "helper parks session", "app owns", "helper owns (2)", "helper stops"], log);
    }

    [Fact]
    public void StopHelper_signals_and_waits_until_the_tracker_has_exited()
    {
        var names = Unique();
        using var started = new ManualResetEventSlim();
        var exited = false;
        var helper = new Thread(() =>
        {
            using var single = new Mutex(false, names.Helper);
            single.WaitOne();
            using var stop = TrackerSignals.OpenEvent(names.Stop);
            stop.Reset();
            started.Set();
            stop.WaitOne();
            Thread.Sleep(100); // parks its session
            exited = true;
            single.ReleaseMutex();
        }) { IsBackground = true };
        helper.Start();
        Assert.True(started.Wait(TimeSpan.FromSeconds(5)));

        Assert.True(TrackerSignals.StopHelper(names, TimeSpan.FromSeconds(5)));
        Assert.True(exited);
        Assert.True(TrackerSignals.StopHelper(names, TimeSpan.FromSeconds(1))); // nothing running: immediate
        Assert.True(helper.Join(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public void Migrations_are_serialised_across_holders()
    {
        var names = Unique();
        var inside = 0;
        var maxInside = 0;
        Parallel.For(0, 6, _ => TrackerSignals.WithLock(names.Migrate, TimeSpan.FromSeconds(10), () =>
        {
            var now = Interlocked.Increment(ref inside);
            lock (names) maxInside = Math.Max(maxInside, now);
            Thread.Sleep(20);
            Interlocked.Decrement(ref inside);
            return 0;
        }));
        Assert.Equal(1, maxInside);
    }
}
