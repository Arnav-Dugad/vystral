using Vystral.Core.Cloud;
using Vystral.Windows.Cloud;
using Vystral.Windows.Monitoring;
using Xunit;

namespace Vystral.Tests.Cloud;

public sealed class CloudSessionDetectorTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 6, 20, 0, 0, TimeSpan.Zero);
    private static ProcessEntry P(int pid, string name) => new(pid, 1, 1, name, 0, 0);
    private static readonly ProcessEntry[] None = [];

    [Fact]
    public void Gfn_counts_only_while_the_stream_process_runs_with_a_grace_period()
    {
        var d = new CloudSessionDetector(CloudDetect.GfnStreamer, 10, T0, TimeSpan.FromHours(6));
        Assert.Equal(CloudDetectorState.Waiting, d.State);
        d.Tick(T0.AddMinutes(3), [P(10, "GeForceNOW.exe")], null); // queue: not counted
        Assert.Equal(CloudDetectorState.Waiting, d.State);
        d.Tick(T0.AddMinutes(4), [P(10, "GeForceNOW.exe"), P(11, "GeForceNOWStreamer.exe")], null);
        Assert.Equal(CloudDetectorState.Running, d.State);
        Assert.Equal(T0.AddMinutes(4), d.Start);
        d.Tick(T0.AddMinutes(50), [P(10, "GeForceNOW.exe"), P(11, "GeForceNOWStreamer.exe")], null);
        d.Tick(T0.AddMinutes(50).AddSeconds(5), [P(10, "GeForceNOW.exe")], null); // a blip
        Assert.Equal(CloudDetectorState.Running, d.State);
        d.Tick(T0.AddMinutes(50).AddSeconds(10), [P(10, "GeForceNOW.exe"), P(11, "GeForceNOWStreamer.exe")], null);
        d.Tick(T0.AddMinutes(60), [P(10, "GeForceNOW.exe")], null);
        d.Tick(T0.AddMinutes(60).AddSeconds(25), [P(10, "GeForceNOW.exe")], null);
        Assert.Equal(CloudDetectorState.Ended, d.State);
        Assert.Equal(T0.AddMinutes(50).AddSeconds(10), d.End);
        Assert.Equal((int)TimeSpan.FromMinutes(46).Add(TimeSpan.FromSeconds(10)).TotalSeconds, d.Seconds);
    }

    [Fact]
    public void Gfn_is_abandoned_when_the_app_closes_before_any_stream()
    {
        var d = new CloudSessionDetector(CloudDetect.GfnStreamer, 10, T0, TimeSpan.FromHours(6));
        d.Tick(T0.AddSeconds(5), [P(10, "GeForceNOW.exe")], null);
        d.Tick(T0.AddSeconds(30), None, null);
        Assert.Equal(CloudDetectorState.Waiting, d.State);
        d.Tick(T0.AddSeconds(95), None, null);
        Assert.Equal(CloudDetectorState.Abandoned, d.State);
    }

    [Fact]
    public void Sessions_are_capped_at_the_membership_session_length()
    {
        var d = new CloudSessionDetector(CloudDetect.GfnStreamer, 10, T0, TimeSpan.FromHours(1));
        d.Tick(T0, [P(11, "GeForceNOWStreamer.exe")], null);
        d.Tick(T0.AddHours(3), [P(11, "GeForceNOWStreamer.exe")], null); // a leftover process
        Assert.Equal(CloudDetectorState.Ended, d.State);
        Assert.Equal(3600, d.Seconds);
    }

    [Fact]
    public void Xbox_app_counts_foreground_time_and_ends_after_five_idle_minutes()
    {
        var d = new CloudSessionDetector(CloudDetect.XboxForeground, null, T0, TimeSpan.FromHours(8));
        var procs = new[] { P(40, "XboxPcApp.exe"), P(41, "explorer.exe") };
        d.Tick(T0.AddSeconds(10), procs, 41);
        Assert.Equal(CloudDetectorState.Waiting, d.State);
        d.Tick(T0.AddSeconds(20), procs, 40);
        Assert.Equal(CloudDetectorState.Running, d.State);
        d.Tick(T0.AddMinutes(30), procs, 40);
        d.Tick(T0.AddMinutes(33), procs, 41); // alt-tab: still within five minutes
        Assert.Equal(CloudDetectorState.Running, d.State);
        d.Tick(T0.AddMinutes(36), procs, 41);
        Assert.Equal(CloudDetectorState.Ended, d.State);
        Assert.Equal(T0.AddMinutes(30), d.End);
    }

    [Fact]
    public void Edge_window_lasts_as_long_as_the_process_vystral_started()
    {
        var d = new CloudSessionDetector(CloudDetect.OwnProcess, 77, T0, TimeSpan.FromHours(8));
        Assert.Equal(CloudDetectorState.Running, d.State);
        d.Tick(T0.AddMinutes(20), [P(77, "msedge.exe")], null);
        d.Tick(T0.AddMinutes(20).AddSeconds(3), None, null);
        Assert.Equal(CloudDetectorState.Ended, d.State);
        Assert.Equal(1200, d.Seconds);
    }

    [Fact]
    public void Edge_hand_over_follows_the_earlier_browser_or_waits_for_im_done()
    {
        var follow = new CloudSessionDetector(CloudDetect.OwnProcess, 77, T0, TimeSpan.FromHours(8), previousBrowserPid: 55);
        follow.Tick(T0.AddSeconds(3), [P(55, "msedge.exe")], null);
        Assert.Equal(55, follow.BrowserPid);
        follow.Tick(T0.AddMinutes(10), [P(55, "msedge.exe")], null);
        Assert.Equal(CloudDetectorState.Running, follow.State);

        var manual = new CloudSessionDetector(CloudDetect.OwnProcess, 77, T0, TimeSpan.FromHours(8));
        manual.Tick(T0.AddSeconds(3), None, null);
        Assert.Equal(CloudDetect.Manual, manual.Mode);
        manual.Tick(T0.AddMinutes(30), None, null);
        Assert.Equal(CloudDetectorState.Running, manual.State);
        manual.EndNow(T0.AddMinutes(31));
        Assert.Equal(CloudDetectorState.Ended, manual.State);
        Assert.Equal(31 * 60, manual.Seconds);
    }
}

