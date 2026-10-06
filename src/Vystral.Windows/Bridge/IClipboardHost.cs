namespace Vystral.Windows.Bridge;

/// <summary>
/// Track M: the Windows clipboard, implemented by the WinUI shell (Vystral.App) and attached to
/// <see cref="AppBackend.ClipboardHost"/>. Only validated PNG bytes ever reach it.
/// </summary>
public interface IClipboardHost
{
    /// <summary>Puts a PNG image on the clipboard. Returns false when the clipboard is busy or unavailable.</summary>
    Task<bool> CopyPngAsync(byte[] png);
}
