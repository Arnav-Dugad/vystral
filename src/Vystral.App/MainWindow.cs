using System.Diagnostics;
using System.Text.Json;
using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Xaml.Media;
using Microsoft.Web.WebView2.Core;
using Vystral.App.Host;
using Vystral.Windows;
using Vystral.Windows.Bridge;
using Vystral.Windows.Launch;
using Vystral.Windows.Services;
using Vystral.Windows.Services.Startup;
using Windows.Graphics;

namespace Vystral.App;

/// <summary>
/// The single application window. Hosts the React UI in a locked-down WebView2, implements the
/// native side of the bridge, and switches into Performance Mode while a game runs.
/// </summary>
public sealed partial class MainWindow : Window, IHostShell, IEventSink
{
    public const string AppHost = "app.vystral.example";
    private static readonly global::Windows.UI.Color Obsidian = global::Windows.UI.Color.FromArgb(255, 9, 9, 14);

    private readonly Grid _root;
    private readonly WebView2 _web;
    private readonly AppBackend _backend;
    private readonly GamepadBridge _gamepad;
    private readonly AppearanceHost _appearance;
    private readonly WindowPlacement _placement;
    /// <summary>Messages held while the interface is suspended (event name, or null for a bridge reply).</summary>
    private readonly List<(string? Event, string Json)> _bufferedEvents = [];
    private const int MaxBufferedEvents = 500;
    private readonly CancellationTokenSource _life = new();
    private PulseWindow? _pulse;
    private CoreWebView2? _core;
    private bool _suspended;
    private bool _immersive;
    private bool _restoreImmersiveAfterGame;
    private bool _closing;
    private readonly GlobalHotkey _hotkey;
    private string? _pendingRoute;
    private bool _pageLoaded;
    // Track AA: startup speed.
    private static readonly global::Windows.UI.Color LightWindow = global::Windows.UI.Color.FromArgb(255, 242, 243, 247); // --bg-0 of the light theme
    private readonly AppPaths _paths;
    private readonly bool _safeMode;
    private readonly Task<CoreWebView2Environment>? _envTask;
    private global::Windows.UI.Color _windowColor = Obsidian;
    private string? _firstPaintScriptId;

    internal MainWindow(bool safeMode, AppNotifications notifications, EarlyStartup startup)
    {
        StartupTimeline.Mark("windowCreate");
        _paths = startup.Paths;
        _safeMode = safeMode;
        // Track AA: WebView2's environment first, so its browser process starts while the window and the backend finish.
        _envTask = StartWebViewEnvironment();
        Title = "VYSTRAL";
        ExtendsContentIntoTitleBar = true;
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        SetCaptionTheme(dark: true);
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "vystral.ico");
        if (File.Exists(icon)) AppWindow.SetIcon(icon);
        if (AppWindow.Presenter is OverlappedPresenter op)
        {
            op.PreferredMinimumWidth = 960;
            op.PreferredMinimumHeight = 600;
        }

        _web = new WebView2 { DefaultBackgroundColor = Obsidian };
        _root = new Grid { Background = new SolidColorBrush(Obsidian) };
        _root.Children.Add(_web);
        Content = _root;

        // Track G: Windows accent + Mica backdrop (used when Living Canvas is off).
        _appearance = new AppearanceHost(this, safeMode);
        _placement = new WindowPlacement(Path.Combine(_paths.Root, "window.json"));
        _placement.Restore(AppWindow);
        _gamepad = new GamepadBridge(DispatcherQueue, this);

        // Track B: global summon shortcut, notifications, and pre-flight probes (controllers, display).
        var hwnd = Win32.GetHwnd(this);
        _hotkey = new GlobalHotkey(hwnd);
        _hotkey.Pressed += Summon;

