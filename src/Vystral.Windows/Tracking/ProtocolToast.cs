using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using Windows.UI.Notifications;

namespace Vystral.Windows.Tracking;

/// <summary>
/// Shows a toast from the background tracker, which has no window and doesn't register with the Windows
/// App SDK. It uses the app's protocol-activation channel (<see cref="ToastXml"/>, <see cref="ActivationUri"/>):
/// selecting the toast opens <c>vystral://open?route=…</c>, which starts VYSTRAL on that page.
/// </summary>
public sealed class ProtocolToast(string aumid)
{
    private ToastNotifier? _notifier;

    public bool Show(NotificationRequest request)
    {
        try
        {
            var uri = ActivationUri.Build(request.RouteJson);
            var xml = new global::Windows.Data.Xml.Dom.XmlDocument();
            xml.LoadXml(ToastXml.Build(request.Title, request.Body, uri));
            var toast = new ToastNotification(xml) { Group = Trim(request.Category, 60) };
            if (request.Tag is { } tag) toast.Tag = Trim(tag, 60);
            _notifier ??= ToastNotificationManager.CreateToastNotifier(aumid);
            try
            {
                if (_notifier.Setting != NotificationSetting.Enabled) return false;
            }
            catch (Exception) { /* unknown until this AUMID has shown a toast once */ }
            _notifier.Show(toast);
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn("tracker", "Showing a notification failed", ex: ex);
            return false;
        }
    }

    private static string Trim(string s, int max) => s.Length <= max ? s : s[..max];
}
