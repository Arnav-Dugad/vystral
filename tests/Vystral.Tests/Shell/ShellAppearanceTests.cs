using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Shell;

public class BackdropPolicyTests
{
    private static readonly BackdropInputs Ok = new(Requested: true, Supported: true, TransparencyEffects: true, HighContrast: false, EnergySaver: false, Immersive: false, SafeMode: false);

    [Fact]
    public void Mica_when_requested_and_possible() => Assert.Equal((BackdropPolicy.Mica, (string?)null), BackdropPolicy.Decide(Ok));

    [Theory]
    [InlineData("notRequested")]
    [InlineData("safeMode")]
    [InlineData("immersive")]
    [InlineData("unsupported")]
    [InlineData("highContrast")]
    [InlineData("transparencyOff")]
    [InlineData("energySaver")]
    public void Falls_back_to_an_opaque_window(string reason)
    {
        var inputs = reason switch
        {
            "notRequested" => Ok with { Requested = false },
            "safeMode" => Ok with { SafeMode = true },
            "immersive" => Ok with { Immersive = true },
            "unsupported" => Ok with { Supported = false },
            "highContrast" => Ok with { HighContrast = true },
            "transparencyOff" => Ok with { TransparencyEffects = false },
            _ => Ok with { EnergySaver = true },
        };
        Assert.Equal((BackdropPolicy.None, reason), BackdropPolicy.Decide(inputs));
    }

    [Fact]
    public void Not_requested_wins_over_every_system_reason() =>
        Assert.Equal("notRequested", BackdropPolicy.Decide(new BackdropInputs(false, false, false, true, true, true, true)).Reason);
}

public class CaptionPaletteTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Caption_glyphs_meet_contrast_on_every_surface(bool dark)
    {
        var p = CaptionPalette.For(dark);
        var fg = new Rgb(p.Foreground.R, p.Foreground.G, p.Foreground.B);
        foreach (var surface in dark ? CaptionPalette.DarkSurfaces : CaptionPalette.LightSurfaces)
        {
            Assert.True(Rgb.Contrast(fg, surface) >= 4.5, $"active glyph on {surface.Hex}");
            Assert.True(Rgb.Contrast(fg.Over(surface, p.InactiveForeground.A), surface) >= 3.0, $"inactive glyph on {surface.Hex}");
            // Hover keeps the glyph readable too.
            var hover = fg.Over(surface, p.HoverBackground.A);
            Assert.True(Rgb.Contrast(fg, hover) >= 4.5, $"glyph on hover over {surface.Hex}");
        }
    }

    [Fact]
    public void Inactive_glyphs_are_dimmer_than_active_ones()
    {
        Assert.True(CaptionPalette.For(true).InactiveForeground.A < 255);
        Assert.True(CaptionPalette.For(false).InactiveForeground.A < 255);
    }
}

public class RgbTests
{
    [Fact]
    public void Parses_and_formats_hex()
    {
        Assert.Equal(new Rgb(0, 120, 212), Rgb.Parse("#0078D4"));
        Assert.Equal("#0078D4", new Rgb(0, 120, 212).Hex);
        Assert.Throws<FormatException>(() => Rgb.Parse("0078D4"));
    }

    [Fact]
    public void Contrast_matches_wcag_reference_values()
    {
        Assert.Equal(21.0, Rgb.Contrast(new Rgb(0, 0, 0), new Rgb(255, 255, 255)), 2);
        Assert.Equal(1.0, Rgb.Contrast(new Rgb(10, 20, 30), new Rgb(10, 20, 30)), 5);
        Assert.Equal(4.53, Rgb.Contrast(Rgb.Parse("#0078D4"), new Rgb(255, 255, 255)), 1);
    }
}
