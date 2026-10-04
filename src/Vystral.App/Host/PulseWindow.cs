using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Vystral.Core.Contracts;
using Vystral.Windows.Launch;

namespace Vystral.App.Host;

/// <summary>
/// The Pulse: a tiny always-on-top native window (no WebView, no overlay injection) showing the
/// session timer and read-only system load. It works over borderless-windowed games; exclusive
/// fullscreen games draw above every window, so it won't be visible there.
/// </summary>
public sealed class PulseWindow : Window
{
    private readonly TextBlock _timer;
    private readonly TextBlock _stats;
    private readonly DispatcherTimer _tick;
    private readonly DateTimeOffset? _start;

    public PulseWindow(LaunchStateDto? state)
    {
        Title = "VYSTRAL Pulse";
        _start = DateTimeOffset.TryParse(state?.StartedAt, out var s) ? s : null;
        AppWindow.SetPresenter(AppWindowPresenterKind.CompactOverlay);
        AppWindow.Resize(new global::Windows.Graphics.SizeInt32(340, 150));
        ExtendsContentIntoTitleBar = true;

        var accent = new SolidColorBrush(global::Windows.UI.Color.FromArgb(255, 167, 139, 250));
        var dim = new SolidColorBrush(global::Windows.UI.Color.FromArgb(170, 255, 255, 255));
        _timer = new TextBlock { FontSize = 30, FontFamily = new FontFamily("Cascadia Mono, Consolas"), Foreground = new SolidColorBrush(Colors.White), Text = "--:--:--" };
        _stats = new TextBlock { FontSize = 13, Foreground = dim, Text = "Waiting for the first sample…", TextWrapping = TextWrapping.Wrap };
        var label = new TextBlock { Text = "SESSION", FontSize = 11, CharacterSpacing = 160, Foreground = accent };
        var panel = new StackPanel { Padding = new Thickness(18, 34, 18, 14), Spacing = 4 };
        panel.Children.Add(label);
        panel.Children.Add(_timer);
        panel.Children.Add(_stats);
        Content = new Grid { Background = new SolidColorBrush(global::Windows.UI.Color.FromArgb(255, 12, 12, 18)), Children = { panel } };

        _tick = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _tick.Tick += (_, _) => UpdateTimer();
        _tick.Start();
        UpdateTimer();
        Closed += (_, _) => _tick.Stop();
    }

    public void Update(PerfSampleDto s)
    {
        static string F(double? v, string unit) => v is null ? "n/a" : $"{v:0}{unit}";
        _stats.Text = $"CPU {F(s.Cpu, "%")}   GPU {F(s.Gpu, "%")}   {F(s.GpuTempC, "°C")}\nVRAM {F(s.GpuMemMb / 1024.0, " GB")}   RAM {F(s.RamMb / 1024.0, " GB")}";
    }

    private void UpdateTimer()
    {
        if (_start is null)
        {
            _timer.Text = "Preview";
            return;
        }
        var t = DateTimeOffset.UtcNow - _start.Value;
        _timer.Text = $"{(int)t.TotalHours:00}:{t.Minutes:00}:{t.Seconds:00}";
    }
}