public sealed class CloudHoursTests
{
    private static readonly TimeZoneInfo Utc = TimeZoneInfo.Utc;

    [Theory]
    [InlineData("2026-10-06", 1, "2026-10-01")]
    [InlineData("2026-10-06", 6, "2026-10-06")]
    [InlineData("2026-10-06", 15, "2026-09-15")]
    [InlineData("2026-03-02", 31, "2026-02-28")] // the reset day is clamped to short months
    [InlineData("2026-03-31", 31, "2026-03-31")]
    [InlineData("2026-01-05", 20, "2025-12-20")]
    public void Cycle_starts_on_the_most_recent_reset_day(string today, int resetDay, string expected)
    {
        var now = DateTimeOffset.Parse(today + "T15:00:00Z");
        Assert.Equal(DateTimeOffset.Parse(expected + "T00:00:00Z"), CloudHours.CycleStart(now, resetDay, Utc));
    }

    [Fact]
    public void Next_reset_follows_the_cycle_start()
    {
        Assert.Equal(DateTimeOffset.Parse("2026-02-28T00:00:00Z"), CloudHours.NextReset(DateTimeOffset.Parse("2026-01-31T00:00:00Z"), 31, Utc));
        Assert.Equal(DateTimeOffset.Parse("2026-11-06T00:00:00Z"), CloudHours.NextReset(DateTimeOffset.Parse("2026-10-06T00:00:00Z"), 6, Utc));
    }

    [Fact]
    public void Only_the_part_of_a_session_inside_the_cycle_counts()
    {
        var now = DateTimeOffset.Parse("2026-10-06T12:00:00Z");
        var spans = new[]
        {
            new CloudSpan(DateTimeOffset.Parse("2026-09-30T23:00:00Z"), DateTimeOffset.Parse("2026-10-01T01:00:00Z")), // 1 h inside
            new CloudSpan(DateTimeOffset.Parse("2026-10-03T10:00:00Z"), DateTimeOffset.Parse("2026-10-03T13:30:00Z")), // 3.5 h
        };
        var m = CloudHours.Compute("performance", 1, now, Utc, spans, null);
        Assert.Equal((long)(4.5 * 3600), m.UsedSeconds);
        Assert.Equal(100 * 3600L, m.LimitSeconds);
        Assert.Equal(100 * 3600L - (long)(4.5 * 3600), m.LeftSeconds);
        Assert.Equal("ok", m.Level);
        Assert.Equal(2, m.Sessions);
        Assert.Equal(15, m.RolloverHours);
    }

    [Fact]
    public void Warns_gently_near_the_limit_and_when_it_is_reached()
    {
        var now = DateTimeOffset.Parse("2026-10-20T12:00:00Z");
        var start = DateTimeOffset.Parse("2026-10-02T00:00:00Z");
        Assert.Equal("near", CloudHours.Compute("ultimate", 1, now, Utc, [new CloudSpan(start, start.AddHours(81))], null).Level);
        var full = CloudHours.Compute("ultimate", 1, now, Utc, [new CloudSpan(start, start.AddHours(101))], null);
        Assert.Equal("reached", full.Level);
        Assert.Equal(0, full.LeftSeconds);
        Assert.Equal(1, full.Fraction);
    }

    [Fact]
    public void A_running_session_counts_and_shows_time_left_in_the_session()
    {
        var now = DateTimeOffset.Parse("2026-10-06T12:00:00Z");
        var m = CloudHours.Compute("free", 1, now, Utc, [], now.AddMinutes(-50));
        Assert.Equal("none", m.Level); // no monthly cap published for Free
        Assert.Null(m.LimitSeconds);
        Assert.Equal(50 * 60, m.UsedSeconds);
        Assert.Equal(3600, m.SessionLimitSeconds);
        Assert.Equal(600, m.SessionLeftSeconds);
        Assert.Equal("near", m.SessionLevel);
    }

    [Fact]
    public void Not_a_member_has_no_meter()
    {
        var m = CloudHours.Compute("none", 1, DateTimeOffset.Parse("2026-10-06T12:00:00Z"), Utc, [], null);
        Assert.Equal("none", m.Level);
        Assert.Equal("none", m.SessionLevel);
        Assert.Equal("Not a member", m.PlanLabel);
        Assert.Equal("none", CloudHours.Compute("bogus", 1, DateTimeOffset.UnixEpoch, Utc, [], null).Plan);
    }
}
