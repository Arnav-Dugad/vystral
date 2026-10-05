using System.Text.Json;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using Windows.UI.Notifications;

namespace Vystral.App.Host;

/// <summary>
/// Windows notifications. Selecting one activates VYSTRAL and opens a page; the route is always
/// rebuilt from an allow-list (<see cref="ActivationUri"/>), never passed through.
/// <para>
/// Three channels, best first:
/// <list type="number">
/// <item><b>Windows App SDK</b> (<c>AppNotificationManager.Register</c>): clicks arrive as
/// <c>NotificationInvoked</c>. Fails today in self-contained 2.5.1 builds (microsoft/WindowsAppSDK#6774),
/// but is tried first so a fixed SDK is used automatically.</item>
/// <item><b>Protocol activation</b>: toast XML with <c>activationType="protocol"</c> sent as VYSTRAL's
/// AppUserModelID; Windows opens <c>vystral://open?route=…</c>, which starts VYSTRAL (or is redirected
/// to the running instance) with <c>--uri</c>. Needs only per-user registry entries.</item>
/// <item><b>Show only</b>: notifications appear but selecting one can't open a page.</item>
/// </list>
/// </para>
/// </summary>
public sealed class AppNotifications
{
    private enum Channel { None, AppSdk, Protocol, ShowOnly }

    private Channel _channel;
    private ToastNotifier? _notifier;

    public bool Available => _channel != Channel.None;

    /// <summary>False when notifications can be shown but clicking one can't be routed back to VYSTRAL.</summary>
    public bool Clickable => _channel is Channel.AppSdk or Channel.Protocol;

    /// <summary>Raised with a validated route JSON when the user clicks a notification (Windows App SDK channel).</summary>
    public event Action<string>? Navigate;

    /// <summary>Picks a channel. Must run before reading activation arguments.</summary>
    /// <param name="aumid">AppUserModelID for protocol toasts.</param>
    /// <param name="registerProtocol">Registers the vystral: scheme and AUMID; false if that failed.</param>
    public void Initialize(string aumid, Func<bool> registerProtocol)
    {
        var sdkSupported = false;
        try
        {
            if (AppNotificationManager.IsSupported())
            {
                sdkSupported = true;
                var manager = AppNotificationManager.Default;
                manager.NotificationInvoked += (_, args) =>
                {
                    if (RouteFrom(args.Arguments) is { } route) Navigate?.Invoke(route);
                };
                manager.Register();
                _channel = Channel.AppSdk;
                Log.Info("notify", "Notifications: Windows App SDK activation");
                return;
            }
        }
        catch (Exception ex)
        {
            // Expected on Windows App SDK 2.5.1 self-contained (missing Insights resource DLL, #6774).
            Log.Info("notify", $"Windows App SDK notification registration unavailable ({ex.GetType().Name} 0x{ex.HResult:X8}); using protocol activation");
        }

        try
        {
            if (registerProtocol())
            {
                _notifier = ToastNotificationManager.CreateToastNotifier(aumid);
                _channel = Channel.Protocol;
                Log.Info("notify", "Notifications: protocol activation", new { aumid });
                return;
            }
        }
        catch (Exception ex)
        {
            Log.Warn("notify", "Protocol-activated notifications unavailable", ex: ex);
        }

        _channel = sdkSupported ? Channel.ShowOnly : Channel.None;
        if (_channel == Channel.ShowOnly) Log.Warn("notify", "Notifications are shown but can't open VYSTRAL pages on this PC");
        else Log.Warn("notify", "Windows notifications unavailable");
    }

    public bool Show(NotificationRequest request) => _channel switch
    {
        Channel.Protocol => ShowProtocol(request),
        Channel.AppSdk or Channel.ShowOnly => ShowAppSdk(request),
        _ => false,
    };

    private bool ShowProtocol(NotificationRequest request)
    {
        try
        {
            var uri = ActivationUri.Build(request.RouteJson);
            if (uri is null) Log.Warn("notify", "Notification route isn't openable; showing it without a link", new { request.Category });
            var xml = new global::Windows.Data.Xml.Dom.XmlDocument();
            xml.LoadXml(ToastXml.Build(request.Title, request.Body, uri));
            var toast = new ToastNotification(xml) { Group = Trim(request.Category, 60) };
            if (request.Tag is { } tag) toast.Tag = Trim(tag, 60);

            // Reading the setting fails with ERROR_NOT_FOUND until this AUMID has posted a toast once.
            try
            {
                if (_notifier!.Setting != NotificationSetting.Enabled) return false;
            }
            catch (Exception) { }
            _notifier!.Show(toast);
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn("notify", "Showing a notification failed", ex: ex);
            return false;
        }
    }

    private static bool ShowAppSdk(NotificationRequest request)
    {
        try
        {
            var builder = new AppNotificationBuilder();
            using (var doc = JsonDocument.Parse(request.RouteJson))
            {
                foreach (var p in doc.RootElement.EnumerateObject())
                    if (p.Value.ValueKind == JsonValueKind.String && p.Name is "name" or "id" or "sessionId" or "section")
                        builder.AddArgument(p.Name == "name" ? "route" : p.Name, p.Value.GetString()!);
            }
            builder.AddText(ToastXml.Clean(request.Title, ToastXml.MaxTitle)).AddText(ToastXml.Clean(request.Body, ToastXml.MaxBody));
            var notification = builder.BuildNotification();
            notification.Group = request.Category;
            if (request.Tag is { } tag) notification.Tag = Trim(tag, 60);
            AppNotificationManager.Default.Show(notification);
            return notification.Id != 0;
        }
        catch (Exception ex)
        {
            Log.Warn("notify", "Showing a notification failed", ex: ex);
            return false;
        }
    }

    /// <summary>Builds a route from Windows App SDK activation arguments (same allow-list as URIs).</summary>
    public static string? RouteFrom(IDictionary<string, string>? args) => ActivationUri.RouteFromArguments(args);

    private static string Trim(string s, int max) => s.Length <= max ? s : s[..max];
}
