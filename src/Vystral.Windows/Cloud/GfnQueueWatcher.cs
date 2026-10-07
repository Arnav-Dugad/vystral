using System.Runtime.InteropServices;
using System.Text;
using Vystral.Core.Subscriptions;
using Vystral.Windows.Monitoring;

namespace Vystral.Windows.Cloud;

/// <summary>Top-level window titles of some processes (read-only: nothing is opened, sent to, hooked or injected).</summary>
public interface IWindowTitleSource
{
    IReadOnlyList<(int Pid, string Title)> Titles(IReadOnlySet<int> pids);
}

/// <summary>
/// <c>EnumWindows</c> + <c>GetWindowText</c> over visible top-level windows, filtered to the given processes. For a
/// window of another process <c>GetWindowText</c> returns the caption Windows already keeps; it doesn't send the window
/// a message, so the other app isn't touched. At most 4,000 windows are looked at and 16 titles returned.
/// </summary>
public sealed class Win32WindowTitles : IWindowTitleSource
{
    private const int MaxWindows = 4000;
    private const int MaxTitles = 16;

    public IReadOnlyList<(int Pid, string Title)> Titles(IReadOnlySet<int> pids)
    {
        var result = new List<(int, string)>();
        if (pids.Count == 0) return result;
        var seen = 0;
        var buffer = new StringBuilder(GfnQueueTitle.MaxTitleLength + 1);
        EnumWindows((hwnd, _) =>
        {
            if (++seen > MaxWindows || result.Count >= MaxTitles) return false;
            if (!IsWindowVisible(hwnd) || GetWindowThreadProcessId(hwnd, out var pid) == 0 || !pids.Contains((int)pid)) return true;
            var length = GetWindowTextLengthW(hwnd);
            if (length <= 0 || length > GfnQueueTitle.MaxTitleLength) return true;
            buffer.Clear();
            if (GetWindowTextW(hwnd, buffer, buffer.Capacity) > 0) result.Add(((int)pid, buffer.ToString()));
            return true;
        }, IntPtr.Zero);
        return result;
    }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLengthW(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int maxCount);
}

/// <summary>What the queue watcher noticed in one look.</summary>
/// <param name="Phase">"queue" (waiting; position/ETA when the title shows them), "starting" (the stream process appeared
/// after a wait), or "none" (no GeForce NOW session waiting).</param>
/// <param name="Notify">"near" (position at or under the setting, or about a minute left) or "starting"; null = no notification.</param>
public sealed record QueueSignal(string GameId, string Title, string Phase, int? Position, int? EtaMinutes, string? Notify, string Key);

/// <summary>
/// Track V: cloud queue alerts. Only while a GeForce NOW session VYSTRAL started is waiting for its stream (Track O's
/// detector in its waiting phase), it reads the titles of <c>GeForceNOW.exe</c>'s visible top-level windows and looks
/// for a queue position or wait time (<see cref="GfnQueueTitle"/>). When the stream process
/// (<c>GeForceNOWStreamer.exe</c>) appears after a real wait, it says the stream is starting — the dependable signal,
/// since whether the app's title ever shows the queue is unverified. Nothing is clicked, read from memory or injected.
/// </summary>
public sealed class GfnQueueWatcher
{
    /// <summary>A stream that starts sooner than this after the launch wasn't queued; no "starting" notice.</summary>
    public static readonly TimeSpan MinWaitForStartNotice = TimeSpan.FromSeconds(30);

    private string? _gameId;
    private DateTimeOffset? _waitingSince;
    private QueueReading? _last;
    private bool _nearSent, _startSent;
    private string _key = "";

    public QueueSignal? Current { get; private set; }

    public void Reset()
    {
        _gameId = null;
        _waitingSince = null;
        _last = null;
        _nearSent = _startSent = false;
        Current = null;
    }

    /// <summary>One look. Returns a signal when something changed (the UI and notifications use it), else null.</summary>
    public QueueSignal? Step(DateTimeOffset now, CloudSessionDto? active, IReadOnlyList<ProcessEntry> processes, IWindowTitleSource titles, int alertAt)
    {
        if (active is null || active.Service != Core.Cloud.CloudServices.GeForceNow)
        {
            var had = Current is not null && Current.Phase != "none";
            var game = _gameId;
            Reset();
            return had && game is not null ? Current = new QueueSignal(game, "", "none", null, null, null, _key) : null;
        }
        if (_gameId != active.GameId)
        {
            Reset();
            _gameId = active.GameId;
            _key = $"{active.GameId[..Math.Min(8, active.GameId.Length)]}-{now.ToUnixTimeSeconds()}";
        }

        if (active.State == "waiting")
        {
            _waitingSince ??= now;
            var pids = processes.Where(p => p.Name.Equals(CloudSessionDetector.GfnApp, StringComparison.OrdinalIgnoreCase)).Select(p => p.Pid).ToHashSet();
            QueueReading? reading = null;
            if (pids.Count > 0)
            {
                foreach (var (_, title) in titles.Titles(pids))
                {
                    reading = GfnQueueTitle.Parse(title);
                    if (reading is not null) break;
                }
            }
            string? notify = null;
            var near = reading is { } r && (r.Position is { } pos && pos <= Math.Max(1, alertAt) || r.Position is null && r.EtaMinutes is <= 1);
            if (near && !_nearSent)
            {
                _nearSent = true;
                notify = "near";
            }
            if (Current is { Phase: "queue" } && reading == _last && notify is null) return null;
            _last = reading;
            return Current = new QueueSignal(active.GameId, active.Title, "queue", reading?.Position, reading?.EtaMinutes, notify, _key);
        }

        // Running: the stream process is there.
        if (_startSent || _waitingSince is not { } since) return null;
        _startSent = true;
        var waited = now - since >= MinWaitForStartNotice;
        return Current = new QueueSignal(active.GameId, active.Title, "starting", null, null, waited ? "starting" : null, _key);
    }
}
