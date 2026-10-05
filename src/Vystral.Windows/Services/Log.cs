using System.Collections.Concurrent;
using System.Text.Json;

namespace Vystral.Windows.Services;

/// <summary>
/// Minimal structured logger: JSON lines, one file per day, 7 days retained, written on a
/// background thread. Logs never contain credentials; paths are logged because they are
/// needed for diagnosing integrations and stay on this PC.
/// </summary>
public static class Log
{
    private static readonly BlockingCollection<string> Queue = new(boundedCapacity: 4096);
    private static string? _dir;
    private static string _name = "vystral";
    private static Thread? _writer;

    /// <param name="fileName">File name prefix: "vystral" for the app, "vystral-tracker" for the background tracker
    /// (two processes never append to the same file).</param>
    public static void Initialize(string directory, string fileName = "vystral")
    {
        if (_dir is not null) return;
        _dir = directory;
        _name = fileName;
        Directory.CreateDirectory(directory);
        try
        {
            foreach (var old in new DirectoryInfo(directory).GetFiles("vystral-*.log").Where(f => f.LastWriteTimeUtc < DateTime.UtcNow.AddDays(-7)))
                old.Delete();
        }
        catch (IOException) { }
        _writer = new Thread(Pump) { IsBackground = true, Name = "vystral-log", Priority = ThreadPriority.BelowNormal };
        _writer.Start();
    }

    public static void Info(string area, string message, object? data = null) => Write("info", area, message, data, null);
    public static void Warn(string area, string message, object? data = null, Exception? ex = null) => Write("warn", area, message, data, ex);
    public static void Error(string area, string message, Exception? ex = null, object? data = null) => Write("error", area, message, data, ex);

    private static void Write(string level, string area, string message, object? data, Exception? ex)
    {
        try
        {
            var line = JsonSerializer.Serialize(new
            {
                t = DateTimeOffset.Now.ToString("O"),
                level,
                area,
                message,
                data,
                error = ex is null ? null : $"{ex.GetType().Name}: {ex.Message}",
                stack = ex?.StackTrace,
            });
            Queue.TryAdd(line);
#if DEBUG
            System.Diagnostics.Debug.WriteLine(line);
#endif
        }
        catch (Exception)
        {
            // Logging must never take the app down.
        }
    }

    /// <summary>Waits (bounded) for queued lines to be written, before the process exits abruptly.</summary>
    public static void Flush(TimeSpan timeout)
    {
        var until = DateTime.UtcNow + timeout;
        while (Queue.Count > 0 && DateTime.UtcNow < until) Thread.Sleep(20);
        Thread.Sleep(30); // the line being written when the queue emptied
    }

    private static void Pump()
    {
        foreach (var line in Queue.GetConsumingEnumerable())
        {
            try
            {
                File.AppendAllText(Path.Combine(_dir!, $"{_name}-{DateTime.Now:yyyyMMdd}.log"), line + Environment.NewLine);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
