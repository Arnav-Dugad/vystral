using System.Text.RegularExpressions;

namespace Vystral.Core.Controller;

// Track X: "Compare with default" for a game's Steam Input layout. Pure: two parsed layouts in, a list of what changed out.
// Mirrored in ui/src/bridge/types.trackX.ts.

/// <param name="Change">added (bound only in yours) | removed (bound only in the default) | changed (both, differently).</param>
/// <param name="Before">The default's bindings in plain words.</param>
/// <param name="After">Your bindings in plain words.</param>
public sealed record ControllerDiffDto(string SetId, string SetName, string Control, string Change,
    IReadOnlyList<string> Before, IReadOnlyList<string> After, string? ModeBefore, string? ModeAfter);

/// <param name="Status">ok | same (no differences) | noDefault (nothing local to compare with) | notSteamInput (no layout of yours).</param>
/// <param name="Basis">progenitor (your layout says which one it started from) | title (the same name as a Steam template) |
/// controllerDefault (Steam's Gamepad template for your controller type) | self (you use a template as it is).</param>
public sealed record ControllerCompareDto(
    string Status,
    ControllerLayoutDto? Yours,
    ControllerLayoutDto? Default,
    string? Basis,
    string? DefaultName,
    IReadOnlyList<ControllerDiffDto> Differences,
    int Unchanged,
    IReadOnlyList<string> OnlyInYours,
    IReadOnlyList<string> OnlyInDefault,
    string? Note)
{
    public static ControllerCompareDto Simple(string status, ControllerLayoutDto? yours, string? note = null) =>
        new(status, yours, null, null, null, [], 0, [], [], note);
}

public static partial class SteamInputCompare
{
    public const int MaxDifferences = 400;

