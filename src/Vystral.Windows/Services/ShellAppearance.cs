namespace Vystral.Windows.Services;

/// <summary>Everything that decides whether the window may draw a Mica backdrop.</summary>
public readonly record struct BackdropInputs(
    bool Requested,
    bool Supported,
    bool TransparencyEffects,
    bool HighContrast,
    bool EnergySaver,
    bool Immersive,
    bool SafeMode);

/// <summary>
/// Pure decision logic for the Mica backdrop. Mica is used only when the UI asks for it (Living
/// Canvas off, desktop mode, a suitable theme) and Windows can draw it well; in every other case
/// the window stays opaque and the UI paints its own background, so nothing becomes see-through.
/// </summary>
public static class BackdropPolicy
{
    public const string Mica = "mica";
    public const string None = "none";

    /// <summary>Returns the backdrop to draw and, when it's "none", the first reason why.</summary>
    public static (string Kind, string? Reason) Decide(BackdropInputs i)
    {
        if (!i.Requested) return (None, "notRequested");
        if (i.SafeMode) return (None, "safeMode");
        if (i.Immersive) return (None, "immersive");
        if (!i.Supported) return (None, "unsupported");       // Windows 10, or no composition support
        if (i.HighContrast) return (None, "highContrast");
        if (!i.TransparencyEffects) return (None, "transparencyOff");
        if (i.EnergySaver) return (None, "energySaver");     // Windows would show a flat fill anyway
        return (Mica, null);
    }
}

/// <summary>An opaque sRGB colour (0–255 channels) with WCAG luminance helpers.</summary>
public readonly record struct Rgb(byte R, byte G, byte B)
{
    public string Hex => $"#{R:X2}{G:X2}{B:X2}";

    public static Rgb Parse(string hex)
    {
        if (hex.Length != 7 || hex[0] != '#') throw new FormatException("Expected #RRGGBB.");
        return new Rgb(Convert.ToByte(hex[1..3], 16), Convert.ToByte(hex[3..5], 16), Convert.ToByte(hex[5..7], 16));
    }

    public double Luminance
    {
        get
        {
            static double Lin(byte c) { var s = c / 255.0; return s <= 0.04045 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4); }
            return 0.2126 * Lin(R) + 0.7152 * Lin(G) + 0.0722 * Lin(B);
        }
    }

    public static double Contrast(Rgb a, Rgb b)
    {
        double la = a.Luminance, lb = b.Luminance;
        return (Math.Max(la, lb) + 0.05) / (Math.Min(la, lb) + 0.05);
    }

    /// <summary>Alpha-composites this colour over a background (alpha 0–255).</summary>
    public Rgb Over(Rgb bg, byte alpha)
    {
        byte Mix(byte f, byte b) => (byte)Math.Round((f * alpha + b * (255 - alpha)) / 255.0);
        return new Rgb(Mix(R, bg.R), Mix(G, bg.G), Mix(B, bg.B));
    }
}

/// <summary>An ARGB colour for the title bar's caption buttons.</summary>
public readonly record struct Argb(byte A, byte R, byte G, byte B);

public sealed record CaptionColors(Argb Foreground, Argb InactiveForeground, Argb HoverBackground, Argb PressedBackground);

/// <summary>
/// Colours for the system-drawn minimize/maximize/close buttons. They sit over VYSTRAL's own title
/// bar, or over Mica when the backdrop is on, so they are checked against every surface they can
/// appear on: active glyphs need 4.5:1, inactive glyphs 3:1 (WCAG non-text contrast).
/// </summary>
public static class CaptionPalette
{
    /// <summary>Surfaces behind the caption buttons in dark mode: Obsidian, OLED black, and Mica (dark).</summary>
    public static readonly Rgb[] DarkSurfaces = [new(9, 9, 14), new(0, 0, 0), new(32, 32, 32), new(44, 44, 52)];

    /// <summary>Surfaces in light mode: VYSTRAL Light, Mica (light) and its accent-tinted variants.</summary>
    public static readonly Rgb[] LightSurfaces = [new(244, 244, 248), new(243, 243, 243), new(232, 232, 236), new(255, 255, 255)];

    public static CaptionColors For(bool dark)
    {
        var fg = dark ? new Rgb(255, 255, 255) : new Rgb(20, 20, 28);
        // The lowest alpha for the inactive glyph that still gives 3:1 on every surface.
        var surfaces = dark ? DarkSurfaces : LightSurfaces;
        byte inactive = 255;
        for (byte a = 120; a < 255; a += 5)
        {
            if (surfaces.All(s => Rgb.Contrast(fg.Over(s, a), s) >= 3.0)) { inactive = a; break; }
        }
        return new CaptionColors(
            new Argb(255, fg.R, fg.G, fg.B),
            new Argb(inactive, fg.R, fg.G, fg.B),
            new Argb(dark ? (byte)28 : (byte)20, fg.R, fg.G, fg.B),
            new Argb(dark ? (byte)48 : (byte)36, fg.R, fg.G, fg.B));
    }
}
