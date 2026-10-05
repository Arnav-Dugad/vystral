using Microsoft.Win32;

namespace Vystral.Windows.Tracking;

/// <summary>
/// The per-user "run at sign-in" list (<c>HKCU\Software\Microsoft\Windows\CurrentVersion\Run</c>) and
/// Task Manager's on/off state for its entries. Behind an interface so registration is tested without
/// touching the registry.
/// </summary>
public interface IRunKeyStore
{
    string? Get(string name);
    void Set(string name, string value);
    void Delete(string name);
    /// <summary>True when the user turned the entry off in Task Manager › Startup apps; null when unknown.</summary>
    bool? IsDisabledInStartupApps(string name);
}

public sealed class WindowsRunKeyStore : IRunKeyStore
{
    public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    public string? Get(string name)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
        return key?.GetValue(name) as string;
    }

    public void Set(string name, string value)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
        key.SetValue(name, value, RegistryValueKind.String);
    }

    public void Delete(string name)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
        key?.DeleteValue(name, throwOnMissingValue: false);
    }

    public bool? IsDisabledInStartupApps(string name)
    {
        using var key = Registry.CurrentUser.OpenSubKey(ApprovedKey, writable: false);
        // First byte: 2 or 6 = enabled, 3 or 7 = turned off by the user.
        return key?.GetValue(name) is byte[] { Length: > 0 } data ? (data[0] & 1) == 1 : null;
    }
}

public enum AutostartState
{
    /// <summary>Not possible in this build (development or portable copy).</summary>
    Unavailable,
    Off,
    On,
    /// <summary>Registered, but turned off in Task Manager › Startup apps.</summary>
    DisabledByWindows,
    /// <summary>Registered with a different command (e.g. an older install location); <see cref="TrackerAutostart.Enable"/> repairs it.</summary>
    Stale,
}

/// <summary>
/// Starts the background tracker when the user signs in. The entry points at Velopack's root launcher
/// (<c>%LOCALAPPDATA%\Vystral\Vystral.exe</c>), never at the versioned <c>current\</c> folder, so it keeps
/// working across updates. Only installed builds register it.
/// </summary>
public sealed class TrackerAutostart(IRunKeyStore store, string? launcherPath)
{
    public const string ValueName = "VYSTRAL Background Tracker";

    /// <summary>The exact value written, or null when this build can't register.</summary>
    public string? Command => launcherPath is null ? null : $"\"{launcherPath}\" {TrackerCommandLine.Switch}";

    public bool Available => launcherPath is not null && IsSafePath(launcherPath);

    public AutostartState State()
    {
        if (!Available) return AutostartState.Unavailable;
        var value = store.Get(ValueName);
        if (value is null) return AutostartState.Off;
        if (!string.Equals(value, Command, StringComparison.OrdinalIgnoreCase)) return AutostartState.Stale;
        return store.IsDisabledInStartupApps(ValueName) == true ? AutostartState.DisabledByWindows : AutostartState.On;
    }

    /// <summary>Writes the entry if it is missing or different. False when this build can't register.</summary>
    public bool Enable()
    {
        if (!Available) return false;
        if (!string.Equals(store.Get(ValueName), Command, StringComparison.Ordinal)) store.Set(ValueName, Command!);
        return true;
    }

    /// <summary>
    /// Removes the entry (only VYSTRAL's own value name is ever touched). A development or portable copy
    /// never touches it, so running one can't switch off the installed app's tracker.
    /// </summary>
    public void Disable()
    {
        if (Available && store.Get(ValueName) is not null) store.Delete(ValueName);
    }

    /// <summary>Uninstall: removes the entry whatever this copy is.</summary>
    public void Remove()
    {
        if (store.Get(ValueName) is not null) store.Delete(ValueName);
    }

    private static bool IsSafePath(string path) =>
        Path.IsPathFullyQualified(path) && !path.StartsWith(@"\\", StringComparison.Ordinal) &&
        path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && path.IndexOfAny(['"', '%', '\r', '\n']) < 0;

    /// <summary>
    /// Velopack's root launcher for this install, or null for development and portable builds.
    /// <paramref name="rootAppDir"/> is Velopack's install root (the folder holding Update.exe and current\).
    /// </summary>
    public static string? FindLauncher(string? rootAppDir, bool portable, string? processPath)
    {
        if (portable || string.IsNullOrEmpty(rootAppDir) || string.IsNullOrEmpty(processPath)) return null;
        var launcher = Path.Combine(rootAppDir, Path.GetFileName(processPath));
        return File.Exists(launcher) && File.Exists(Path.Combine(rootAppDir, "Update.exe")) ? launcher : null;
    }
}
