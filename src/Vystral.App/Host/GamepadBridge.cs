using Microsoft.UI.Dispatching;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using Windows.Gaming.Input;

namespace Vystral.App.Host;

/// <summary>
/// Reads Xbox-compatible controllers through global::Windows.Gaming.Input and forwards button edges to
/// the UI. Polling only runs while VYSTRAL's window is focused and no game is running, so
/// VYSTRAL never competes with a game for controller input. Vibration plays only validated
/// <see cref="HapticPatterns"/> on the controller last used, and stops whenever input pauses.
/// </summary>
public sealed class GamepadBridge : IDisposable
{
    private const double StickThreshold = 0.55;
    private const double ScrollDeadzone = 0.25;

    private readonly DispatcherQueueTimer _timer;
    private readonly IEventSink _events;
    private readonly Dictionary<string, bool> _pressed = new();
    private volatile bool _active;
    private volatile bool _suspended;
    private int _lastScrollTick;
    private Gamepad? _lastPad;
    private int _hapticGeneration;

    public GamepadBridge(DispatcherQueue queue, IEventSink events)
    {
        _events = events;
        _timer = queue.CreateTimer();
        _timer.Interval = TimeSpan.FromMilliseconds(16);
        _timer.Tick += (_, _) => Poll();
        Gamepad.GamepadAdded += (_, _) => queue.TryEnqueue(() => { Notify(); UpdateTimer(); });
        Gamepad.GamepadRemoved += (_, _) => queue.TryEnqueue(() => { Notify(); _pressed.Clear(); UpdateTimer(); });
    }

    public void SetWindowActive(bool active)
    {
        _active = active;
        if (!active)
        {
            ReleaseAll();
            StopHaptics();
        }
        UpdateTimer();
    }

    public void SetSuspended(bool suspended)
    {
        _suspended = suspended;
        if (suspended)
        {
            ReleaseAll();
            StopHaptics();
        }
        UpdateTimer();
    }

    /// <summary>
    /// Plays a pattern on the controller the user last touched. A newer pattern (or
    /// <see cref="StopHaptics"/>) supersedes a running one; the motors always end at zero.
    /// </summary>
    public bool PlayHaptic(IReadOnlyList<HapticStep> steps)
    {
        if (!_active || _suspended || steps.Count == 0) return false;
        var pads = Gamepad.Gamepads;
        var pad = Volatile.Read(ref _lastPad) is { } last && pads.Contains(last) ? last : pads.FirstOrDefault();
        if (pad is null) return false;
        var generation = Interlocked.Increment(ref _hapticGeneration);
        _ = RunHapticAsync(pad, steps, generation);
        return true;
    }

    public void StopHaptics()
    {
        Interlocked.Increment(ref _hapticGeneration);
        foreach (var pad in Gamepad.Gamepads) TryVibrate(pad, default);
    }

    private async Task RunHapticAsync(Gamepad pad, IReadOnlyList<HapticStep> steps, int generation)
    {
        try
        {
            foreach (var s in steps)
            {
                if (Volatile.Read(ref _hapticGeneration) != generation || !_active || _suspended) return;
                TryVibrate(pad, new GamepadVibration
                {
                    LeftMotor = Level(s.LeftMotor),
                    RightMotor = Level(s.RightMotor),
                    LeftTrigger = Level(s.LeftTrigger),
                    RightTrigger = Level(s.RightTrigger),
                });
                await Task.Delay(Math.Clamp(s.DurationMs, 1, HapticPatterns.MaxDurationMs)).ConfigureAwait(false);
            }
        }
        finally
        {
            // Superseded patterns leave the motors to their successor; everything else ends silent.
            if (Volatile.Read(ref _hapticGeneration) == generation) TryVibrate(pad, default);
        }
    }

    private static double Level(double v) => double.IsFinite(v) ? Math.Clamp(v, 0, HapticPatterns.MaxLevel) : 0;

    private static void TryVibrate(Gamepad pad, GamepadVibration vibration)
    {
        try { pad.Vibration = vibration; }
        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException or InvalidOperationException)
        {
            // The controller was unplugged mid-pattern.
            Log.Warn("gamepad", "Vibration failed", ex: ex);
        }
    }

    private void UpdateTimer()
    {
        var shouldRun = _active && !_suspended && Gamepad.Gamepads.Count > 0;
        if (shouldRun && !_timer.IsRunning) _timer.Start();
        else if (!shouldRun && _timer.IsRunning) _timer.Stop();
    }

    private void Notify() => _events.Emit("gamepad.connection", new { count = Gamepad.Gamepads.Count });

    private void Poll()
    {
        var pads = Gamepad.Gamepads;
        if (pads.Count == 0) return;
        // Merge all pads so whichever controller the user picks up just works.
        var state = new Dictionary<string, bool>();
        double scrollY = 0;
        foreach (var pad in pads)
        {
            var r = pad.GetCurrentReading();
            if (r.Buttons != GamepadButtons.None || r.LeftTrigger > 0.5 || r.RightTrigger > 0.5) Volatile.Write(ref _lastPad, pad);
            void Set(string name, bool on) => state[name] = state.GetValueOrDefault(name) || on;
            Set("A", r.Buttons.HasFlag(GamepadButtons.A));
            Set("B", r.Buttons.HasFlag(GamepadButtons.B));
            Set("X", r.Buttons.HasFlag(GamepadButtons.X));
            Set("Y", r.Buttons.HasFlag(GamepadButtons.Y));
            Set("LB", r.Buttons.HasFlag(GamepadButtons.LeftShoulder));
            Set("RB", r.Buttons.HasFlag(GamepadButtons.RightShoulder));
            Set("LT", r.LeftTrigger > 0.5);
            Set("RT", r.RightTrigger > 0.5);
            Set("Menu", r.Buttons.HasFlag(GamepadButtons.Menu));
            Set("View", r.Buttons.HasFlag(GamepadButtons.View));
            Set("Up", r.Buttons.HasFlag(GamepadButtons.DPadUp) || r.LeftThumbstickY > StickThreshold);
            Set("Down", r.Buttons.HasFlag(GamepadButtons.DPadDown) || r.LeftThumbstickY < -StickThreshold);
            Set("Left", r.Buttons.HasFlag(GamepadButtons.DPadLeft) || r.LeftThumbstickX < -StickThreshold);
            Set("Right", r.Buttons.HasFlag(GamepadButtons.DPadRight) || r.LeftThumbstickX > StickThreshold);
            if (Math.Abs(r.RightThumbstickY) > Math.Abs(scrollY)) scrollY = r.RightThumbstickY;
        }

        foreach (var (button, down) in state)
        {
            if (_pressed.GetValueOrDefault(button) == down) continue;
            _pressed[button] = down;
            _events.Emit("gamepad.button", new { button, pressed = down });
        }

        var now = Environment.TickCount;
        if (Math.Abs(scrollY) > ScrollDeadzone && now - _lastScrollTick > 33)
        {
            _lastScrollTick = now;
            _events.Emit("gamepad.scroll", new { value = Math.Round(-scrollY, 2) });
        }
    }

    private void ReleaseAll()
    {
        foreach (var (button, down) in _pressed.ToList())
        {
            if (!down) continue;
            _pressed[button] = false;
            _events.Emit("gamepad.button", new { button, pressed = false });
        }
    }

    public void Dispose()
    {
        _timer.Stop();
        StopHaptics();
    }
}
