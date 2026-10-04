using System.Diagnostics;
using System.Runtime.InteropServices;
using Vystral.Core.Domain;

namespace Vystral.Windows.Launch;

public sealed record LaunchStartResult(bool Started, int? ProcessId, string? Error);

/// <summary>
/// Starts a validated launch target using only supported Windows mechanisms:
/// ShellExecute for registered store protocols, CreateProcess for executables (no shell),
/// and IApplicationActivationManager for packaged apps.
/// </summary>
public static class ProcessLauncher
{
    public static LaunchStartResult Start(Installation inst, string? userArgs, string? steamExePath)
    {
        try
        {
            return inst.Launch.Kind switch
            {
                LaunchKind.Uri => StartUri(inst, userArgs, steamExePath),
                LaunchKind.Executable => StartExecutable(inst.Launch, userArgs),
                LaunchKind.PackagedApp => StartPackaged(inst.Launch.Value, userArgs),
                _ => new(false, null, "Unknown launch type."),
            };
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            return new(false, null, ex.NativeErrorCode switch
            {
                2 or 3 => "Windows couldn't find the program or the store app that handles this game.",
                5 => "Windows denied access when starting the game.",
                1155 => $"No app is registered to open {inst.Platform.DisplayName()} links. Install or repair {inst.Platform.DisplayName()}.",
                1223 => "The launch was cancelled.",
                _ => $"Windows reported an error starting the game ({ex.NativeErrorCode}).",
            });
        }
        catch (COMException ex)
        {
            return new(false, null, $"Windows couldn't start this app (0x{ex.HResult:X8}). It may need to be repaired from the Xbox app.");
        }
    }

    private static LaunchStartResult StartUri(Installation inst, string? userArgs, string? steamExePath)
    {
        // Steam supports launch options when invoked through its own executable.
        if (inst.Platform == PlatformId.Steam && !string.IsNullOrWhiteSpace(userArgs) && steamExePath is not null &&
            File.Exists(steamExePath) && inst.SteamAppId is not null)
        {
            var psi = new ProcessStartInfo(steamExePath) { UseShellExecute = false };
            psi.ArgumentList.Add("-applaunch");
            psi.ArgumentList.Add(inst.SteamAppId);
            foreach (var a in LaunchValidator.SplitArguments(userArgs)) psi.ArgumentList.Add(a);
            Process.Start(psi);
            return new(true, null, null);
        }

        Process.Start(new ProcessStartInfo(inst.Launch.Value) { UseShellExecute = true });
        return new(true, null, null);
    }

    private static LaunchStartResult StartExecutable(LaunchTarget target, string? userArgs)
    {
        var psi = new ProcessStartInfo(target.Value)
        {
            UseShellExecute = false,
            WorkingDirectory = target.WorkingDirectory ?? Path.GetDirectoryName(target.Value)!,
        };
        foreach (var a in LaunchValidator.SplitArguments(target.Arguments)) psi.ArgumentList.Add(a);
        foreach (var a in LaunchValidator.SplitArguments(userArgs)) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi);
        return new(p is not null, p?.Id, p is null ? "Windows didn't start the program." : null);
    }

    private static LaunchStartResult StartPackaged(string aumid, string? userArgs)
    {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        var hr = manager.ActivateApplication(aumid, userArgs ?? "", ActivateOptions.None, out var pid);
        Marshal.ThrowExceptionForHR(hr);
        return new(true, (int)pid, null);
    }

    private enum ActivateOptions { None = 0 }

    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments, ActivateOptions options, out uint processId);
    }

    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private class ApplicationActivationManager;
}
