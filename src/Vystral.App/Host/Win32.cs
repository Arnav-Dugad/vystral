using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;

namespace Vystral.App.Host;

internal static partial class Win32
{
    public static IntPtr GetHwnd(Window window) => WinRT.Interop.WindowNative.GetWindowHandle(window);

    /// <summary>Brings our own window to the foreground when the user re-launches VYSTRAL.</summary>
    public static void ForceForeground(IntPtr hwnd)
    {
        ShowWindow(hwnd, 9); // SW_RESTORE
        SetForegroundWindow(hwnd);
    }

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetForegroundWindow(IntPtr hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ShowWindow(IntPtr hwnd, int cmd);
}
