using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vystral.Windows.Services.Startup;

/// <summary>
/// One start of VYSTRAL as four milestones, in milliseconds since the process started, each at or after the one
/// before: the backend was ready for the window, the WebView2 control was ready, the first frame of Home was painted,
/// and the interface reported ready. <see cref="CachedFirstPaint"/> says Home was painted from the saved snapshot.
/// </summary>
public sealed record StartupRun(string At, double BackendMs, double WebViewMs, double FirstPaintMs, double ReadyMs, bool CachedFirstPaint);

public sealed record StartupHistoryDto(IReadOnlyList<StartupRun> Runs, int FilesRead);

/// <summary>
/// Track C2: recent startup timings, read back from VYSTRAL's own local logs (the once-per-start "Startup timings"
/// line that <see cref="StartupTimeline.LogOnce"/> writes). Nothing is stored anywhere else and nothing leaves the PC.
/// Reading is bounded: only the app's own daily log files, newest first, at most a few megabytes and lines per file,
/// and only lines that mention the startup message are parsed.
/// </summary>
public static partial class StartupHistory
{
    public const int DefaultLimit = 20;
    public const int MaxLimit = 50;
    public const int MaxFiles = 10;
    public const long MaxBytesPerFile = 16L * 1024 * 1024;
    public const int MaxLinesPerFile = 200_000;
    /// <summary>A start slower than ten minutes isn't a start time; ignore it.</summary>
    private const double MaxMs = 600_000;
    private const string Marker = "Startup timings";

    /// <summary>The app's daily logs only ("vystral-20261010.log"), never the tracker's or anything else in the folder.</summary>
    [GeneratedRegex(@"^vystral-\d{8}\.log$", RegexOptions.CultureInvariant)]
    private static partial Regex AppLogName();

    /// <summary>The newest <paramref name="limit"/> starts, oldest first. An unreadable or missing folder gives none.</summary>
    public static StartupHistoryDto Read(string logDirectory, int limit = DefaultLimit)
    {
        limit = Math.Clamp(limit, 1, MaxLimit);
        var runs = new List<StartupRun>();
        var filesRead = 0;
        IEnumerable<FileInfo> files;
        try
        {
            if (!Directory.Exists(logDirectory)) return new StartupHistoryDto([], 0);
            files = new DirectoryInfo(logDirectory).EnumerateFiles("vystral-*.log", SearchOption.TopDirectoryOnly)
                .Where(f => AppLogName().IsMatch(f.Name) && (f.Attributes & FileAttributes.ReparsePoint) == 0)
                .OrderByDescending(f => f.Name, StringComparer.Ordinal)
                .Take(MaxFiles)
                .ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            return new StartupHistoryDto([], 0);
        }

        foreach (var file in files)
        {
            if (runs.Count >= limit) break;
            List<StartupRun> inFile;
            try { inFile = Parse(ReadLines(file.FullName)).ToList(); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { continue; }
            filesRead++;
            // Newer files first; within a file the last line is the newest start.
            runs.InsertRange(0, inFile);
        }
        var newest = runs.OrderBy(r => DateTimeOffset.Parse(r.At, CultureInfo.InvariantCulture)).ToList();
        return new StartupHistoryDto(newest.Skip(Math.Max(0, newest.Count - limit)).ToList(), filesRead);
    }

    /// <summary>Lines of a log file, shared with the writer (it keeps appending), capped in bytes and lines.</summary>
    private static IEnumerable<string> ReadLines(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (stream.Length > MaxBytesPerFile) stream.Seek(stream.Length - MaxBytesPerFile, SeekOrigin.Begin);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var count = 0;
        while (count++ < MaxLinesPerFile && reader.ReadLine() is { } line) yield return line;
    }

    /// <summary>Startup runs found in log lines, in order. Other lines and malformed ones are skipped.</summary>
    public static IEnumerable<StartupRun> Parse(IEnumerable<string> lines)
    {
        foreach (var line in lines)
        {
            if (line.Length > 64_000 || !line.Contains(Marker, StringComparison.Ordinal)) continue;
            var run = ParseLine(line);
            if (run is not null) yield return run;
        }
    }

    public static StartupRun? ParseLine(string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 8 });
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("area", out var area) || area.ValueKind != JsonValueKind.String || area.GetString() != "startup") return null;
            if (!root.TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.String ||
                message.GetString()?.StartsWith(Marker, StringComparison.Ordinal) != true) return null;
            if (!root.TryGetProperty("t", out var t) || t.ValueKind != JsonValueKind.String ||
                !DateTimeOffset.TryParse(t.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var at)) return null;
            if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object) return null;

            var marks = new Dictionary<string, double>(StringComparer.Ordinal);
            var n = 0;
            foreach (var p in data.EnumerateObject())
            {
                if (++n > 64) break;
                if (p.Value.ValueKind == JsonValueKind.Number && p.Value.TryGetDouble(out var v) && double.IsFinite(v) && v is >= 0 and <= MaxMs)
                    marks[p.Name] = v;
            }
            return FromMarks(at, marks);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// The four milestones from one start's marks. Ready is required; a missing milestone takes the one before it
    /// (a zero-length phase), and each is at least the previous one so the phases stack.
    /// </summary>
    public static StartupRun? FromMarks(DateTimeOffset at, IReadOnlyDictionary<string, double> marks)
    {
        double? Get(params string[] names)
        {
            foreach (var name in names)
                if (marks.TryGetValue(name, out var v)) return v;
            return null;
        }
        var ready = Get("ui:ready", "appReady");
        if (ready is null or <= 0) return null;
        var backend = Math.Min(Get("backendWaitDone", "backendReady") ?? 0, ready.Value);
        var webview = Math.Clamp(Get("webviewReady") ?? backend, backend, ready.Value);
        var firstPaint = Math.Clamp(Get("ui:firstPaint", "ui:fcp", "ui:liveHome") ?? webview, webview, ready.Value);
        return new StartupRun(at.ToString("O", CultureInfo.InvariantCulture), R(backend), R(webview), R(firstPaint), R(ready.Value),
            marks.ContainsKey("firstPaintInjected") || marks.ContainsKey("ui:firstPaint"));
    }

    private static double R(double v) => Math.Round(v, 1);
}
