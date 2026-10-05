using System.Text.Json;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;

namespace Vystral.App.Host;

/// <summary>
/// Windows notifications through the Windows App SDK (works for unpackaged apps). Clicking a
/// notification activates VYSTRAL and navigates to a route; only routes VYSTRAL itself created
/// are accepted (the arguments are rebuilt from an allow-list, never passed through).
/// </summary>
public sealed class AppNotifications
{
    private static readonly HashSet<string> RouteNames = ["home", "library", "game", "journal", "performance", "settings", "storage"];
    private static readonly string[] RouteKeys = ["id", "sessionId", "section"];

    public bool Available { get; private set; }

    /// <summary>False when notifications can be shown but clicking one can't be routed back to VYSTRAL.</summary>
    public bool Clickable { get; private set; }

    /// <summary>Raised with a validated route JSON when the user clicks a notification.</summary>
    public event Action<string>? Navigate;

    /// <summary>Hooks the click handler and registers this process. Must run before reading activation arguments.</summary>
    public void Initialize()
    {
        try
        {
            if (!AppNotificationManager.IsSupported()) return;
            var manager = AppNotificationManager.Default;
            manager.NotificationInvoked += (_, args) =>
            {
                if (RouteFrom(args.Arguments) is { } route) Navigate?.Invoke(route);
            };
            Available = true;
            manager.Register();
            Clickable = true;
        }
        catch (Exception ex) when (Available)
        {
            // Windows App SDK 2.5.1 self-contained builds fail Register() looking for a resource DLL
            // that isn't shipped (microsoft/WindowsAppSDK#6774). Show() still works; clicks just
            // can't be routed back, so VYSTRAL keeps notifications and says so in Settings.
            Log.Warn("notify", "Notification click activation unavailable; notifications still shown", ex: ex);
        }
        catch (Exception ex)
        {
            Log.Warn("notify", "Windows notifications unavailable", ex: ex);
            Available = false;
        }
    }

    public bool Show(NotificationRequest request)
    {
        if (!Available) return false;
        try
        {
            var builder = new AppNotificationBuilder();
            using (var doc = JsonDocument.Parse(request.RouteJson))
            {
                foreach (var p in doc.RootElement.EnumerateObject())
                    if (p.Value.ValueKind == JsonValueKind.String && (p.Name == "name" || RouteKeys.Contains(p.Name)))
                        builder.AddArgument(p.Name == "name" ? "route" : p.Name, p.Value.GetString()!);
            }
            builder.AddText(Trim(request.Title, 120)).AddText(Trim(request.Body, 240));
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

    /// <summary>Builds a route from activation arguments, accepting only known names and ID-shaped values.</summary>
    public static string? RouteFrom(IDictionary<string, string>? args)
    {
        if (args is null || !args.TryGetValue("route", out var name) || !RouteNames.Contains(name)) return null;
        var route = new Dictionary<string, string> { ["name"] = name };
        foreach (var key in RouteKeys)
        {
            if (!args.TryGetValue(key, out var v)) continue;
            if (v.Length is 0 or > 40 || !v.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')) return null;
            route[key] = v;
        }
        return JsonSerializer.Serialize(route);
    }

    private static string Trim(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";
}
