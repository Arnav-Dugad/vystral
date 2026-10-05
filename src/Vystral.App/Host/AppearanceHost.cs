using System.Text.Json;
using Microsoft.UI.Composition.SystemBackdrops;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using Windows.UI.ViewManagement;

namespace Vystral.App.Host;

/// <summary>
/// Follows the Windows accent colour, light/dark mode, transparency effects, high contrast and
/// energy saver, and turns the window's Mica backdrop on or off (see <see cref="BackdropPolicy"/>).
/// Changes reach the UI as the <c>system.accent</c> event.
/// <para>
/// Ordering keeps the window from ever showing see-through gaps: turning Mica on happens before the
/// UI makes its chrome transparent; turning it off because of a system change (energy saver, high
/// contrast…) first tells the UI, waits for its fade, then makes the window opaque again.
/// </para>
/// </summary>
internal sealed class AppearanceHost : IShellAppearanceHost, IDisposable
{
    private static readonly TimeSpan FadeOut = TimeSpan.FromMilliseconds(450);

    private readonly MainWindow _window;
    private readonly bool _safeMode;
    private readonly UISettings _ui = new();
    private readonly AccessibilitySettings _a11y = new();
    private readonly Lock _lock = new();
    private bool _requested;
    private bool _immersive;
    private bool _applied;       // UI thread only
    private bool _failed;
    private int _generation;     // UI thread only
    private string? _lastJson;
    private bool _disposed;

    public event Action<SystemAppearanceDto>? Changed;

    public AppearanceHost(MainWindow window, bool safeMode)
    {
        _window = window;
        _safeMode = safeMode;
        try
        {
            _ui.ColorValuesChanged += OnSystemChanged;
            _ui.AdvancedEffectsEnabledChanged += OnSystemChanged;
            _a11y.HighContrastChanged += OnSystemChanged;
            global::Windows.System.Power.PowerManager.EnergySaverStatusChanged += OnSystemChanged;
        }
        catch (Exception ex)
        {
            Log.Warn("appearance", "Couldn't subscribe to Windows appearance changes", ex: ex);
        }
    }

    public SystemAppearanceDto Current => Snapshot();

    public SystemAppearanceDto RequestBackdrop(bool wanted)
    {
        lock (_lock) _requested = wanted;
        return Apply(systemDriven: false);
    }

    /// <summary>Called by the window when it enters or leaves Immersive (full screen).</summary>
    public void SetImmersive(bool immersive)
    {
        lock (_lock)
        {
            if (_immersive == immersive) return;
            _immersive = immersive;
        }
        Apply(systemDriven: true);
    }

    private void OnSystemChanged(object? sender, object? e)
    {
        if (!_disposed) Apply(systemDriven: true);
    }

    private SystemAppearanceDto Apply(bool systemDriven)
    {
        var snap = Snapshot();
        var want = snap.Backdrop == BackdropPolicy.Mica;
        try
        {
            _window.RunOnUi(() =>
            {
                if (want)
                {
                    _generation++; // cancels a pending fade-out
                    if (!_applied)
                    {
                        _applied = _window.SetBackdrop(true);
                        if (!_applied) _failed = true;
                    }
                }
                else if (_applied)
                {
                    if (!systemDriven)
                    {
                        // The UI has already faded its own background back in before asking.
                        _window.SetBackdrop(false);
                        _applied = false;
                    }
                    else
                    {
                        var generation = ++_generation;
                        Task.Delay(FadeOut).ContinueWith(_ => _window.DispatcherQueue.TryEnqueue(() =>
                        {
                            if (generation != _generation || !_applied) return;
                            _window.SetBackdrop(false);
                            _applied = false;
                        }), TaskScheduler.Default);
                    }
                }
                return true;
            });
        }
        catch (Exception ex)
        {
            Log.Warn("appearance", "Applying the window backdrop failed", ex: ex);
        }
        if (_failed) snap = Snapshot();
        Publish(snap);
        return snap;
    }

    private void Publish(SystemAppearanceDto snap)
    {
        var json = JsonSerializer.Serialize(snap);
        lock (_lock)
        {
            if (json == _lastJson) return;
            _lastJson = json;
        }
        try { Changed?.Invoke(snap); }
        catch (Exception ex) { Log.Warn("appearance", "Appearance listener failed", ex: ex); }
    }

    private SystemAppearanceDto Snapshot()
    {
        string accent = "#0078D4";
        string[] light = ["#429CE3", "#76B9ED", "#99EBFF"], dark = ["#005A9E", "#004275", "#002642"];
        bool systemDark = true, highContrast = false, effects = false, energySaver = false, supported = false;
        try
        {
            accent = Hex(_ui.GetColorValue(UIColorType.Accent));
            light = [Hex(_ui.GetColorValue(UIColorType.AccentLight1)), Hex(_ui.GetColorValue(UIColorType.AccentLight2)), Hex(_ui.GetColorValue(UIColorType.AccentLight3))];
            dark = [Hex(_ui.GetColorValue(UIColorType.AccentDark1)), Hex(_ui.GetColorValue(UIColorType.AccentDark2)), Hex(_ui.GetColorValue(UIColorType.AccentDark3))];
            var bg = _ui.GetColorValue(UIColorType.Background);
            systemDark = bg.R + bg.G + bg.B < 384;
            effects = _ui.AdvancedEffectsEnabled;
            highContrast = _a11y.HighContrast;
            energySaver = global::Windows.System.Power.PowerManager.EnergySaverStatus == global::Windows.System.Power.EnergySaverStatus.On;
            supported = MicaController.IsSupported();
        }
        catch (Exception ex)
        {
            Log.Warn("appearance", "Reading Windows appearance failed", ex: ex);
        }

        bool requested, immersive;
        lock (_lock) (requested, immersive) = (_requested, _immersive);
        var (kind, reason) = BackdropPolicy.Decide(new BackdropInputs(requested, supported && !_failed, effects, highContrast, energySaver, immersive, _safeMode));
        return new SystemAppearanceDto(accent, light, dark, systemDark, highContrast, effects, energySaver, supported && !_failed, requested, kind, reason);
    }

    private static string Hex(global::Windows.UI.Color c) => new Rgb(c.R, c.G, c.B).Hex;

    public void Dispose()
    {
        _disposed = true;
        try
        {
            _ui.ColorValuesChanged -= OnSystemChanged;
            _ui.AdvancedEffectsEnabledChanged -= OnSystemChanged;
            _a11y.HighContrastChanged -= OnSystemChanged;
            global::Windows.System.Power.PowerManager.EnergySaverStatusChanged -= OnSystemChanged;
        }
        catch (Exception) { }
    }
}
