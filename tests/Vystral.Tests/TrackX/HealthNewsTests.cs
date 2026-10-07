using Vystral.Core.Health;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.TrackX;

public sealed class HealthNewsTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 7, 12, 0, 0, TimeSpan.Zero);

    internal static HealthIssueDto Issue(string id, string severity = "warning") =>
        new(id, id.Split(':')[0], "drives", severity, $"Issue {id}", "Detail", null, [], null, null, [], null, null, null, null, null, []);

    [Fact]
    public void First_check_only_records_a_baseline()
    {
        var (state, fresh) = HealthNews.Diff([Issue("missingDrive:E"), Issue("brokenShortcut:a", "problem")], null, Now);
        Assert.Empty(fresh);
        Assert.True(state.Baselined);
        Assert.Equal(2, state.Known.Count);
        Assert.Empty(state.Pending);
    }

    [Fact]
    public void New_problems_and_warnings_are_announced_once_ever()
    {
        var (s1, _) = HealthNews.Diff([Issue("artMissing:x")], null, Now);
        var (s2, fresh) = HealthNews.Diff([Issue("artMissing:x"), Issue("missingDrive:E"), Issue("longSession:y", "info")], s1, Now);
        Assert.Equal(["missingDrive:E"], fresh); // info-level notes never interrupt Home
        Assert.Equal(["missingDrive:E"], s2.Pending);

        // The drive comes back: the issue leaves on its own. Unplugged again later: not announced a second time.
        var (s3, _) = HealthNews.Diff([Issue("artMissing:x")], s2, Now.AddHours(1));
        Assert.Empty(s3.Pending);
        var (s4, again) = HealthNews.Diff([Issue("artMissing:x"), Issue("missingDrive:E")], s3, Now.AddDays(2));
        Assert.Empty(again);
        Assert.Empty(s4.Pending);

        // …unless it has been gone for months.
        var (_, later) = HealthNews.Diff([Issue("missingDrive:E")], s3, Now.AddDays(200));
        Assert.Equal(["missingDrive:E"], later);
    }

    [Fact]
    public void Acknowledged_issues_stop_pending_and_pending_is_ordered_by_severity()
    {
        var (s1, _) = HealthNews.Diff([], null, Now);
        var issues = new[] { Issue("missingDrive:E"), Issue("brokenShortcut:a", "problem"), Issue("openSession:s") };
        var (s2, fresh) = HealthNews.Diff(issues, s1, Now);
        Assert.Equal(3, fresh.Count);
        Assert.Equal("brokenShortcut:a", HealthNews.Order(s2.Pending, issues)[0].Id);
        var s3 = HealthNews.Acknowledge(s2, ["brokenShortcut:a"]);
        Assert.Equal(["missingDrive:E", "openSession:s"], HealthNews.Order(s3.Pending, issues).Select(i => i.Id));
        var (s4, none) = HealthNews.Diff(issues, s3, Now);
        Assert.Empty(none);
        Assert.DoesNotContain("brokenShortcut:a", s4.Pending);
    }

    [Fact]
    public void Already_present_issues_never_become_news()
    {
        var (s1, _) = HealthNews.Diff([Issue("missingDrive:E")], null, Now);
        var (_, fresh) = HealthNews.Diff([Issue("missingDrive:E")], s1, Now.AddDays(1));
        Assert.Empty(fresh);
    }

    private sealed class Events : IEventSink
    {
        public List<(string Name, object? Payload)> Sent { get; } = [];
        public void Emit(string eventName, object? payload) { lock (Sent) Sent.Add((eventName, payload)); }
    }

    private static HealthReportDto Report(params HealthIssueDto[] issues) => new(Now.ToString("O"), 5, 90, 10, issues, 0, false, false);

    [Fact]
    public void Watcher_persists_state_announces_and_acknowledges()
    {
        using var dir = new TempDir();
        var events = new Events();
        var current = Report();
        var enabled = true;
        var watch = new HealthWatchService(() => current, dir.Path, events, () => false, () => enabled);

        Assert.Empty(watch.RunOnce()); // baseline
        Assert.Empty(watch.Current().Issues);
        current = Report(Issue("missingDrive:E"));
        Assert.Equal(["missingDrive:E"], watch.RunOnce());
        Assert.Contains(events.Sent, e => e.Name == "health.news");
        Assert.Single(watch.Current().Issues);
        Assert.True(File.Exists(Path.Combine(dir.Path, "ui-state", "health-watch.json")));

        // A new instance (next start) remembers: nothing is announced again.
        var next = new HealthWatchService(() => current, dir.Path, events, () => false, () => enabled);
        Assert.Empty(next.RunOnce());
        Assert.Single(next.Current().Issues);
        Assert.Empty(next.Acknowledge(["missingDrive:E"]).Issues);

        enabled = false;
        current = Report(Issue("missingDrive:E"), Issue("brokenShortcut:z", "problem"));
        events.Sent.Clear();
        next.RunOnce();
        Assert.Empty(next.Current().Issues); // turned off: nothing shown and nothing emitted
        Assert.DoesNotContain(events.Sent, e => e.Name == "health.news");
    }

    [Fact]
    public void Corrupt_state_files_start_fresh()
    {
        using var dir = new TempDir();
        dir.Write(Path.Combine("ui-state", "health-watch.json"), "{ not json");
        var watch = new HealthWatchService(() => Report(Issue("missingDrive:E")), dir.Path, new Events(), () => false, () => true);
        Assert.Empty(watch.RunOnce()); // treated as the first run: a baseline, not a flood
    }

    [Fact]
    public async Task Drive_changes_trigger_a_check()
    {
        using var dir = new TempDir();
        var drives = new[] { "C:\\" };
        var checks = 0;
        var watch = new HealthWatchService(() => { Interlocked.Increment(ref checks); return Report(); }, dir.Path, new Events(), () => false, () => true)
        {
            Drives = () => drives,
        };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var run = watch.RunAsync(cts.Token);
        drives = ["C:\\", "E:\\"];
        while (Volatile.Read(ref checks) == 0 && !cts.IsCancellationRequested) await Task.Delay(100, TestContext.Current.CancellationToken);
        await cts.CancelAsync();
        await run;
        Assert.True(checks >= 1);
    }
}
