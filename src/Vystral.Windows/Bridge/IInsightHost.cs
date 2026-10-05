using Vystral.Windows.Services;

namespace Vystral.Windows.Bridge;

/// <summary>A connected game controller. Battery is null for wired pads or when Windows doesn't report it.</summary>
public sealed record ControllerInfo(string Name, int? BatteryPercent, bool? Charging, bool Wireless);

/// <summary>A Windows notification VYSTRAL wants to show. Route is navigated to when it is clicked.</summary>
public sealed record NotificationRequest(string Category, string Title, string Body, string RouteJson, string? Tag = null);

public sealed record HotkeyApplyResult(bool Registered, string? Error);

/// <summary>
/// Native capabilities used by pre-flight checks, the summon hotkey and Windows notifications.
/// Implemented by the WinUI shell (Vystral.App) and attached to <see cref="AppBackend.InsightHost"/>
/// after the window exists. Every member must be safe to call from any thread and must never throw.
/// </summary>
public interface IInsightHost
{
    /// <summary>The main window handle (for display queries); 0 before the window exists.</summary>
    nint WindowHandle { get; }

    /// <summary>True when VYSTRAL's window is the active, visible foreground window.</summary>
    bool IsForeground { get; }

    IReadOnlyList<ControllerInfo> GetControllers();

    /// <summary>Registers (or, with null, unregisters) the global summon shortcut on the main window.</summary>
    HotkeyApplyResult ApplyHotkey(Hotkey? hotkey);

    /// <summary>False when Windows notifications couldn't be registered for this process.</summary>
    bool NotificationsAvailable { get; }

    /// <summary>False when a notification can be shown but selecting it can't open VYSTRAL's page.</summary>
    bool NotificationsClickable { get; }

    bool ShowNotification(NotificationRequest request);
}
