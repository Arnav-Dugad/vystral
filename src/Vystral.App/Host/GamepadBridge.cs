using Microsoft.UI.Dispatching;
using Vystral.Windows.Bridge;
using Windows.Gaming.Input;

namespace Vystral.App.Host;

/// <summary>
/// Reads Xbox-compatible controllers through global::Windows.Gaming.Input and forwards button edges to
/// the UI. Polling only runs while VYSTRAL's window is focused and no game is running, so
/// VYSTRAL never competes with a game for controller input.
/// </summary>
public sealed class GamepadBridge : IDisposable
{
    private const double StickThreshold = 0.55;
    private const double ScrollDeadzone = 0.25;

    private readonly DispatcherQueueTimer _timer;
    private readonly IEventSink _events;
    private readonly Dictionary<string, bool> _pressed = new();
    private bool _active;
    private bool _suspended;
    private int _lastScrollTick;

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
        if (!active) ReleaseAll();
        UpdateTimer();
    }

    public void SetSuspended(bool suspended)
    {
        _suspended = suspended;
        if (suspended) ReleaseAll();
        UpdateTimer();
    }

    public void Rumble(double strength, int durationMs)
    {
        var pad = Gamepad.Gamepads.FirstOrDefault();
        if (pad is null) return;
        pad.Vibration = new GamepadVibration { LeftMotor = strength * 0.6, RightMotor = strength };
        _ = Task.Delay(durationMs).ContinueWith(_ => pad.Vibration = default);
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

    public void Dispose() => _timer.Stop();
}
