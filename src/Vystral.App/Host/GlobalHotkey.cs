using System.Runtime.InteropServices;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;

namespace Vystral.App.Host;

/// <summary>
/// The global "summon VYSTRAL" shortcut: RegisterHotKey on the main window plus a window
/// subclass (comctl32 SetWindowSubclass) to receive WM_HOTKEY. It only ever brings VYSTRAL to
/// the front. Must be used on the window's UI thread.
/// </summary>
internal sealed partial class GlobalHotkey : IDisposable
{
    private const int HotkeyId = 0x5659;       // arbitrary, unique within our window
    private const uint WmHotkey = 0x0312;
    private const uint ModNoRepeat = 0x4000;
    private const int ErrorHotkeyAlreadyRegistered = 1409;
    private static readonly nuint SubclassId = 0x56595354;

    private readonly nint _hwnd;
    private readonly SubclassProc _proc;   // kept alive for as long as the subclass exists
    private bool _subclassed;
    private bool _registered;

    public event Action? Pressed;

    public GlobalHotkey(nint hwnd)
    {
        _hwnd = hwnd;
        _proc = WndProc;
        try { _subclassed = SetWindowSubclass(hwnd, _proc, SubclassId, 0); }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            Log.Warn("hotkey", "Window subclassing unavailable", ex: ex);
        }
    }

    public HotkeyApplyResult Apply(Hotkey? hotkey)
    {
        Unregister();
        if (hotkey is null) return new HotkeyApplyResult(false, null);
        if (!_subclassed) return new HotkeyApplyResult(false, "Global shortcuts aren't available on this PC.");
        if (RegisterHotKey(_hwnd, HotkeyId, (uint)hotkey.Modifiers | ModNoRepeat, hotkey.VirtualKey))
        {
            _registered = true;
            return new HotkeyApplyResult(true, null);
        }
        var err = Marshal.GetLastPInvokeError();
        return new HotkeyApplyResult(false, err == ErrorHotkeyAlreadyRegistered
            ? $"{hotkey} is already used by another app or by Windows. Try a different shortcut."
            : $"Windows didn't accept {hotkey} (error {err}). Try a different shortcut.");
    }

    private void Unregister()
    {
        if (!_registered) return;
        UnregisterHotKey(_hwnd, HotkeyId);
        _registered = false;
    }

    private nint WndProc(nint hwnd, uint msg, nint wParam, nint lParam, nuint id, nuint refData)
    {
        if (msg == WmHotkey && wParam == HotkeyId)
        {
            try { Pressed?.Invoke(); }
            catch (Exception ex) { Log.Warn("hotkey", "Summon failed", ex: ex); }
            return 0;
        }
        return DefSubclassProc(hwnd, msg, wParam, lParam);
    }

    public void Dispose()
    {
        Unregister();
        if (_subclassed)
        {
            try { RemoveWindowSubclass(_hwnd, _proc, SubclassId); } catch (EntryPointNotFoundException) { }
            _subclassed = false;
        }
    }

    private delegate nint SubclassProc(nint hwnd, uint msg, nint wParam, nint lParam, nuint id, nuint refData);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool RegisterHotKey(nint hwnd, int id, uint modifiers, uint vk);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool UnregisterHotKey(nint hwnd, int id);

    [DllImport("comctl32.dll", SetLastError = true)]
    private static extern bool SetWindowSubclass(nint hwnd, SubclassProc proc, nuint id, nuint refData);

    [DllImport("comctl32.dll", SetLastError = true)]
    private static extern bool RemoveWindowSubclass(nint hwnd, SubclassProc proc, nuint id);

    [DllImport("comctl32.dll")]
    private static extern nint DefSubclassProc(nint hwnd, uint msg, nint wParam, nint lParam);
}
