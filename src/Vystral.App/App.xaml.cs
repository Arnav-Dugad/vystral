using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using Vystral.Windows.Services;

namespace Vystral.App;

public partial class App : Application
{
    private MainWindow? _window;

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
        _window = new MainWindow(Program.SafeMode);
        AppInstance.GetCurrent().Activated += (_, _) => _window.DispatcherQueue.TryEnqueue(_window.BringToFront);
        _window.Activate();
    }
}
