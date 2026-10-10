using Vystral.Windows.Bridge;
using Xunit;

namespace Vystral.Tests.Shell;

/// <summary>Track C2: the caption-button space reserved in VYSTRAL's title bar.</summary>
public class CaptionInsetsTests
{
    [Theory]
    [InlineData(138, 1.0, 138)]   // 100%
    [InlineData(173, 1.25, 138.4)] // 125%: 173 physical px
    [InlineData(207, 1.5, 138)]   // 150%
    [InlineData(276, 2.0, 138)]   // 200%
    public void Physical_pixels_become_dips(int rightPx, double scale, double expected)
    {
        var (right, left) = CaptionInsets.Compute(rightPx, 0, scale, captionsVisible: true);
        Assert.Equal(expected, right, 1);
        Assert.Equal(0, left);
    }

    [Theory]
    [InlineData(1.0)]
    [InlineData(1.5)]
    public void A_zero_inset_while_the_buttons_show_falls_back_to_their_width(double scale)
    {
        // The window was restored maximized before it was shown: RightInset reads 0. Reserve the buttons anyway.
        var (right, _) = CaptionInsets.Compute(0, 0, scale, captionsVisible: true);
        Assert.Equal(CaptionInsets.FallbackRight, right);
    }

    [Fact]
    public void Full_screen_reserves_nothing() => Assert.Equal((0d, 0d), CaptionInsets.Compute(207, 0, 1.5, captionsVisible: false));

    [Fact]
    public void Left_inset_for_right_to_left_layouts()
    {
        var (right, left) = CaptionInsets.Compute(0, 207, 1.5, captionsVisible: true);
        Assert.Equal(138, left);
        Assert.Equal(CaptionInsets.FallbackRight, right);
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(100)]
    public void A_bad_scale_counts_as_100_percent(double scale)
    {
        Assert.Equal(1.0, CaptionInsets.Scale(scale));
        Assert.Equal(150, CaptionInsets.Compute(150, 0, scale, true).Right);
    }

    [Fact]
    public void Absurd_insets_are_clamped() => Assert.Equal(CaptionInsets.Max, CaptionInsets.Compute(100_000, 0, 1, true).Right);

    [Fact]
    public void Regions_are_validated()
    {
        var ok = new DragRect(0, 0, 200, 48);
        Assert.True(CaptionInsets.ValidRegions([ok], null));
        Assert.True(CaptionInsets.ValidRegions([ok], [new DragRect(900, 8, 30, 30)]));
        Assert.False(CaptionInsets.ValidRegions(null, null));
        Assert.False(CaptionInsets.ValidRegions(Enumerable.Repeat(ok, CaptionInsets.MaxDragRegions + 1).ToList(), null));
        Assert.False(CaptionInsets.ValidRegions([ok], Enumerable.Repeat(ok, CaptionInsets.MaxPassthroughRegions + 1).ToList()));
        Assert.False(CaptionInsets.ValidRegions([new DragRect(double.NaN, 0, 10, 10)], null));
        Assert.False(CaptionInsets.ValidRegions([new DragRect(0, 0, -1, 10)], null));
        Assert.False(CaptionInsets.ValidRegions([new DragRect(0, 0, 10, 401)], null));
        Assert.False(CaptionInsets.ValidRegions([ok], [new DragRect(0, double.PositiveInfinity, 10, 10)]));
    }
}
