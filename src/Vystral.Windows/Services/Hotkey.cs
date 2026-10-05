namespace Vystral.Windows.Services;

[Flags]
public enum HotkeyModifiers : uint
{
    None = 0,
    Alt = 0x1,      // MOD_ALT
    Ctrl = 0x2,     // MOD_CONTROL
    Shift = 0x4,    // MOD_SHIFT
    Win = 0x8,      // MOD_WIN
}

/// <summary>
/// A global keyboard shortcut in canonical text form ("Ctrl+Alt+V"). Parsing is strict: a
/// shortcut needs Ctrl, Alt or Win (Shift alone would steal ordinary typing) and one key from a
/// small allow-list (A–Z, 0–9, F1–F24).
/// </summary>
public sealed record Hotkey(HotkeyModifiers Modifiers, uint VirtualKey, string Key)
{
    public const string Default = "Ctrl+Alt+V";

    /// <summary>Settings validation pattern (shape only; <see cref="TryParse"/> does the real check).</summary>
    public const string Pattern = @"^[A-Za-z0-9+]{1,40}\z";

    public override string ToString()
    {
        var parts = new List<string>(5);
        if (Modifiers.HasFlag(HotkeyModifiers.Ctrl)) parts.Add("Ctrl");
        if (Modifiers.HasFlag(HotkeyModifiers.Alt)) parts.Add("Alt");
        if (Modifiers.HasFlag(HotkeyModifiers.Shift)) parts.Add("Shift");
        if (Modifiers.HasFlag(HotkeyModifiers.Win)) parts.Add("Win");
        parts.Add(Key);
        return string.Join('+', parts);
    }

    public static bool TryParse(string? text, out Hotkey? hotkey, out string? error)
    {
        hotkey = null;
        error = null;
        if (string.IsNullOrWhiteSpace(text) || text.Length > 40)
        {
            error = "Enter a shortcut such as Ctrl+Alt+V.";
            return false;
        }
        var mods = HotkeyModifiers.None;
        string? key = null;
        uint vk = 0;
        foreach (var raw in text.Split('+'))
        {
            var part = raw.Trim();
            var mod = part.ToLowerInvariant() switch
            {
                "ctrl" or "control" => HotkeyModifiers.Ctrl,
                "alt" => HotkeyModifiers.Alt,
                "shift" => HotkeyModifiers.Shift,
                "win" or "windows" or "meta" => HotkeyModifiers.Win,
                _ => HotkeyModifiers.None,
            };
            if (mod != HotkeyModifiers.None)
            {
                if (mods.HasFlag(mod)) { error = "A modifier key appears twice."; return false; }
                mods |= mod;
                continue;
            }
            if (key is not null) { error = "Use one key plus modifiers, for example Ctrl+Alt+V."; return false; }
            if (!TryKey(part, out vk, out key)) { error = $"“{Truncate(part)}” can't be used. Use a letter, a number or F1–F24."; return false; }
        }
        if (key is null) { error = "Add a letter, number or function key."; return false; }
        if ((mods & (HotkeyModifiers.Ctrl | HotkeyModifiers.Alt | HotkeyModifiers.Win)) == 0)
        {
            error = "Include Ctrl, Alt or Win so the shortcut doesn't interfere with typing.";
            return false;
        }
        hotkey = new Hotkey(mods, vk, key);
        return true;
    }

    private static bool TryKey(string part, out uint vk, out string? canonical)
    {
        vk = 0;
        canonical = null;
        if (part.Length == 1 && char.IsAsciiLetter(part[0]))
        {
            canonical = part.ToUpperInvariant();
            vk = canonical[0];
            return true;
        }
        if (part.Length == 1 && char.IsAsciiDigit(part[0]))
        {
            canonical = part;
            vk = part[0];
            return true;
        }
        if (part.Length is 2 or 3 && (part[0] is 'F' or 'f') && int.TryParse(part.AsSpan(1), out var n) && n is >= 1 and <= 24 && part[1] != '0')
        {
            canonical = $"F{n}";
            vk = (uint)(0x70 + n - 1); // VK_F1
            return true;
        }
        return false;
    }

    private static string Truncate(string s) => s.Length <= 12 ? s : s[..12];
}
