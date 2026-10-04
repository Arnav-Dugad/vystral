namespace Vystral.Windows.Bridge;

public sealed record DragRect(double X, double Y, double Width, double Height);

public sealed record WindowStateDto(string Mode, bool Maximized, bool Fullscreen, double CaptionInsetRight, double Scale);

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
    void SetDragRegions(IReadOnlyList<DragRect> regions);
    void SetCaptionTheme(bool dark);
    void SetPulseVisible(bool visible);
    void OpenFolder(string path);
    void OpenUri(Uri uri);
    void Rumble(double strength, int durationMs);
}
