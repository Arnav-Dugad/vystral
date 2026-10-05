using System.Runtime.InteropServices;
using Velopack.Locators;
using Vystral.Windows.Services;

namespace Vystral.App.Host;

/// <summary>
/// The app's identity in the Windows shell: its AppUserModelID (shared with the Velopack Start
/// menu shortcut, so toasts, taskbar and shortcut agree) and the per-user <c>vystral:</c> URI
/// scheme used for clickable notifications. See <see cref="ShellRegistration"/> for the keys.
/// </summary>
internal static partial class ShellIntegration
{
    public const string DisplayName = "VYSTRAL";

    /// <summary>Used by development builds, which Velopack doesn't manage (no shortcut, no explicit AUMID).</summary>
    public const string DevAumid = "Vystral.Dev";

    private static string? _aumid;

    /// <summary>The AppUserModelID toasts are sent as.</summary>
    public static string Aumid => _aumid ??= ResolveAumid(setForProcess: false);

    /// <summary>
    /// Runs right after <c>VelopackApp.Run()</c>. Installed builds already have Velopack's AUMID
    /// (<c>velopack.Vystral</c>) set on the process; development builds get <see cref="DevAumid"/>.
    /// </summary>
    public static void InitializeProcessIdentity() => _aumid = ResolveAumid(setForProcess: true);

    private static string ResolveAumid(bool setForProcess)
    {
        string? aumid = null;
        try { aumid = VelopackLocator.IsCurrentSet ? VelopackLocator.Current.AppUserModelId : null; }
        catch (Exception) { /* not installed by Velopack */ }
        if (!string.IsNullOrWhiteSpace(aumid)) return aumid;
        if (setForProcess) _ = SetCurrentProcessExplicitAppUserModelID(DevAumid);
        return DevAumid;
    }

    private static ShellRegistration Registration()
    {
        var exe = Environment.ProcessPath ?? throw new InvalidOperationException("Unknown executable path.");
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "vystral-256.png");
        return new ShellRegistration(new WindowsUserClassesRegistry(), exe, Aumid, DisplayName, File.Exists(icon) ? icon : null);
    }

    /// <summary>Registers (or repairs) the URI scheme and AUMID entries. Returns false if that failed.</summary>
    public static bool EnsureRegistered()
    {
        try
        {
            var written = Registration().EnsureRegistered();
            if (written > 0) Log.Info("shell", $"Registered the vystral: URI scheme and notification identity ({written} values)", new { aumid = Aumid });
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn("shell", "Couldn't register the vystral: URI scheme; notifications won't open pages", ex: ex);
            return false;
        }
    }

    /// <summary>Velopack install/update hook. Must be quick and must never throw.</summary>
    public static void OnInstalled()
    {
        try { Registration().EnsureRegistered(); }
        catch (Exception) { /* repaired on next start */ }
    }

    /// <summary>Velopack uninstall hook: removes the registration and this app's notifications.</summary>
    public static void OnUninstalling()
    {
        try { Registration().Unregister(); }
        catch (Exception) { }
        try { global::Windows.UI.Notifications.ToastNotificationManager.History.Clear(Aumid); }
        catch (Exception) { }
    }

    [LibraryImport("shell32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int SetCurrentProcessExplicitAppUserModelID(string appId);
}
