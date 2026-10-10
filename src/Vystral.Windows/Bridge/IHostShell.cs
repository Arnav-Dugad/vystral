using Vystral.Windows.Services;

namespace Vystral.Windows.Bridge;

public sealed record DragRect(double X, double Y, double Width, double Height);

/// <summary>Window state for the interface. Caption insets are in DIP (Track C2 added the left one, for right-to-left layouts).</summary>
public sealed record WindowStateDto(string Mode, bool Maximized, bool Fullscreen, double CaptionInsetRight, double Scale, double CaptionInsetLeft = 0);

/// <summary>
/// Native window and OS-dialog operations implemented by the WinUI shell. Pickers are the only
/// way the UI can name a file or folder: the web layer never supplies arbitrary paths itself.
/// </summary>
public interface IHostShell
{
    Task<string?> PickExecutableAsync();
    Task<string?> PickImageAsync();
    Task<string?> PickFolderAsync();
    Task<string?> PickSaveFileAsync(string suggestedName, string extension, string description);

    WindowStateDto GetWindowState();
    void SetMode(string mode);          // "desktop" | "immersive"
    void Minimize();
    void ToggleMaximize();
    void Close();
    /// <summary>Caption (drag) rectangles, and the title bar's own buttons as passthrough rectangles so they always get clicks.</summary>
    void SetDragRegions(IReadOnlyList<DragRect> regions, IReadOnlyList<DragRect>? passthrough = null);
    void SetCaptionTheme(bool dark);
    void SetPulseVisible(bool visible);
    void OpenFolder(string path);
    void OpenUri(Uri uri);
    /// <summary>Plays a validated vibration pattern on the active controller; false when none is connected or input is paused.</summary>
    bool PlayHaptic(IReadOnlyList<HapticStep> steps);
    void StopHaptics();
}
