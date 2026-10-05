using System.Runtime.InteropServices;

namespace Vystral.Windows.Launch;

/// <summary>A top-level window seen while looking for the game's main window.</summary>
public readonly record struct WindowCandidate(IntPtr Handle, int ProcessId, bool Visible, bool Owned, bool Cloaked, long Area);

/// <summary>
/// Brings a tracked game's main window to the front (the Play button's "Playing" state). It only
/// restores and activates an existing window; nothing is sent to or read from the game. Windows
/// allows this because VYSTRAL is the foreground app at the moment the user clicks.
/// </summary>
public static partial class WindowFocus
{
    /// <summary>The game's main window: the largest visible, unowned, uncloaked top-level window of its processes.</summary>
    public static IntPtr Pick(IEnumerable<WindowCandidate> windows, IReadOnlyCollection<int> pids) =>
        windows
            .Where(w => w.Visible && !w.Owned && !w.Cloaked && w.Area > 0 && pids.Contains(w.ProcessId))
            .OrderByDescending(w => w.Area)
            .Select(w => w.Handle)
            .FirstOrDefault();

    public static bool BringToFront(IReadOnlyCollection<int> pids)
    {
        if (pids.Count == 0 || !OperatingSystem.IsWindows()) return false;
        var list = new List<WindowCandidate>();
        EnumWindows((h, _) =>
        {
            GetWindowThreadProcessId(h, out var pid);
            if (pids.Contains((int)pid))
            {
                GetWindowRect(h, out var r);
                var cloaked = DwmGetWindowAttribute(h, DwmwaCloaked, out int c, sizeof(int)) == 0 && c != 0;
                list.Add(new WindowCandidate(h, (int)pid, IsWindowVisible(h), GetWindow(h, GwOwner) != IntPtr.Zero, cloaked,
                    (long)Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top)));
            }
            return true;
        }, IntPtr.Zero);
        var target = Pick(list, pids);
        if (target == IntPtr.Zero) return false;
        if (IsIconic(target)) ShowWindow(target, SwRestore);
        return SetForegroundWindow(target);
    }

    private const uint GwOwner = 4;
    private const int SwRestore = 9;
    private const int DwmwaCloaked = 14;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hwnd, int cmd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
}
