using System.Runtime.InteropServices;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;

namespace Vystral.App.Host;

/// <summary>The shell's implementation of <see cref="IInsightHost"/>. Thread-safe; never throws.</summary>
internal sealed partial class InsightHost(MainWindow window, nint hwnd, GlobalHotkey hotkey, AppNotifications notifications) : IInsightHost
{
    public nint WindowHandle => hwnd;

    public bool IsForeground => hwnd != 0 && GetForegroundWindow() == hwnd && !IsIconic(hwnd);

    public IReadOnlyList<ControllerInfo> GetControllers() => ControllerProbe.Get();

    public HotkeyApplyResult ApplyHotkey(Hotkey? hk)
    {
        try { return window.RunOnUi(() => hotkey.Apply(hk)); }
        catch (Exception ex)
        {
            Log.Warn("hotkey", "Applying the shortcut failed", ex: ex);
            return new HotkeyApplyResult(false, "The shortcut couldn't be set right now.");
        }
    }

    public bool NotificationsAvailable => notifications.Available;

    public bool NotificationsClickable => notifications.Clickable;

    public bool ShowNotification(NotificationRequest request) => notifications.Show(request);

    [LibraryImport("user32.dll")]
    private static partial nint GetForegroundWindow();

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsIconic(nint hwnd);
}
