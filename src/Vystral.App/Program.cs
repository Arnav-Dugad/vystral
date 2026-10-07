using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using Velopack;
using Vystral.App.Host;
using Vystral.Windows.Services;
using Vystral.Windows.Services.Rollback;
using Vystral.Windows.Services.Startup;
using Vystral.Windows.Tracking;

namespace Vystral.App;

public static class Program
{
    [DllImport("Microsoft.ui.xaml.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
    private static extern void XamlCheckProcessRequirements();

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);

    public static bool SafeMode { get; private set; }

    /// <summary>Track AA: the backend being built in parallel with WinUI's start (see <see cref="EarlyStartup"/>).</summary>
    internal static EarlyStartup? Startup { get; private set; }

    [STAThread]
    private static int Main(string[] args)
    {
        // Track H: "--background-tracker" runs the windowless tracker instead of the app (decided before anything else loads).
        var tracker = TrackerCommandLine.Parse(args);

        // Must run first: handles install/update/uninstall hooks and may exit the process.
        // The hooks register / remove the per-user vystral: URI scheme used by clickable notifications,
        // and stop / restart the background tracker around updates (Velopack replaces current\).
        VelopackApp.Build()
            // A downloaded update installs on the next start of the app — never from the tracker, which starts at
            // sign-in and must not show the updater's window then.
            .SetAutoApplyOnStartup(!tracker.BackgroundTracker)
            .OnAfterInstallFastCallback(_ => ShellIntegration.OnInstalled())
            .OnBeforeUpdateFastCallback(_ => TrackerLifecycle.BeforeUpdate())
            .OnAfterUpdateFastCallback(_ =>
            {
                ShellIntegration.OnInstalled();
                TrackerLifecycle.AfterUpdate();
            })
            .OnBeforeUninstallFastCallback(_ =>
            {
                TrackerLifecycle.BeforeUninstall();
                ShellIntegration.OnUninstalling();
            })
            .Run();
        ShellIntegration.InitializeProcessIdentity();

        return tracker.BackgroundTracker ? RunBackgroundTracker(tracker) : RunApp(args);
    }

    /// <summary>
    /// The background tracker: no window, no XAML, no WebView2. Kept in its own method (never inlined) so none
    /// of the UI code below is compiled or loaded in that process.
    /// </summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int RunBackgroundTracker(TrackerCommand command)
    {
        var toast = new ProtocolToast(ShellIntegration.Aumid);
        return BackgroundTrackerHost.Main(command, toast.Show);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int RunApp(string[] args)
    {
        StartupTimeline.Mark("appMain"); // after Velopack's hooks
        // A notification click (vystral:// URI) passes exactly "--uri <uri>". Anything a crafted URI
        // could smuggle onto that command line is ignored, including --safe-mode.
        var uriLaunch = args.Length > 0 && args[0] == ActivationUri.Switch;

        // Holding Shift while starting VYSTRAL, or --safe-mode, starts without visual effects,
        // AI or background downloads, so a bad setting or driver issue can always be recovered.
        SafeMode = (!uriLaunch && args.Contains("--safe-mode", StringComparer.OrdinalIgnoreCase)) || (GetAsyncKeyState(0x10) & 0x8000) != 0;

        XamlCheckProcessRequirements();
        WinRT.ComWrappersSupport.InitializeComWrappers();

        // Single instance: a second launch brings the existing window forward instead.
        var instance = AppInstance.FindOrRegisterForKey("vystral-main");
        if (!instance.IsCurrent)
        {
            var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
            Task.Run(() => instance.RedirectActivationToAsync(activation).AsTask()).Wait(TimeSpan.FromSeconds(5));
            return 0;
        }

        // Silent rollback: records this start before any WinUI/WebView code runs, and returns to the
        // previous version if this one has failed to start twice in a row (see StartupGuard).
        var paths = new AppPaths();
        Log.Initialize(paths.Logs);
        StartupProtection.RunAtStartup(paths.Root, SafeMode);
        StartupTimeline.Mark("protectionDone");

        // Track AA: build the backend (database, settings, services) while WinUI starts, not after it.
        Startup = EarlyStartup.Begin(paths, SafeMode);

        Application.Start(callback =>
        {
            StartupTimeline.Mark("xamlStart");
            var context = new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            _ = new App();
        });
        return 0;
    }
}