        // Track AA: the backend was built on its own thread while WinUI started; wait for whatever is left.
        StartupTimeline.Mark("backendWait");
        _backend = startup.WaitForBackend();
        StartupTimeline.Mark("backendWaitDone");
        startup.Host.Attach(this);
        _backend.AppearanceHost = _appearance;
        ApplyStartupTheme(_backend.Settings.GetString("appearance.theme"));
        if (_backend.Settings.GetBool("startup.immersive") && !safeMode) SetMode("immersive");

        _backend.Sessions.StateChanged += s => DispatcherQueue.TryEnqueue(() => OnLaunchState(s));
        _backend.Sessions.Sampled += s => DispatcherQueue.TryEnqueue(() => _pulse?.Update(s));
        _backend.InsightHost = new InsightHost(this, hwnd, _hotkey, notifications);
        _backend.ClipboardHost = new ClipboardHost(this); // Track M: "Copy image" on session replay cards

        Activated += (_, e) => _gamepad.SetWindowActive(e.WindowActivationState != WindowActivationState.Deactivated);
        AppWindow.Changed += OnAppWindowChanged;
        AppWindow.Closing += OnClosing;

        _ = InitializeWebViewAsync();
    }

    // ---------------- WebView2 setup ----------------

    /// <summary>
    /// Track AA: starts creating the WebView2 environment straight away (null when the runtime is missing;
    /// <see cref="InitializeWebViewAsync"/> then explains). Same options and folder as before.
    /// </summary>
    private Task<CoreWebView2Environment>? StartWebViewEnvironment()
    {
        try
        {
            CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException or FileNotFoundException or InvalidOperationException)
        {
            Log.Warn("webview", "WebView2 runtime not found", ex: ex);
            return null;
        }
        try
        {
            StartupTimeline.Mark("webviewEnvStart");
            var options = new CoreWebView2EnvironmentOptions { AreBrowserExtensionsEnabled = false };
            return CoreWebView2Environment.CreateWithOptionsAsync(null, _paths.WebViewData, options).AsTask();
        }
        catch (Exception ex)
        {
            return Task.FromException<CoreWebView2Environment>(ex);
        }
    }

    private async Task InitializeWebViewAsync()
    {
        if (_envTask is null)
        {
            ShowFatal("Microsoft Edge WebView2 Runtime is missing",
                "VYSTRAL draws its interface with the WebView2 Runtime that ships with Windows 11. It looks like it was removed. Install it from Microsoft and start VYSTRAL again.",
                new Uri("https://go.microsoft.com/fwlink/p/?LinkId=2124703"));
            return;
        }

        var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (!File.Exists(Path.Combine(wwwroot, "index.html")))
        {
            ShowFatal("Interface files are missing",
                "This build of VYSTRAL doesn't include its interface. Reinstall VYSTRAL from the GitHub releases page.",
                new Uri(UpdateService.RepositoryUrl + "/releases"));
            return;
        }

        try
        {
            var env = await _envTask;
            StartupTimeline.Mark("webviewEnvReady");
            await _web.EnsureCoreWebView2Async(env);
            StartupTimeline.Mark("webviewReady");
            _core = _web.CoreWebView2;

            _core.SetVirtualHostNameToFolderMapping(AppHost, wwwroot, CoreWebView2HostResourceAccessKind.Deny);
            // Artwork is read by the UI for colour extraction, so it needs CORS access. Only the art cache is mapped.
            _core.SetVirtualHostNameToFolderMapping(ArtworkService.ArtHost, _backend.Paths.ArtCache, CoreWebView2HostResourceAccessKind.Allow);
            _core.AddWebResourceRequestedFilter($"https://{MediaService.MediaHost}/*", CoreWebView2WebResourceContext.All);
            _core.WebResourceRequested += OnWebResourceRequested;

            var s = _core.Settings;
#if !DEBUG
            s.AreDevToolsEnabled = false;
            s.AreDefaultContextMenusEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = false;
#endif
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;
            s.IsPinchZoomEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.AreHostObjectsAllowed = false;
            s.IsWebMessageEnabled = true;

            _core.NavigationStarting += (_, e) =>
            {
                if (!IsTrustedUri(e.Uri)) e.Cancel = true;
            };
            _core.FrameNavigationStarting += (_, e) =>
            {
                if (!IsTrustedUri(e.Uri)) e.Cancel = true;
            };
            _core.NewWindowRequested += (_, e) => e.Handled = true;
            _core.DownloadStarting += (_, e) => e.Cancel = true;
            _core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            _core.WebMessageReceived += OnWebMessage;
            _core.ProcessFailed += OnProcessFailed;
            _core.DOMContentLoaded += (_, _) => StartupTimeline.Mark("domContentLoaded");
            _core.NavigationCompleted += (_, nav) =>
            {
                StartupTimeline.Mark("navigationCompleted");
                // Track AA: the snapshot is for the first load only; a reload (e.g. after a renderer crash) takes the live path.
                if (_firstPaintScriptId is { } scriptId)
                {
                    _firstPaintScriptId = null;
                    try { _core?.RemoveScriptToExecuteOnDocumentCreated(scriptId); }
                    catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { }
                }
                if (!nav.IsSuccess) return;
                _pageLoaded = true;
                if (_pendingRoute is { } route)
                {
                    _pendingRoute = null;
                    // Give the UI a moment to subscribe to bridge events after its modules run.
                    Task.Delay(800).ContinueWith(_ => DispatcherQueue.TryEnqueue(() => EmitNavigate(route)), TaskScheduler.Default);
                }
            };

            await InjectFirstPaintAsync();
            StartupTimeline.Mark("navigationStart");
            _core.Navigate($"https://{AppHost}/index.html");
        }
        catch (Exception ex)
        {
            Log.Error("webview", "WebView2 initialisation failed", ex);
            ShowFatal("VYSTRAL couldn't start its interface",
                $"WebView2 failed to start ({ex.GetType().Name}). Restarting your PC usually fixes this. Logs are in {_backend.Paths.Logs}.", null);
        }
    }

    /// <summary>
    /// Track AA: hands the last Home snapshot to the page before any of its scripts run, so Home paints at once
    /// and is then reconciled with live data. Skipped in safe mode (the recovery path stays as plain as possible),
    /// before onboarding, in Immersive starts, and after a database reset. A stale or corrupt file is simply ignored.
    /// </summary>
    private async Task InjectFirstPaintAsync()
    {
        if (_core is null) return;
        try
        {
            string reason;
            FirstPaintSnapshot? snapshot = null;
            if (_safeMode) reason = "safeMode";
            else if (_backend.StartupProblem is not null)
            {
                reason = "databaseReset";
                _backend.FirstPaint.Clear();
            }
            else if (!_backend.Settings.GetBool("onboarding.completed")) reason = "onboarding";
            else if (_immersive) reason = "immersive";
            else snapshot = _backend.FirstPaint.Load(_backend.Version, DateTimeOffset.Now, out reason);

            if (snapshot is not null)
            {
                _firstPaintScriptId = await _core.AddScriptToExecuteOnDocumentCreatedAsync(FirstPaintStore.Script(snapshot));
                StartupTimeline.Mark("firstPaintInjected");
            }
            Log.Info("startup", "First paint", new { reason, savedAt = snapshot?.SavedAt, bytes = snapshot?.PayloadJson.Length });
        }
        catch (Exception ex)
        {
            // Never a reason for the interface not to load: it just paints from live data.
            Log.Warn("startup", "Couldn't hand the first-paint snapshot to the interface", ex: ex);
        }
    }

    /// <summary>Track AA: the window's colour under the page matches the theme, so nothing flashes before the first paint.</summary>
    private void ApplyStartupTheme(string theme)
    {
        _windowColor = theme switch
        {
            "light" => LightWindow,
            "oled" or "contrast" => global::Windows.UI.Color.FromArgb(255, 0, 0, 0),
            _ => Obsidian,
        };
        _web.DefaultBackgroundColor = _windowColor;
        _root.Background = new SolidColorBrush(_windowColor);
    }

    private static bool IsTrustedUri(string uri) =>
        Uri.TryCreate(uri, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps && u.Host == AppHost;

    private void OnWebMessage(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!IsTrustedUri(e.Source)) return;
        string raw;
        try { raw = e.TryGetWebMessageAsString(); }
        catch (ArgumentException) { return; }

        _ = Task.Run(async () =>
        {
            var reply = await _backend.Dispatcher.HandleAsync(raw, _life.Token);
            if (reply is not null) DispatcherQueue.TryEnqueue(() => Post(reply, bufferIfSuspended: true));
        });
    }

    private async void OnWebResourceRequested(CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var deferral = e.GetDeferral();
        try
        {
            var uri = new Uri(e.Request.Uri);
            if (uri.Host == MediaService.MediaHost && uri.AbsolutePath.StartsWith(TrailerService.PathPrefix, StringComparison.Ordinal))
            {
                // Steam trailers: allow-listed, size-capped proxy (see TrailerService). Never touches disk.
                var range = e.Request.Headers.Contains("Range") ? e.Request.Headers.GetHeader("Range") : null;
                var r = await _backend.Trailers.FetchAsync(uri.AbsolutePath, range, _life.Token);
                e.Response = r is null
                    ? sender.Environment.CreateWebResourceResponse(null, 404, "Not Found", "")
                    : sender.Environment.CreateWebResourceResponse(new MemoryStream(r.Body).AsRandomAccessStream(), r.Status, r.Reason, r.Headers("https://" + AppHost));
                return;
            }
            if (uri.Host == MediaService.MediaHost && uri.AbsolutePath.StartsWith(LiveTileService.PathPrefix, StringComparison.Ordinal))
            {
                // Home live tiles: Steam micro-trailers, allow-listed, size-capped, cached (see LiveTileService).
                var range = e.Request.Headers.Contains("Range") ? e.Request.Headers.GetHeader("Range") : null;
                var r = await _backend.LiveTiles.FetchAsync(uri.AbsolutePath, range, _life.Token);
                e.Response = r is null
                    ? sender.Environment.CreateWebResourceResponse(null, 404, "Not Found", "")
                    : sender.Environment.CreateWebResourceResponse(new MemoryStream(r.Body).AsRandomAccessStream(), r.Status, r.Reason, r.Headers("https://" + AppHost));
                return;
            }
            var resolved = uri.Host == MediaService.MediaHost ? _backend.Media.Resolve(uri.AbsolutePath) : null;
            if (resolved is null)
            {
                e.Response = sender.Environment.CreateWebResourceResponse(null, 404, "Not Found", "");
                return;
            }
            var (path, thumbnail, type) = resolved.Value;
            var file = await global::Windows.Storage.StorageFile.GetFileFromPathAsync(path);
            if (thumbnail)
            {
                var thumb = await file.GetThumbnailAsync(global::Windows.Storage.FileProperties.ThumbnailMode.SingleItem, 480,
                    global::Windows.Storage.FileProperties.ThumbnailOptions.ResizeThumbnail);
                e.Response = sender.Environment.CreateWebResourceResponse(thumb, 200, "OK",
                    "Content-Type: image/jpeg\r\nCache-Control: max-age=86400\r\nAccess-Control-Allow-Origin: https://" + AppHost);
            }
            else
            {
                var stream = await file.OpenReadAsync();
                e.Response = sender.Environment.CreateWebResourceResponse(stream, 200, "OK",
                    $"Content-Type: {type}\r\nCache-Control: max-age=3600\r\nAccess-Control-Allow-Origin: https://{AppHost}");
            }
        }
        catch (Exception ex)
        {
            Log.Warn("media", "Media request failed", ex: ex);
            e.Response = sender.Environment.CreateWebResourceResponse(null, 404, "Not Found", "");
        }
        finally
        {
            deferral.Complete();
        }
    }

    private void OnProcessFailed(CoreWebView2 sender, CoreWebView2ProcessFailedEventArgs e)
    {
        Log.Error("webview", $"WebView2 process failed: {e.ProcessFailedKind} ({e.Reason})");
        if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
        {
            // The interface crashed; reload it. Game tracking continues natively in the meantime.
            DispatcherQueue.TryEnqueue(() => sender.Reload());
        }
    }

    // ---------------- IEventSink ----------------

    public void Emit(string eventName, object? payload)
    {
        string json;
        try { json = BridgeDispatcher.EventJson(eventName, payload); }
        catch (Exception ex)
        {
            Log.Error("bridge", $"Event {eventName} could not be serialised", ex);
            return;
        }
        DispatcherQueue.TryEnqueue(() => Post(json, bufferIfSuspended: true, eventName));
        // Windows notifications are decided from the same events (session saved, update ready, install finished).
        _backend?.ObserveEvent(eventName, json);
    }

    // ---------------- Summon & notification navigation ----------------

    /// <summary>Global shortcut: show VYSTRAL (waking the interface if a game had put it to sleep).</summary>
    private void Summon()
    {
        if (_closing) return;
        ResumeUi();
        BringToFront();
    }

    /// <summary>A notification was clicked: bring VYSTRAL forward and open the route it points to.</summary>
    internal void NavigateFromNotification(string routeJson)
    {
        if (_closing) return;
        ResumeUi();
        BringToFront();
        if (_pageLoaded) EmitNavigate(routeJson);
        else _pendingRoute = routeJson;
    }

    private void EmitNavigate(string routeJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(routeJson);
            Emit("app.navigate", new { route = doc.RootElement.Clone() });
        }
        catch (JsonException ex)
        {
            Log.Warn("notify", "Ignored an invalid route", ex: ex);
        }
    }

    private void Post(string json, bool bufferIfSuspended, string? eventName = null)
    {
        if (_core is null || _closing) return;
        if (_suspended)
        {
            if (bufferIfSuspended) Buffer(eventName, json);
            return;
        }
        try { _core.PostWebMessageAsJson(json); }
        catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            Log.Warn("bridge", "Post to UI failed", ex: ex);
        }
    }

    /// <summary>
    /// Holds a message for when the interface resumes. When full, the oldest event that a newer one of the same
    /// name supersedes is dropped (frequent samples first), else the oldest event other than a launch state; a
    /// bridge reply never is. So the newest state of everything, the final launch.state included, always arrives.
    /// </summary>
    private void Buffer(string? eventName, string json)
    {
        if (_bufferedEvents.Count >= MaxBufferedEvents)
        {
            var later = new HashSet<string>(StringComparer.Ordinal);
            if (eventName is not null) later.Add(eventName);
            var drop = -1;
            for (var i = _bufferedEvents.Count - 1; i >= 0; i--)
            {
                if (_bufferedEvents[i].Event is { } name && !later.Add(name)) drop = i;
            }
            if (drop < 0) drop = _bufferedEvents.FindIndex(b => b.Event is not null and not "launch.state");
            if (drop >= 0) _bufferedEvents.RemoveAt(drop);
        }
        _bufferedEvents.Add((eventName, json));
    }

    // ---------------- Performance Mode ----------------

    private async void OnLaunchState(LaunchStateDto state)
    {
        try
        {
            // Track H: a game started outside VYSTRAL. Performance Mode still applies, but VYSTRAL doesn't move
            // its own window around for a game the user didn't start from it.
            var external = state.Source is not (null or "tracked");
            switch (state.Phase)
            {
                case "running" when external:
                    _gamepad.SetSuspended(true);
                    if (_backend.Settings.GetBool("pulse.enabled")) SetPulseVisible(true);
                    if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized }) await SuspendUiAsync();
                    break;
                case "ended" when external:
                    _pulse?.Close();
                    _pulse = null;
                    ResumeUi();
                    _gamepad.SetSuspended(false);
                    break;
                case "running":
                    _gamepad.SetSuspended(true);
                    if (_backend.Settings.GetBool("pulse.enabled")) SetPulseVisible(true);
                    if (_backend.Settings.GetBool("launch.minimizeOnStart"))
                    {
                        // Give the UI a moment to play its final frame, then hide and suspend it.
                        await Task.Delay(500);
                        _restoreImmersiveAfterGame = _immersive;
                        if (_immersive) SetMode("desktop");
                        (AppWindow.Presenter as OverlappedPresenter)?.Minimize();
                        await SuspendUiAsync();
                    }
                    break;
                case "ended":
                    _pulse?.Close();
                    _pulse = null;
                    ResumeUi();
                    _gamepad.SetSuspended(false);
                    if (_backend.Settings.GetBool("launch.restoreOnExit") && state.SessionId is not null)
                    {
                        if (_restoreImmersiveAfterGame) SetMode("immersive");
                        _restoreImmersiveAfterGame = false;
                        BringToFront();
                    }
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Error("perfmode", "Performance Mode transition failed", ex);
        }
    }

    /// <summary>Hides and suspends the WebView2 renderer so it uses no CPU/GPU while a game runs.</summary>
    private async Task SuspendUiAsync()
    {
        if (_core is null || _suspended) return;
        _web.Visibility = Visibility.Collapsed;
        _suspended = true;
        try
        {
            var ok = await _core.TrySuspendAsync();
            Log.Info("perfmode", $"Interface suspended: {ok}");
        }
        catch (Exception ex)
        {
            Log.Warn("perfmode", "TrySuspendAsync failed", ex: ex);
        }
    }

    private void ResumeUi()
    {
        if (_core is null || !_suspended) return;
        try { _core.Resume(); } catch (Exception ex) { Log.Warn("perfmode", "Resume failed", ex: ex); }
        _web.Visibility = Visibility.Visible;
        _suspended = false;
        foreach (var (_, json) in _bufferedEvents) Post(json, bufferIfSuspended: false);
        _bufferedEvents.Clear();
    }

    private void OnAppWindowChanged(AppWindow sender, AppWindowChangedEventArgs args)
    {
        if (!args.DidPresenterChange && !args.DidSizeChange) return;
        // While minimized (and not in a game), hide the WebView so the page reports itself hidden
        // and pauses animation; this is what keeps VYSTRAL near-idle in the background.
        var minimized = sender.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized };
        // Restored while suspended for a game (taskbar, Alt+Tab, a second launch): wake the interface, never show a blank window.
        if (!minimized && _suspended) ResumeUi();
        if (!_suspended) _web.Visibility = minimized ? Visibility.Collapsed : Visibility.Visible;
        if (!minimized) Emit("window.state", GetWindowState());
        // Summoned during a game and minimized again: go back to Performance Mode.
        if (minimized && !_suspended && _backend.IsGameActive && _backend.Settings.GetBool("launch.minimizeOnStart"))
            _ = SuspendUiAsync();
    }

    private void OnClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        _closing = true;
        _appearance.Dispose();
        _hotkey.Dispose();
        _placement.Save(AppWindow, _immersive);
        _pulse?.Close();
        _gamepad.Dispose();
        _life.Cancel();
        _backend.Shutdown();
        _backend.Dispose();
    }

    // ---------------- IHostShell ----------------

    public void BringToFront()
    {
        // Shown on purpose (second launch, session ended): the interface must be awake, also if the window wasn't minimized.
        if (DispatcherQueue.HasThreadAccess) ResumeUi();
        if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } p) p.Restore();
        AppWindow.Show();
        Activate();
        Win32.ForceForeground(Win32.GetHwnd(this));
    }

    public WindowStateDto GetWindowState() => OnUi(() =>
    {
        var scale = _root.XamlRoot?.RasterizationScale ?? 1.0;
        var maximized = AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Maximized };
        return new WindowStateDto(_immersive ? "immersive" : "desktop", maximized, _immersive,
            AppWindow.TitleBar.RightInset / scale, scale);
    });

    public void SetMode(string mode) => OnUi(() =>
    {
        _immersive = mode == "immersive";
        AppWindow.SetPresenter(_immersive ? AppWindowPresenterKind.FullScreen : AppWindowPresenterKind.Overlapped);
        if (_immersive) SetDragRegions([]);
        _appearance?.SetImmersive(_immersive);
        return true;
    });

    public void Minimize() => OnUi(() => { (AppWindow.Presenter as OverlappedPresenter)?.Minimize(); return true; });

    public void ToggleMaximize() => OnUi(() =>
    {
        if (AppWindow.Presenter is OverlappedPresenter p)
        {
            if (p.State == OverlappedPresenterState.Maximized) p.Restore(); else p.Maximize();
        }
        return true;
    });

    public new void Close() => OnUi(() => { base.Close(); return true; });

    public void SetDragRegions(IReadOnlyList<DragRect> regions) => OnUi(() =>
    {
        var scale = _root.XamlRoot?.RasterizationScale ?? 1.0;
        var rects = _immersive ? [] : regions.Select(r => new RectInt32(
            (int)Math.Round(r.X * scale), (int)Math.Round(r.Y * scale),
            (int)Math.Round(r.Width * scale), (int)Math.Round(r.Height * scale))).ToArray();
        InputNonClientPointerSource.GetForWindowId(AppWindow.Id).SetRegionRects(NonClientRegionKind.Caption, rects);
        return true;
    });

    public void SetCaptionTheme(bool dark) => OnUi(() =>
    {
        // Contrast-checked against VYSTRAL's own title bar and Mica in both modes (CaptionPalette).
        static global::Windows.UI.Color C(Argb c) => global::Windows.UI.Color.FromArgb(c.A, c.R, c.G, c.B);
        var palette = CaptionPalette.For(dark);
        var tb = AppWindow.TitleBar;
        tb.ButtonBackgroundColor = Colors.Transparent;
        tb.ButtonInactiveBackgroundColor = Colors.Transparent;
        tb.ButtonForegroundColor = C(palette.Foreground);
        tb.ButtonInactiveForegroundColor = C(palette.InactiveForeground);
        tb.ButtonHoverBackgroundColor = C(palette.HoverBackground);
        tb.ButtonHoverForegroundColor = C(palette.Foreground);
        tb.ButtonPressedBackgroundColor = C(palette.PressedBackground);
        tb.ButtonPressedForegroundColor = C(palette.Foreground);
        // Mica takes its tint from the content's theme, so it follows VYSTRAL's theme rather than Windows'.
        if (_root is not null) _root.RequestedTheme = dark ? ElementTheme.Dark : ElementTheme.Light; // null during construction
        // Track AA: keep the colour under the page in step with a theme change (only visible while the page repaints).
        var color = dark ? (_windowColor.Equals(LightWindow) ? Obsidian : _windowColor) : LightWindow;
        if (_root is not null && _web is not null && SystemBackdrop is null && !color.Equals(_windowColor))
        {
            _windowColor = color;
            _web.DefaultBackgroundColor = color;
            _root.Background = new SolidColorBrush(color);
        }
        return true;
    });

    /// <summary>
    /// Turns the Mica backdrop on or off. While it's on, the window and WebView2 are transparent and
    /// the page paints its own opaque background everywhere except the title bar and sidebar.
    /// </summary>
    internal bool SetBackdrop(bool on)
    {
        try
        {
            if (on)
            {
                SystemBackdrop ??= new MicaBackdrop { Kind = MicaKind.Base };
                _root.Background = new SolidColorBrush(Colors.Transparent);
                _web.DefaultBackgroundColor = Colors.Transparent;
            }
            else
            {
                _web.DefaultBackgroundColor = _windowColor;
                _root.Background = new SolidColorBrush(_windowColor);
                SystemBackdrop = null;
            }
            Log.Info("appearance", on ? "Mica backdrop on" : "Mica backdrop off");
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn("appearance", "Changing the window backdrop failed; staying opaque", ex: ex);
            try
            {
                _web.DefaultBackgroundColor = _windowColor;
                _root.Background = new SolidColorBrush(_windowColor);
                SystemBackdrop = null;
            }
            catch (Exception) { }
            return false;
        }
    }

    public void SetPulseVisible(bool visible) => OnUi(() =>
    {
        if (visible && _pulse is null)
        {
            _pulse = new PulseWindow(_backend.Sessions.Current);
            _pulse.Closed += (_, _) => _pulse = null;
            _pulse.Activate();
        }
        else if (!visible)
        {
            _pulse?.Close();
            _pulse = null;
        }
        return true;
    });

    public void OpenFolder(string path)
    {
        if (!Directory.Exists(path)) throw new BridgeException("notFound", "That folder no longer exists.");
        Process.Start(new ProcessStartInfo("explorer.exe") { ArgumentList = { path }, UseShellExecute = false });
    }

    public void OpenUri(Uri uri)
    {
        if (uri.Scheme is not ("https" or "steam" or "com.epicgames.launcher" or "goggalaxy" or "ms-windows-store" or "uplay" or "battlenet" or "origin2"))
            throw new BridgeException("forbidden", "That link type isn't allowed.");
        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }

    public bool PlayHaptic(IReadOnlyList<HapticStep> steps) => _gamepad.PlayHaptic(steps);
    public void StopHaptics() => _gamepad.StopHaptics();

    public Task<string?> PickExecutableAsync() => Pickers.PickFileAsync(this, [".exe"]);
    public Task<string?> PickImageAsync() => Pickers.PickFileAsync(this, [".jpg", ".jpeg", ".png", ".webp"]);
    public Task<string?> PickFolderAsync() => Pickers.PickFolderAsync(this);
    public Task<string?> PickSaveFileAsync(string suggestedName, string extension, string description) =>
        Pickers.PickSaveAsync(this, suggestedName, extension, description);

    /// <summary>Runs on the UI thread, waiting synchronously when called from a worker thread.</summary>
    private T OnUi<T>(Func<T> func)
    {
        if (DispatcherQueue.HasThreadAccess) return func();
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!DispatcherQueue.TryEnqueue(() =>
            {
                try { tcs.SetResult(func()); }
                catch (Exception ex) { tcs.SetException(ex); }
            }))
            throw new BridgeException("unavailable", "The window is closing.");
        return tcs.Task.GetAwaiter().GetResult();
    }

    internal T RunOnUi<T>(Func<T> func) => OnUi(func);

    internal Task<T> OnUiAsync<T>(Func<Task<T>> func)
    {
        if (DispatcherQueue.HasThreadAccess) return func();
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        DispatcherQueue.TryEnqueue(async () =>
        {
            try { tcs.SetResult(await func()); }
            catch (Exception ex) { tcs.SetException(ex); }
        });
        return tcs.Task;
    }

    private void ShowFatal(string title, string body, Uri? link)
    {
        _root.Children.Clear();
        var panel = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center, MaxWidth = 520, Spacing = 14 };
        panel.Children.Add(new TextBlock { Text = title, FontSize = 26, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = new SolidColorBrush(Colors.White), TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(new TextBlock { Text = body, FontSize = 15, Foreground = new SolidColorBrush(global::Windows.UI.Color.FromArgb(200, 255, 255, 255)), TextWrapping = TextWrapping.Wrap });
        if (link is not null)
        {
            var button = new Button { Content = "Open download page", Margin = new Thickness(0, 8, 0, 0) };
            button.Click += (_, _) => Process.Start(new ProcessStartInfo(link.AbsoluteUri) { UseShellExecute = true });
            panel.Children.Add(button);
        }
        _root.Children.Add(panel);
    }
}
