using System.Text;
using Vystral.Windows.Monitoring;
using Xunit;

namespace Vystral.Tests.Insights;

public sealed class FrameCaptureTests
{
    // Header written by PresentMon 2.6.0 with default metrics (abridged to the real column order prefix).
    private const string V2Header =
        "Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,FrameType,CPUStartTime,MsBetweenSimulationStart,MsBetweenPresents,MsBetweenDisplayChange,MsInPresentAPI,MsRenderPresentLatency,MsUntilDisplayed";

    private static string Row(string app, int pid, string swap, double ft) =>
        $"{app},{pid},{swap},DXGI,1,0,0,Hardware: Independent Flip,Application,123.4,NA,{ft.ToString(System.Globalization.CultureInfo.InvariantCulture)},16.6,0.2,3.1,10.0";

    [Fact]
    public void Parser_waits_for_header_and_filters_by_pid()
    {
        var p = new PresentMonCsvParser(42);
        Assert.Null(p.ParseLine("warning: something on stdout"));
        Assert.Null(p.ParseLine(V2Header));
        Assert.True(p.HasHeader);
        // Lock-in: the first 240 rows only pick the swap chain.
        for (var i = 0; i < 240; i++) Assert.Null(p.ParseLine(Row("game.exe", 42, "0xA", 16.7)));
        Assert.True(p.Locked);
        Assert.Equal(16.7, p.ParseLine(Row("game.exe", 42, "0xA", 16.7)));
        Assert.Null(p.ParseLine(Row("other.exe", 7, "0xA", 5)));
        Assert.Null(p.ParseLine("game.exe,42,0xA,DXGI,NA"));        // short row
    }

    [Fact]
    public void Parser_locks_onto_the_busiest_swap_chain()
    {
        var p = new PresentMonCsvParser(42);
        p.ParseLine(V2Header);
        for (var i = 0; i < 240; i++) p.ParseLine(Row("game.exe", 42, i % 4 == 0 ? "0xOVERLAY" : "0xMAIN", 10));
        Assert.Equal(8.0, p.ParseLine(Row("game.exe", 42, "0xMAIN", 8)));
        Assert.Null(p.ParseLine(Row("game.exe", 42, "0xOVERLAY", 8)));
    }

    [Fact]
    public void Parser_handles_v1_headers_and_commas_in_the_exe_name()
    {
        var p = new PresentMonCsvParser(9);
        p.ParseLine("Application,ProcessID,TimeInSeconds,msBetweenPresents"); // no SwapChainAddress → no lock-in
        Assert.True(p.Locked);
        Assert.Equal(33.3, p.ParseLine("my,game.exe,9,1.5,33.3"));
        Assert.Null(p.ParseLine("game.exe,9,1.5,NA"));
    }

    [Fact]
    public void Line_reader_decodes_utf8_and_utf16_split_across_chunks()
    {
        var utf8 = new OutputLineReader();
        var bytes = Encoding.UTF8.GetBytes("a,b\r\nc,d\nlast");
        var lines = utf8.Feed(bytes.AsSpan(0, 5)).Concat(utf8.Feed(bytes.AsSpan(5))).ToList();
        Assert.Equal(["a,b", "c,d"], lines);

        var utf16 = new OutputLineReader();
        var wide = new byte[] { 0xFF, 0xFE }.Concat(Encoding.Unicode.GetBytes("x,y\ny,z\n")).ToArray();
        var wl = utf16.Feed(wide.AsSpan(0, 7)).Concat(utf16.Feed(wide.AsSpan(7))).ToList();
        Assert.Equal(["x,y", "y,z"], wl);

        var noBom = new OutputLineReader();
        Assert.Equal(["Application"], noBom.Feed(Encoding.Unicode.GetBytes("Application\n")).ToList());
    }

    [Fact]
    public void Line_reader_drops_overlong_lines()
    {
        var r = new OutputLineReader();
        var lines = r.Feed(Encoding.UTF8.GetBytes(new string('x', 10000) + "\nok\n")).ToList();
        Assert.Equal(["ok"], lines);
    }

