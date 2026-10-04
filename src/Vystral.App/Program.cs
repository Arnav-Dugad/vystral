using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using Velopack;

namespace Vystral.App;

public static class Program
{
    [DllImport("Microsoft.ui.xaml.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
    private static extern void XamlCheckProcessRequirements();

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);

    public static bool SafeMode { get; private set; }

    [STAThread]
    private static int Main(string[] args)
    {
        // Must run first: handles install/update/uninstall hooks and may exit the process.
        VelopackApp.Build().Run();

        // Holding Shift while starting VYSTRAL, or --safe-mode, starts without visual effects,
        // AI or background downloads, so a bad setting or driver issue can always be recovered.
        SafeMode = args.Contains("--safe-mode", StringComparer.OrdinalIgnoreCase) || (GetAsyncKeyState(0x10) & 0x8000) != 0;

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

        Application.Start(callback =>
        {
            var context = new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            _ = new App();
        });
        return 0;
    }
}
