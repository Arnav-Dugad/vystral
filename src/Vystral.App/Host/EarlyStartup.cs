using Vystral.Windows;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using Vystral.Windows.Services.Startup;

namespace Vystral.App.Host;

/// <summary>
/// Track AA: builds the backend (database open and migrate, session recovery, settings, services, bridge
/// handlers) on its own thread while WinUI starts (XAML resources, the window, WebView2's browser process),
/// instead of after it on the UI thread. <see cref="MainWindow"/> waits only for whatever is left.
/// A failure is rethrown where the backend used to be created, so it behaves exactly as before.
/// </summary>
internal sealed class EarlyStartup
{
    private readonly TaskCompletionSource<AppBackend> _backend = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public AppPaths Paths { get; }
    public bool SafeMode { get; }
    /// <summary>The backend's window and event sink until the window exists (see <see cref="DeferredHost"/>).</summary>
    public DeferredHost Host { get; } = new();

    private EarlyStartup(AppPaths paths, bool safeMode)
    {
        Paths = paths;
        SafeMode = safeMode;
    }

    public static EarlyStartup Begin(AppPaths paths, bool safeMode)
    {
        var startup = new EarlyStartup(paths, safeMode);
        var thread = new Thread(() =>
        {
            try
            {
                StartupTimeline.Mark("backendStart");
                var backend = new AppBackend(startup.Host, startup.Host, safeMode, paths);
                StartupTimeline.Mark("backendReady");
                startup._backend.SetResult(backend);
            }
            catch (Exception ex)
            {
                startup._backend.SetException(ex);
            }
        })
        {
            IsBackground = true,
            Name = "vystral-backend-start",
        };
        thread.Start();
        return startup;
    }

    /// <summary>Blocks until the backend is built (usually it already is). Rethrows its constructor's exception.</summary>
    public AppBackend WaitForBackend() => _backend.Task.GetAwaiter().GetResult();
}

/// <summary>
/// Forwards the backend's window calls and events to <see cref="MainWindow"/> once it exists. Events sent
/// before that are dropped, as they always were (there is no page yet to receive them). Window calls only come
/// from bridge requests, which need the page, so in practice they never wait.
/// </summary>
internal sealed class DeferredHost : IHostShell, IEventSink
{
    private readonly TaskCompletionSource<MainWindow> _window = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public void Attach(MainWindow window) => _window.TrySetResult(window);

    private MainWindow W
    {
        get
        {
            var t = _window.Task;
            if (t.IsCompletedSuccessfully || t.Wait(TimeSpan.FromSeconds(10))) return t.Result;
            throw new BridgeException("unavailable", "The window isn't ready yet. Try again in a moment.");
        }
    }

    public void Emit(string eventName, object? payload)
    {
        if (_window.Task.IsCompletedSuccessfully) _window.Task.Result.Emit(eventName, payload);
    }

    public Task<string?> PickExecutableAsync() => W.PickExecutableAsync();
    public Task<string?> PickImageAsync() => W.PickImageAsync();
    public Task<string?> PickFolderAsync() => W.PickFolderAsync();
    public Task<string?> PickSaveFileAsync(string suggestedName, string extension, string description) => W.PickSaveFileAsync(suggestedName, extension, description);
    public WindowStateDto GetWindowState() => W.GetWindowState();
    public void SetMode(string mode) => W.SetMode(mode);
    public void Minimize() => W.Minimize();
    public void ToggleMaximize() => W.ToggleMaximize();
    public void Close() => W.Close();
    public void SetDragRegions(IReadOnlyList<DragRect> regions, IReadOnlyList<DragRect>? passthrough = null) => W.SetDragRegions(regions, passthrough);
    public void SetCaptionTheme(bool dark) => W.SetCaptionTheme(dark);
    public void SetPulseVisible(bool visible) => W.SetPulseVisible(visible);
    public void OpenFolder(string path) => W.OpenFolder(path);
    public void OpenUri(Uri uri) => W.OpenUri(uri);
    public bool PlayHaptic(IReadOnlyList<HapticStep> steps) => W.PlayHaptic(steps);
    public void StopHaptics() => W.StopHaptics();
}
