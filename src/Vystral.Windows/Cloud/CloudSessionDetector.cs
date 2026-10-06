using Vystral.Windows.Monitoring;

namespace Vystral.Windows.Cloud;

public enum CloudDetectorState { Waiting, Running, Ended, Abandoned }

/// <summary>
/// Notices a cloud session started from VYSTRAL, read-only, from a handle-free process list and the foreground
/// window's process id (nothing is opened, read or hooked):
/// <list type="bullet">
/// <item><see cref="CloudDetect.OwnProcess"/>: the Edge window VYSTRAL started with its own profile folder; the session
/// lasts while that process runs. If it hands over to an Edge already open on that folder, the earlier browser process
/// is followed when VYSTRAL knows it, otherwise the session waits for "I'm done".</item>
/// <item><see cref="CloudDetect.GfnStreamer"/>: GeForce NOW's stream process (<c>GeForceNOWStreamer.exe</c>) appearing and
/// going away, with a grace period. Queue time before the stream isn't counted.</item>
/// <item><see cref="CloudDetect.XboxForeground"/>: the Xbox app in the foreground after the launch; the session ends when it
/// has been in the background for five minutes or has closed.</item>
/// <item><see cref="CloudDetect.Manual"/>: the default browser (tabs can't be seen); runs until "I'm done".</item>
/// </list>
/// Every session is capped (the membership's session length, or 8 hours), so a leftover process can't run the meter forever.
/// </summary>
public sealed class CloudSessionDetector
{
    public const string GfnStreamer = "GeForceNOWStreamer.exe";
    public const string GfnApp = "GeForceNOW.exe";
    public static readonly string[] XboxApp = ["XboxPcApp.exe", "XboxPcAppCE.exe"];

    public static readonly TimeSpan HandOffWindow = TimeSpan.FromSeconds(10);
    public static readonly TimeSpan StreamerGrace = TimeSpan.FromSeconds(20);
    public static readonly TimeSpan GfnAppGone = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan GfnMaxWait = TimeSpan.FromMinutes(45);
    public static readonly TimeSpan XboxMaxWait = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan XboxIdle = TimeSpan.FromMinutes(5);

    private readonly DateTimeOffset _launchedAt;
    private readonly TimeSpan _cap;
    private int? _pid;
    private readonly int? _previousBrowserPid;
    private DateTimeOffset? _absentSince;

    public CloudDetect Mode { get; private set; }
    public CloudDetectorState State { get; private set; } = CloudDetectorState.Waiting;
    public DateTimeOffset? Start { get; private set; }
    public DateTimeOffset? LastSeen { get; private set; }
    public DateTimeOffset? End { get; private set; }
    /// <summary>The Edge browser process now being followed (remembered for a later hand-over).</summary>
    public int? BrowserPid => Mode == CloudDetect.OwnProcess ? _pid : null;

    public CloudSessionDetector(CloudDetect mode, int? launchedPid, DateTimeOffset launchedAt, TimeSpan cap, int? previousBrowserPid = null)
    {
        Mode = mode;
        _pid = launchedPid;
        _launchedAt = launchedAt;
        _cap = cap <= TimeSpan.Zero ? TimeSpan.FromHours(8) : cap;
        _previousBrowserPid = previousBrowserPid;
        if (mode is CloudDetect.OwnProcess or CloudDetect.Manual)
        {
            // The window opens right away; there's no queue to leave out.
            State = CloudDetectorState.Running;
            Start = LastSeen = launchedAt;
            if (mode == CloudDetect.OwnProcess && launchedPid is null) Mode = CloudDetect.Manual;
        }
    }

    public bool Done => State is CloudDetectorState.Ended or CloudDetectorState.Abandoned;

    /// <summary>One look (every few seconds). <paramref name="processes"/> is a handle-free snapshot.</summary>
    public void Tick(DateTimeOffset now, IReadOnlyList<ProcessEntry> processes, int? foregroundPid)
    {
        if (Done) return;
        switch (Mode)
        {
            case CloudDetect.OwnProcess: TickOwn(now, processes); break;
            case CloudDetect.GfnStreamer: TickGfn(now, processes); break;
            case CloudDetect.XboxForeground: TickXbox(now, processes, foregroundPid); break;
            case CloudDetect.Manual: LastSeen = now; break;
        }
        if (State == CloudDetectorState.Running && Start is { } s && now - s >= _cap) Finish(s + _cap);
    }

    /// <summary>"I'm done": ends a running session now, or abandons one that never started.</summary>
    public void EndNow(DateTimeOffset now)
    {
        if (Done) return;
        if (State == CloudDetectorState.Running) Finish(now);
        else State = CloudDetectorState.Abandoned;
    }

    private void TickOwn(DateTimeOffset now, IReadOnlyList<ProcessEntry> processes)
    {
        if (_pid is { } pid && processes.Any(p => p.Pid == pid))
        {
            LastSeen = now;
            return;
        }
        if (now - _launchedAt <= HandOffWindow)
        {
            // Edge handed the window to a browser already open on VYSTRAL's profile folder and exited.
            if (_previousBrowserPid is { } prev && processes.Any(p => p.Pid == prev && p.Name.Equals("msedge.exe", StringComparison.OrdinalIgnoreCase)))
                _pid = prev;
            else
                Mode = CloudDetect.Manual;
            LastSeen = now;
            return;
        }
        Finish(LastSeen ?? now);
    }

    private void TickGfn(DateTimeOffset now, IReadOnlyList<ProcessEntry> processes)
    {
        var streaming = processes.Any(p => p.Name.Equals(GfnStreamer, StringComparison.OrdinalIgnoreCase));
        if (State == CloudDetectorState.Waiting)
        {
            if (streaming)
            {
                State = CloudDetectorState.Running;
                Start = LastSeen = now;
                return;
            }
            var app = processes.Any(p => p.Name.Equals(GfnApp, StringComparison.OrdinalIgnoreCase));
            if (app) _absentSince = null;
            else _absentSince ??= now;
            if ((_absentSince is { } gone && now - gone >= GfnAppGone && now - _launchedAt >= GfnAppGone) || now - _launchedAt >= GfnMaxWait)
                State = CloudDetectorState.Abandoned;
            return;
        }
        if (streaming)
        {
            LastSeen = now;
            _absentSince = null;
            return;
        }
        _absentSince ??= now;
        if (now - _absentSince.Value >= StreamerGrace) Finish(LastSeen ?? now);
    }

    private void TickXbox(DateTimeOffset now, IReadOnlyList<ProcessEntry> processes, int? foregroundPid)
    {
        var xbox = processes.Where(p => XboxApp.Contains(p.Name, StringComparer.OrdinalIgnoreCase)).Select(p => p.Pid).ToHashSet();
        var front = foregroundPid is { } f && xbox.Contains(f);
        if (State == CloudDetectorState.Waiting)
        {
            if (front)
            {
                State = CloudDetectorState.Running;
                Start = LastSeen = now;
            }
            else if (now - _launchedAt >= XboxMaxWait) State = CloudDetectorState.Abandoned;
            return;
        }
        if (front) LastSeen = now;
        else if (xbox.Count == 0 || now - (LastSeen ?? now) >= XboxIdle) Finish(LastSeen ?? now);
    }

    private void Finish(DateTimeOffset end)
    {
        if (Start is { } s && end < s) end = s;
        End = end;
        State = CloudDetectorState.Ended;
    }

    public int Seconds => Start is { } s && (End ?? LastSeen) is { } e ? (int)Math.Max(0, (e - s).TotalSeconds) : 0;
}