    [Fact]
    public void Constant_frame_times_give_exact_fps_and_lows()
    {
        var s = new FrameStats();
        for (var i = 0; i < 1000; i++) s.Add(10);
        var sum = s.Summarize()!;
        Assert.Equal(1000, sum.Frames);
        Assert.Equal(100, sum.FpsAvg);
        Assert.Equal(100, sum.Fps1Low, 0.6);
        Assert.Equal(10, sum.FrameTimeP50Ms, 0.1);
        Assert.Equal(10, sum.FrameTimeP99Ms, 0.1);
        Assert.Equal(0, sum.Stutters);
    }

    [Fact]
    public void Lows_are_the_average_of_the_slowest_frames()
    {
        var s = new FrameStats();
        for (var i = 0; i < 990; i++) s.Add(10);   // 100 fps
        for (var i = 0; i < 10; i++) s.Add(40);    // slowest 1% at 25 fps
        var sum = s.Summarize()!;
        Assert.Equal(1000.0 * 1000 / (990 * 10 + 10 * 40), sum.FpsAvg, 0.1);
        Assert.Equal(25, sum.Fps1Low, 0.1);        // mean of worst 10 frames = 40 ms
        Assert.Equal(25, sum.Fps01Low, 0.1);        // worst 1 frame = 40 ms
        Assert.Equal(10, sum.FrameTimeP50Ms, 0.1);
        Assert.Equal(10, sum.FrameTimeP99Ms, 0.1);   // 990th frame is still 10 ms
        Assert.Equal(1000, sum.Histogram.Sum());
    }

    [Fact]
    public void Very_long_frames_count_through_the_overflow_bucket_and_pauses_are_ignored()
    {
        var s = new FrameStats();
        for (var i = 0; i < 999; i++) s.Add(16);
        s.Add(400);         // a real hitch (beyond the fine histogram)
        s.Add(9000);        // a pause (alt-tab / loading) — ignored
        s.Add(double.NaN);
        s.Add(-1);
        var sum = s.Summarize()!;
        Assert.Equal(1000, sum.Frames);
        Assert.Equal(2.5, sum.Fps01Low, 0.01);        // 1000 / 400 ms
        Assert.Equal(1, sum.Histogram[^1]);         // > 100 ms bucket
    }

    [Fact]
    public void Stutters_are_spikes_against_the_recent_average()
    {
        var s = new FrameStats();
        for (var i = 0; i < 50; i++) s.Add(8);
        s.Add(30);      // > 2× and ≥ 8 ms above → stutter
        for (var i = 0; i < 50; i++) s.Add(8);
        s.Add(14);      // 1.75× → not a stutter
        Assert.Equal(1, s.Summarize()!.Stutters);

        var fast = new FrameStats();
        for (var i = 0; i < 50; i++) fast.Add(2);
        fast.Add(5);    // 2.5× but only 3 ms longer → not a stutter
        Assert.Equal(0, fast.Summarize()!.Stutters);
    }

    [Fact]
    public void Window_drains_per_sample()
    {
        var s = new FrameStats();
        Assert.Null(s.DrainWindow());
        for (var i = 0; i < 99; i++) s.Add(10);
        s.Add(20);
        var w = s.DrainWindow()!.Value;
        Assert.Equal(1000.0 * 100 / 1010, w.Fps, 0.1);
        Assert.Equal(10.1, w.FrameTimeMs, 2);
        Assert.Equal(10, w.FrameTimeP99Ms);
        Assert.Null(s.DrainWindow());
        Assert.Null(new FrameStats().Summarize());
    }

    [Fact]
    public void Capture_arguments_are_fixed_and_stop_the_existing_session()
    {
        var args = FrameCapture.Arguments(1234);
        Assert.Equal(["--process_id", "1234", "--output_stdout", "--no_console_stats", "--no_track_input",
            "--session_name", FrameCapture.SessionName, "--stop_existing_session", "--terminate_on_proc_exit"], args);
    }

    [Fact]
    public void Access_denied_is_explained()
    {
        var msg = FrameCapture.Explain(6, "error: failed to start trace session: access denied.");
        Assert.Contains("Performance Log Users", msg);
        Assert.Null(FrameCapture.Explain(0, ""));
        Assert.Contains("code 3", FrameCapture.Explain(3, "other"));
    }
}