    /// <summary>
    /// Steam records which layout a personal one was made from in <c>"progenitor"</c>: a template file
    /// (<c>templates\controller_xboxone_wasd.vdf</c>) or a Workshop item id. Anything else is ignored.
    /// </summary>
    public static (string Kind, string Value)? Progenitor(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw) || raw.Length > 200) return null;
        var s = raw.Trim();
        if (WorkshopId().IsMatch(s)) return ("workshop", s);
        var m = TemplatePath().Match(s);
        return m.Success ? ("template", m.Groups[1].Value) : null;
    }

    /// <summary>The template Steam suggests first for a controller type ("Gamepad"), most specific first.</summary>
    public static IReadOnlyList<string> DefaultTemplateCandidates(string? controllerType)
    {
        var list = new List<string>();
        if (controllerType is { Length: > 0 and <= 40 } t && ControllerType().IsMatch(t))
        {
            list.Add($"{t.ToLowerInvariant()}_gamepad_joystick.vdf");
            list.Add($"{t.ToLowerInvariant()}_gamepad_fps.vdf");
        }
        list.Add("controller_xboxone_gamepad_joystick.vdf");
        list.Add("gamepad_joystick.vdf");
        return list.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    public static ControllerCompareDto Compare(ControllerLayoutDto yours, ControllerLayoutDto baseline, string basis, string? defaultName)
    {
        var diffs = new List<ControllerDiffDto>();
        var unchanged = 0;
        var baseSets = baseline.Sets.ToList();
        var matchedBase = new HashSet<ControllerSetDto>();
        var onlyYours = new List<string>();

        // Sets match by id; a single set on each side always matches (templates call theirs "Default", games often rename it).
        var yourSets = yours.Sets.Where(s => s.Kind == "set").ToList();
        var defaultSets = baseSets.Where(s => s.Kind == "set").ToList();
        foreach (var set in yours.Sets)
        {
            var other = baseSets.FirstOrDefault(b => b.Kind == set.Kind && b.Id.Equals(set.Id, StringComparison.OrdinalIgnoreCase) && !matchedBase.Contains(b));
            if (other is null && set.Kind == "set" && yourSets.Count == 1 && defaultSets.Count == 1 && !matchedBase.Contains(defaultSets[0])) other = defaultSets[0];
            if (other is null)
            {
                onlyYours.Add(set.Name);
                continue;
            }
            matchedBase.Add(other);
            unchanged += CompareSet(set, other, diffs);
        }
        var onlyDefault = baseSets.Where(b => !matchedBase.Contains(b)).Select(b => b.Name).ToList();
        var capped = diffs.Take(MaxDifferences).ToList();
        var status = capped.Count == 0 && onlyYours.Count == 0 && onlyDefault.Count == 0 ? "same" : "ok";
        return new ControllerCompareDto(status, yours, baseline, basis, defaultName, capped, unchanged, onlyYours, onlyDefault,
            diffs.Count > MaxDifferences ? $"Showing the first {MaxDifferences} differences." : null);
    }

    private static int CompareSet(ControllerSetDto yours, ControllerSetDto baseline, List<ControllerDiffDto> into)
    {
        var mine = yours.Controls.Where(Bound).ToDictionary(c => c.Control, StringComparer.Ordinal);
        var theirs = baseline.Controls.Where(Bound).ToDictionary(c => c.Control, StringComparer.Ordinal);
        var same = 0;
        foreach (var id in Order(mine.Keys.Union(theirs.Keys)))
        {
            mine.TryGetValue(id, out var a);
            theirs.TryGetValue(id, out var b);
            if (a is not null && b is not null)
            {
                if (Key(a) == Key(b)) { same++; continue; }
                into.Add(new(yours.Id, yours.Name, id, "changed", Words(b), Words(a), b.Mode, a.Mode));
            }
            else if (a is not null) into.Add(new(yours.Id, yours.Name, id, "added", [], Words(a), null, a.Mode));
            else if (b is not null) into.Add(new(yours.Id, yours.Name, id, "removed", Words(b), [], b.Mode, null));
        }
        return same;
    }

    private static bool Bound(ControllerControlDto c) => c.Bindings.Count > 0 || c.Mode is not null;

    /// <summary>Order-insensitive identity of what a control does: its mode and every binding.</summary>
    private static string Key(ControllerControlDto c) =>
        (c.Mode ?? "") + "\u0001" + string.Join("\u0002", c.Bindings
            .Select(b => $"{b.Activator}|{b.Slot}|{b.Label}|{b.Detail}|{b.Kind}")
            .Order(StringComparer.Ordinal));

    /// <summary>One line per binding, in the words the controls table uses ("Hold: Left Ctrl", "↑ Move Forward (W)").</summary>
    public static IReadOnlyList<string> Words(ControllerControlDto c) =>
        c.Bindings.Count == 0 && c.Mode is not null ? [c.Mode] : c.Bindings.Select(Line).Take(8).ToList();

    public static string Line(ControllerBindingDto b)
    {
        var slot = b.Slot switch { "up" => "↑", "down" => "↓", "left" => "←", "right" => "→", "click" => "Click", "outer" => "Outer ring", _ => null };
        var activator = b.Activator switch
        {
            "long" => "Hold", "double" => "Double press", "start" => "On press", "release" => "On release", "soft" => "Soft pull",
            "chord" => "Chord", "turbo" => "Turbo", "modeshift" => "Mode shift", _ => null,
        };
        var text = b.Detail is { Length: > 0 } d && d != b.Label ? $"{b.Label} ({d})" : b.Label;
        if (slot is not null && activator is not null) return $"{slot} {activator}: {text}";
        if (activator is not null) return $"{activator}: {text}";
        return slot is not null ? $"{slot} {text}" : text;
    }

    private static readonly string[] ControlOrder =
    [
        "a", "b", "x", "y", "lb", "rb", "lt", "rt", "ls", "lsClick", "rs", "rsClick", "dpadUp", "dpadDown", "dpadLeft", "dpadRight",
        "view", "menu", "share", "guide", "p1", "p2", "p3", "p4", "leftPad", "rightPad", "centerPad", "gyro",
    ];

    private static IEnumerable<string> Order(IEnumerable<string> ids) =>
        ids.OrderBy(id => Array.IndexOf(ControlOrder, id) is var i and >= 0 ? i : ControlOrder.Length).ThenBy(id => id, StringComparer.Ordinal);

    [GeneratedRegex(@"^[0-9]{1,20}\z")]
    private static partial Regex WorkshopId();

    // "templates\x.vdf", "templates/x.vdf", "controller_base\templates\x.vdf" or just "x.vdf" — never anything with "..".
    [GeneratedRegex(@"^(?:(?:controller_base[\\/])?templates[\\/])?([A-Za-z0-9_+\-]{1,80}\.vdf)\z", RegexOptions.IgnoreCase)]
    private static partial Regex TemplatePath();

    [GeneratedRegex(@"^controller_[a-z0-9_]{1,30}\z", RegexOptions.IgnoreCase)]
    private static partial Regex ControllerType();
}
