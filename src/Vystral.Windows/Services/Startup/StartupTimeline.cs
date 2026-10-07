using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Vystral.Windows.Services.Startup;

/// <summary>
/// Track AA: where startup time goes, measured locally and written once to VYSTRAL's own log (no telemetry:
/// nothing leaves the PC). Host marks are milliseconds since the process started; the interface reports its
/// own marks (first paint, cached Home, live Home, ready) relative to its time origin, converted here.
/// Read in Settings-free form with <c>diagnostics.startup</c> or from the "Startup timings" log line.
/// </summary>
public static partial class StartupTimeline
{
    public const int MaxUiMarks = 24;
    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private static readonly ConcurrentDictionary<string, double> Marks = new(StringComparer.Ordinal);
    private static readonly DateTimeOffset ProcessStart = ReadProcessStart();
    /// <summary>Milliseconds between the process start and this class's first use.</summary>
    private static readonly double Offset = Math.Max(0, (DateTimeOffset.Now - ProcessStart).TotalMilliseconds - Clock.Elapsed.TotalMilliseconds);
    private static int _uiReported;
    private static int _logged;

    [GeneratedRegex(@"^[a-z][a-zA-Z0-9:.\-]{0,40}\z")]
    public static partial Regex MarkName();

    /// <summary>Milliseconds since the process started.</summary>
    public static double Now => Offset + Clock.Elapsed.TotalMilliseconds;

    /// <summary>Records the first time <paramref name="name"/> happens (later calls are ignored).</summary>
    public static void Mark(string name) => Marks.TryAdd(name, Math.Round(Now, 1));

    public static IReadOnlyDictionary<string, double> Snapshot() =>
        Marks.OrderBy(m => m.Value).ToDictionary(m => m.Key, m => m.Value, StringComparer.Ordinal);

    /// <summary>
    /// The interface's marks (ms after its <paramref name="timeOriginEpochMs"/>), accepted once per process.
    /// Returns false when they were already reported or are out of range.
    /// </summary>
    public static bool AddUiMarks(double timeOriginEpochMs, IReadOnlyDictionary<string, double> marks) =>
        AddUiMarks(timeOriginEpochMs, marks, ProcessStart.ToUnixTimeMilliseconds(), Marks);

    /// <summary>Pure core of <see cref="AddUiMarks(double, IReadOnlyDictionary{string, double})"/> (tests use it).</summary>
    public static bool AddUiMarks(double timeOriginEpochMs, IReadOnlyDictionary<string, double> marks, double processStartEpochMs, IDictionary<string, double> into)
    {
        if (marks.Count > MaxUiMarks || double.IsNaN(timeOriginEpochMs)) return false;
        // The page can't have started before the process, nor more than ten minutes after it.
        var originRel = timeOriginEpochMs - processStartEpochMs;
        if (originRel is < -1_000 or > 600_000) return false;
        if (ReferenceEquals(into, Marks) && Interlocked.Exchange(ref _uiReported, 1) == 1) return false;
        into.TryAdd("ui:origin", Math.Round(originRel, 1));
        foreach (var (name, at) in marks)
        {
            if (!MarkName().IsMatch(name) || double.IsNaN(at) || at < 0 || at > 600_000) continue;
            into.TryAdd("ui:" + name, Math.Round(originRel + at, 1));
        }
        return true;
    }

    /// <summary>Writes the timeline to the log once (after the interface is ready).</summary>
    public static void LogOnce()
    {
        if (Interlocked.Exchange(ref _logged, 1) == 1) return;
        Log.Info("startup", "Startup timings (ms since the process started)", Snapshot());
    }

    private static DateTimeOffset ReadProcessStart()
    {
        try
        {
            using var p = Process.GetCurrentProcess();
            return new DateTimeOffset(p.StartTime);
        }
        catch (Exception)
        {
            return DateTimeOffset.Now;
        }
    }
}
