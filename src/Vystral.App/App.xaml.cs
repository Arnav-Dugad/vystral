using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using Microsoft.Windows.AppNotifications;
using Vystral.App.Host;
using Vystral.Windows.Services;

namespace Vystral.App;

public partial class App : Application
{
    private MainWindow? _window;
    private readonly AppNotifications _notifications = new();

    public App()
    {
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            Log.Error("app", "Unhandled UI exception", e.Exception);
            // Keep running: a failure in one view must never stop the user from launching games.
            e.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Error("app", "Fatal exception", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Log.Error("app", "Unobserved task exception", e.Exception);
            e.SetObserved();
        };
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        // Register for notification clicks before anything reads the activation arguments.
        _notifications.Initialize();
        _window = new MainWindow(Program.SafeMode, _notifications);
        var window = _window;
        _notifications.Navigate += route => window.DispatcherQueue.TryEnqueue(() => window.NavigateFromNotification(route));

        AppInstance.GetCurrent().Activated += (_, e) => window.DispatcherQueue.TryEnqueue(() =>
        {
            // A second launch, or a notification click redirected from a new process.
            if (NotificationRoute(e) is { } route) window.NavigateFromNotification(route);
            else window.BringToFront();
        });
        window.Activate();

        // Started by clicking a notification while VYSTRAL wasn't running.
        try
        {
            if (NotificationRoute(AppInstance.GetCurrent().GetActivatedEventArgs()) is { } route) window.NavigateFromNotification(route);
        }
        catch (Exception ex)
        {
            Log.Warn("notify", "Couldn't read activation arguments", ex: ex);
        }
    }

    private static string? NotificationRoute(AppActivationArguments? e) =>
        e is { Kind: ExtendedActivationKind.AppNotification, Data: AppNotificationActivatedEventArgs n } ? AppNotifications.RouteFrom(n.Arguments) : null;
}
