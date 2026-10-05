using System.Diagnostics;
using Velopack.Locators;
using Vystral.Windows.Services;

namespace Vystral.Windows.Tracking;

/// <summary>
/// The background tracker around Velopack's install, update and uninstall steps. Velopack's updater stops
/// every process running from the install folder before it replaces <c>current\</c>; these hooks make that a
/// clean stop (the running session is parked, not cut off) and start the tracker again afterwards.
/// Each runs inside a Velopack hook process with a 15–30 s limit, so everything here is bounded and never throws.
/// </summary>
public static class TrackerLifecycle
{
    private static readonly TimeSpan StopTimeout = TimeSpan.FromSeconds(10);

    /// <summary>Old version, before the update is applied (<c>--veloapp-obsolete</c>): stop the tracker gracefully.</summary>
    public static void BeforeUpdate()
    {
        try
        {
            if (!TrackerSignals.StopHelper(TrackerNames.For(AppPaths.DefaultRoot), StopTimeout))
                Log.Warn("tracker", "The background tracker didn't stop before the update; Velopack will close it");
        }
        catch (Exception) { /* the updater stops it anyway */ }
    }

    /// <summary>
    /// New version, after the update (<c>--veloapp-updated</c>): if the user has the tracker starting with Windows
    /// (and hasn't turned that off in Task Manager), refresh the entry and start the tracker again now.
    /// </summary>
    public static void AfterUpdate()
    {
        try
        {
            var autostart = new TrackerAutostart(new WindowsRunKeyStore(), Launcher());
            var state = autostart.State();
            if (state is not (AutostartState.On or AutostartState.Stale)) return;
            autostart.Enable();
            if (Launcher() is { } launcher)
            {
                var psi = new ProcessStartInfo(launcher)
                {
                    UseShellExecute = false,
                    WorkingDirectory = Path.GetDirectoryName(launcher)!,
                };
                psi.ArgumentList.Add(TrackerCommandLine.Switch);
                using var _ = Process.Start(psi);
            }
        }
        catch (Exception) { /* started at the next sign-in or when VYSTRAL opens */ }
    }

    /// <summary>Before uninstall (<c>--veloapp-uninstall</c>): stop the tracker and remove its sign-in entry.</summary>
    public static void BeforeUninstall()
    {
        try { TrackerSignals.StopHelper(TrackerNames.For(AppPaths.DefaultRoot), StopTimeout); }
        catch (Exception) { }
        try { new TrackerAutostart(new WindowsRunKeyStore(), null).Remove(); }
        catch (Exception) { }
    }

    private static string? Launcher()
    {
        try
        {
            if (!VelopackLocator.IsCurrentSet) return null;
            var l = VelopackLocator.Current;
            return TrackerAutostart.FindLauncher(l.RootAppDir, l.IsPortable, Environment.ProcessPath);
        }
        catch (Exception) { return null; }
    }
}
