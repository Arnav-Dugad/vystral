namespace Vystral.Windows.Bridge;

/// <summary>
/// Track C2: the space the system caption buttons (minimize, maximize, close) take in VYSTRAL's own title bar,
/// in device-independent pixels. <c>AppWindowTitleBar.RightInset</c>/<c>LeftInset</c> are physical pixels and can
/// read 0 before the window has been shown (a window restored maximized at startup never resized afterwards, so the
/// interface kept drawing its icons under the buttons). A zero inset while the buttons are visible therefore falls
/// back to their known width instead of reserving nothing.
/// </summary>
public static class CaptionInsets
{
    /// <summary>Windows 11's three caption buttons at the tall title bar height: 3 × 46 DIP.</summary>
    public const double FallbackRight = 138;
    /// <summary>No real caption area is this wide; anything larger is a bad reading.</summary>
    public const double Max = 480;

    /// <summary>A usable rasterization scale (1 when unknown or absurd).</summary>
    public static double Scale(double scale) => double.IsFinite(scale) && scale is >= 0.5 and <= 8 ? scale : 1.0;

    /// <summary>
    /// The right and left insets in DIP. <paramref name="captionsVisible"/> is false in full screen (Immersive), where
    /// there are no caption buttons and nothing needs reserving.
    /// </summary>
    public static (double Right, double Left) Compute(int rightPx, int leftPx, double scale, bool captionsVisible)
    {
        if (!captionsVisible) return (0, 0);
        var s = Scale(scale);
        var right = rightPx > 0 ? rightPx / s : FallbackRight;
        var left = leftPx > 0 ? leftPx / s : 0;
        return (Math.Round(Math.Clamp(right, 0, Max), 1), Math.Round(Math.Clamp(left, 0, Max), 1));
    }

    /// <summary>At most this many caption (drag) rectangles per call.</summary>
    public const int MaxDragRegions = 16;
    /// <summary>At most this many passthrough rectangles (title bar buttons) per call.</summary>
    public const int MaxPassthroughRegions = 32;

    /// <summary>True when every rectangle is finite, inside a sane window area and the lists are small.</summary>
    public static bool ValidRegions(IReadOnlyList<DragRect>? drag, IReadOnlyList<DragRect>? passthrough)
    {
        if (drag is null || drag.Count > MaxDragRegions) return false;
        if (passthrough is not null && passthrough.Count > MaxPassthroughRegions) return false;
        return drag.All(ValidRect) && (passthrough?.All(ValidRect) ?? true);
    }

    private static bool ValidRect(DragRect? r) =>
        r is not null
        && double.IsFinite(r.X) && double.IsFinite(r.Y) && double.IsFinite(r.Width) && double.IsFinite(r.Height)
        && r.X is >= -100 and <= 20000 && r.Y is >= -100 and <= 400
        && r.Width is >= 0 and <= 20000 && r.Height is >= 0 and <= 400;
}
