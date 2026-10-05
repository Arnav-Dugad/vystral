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
        _notifications.Initialize(ShellIntegration.Aumid, ShellIntegration.EnsureRegistered);
        _window = new MainWindow(Program.SafeMode, _notifications);
        var window = _window;
        _notifications.Navigate += route => window.DispatcherQueue.TryEnqueue(() => window.NavigateFromNotification(route));

        AppInstance.GetCurrent().Activated += (_, e) => window.DispatcherQueue.TryEnqueue(() =>
        {
            // A second launch, or a notification click redirected from a new process.
            if (RouteFromActivation(e) is { } route) window.NavigateFromNotification(route);
            else window.BringToFront();
        });
        window.Activate();

        // Started by clicking a notification while VYSTRAL wasn't running: the route is opened once the interface has loaded.
        try
        {
            var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
            var route = activation?.Kind == ExtendedActivationKind.AppNotification
                ? RouteFromActivation(activation)
                : RouteFromUri(ActivationUri.FromArgs(Environment.GetCommandLineArgs().Skip(1).ToArray()));
            if (route is not null) window.NavigateFromNotification(route);
        }
        catch (Exception ex)
        {
            Log.Warn("notify", "Couldn't read activation arguments", ex: ex);
        }
    }

    /// <summary>
    /// A validated route from an activation: a Windows App SDK notification click, or a launch whose
    /// command line is exactly <c>--uri vystral://…</c> (protocol-activated toast, possibly redirected
    /// from a second process). Anything else is not a navigation.
    /// </summary>
    private static string? RouteFromActivation(AppActivationArguments? e) => e switch
    {
        { Kind: ExtendedActivationKind.AppNotification, Data: AppNotificationActivatedEventArgs n } => AppNotifications.RouteFrom(n.Arguments),
        { Kind: ExtendedActivationKind.Launch, Data: global::Windows.ApplicationModel.Activation.ILaunchActivatedEventArgs l } =>
            RouteFromUri(ActivationUri.FromCommandLine(l.Arguments)),
        _ => null,
    };

    private static string? RouteFromUri(string? uri)
    {
        if (uri is null) return null;
        var route = ActivationUri.RouteFromUri(uri);
        // The URI may come from any program or web page: log that it was refused, never its content.
        if (route is null) Log.Warn("notify", "Ignored a vystral: link that isn't a known VYSTRAL page", new { length = uri.Length });
        return route;
    }
}
