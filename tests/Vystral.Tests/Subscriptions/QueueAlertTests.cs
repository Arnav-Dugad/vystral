using System.Text.Json;
using Vystral.Windows.Cloud;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Subscriptions;

/// <summary>Track V: GeForce NOW queue alerts (window titles, read-only) and the two new notification kinds.</summary>
public sealed class QueueAlertTests
{
    private sealed class FakeTitles : IWindowTitleSource
    {
        public List<(int Pid, string Title)> Windows { get; } = [];
        public List<IReadOnlySet<int>> Asked { get; } = [];
        public IReadOnlyList<(int Pid, string Title)> Titles(IReadOnlySet<int> pids)
        {
            Asked.Add(pids);
            return Windows.Where(w => pids.Contains(w.Pid)).ToList();
        }
    }

    private static readonly string GameId = new('a', 32);
    private static readonly DateTimeOffset T0 = new(2026, 10, 7, 20, 0, 0, TimeSpan.Zero);

    private static CloudSessionDto Session(string state, string service = "gfn") =>
        new(GameId, "Nebula Drift", service, "gfnApp", state, state == "running" ? T0.ToString("O") : null, 0, false, null, null, "none");

    private static readonly IReadOnlyList<ProcessEntry> Gfn = [new ProcessEntry(100, 1, 1, "GeForceNOW.exe", 0, 0), new ProcessEntry(200, 1, 1, "explorer.exe", 0, 0)];

    [Fact]
    public void Reads_only_the_gfn_apps_windows_and_alerts_once_when_near()
    {
        var titles = new FakeTitles();
        titles.Windows.Add((200, "Position in queue: 1")); // another app's window: never read
        titles.Windows.Add((100, "GeForce NOW"));
        var w = new GfnQueueWatcher();

        var s = w.Step(T0, Session("waiting"), Gfn, titles, alertAt: 5);
        Assert.Equal("queue", s!.Phase);
        Assert.Null(s.Position);
        Assert.Null(s.Notify);
        Assert.All(titles.Asked, set => Assert.Equal([100], set));
        Assert.Null(w.Step(T0.AddSeconds(4), Session("waiting"), Gfn, titles, 5)); // nothing changed

        titles.Windows[1] = (100, "GeForce NOW - Position in queue: 12");
        s = w.Step(T0.AddSeconds(8), Session("waiting"), Gfn, titles, 5);
        Assert.Equal(12, s!.Position);
        Assert.Null(s.Notify);

        titles.Windows[1] = (100, "GeForce NOW - Position in queue: 4");
        s = w.Step(T0.AddSeconds(12), Session("waiting"), Gfn, titles, 5);
        Assert.Equal("near", s!.Notify);
        titles.Windows[1] = (100, "GeForce NOW - Position in queue: 2");
        Assert.Null(w.Step(T0.AddSeconds(16), Session("waiting"), Gfn, titles, 5)!.Notify); // once

        s = w.Step(T0.AddSeconds(90), Session("running"), Gfn, titles, 5);
        Assert.Equal("starting", s!.Phase);
        Assert.Equal("starting", s.Notify);
        Assert.Null(w.Step(T0.AddSeconds(94), Session("running"), Gfn, titles, 5));

        s = w.Step(T0.AddSeconds(200), null, [], titles, 5);
        Assert.Equal("none", s!.Phase);
        Assert.Null(w.Step(T0.AddSeconds(204), null, [], titles, 5));
    }

    [Fact]
    public void A_stream_that_starts_quickly_was_not_queued_and_other_services_are_ignored()
    {
        var titles = new FakeTitles();
        var w = new GfnQueueWatcher();
        w.Step(T0, Session("waiting"), Gfn, titles, 5);
        var s = w.Step(T0.AddSeconds(8), Session("running"), Gfn, titles, 5);
        Assert.Equal("starting", s!.Phase);
        Assert.Null(s.Notify);

        var x = new GfnQueueWatcher();
        Assert.Null(x.Step(T0, Session("waiting", "xbox"), Gfn, titles, 5));
        Assert.Null(x.Current);
        // Without the GeForce NOW app running, no window is looked at.
        var y = new GfnQueueWatcher();
        var t2 = new FakeTitles();
        y.Step(T0, Session("waiting"), [new ProcessEntry(200, 1, 1, "explorer.exe", 0, 0)], t2, 5);
        Assert.Empty(t2.Asked);
    }

