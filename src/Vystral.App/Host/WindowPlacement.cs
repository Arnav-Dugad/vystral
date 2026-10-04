using System.Text.Json;
using Microsoft.UI.Windowing;
using Vystral.Windows.Services;
using Windows.Graphics;

namespace Vystral.App.Host;

/// <summary>Remembers window size/position, and never restores onto a monitor that is gone.</summary>
public sealed class WindowPlacement(string file)
{
    private sealed record Saved(int X, int Y, int Width, int Height, bool Maximized);

    public void Restore(AppWindow window)
    {
        try
        {
            if (File.Exists(file) && JsonSerializer.Deserialize<Saved>(File.ReadAllText(file)) is { Width: >= 640, Height: >= 400 } s)
            {
                var rect = new RectInt32(s.X, s.Y, s.Width, s.Height);
                var area = DisplayArea.GetFromRect(rect, DisplayAreaFallback.None);
                if (area is not null)
                {
                    window.MoveAndResize(rect);
                    if (s.Maximized && window.Presenter is OverlappedPresenter p) p.Maximize();
                    return;
                }
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            Log.Warn("window", "Window placement unreadable", ex: ex);
        }
        // First run: 80% of the work area, centred — 1536×960 on a 1920×1200 display.
        var work = DisplayArea.Primary.WorkArea;
        var w = Math.Max(1100, (int)(work.Width * 0.8));
        var h = Math.Max(700, (int)(work.Height * 0.8));
        window.MoveAndResize(new RectInt32(work.X + (work.Width - w) / 2, work.Y + (work.Height - h) / 2, Math.Min(w, work.Width), Math.Min(h, work.Height)));
    }

    public void Save(AppWindow window, bool immersive)
    {
        if (immersive) return; // keep the last windowed placement
        try
        {
            var maximized = window.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Maximized };
            if (window.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized }) return;
            var p = window.Position;
            var s = window.Size;
            var tmp = file + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(new Saved(p.X, p.Y, s.Width, s.Height, maximized)));
            File.Move(tmp, file, overwrite: true);
        }
        catch (IOException) { }
    }
}
