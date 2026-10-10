using System.Text.Json;
using Vystral.Tests.Support;
using Vystral.Windows.Services.Startup;
using Xunit;

namespace Vystral.Tests.Startup;

/// <summary>Track C2: startup timings read back from the local log for Settings › About.</summary>
public sealed class StartupHistoryTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    /// <summary>A log line exactly as Log.Info writes it.</summary>
    private static string Line(string t, object data, string area = "startup", string message = "Startup timings (ms since the process started)") =>
        JsonSerializer.Serialize(new { t, level = "info", area, message, data, error = (string?)null, stack = (string?)null });

    private static readonly Dictionary<string, double> Typical = new()
    {
        ["appMain"] = 41.2, ["backendStart"] = 60.1, ["backendReady"] = 240.5, ["windowCreate"] = 180.3, ["backendWaitDone"] = 251.9,
        ["webviewReady"] = 610.4, ["firstPaintInjected"] = 640, ["navigationStart"] = 650.2, ["ui:script"] = 820.1,
        ["ui:firstPaint"] = 905.6, ["ui:liveHome"] = 1300.2, ["ui:ready"] = 1420.7, ["appReady"] = 1431.0,
    };

    [Fact]
    public void Reads_the_four_milestones_of_a_start()
    {
        var run = StartupHistory.ParseLine(Line("2026-10-09T08:15:00.0000000+02:00", Typical));
        Assert.NotNull(run);
        Assert.Equal(251.9, run!.BackendMs);
        Assert.Equal(610.4, run.WebViewMs);
        Assert.Equal(905.6, run.FirstPaintMs);
        Assert.Equal(1420.7, run.ReadyMs);
        Assert.True(run.CachedFirstPaint);
    }

    [Fact]
    public void Missing_milestones_become_zero_length_phases_and_never_go_backwards()
    {
        var marks = new Dictionary<string, double> { ["backendReady"] = 900, ["webviewReady"] = 500, ["ui:fcp"] = 1200, ["appReady"] = 1100 };
        var run = StartupHistory.FromMarks(DateTimeOffset.UnixEpoch, marks)!;
        Assert.Equal(900, run.BackendMs);
        Assert.Equal(900, run.WebViewMs);     // reported earlier than the backend: clamped up
        Assert.Equal(1100, run.FirstPaintMs); // later than ready: clamped down
        Assert.Equal(1100, run.ReadyMs);
        Assert.False(run.CachedFirstPaint);
    }

    [Fact]
    public void A_start_that_never_got_ready_is_skipped() =>
        Assert.Null(StartupHistory.FromMarks(DateTimeOffset.UnixEpoch, new Dictionary<string, double> { ["backendReady"] = 200 }));

    [Theory]
    [InlineData("not json at all Startup timings")]
    [InlineData("{\"t\":\"2026-10-09T08:15:00Z\",\"area\":\"startup\",\"message\":\"Startup timings\",\"data\":[1,2]}")]
    [InlineData("{\"t\":\"yesterday\",\"area\":\"startup\",\"message\":\"Startup timings\",\"data\":{\"appReady\":1}}")]
    [InlineData("{\"t\":\"2026-10-09T08:15:00Z\",\"area\":\"other\",\"message\":\"Startup timings\",\"data\":{\"appReady\":1}}")]
    [InlineData("[\"Startup timings\"]")]
    public void Malformed_or_foreign_lines_are_ignored(string line) => Assert.Null(StartupHistory.ParseLine(line));

    [Fact]
    public void Out_of_range_values_are_dropped()
    {
        var run = StartupHistory.ParseLine(Line("2026-10-09T08:15:00Z", new Dictionary<string, object> { ["backendReady"] = -5, ["webviewReady"] = 9e9, ["appReady"] = 1500, ["ui:ready"] = "fast" }));
        Assert.NotNull(run);
        Assert.Equal(0, run!.BackendMs);
        Assert.Equal(0, run.WebViewMs);
        Assert.Equal(1500, run.ReadyMs);
    }

    [Fact]
    public void Reads_only_the_apps_daily_logs_newest_last_and_caps_the_count()
    {
        var day1 = Enumerable.Range(0, 15).Select(i => Line($"2026-10-08T{8 + i / 2:00}:{i % 2 * 30:00}:00Z", Typical)).ToList();
        day1.Insert(3, Line("2026-10-08T08:10:00Z", new { }, area: "library", message: "Scan finished"));
        File.WriteAllLines(Path.Combine(_dir.Path, "vystral-20261008.log"), day1);
        var slow = new Dictionary<string, double>(Typical) { ["ui:ready"] = 4200 };
        File.WriteAllLines(Path.Combine(_dir.Path, "vystral-20261009.log"), [Line("2026-10-09T09:00:00Z", Typical), Line("2026-10-09T20:00:00Z", slow)]);
        // The tracker's log and stray files are never read.
        File.WriteAllLines(Path.Combine(_dir.Path, "vystral-tracker-20261009.log"), [Line("2026-10-09T23:00:00Z", Typical)]);
        File.WriteAllLines(Path.Combine(_dir.Path, "notes.log"), [Line("2026-10-09T23:30:00Z", Typical)]);

        var all = StartupHistory.Read(_dir.Path, 50);
        Assert.Equal(17, all.Runs.Count);
        Assert.Equal(2, all.FilesRead);
        Assert.Equal(4200, all.Runs[^1].ReadyMs);
        Assert.True(all.Runs.Zip(all.Runs.Skip(1)).All(p => DateTimeOffset.Parse(p.First.At) <= DateTimeOffset.Parse(p.Second.At)));

        var recent = StartupHistory.Read(_dir.Path, 5);
        Assert.Equal(5, recent.Runs.Count);
        Assert.Equal("2026-10-09T20:00:00.0000000+00:00", recent.Runs[^1].At);
    }

    [Fact]
    public void A_missing_folder_or_limit_out_of_range_is_safe()
    {
        Assert.Empty(StartupHistory.Read(Path.Combine(_dir.Path, "nope")).Runs);
        File.WriteAllLines(Path.Combine(_dir.Path, "vystral-20261009.log"), [Line("2026-10-09T09:00:00Z", Typical)]);
        Assert.Single(StartupHistory.Read(_dir.Path, 0).Runs);
        Assert.Single(StartupHistory.Read(_dir.Path, 9999).Runs);
    }
}