    [Fact]
    public void A_wait_time_of_about_a_minute_counts_as_near()
    {
        var titles = new FakeTitles();
        titles.Windows.Add((100, "GeForce NOW · ETA less than a minute"));
        // "ETA less than a minute" has no "wait"/"eta" time unit, but the less-than-a-minute phrase reads as 1.
        var s = new GfnQueueWatcher().Step(T0, Session("waiting"), Gfn, titles, 5);
        Assert.Equal(1, s!.EtaMinutes);
        Assert.Equal("near", s.Notify);
    }

    // ---------------- notifications ----------------

    private static NotificationPolicy Policy(Dictionary<string, bool>? overrides = null)
    {
        var settings = new Dictionary<string, bool>
        {
            [NotificationPolicy.Enabled] = true, [NotificationPolicy.OnlyInBackground] = true,
            [NotificationPolicy.SubsLeaving] = true, [NotificationPolicy.CloudQueue] = true,
        };
        foreach (var (k, v) in overrides ?? []) settings[k] = v;
        return new NotificationPolicy(k => settings.GetValueOrDefault(k), id => id == GameId ? "Nebula Drift" : null);
    }

    private static JsonElement J(object o) => JsonSerializer.SerializeToElement(o, new JsonSerializerOptions(JsonSerializerDefaults.Web));

    [Fact]
    public void Leaving_soon_notifies_once_with_the_date_and_opens_the_game()
    {
        var p = Policy();
        var payload = J(new { key = "9PNKG0WBL61W", count = 1, items = new[] { new { gameId = GameId, title = "Pacific Drive", end = "2026-10-16T09:59:59Z" } } });
        var n = Assert.Single(p.Evaluate("subs.leaving", payload, foreground: false));
        Assert.StartsWith("Pacific Drive leaves Game Pass around ", n.Title);
        Assert.Equal($$"""{"name":"game","id":"{{GameId}}"}""", n.RouteJson);
        Assert.Empty(p.Evaluate("subs.leaving", payload, foreground: false));

        var many = J(new { key = "a,b,c", count = 4, items = new[] { new { gameId = GameId, title = "A", end = (string?)null }, new { gameId = GameId, title = "B", end = (string?)null } } });
        var m = Assert.Single(Policy().Evaluate("subs.leaving", many, foreground: false));
        Assert.Equal("4 of your games are leaving Game Pass soon", m.Title);
        Assert.Contains("A, B and 2 more", m.Body);
        Assert.Empty(Policy(new() { [NotificationPolicy.SubsLeaving] = false }).Evaluate("subs.leaving", payload, foreground: false));
    }

    [Fact]
    public void Queue_alerts_follow_their_setting_and_say_where_the_number_came_from()
    {
        var near = J(new { gameId = GameId, title = "Nebula Drift", phase = "queue", position = 3, etaMinutes = 2, notify = "near", key = "k1" });
        var n = Assert.Single(Policy().Evaluate("cloud.queue", near, foreground: false));
        Assert.Equal("Almost your turn on GeForce NOW", n.Title);
        Assert.Contains("number 3", n.Body);
        Assert.Contains("As shown in the GeForce NOW window", n.Body);
        Assert.Empty(Policy().Evaluate("cloud.queue", J(new { gameId = GameId, phase = "queue", position = 9, notify = (string?)null, key = "k2" }), foreground: false));
        var start = Assert.Single(Policy().Evaluate("cloud.queue", J(new { gameId = GameId, title = "Nebula Drift", phase = "starting", notify = "starting", key = "k1" }), foreground: false));
        Assert.Equal("Your stream is starting", start.Title);
        Assert.Empty(Policy(new() { [NotificationPolicy.CloudQueue] = false }).Evaluate("cloud.queue", near, foreground: false));
        Assert.Empty(Policy().Evaluate("cloud.queue", near, foreground: true)); // only in the background, as set
    }
}
