using Vystral.Core.Health;
using Vystral.Tests.Support;
using Vystral.Windows.Services.Startup;
using Xunit;

namespace Vystral.Tests.TrackD6;

/// <summary>Track D6: the crash-free streak from the start history.</summary>
public sealed class StartStreakTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 10, 18, 0, 0, TimeSpan.Zero);
    private static readonly TimeZoneInfo Utc = TimeZoneInfo.Utc;

    private static StartRecord S(int daysAgo, string outcome, string version = "0.9.0") =>
        new(Now.AddDays(-daysAgo).ToString("O"), version, outcome);

    [Fact]
    public void A_start_still_pending_at_the_next_start_failed()
    {
        var h = StartStreak.BeginStart([S(3, StartStreak.Ok), S(1, StartStreak.Pending)], "0.9.0", Now, previousClosedUncleanly: true);
        Assert.Equal([StartStreak.Ok, StartStreak.Failed, StartStreak.Pending], h.Select(x => x.Outcome));
    }

    [Fact]
    public void A_steady_run_without_a_clean_exit_is_an_unexpected_close_not_a_failed_start()
    {
        var h = StartStreak.BeginStart([S(1, StartStreak.Ok)], "0.9.0", Now, previousClosedUncleanly: true);
        Assert.Equal(StartStreak.Unexpected, h[0].Outcome);
        var s = StartStreak.Summarize(h, [], Now, Utc);
        Assert.Equal(0, s.FailedStarts);
        Assert.Equal(1, s.UnexpectedCloses);
        Assert.Equal("unexpectedClose", s.LastIncident!.Kind);
    }

    [Fact]
    public void Steady_and_clean_exit_mark_the_newest_pending_start()
    {
        var h = StartStreak.MarkSteady([S(2, StartStreak.Ok), S(0, StartStreak.Pending)]);
        Assert.Equal(StartStreak.Ok, h[^1].Outcome);
        var quick = StartStreak.MarkCleanExit([S(0, StartStreak.Pending)], uiReady: true);
        Assert.Equal(StartStreak.Ok, quick[0].Outcome);
        var notReady = StartStreak.MarkCleanExit([S(0, StartStreak.Pending)], uiReady: false);
        Assert.Equal(StartStreak.Pending, notReady[0].Outcome);
    }

    [Fact]
    public void Streak_counts_days_since_the_last_failed_start()
    {
        var s = StartStreak.Summarize([S(60, StartStreak.Ok), S(42, StartStreak.Failed, "0.8.0"), S(41, StartStreak.Ok), S(1, StartStreak.Ok), S(0, StartStreak.Pending)], [], Now, Utc);
        Assert.Equal(42, s.Days);
        Assert.False(s.SinceHistoryBegan);
        Assert.Equal(1, s.FailedStarts);
        Assert.Equal(4, s.StartsCounted);
        Assert.Equal("failedStart", s.LastIncident!.Kind);
        Assert.Contains("0.8.0", s.LastIncident.Text);
        Assert.Equal(StartStreak.RecentDays, s.Recent.Count);
        Assert.Equal(1, s.Recent[^2].Starts);
    }

    [Fact]
    public void Without_failures_it_counts_since_the_history_began_and_says_so()
    {
        var s = StartStreak.Summarize([S(12, StartStreak.Ok), S(3, StartStreak.Ok)], [], Now, Utc);
        Assert.Equal(12, s.Days);
        Assert.True(s.SinceHistoryBegan);
        Assert.Null(s.LastIncident);
        var none = StartStreak.Summarize([], [], Now, Utc);
        Assert.Equal((0, (string?)null), (none.Days, none.Since));
    }

    [Fact]
    public void Other_incidents_join_the_history_newest_first_but_dont_break_the_streak()
    {
        var other = new StreakIncident(Now.AddDays(-5).ToString("O"), "rollback", "0.9.1", "VYSTRAL 0.9.1 didn’t start twice, so it went back to 0.9.0");
        var future = new StreakIncident(Now.AddDays(5).ToString("O"), "selfCheck", "9.9.9", "from the future");
        var s = StartStreak.Summarize([S(30, StartStreak.Ok), S(10, StartStreak.Unexpected)], [other, future], Now, Utc);
        Assert.Equal(30, s.Days);
        Assert.Equal(["rollback", "unexpectedClose"], s.Incidents.Select(i => i.Kind));
    }

    [Fact]
    public void Garbage_records_are_ignored_and_versions_are_cleaned()
    {
        var s = StartStreak.Summarize([new("not a time", "0.9.0", "ok"), new(Now.ToString("O"), "<script>", "ok"), new(Now.ToString("O"), "0.9.0", "weird")], [], Now, Utc);
        Assert.Equal(1, s.StartsCounted);
    }

    [Fact]
    public void History_is_capped()
    {
        var h = Enumerable.Range(0, 400).Select(i => S(400 - i, StartStreak.Ok)).ToList();
        Assert.Equal(StartStreak.MaxRecords, StartStreak.BeginStart(h, "0.9.0", Now, false).Count);
    }

    [Fact]
    public void The_store_round_trips_and_survives_a_corrupt_file()
    {
        using var dir = new TempDir();
        var store = new StartHistoryStore(dir.Path);
        store.Update(h => StartStreak.BeginStart(h, "0.9.0", Now, false));
        store.Update(StartStreak.MarkSteady);
        Assert.Equal(StartStreak.Ok, store.Load().Single().Outcome);
        File.WriteAllText(store.FilePath, "{ not json");
        Assert.Empty(store.Load());
    }
}
