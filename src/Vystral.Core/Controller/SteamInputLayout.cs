using System.Globalization;
using System.Text;
using Vystral.Core.Parsing;

namespace Vystral.Core.Controller;

// Track Q: a game's Steam Input layout, read-only. These records are serialized to the UI (camelCase);
// the TypeScript mirror is ui/src/bridge/types.controls.ts.

/// <summary>One thing a control does: "Space", "Jump", "Left click", "Switch to Menu".</summary>
/// <param name="Activator">press | long | double | start | release | soft | chord | turbo | analog | modeshift | other.</param>
/// <param name="Slot">Where on the control: null (the control itself), up/down/left/right, click, outer.</param>
/// <param name="Label">What the user sees first: the config's own label when it has one, else the output.</param>
/// <param name="Detail">The raw output in friendly words when the label is a custom name ("Space"), else null.</param>
/// <param name="Kind">key | mouse | gamepad | action | system | set | layer | mode | other.</param>
public sealed record ControllerBindingDto(string Activator, string? Slot, string Label, string? Detail, string Kind);

/// <param name="Control">a, b, x, y, lb, rb, lt, rt, ls, rs, lsClick, rsClick, dpadUp/Down/Left/Right, view, menu, share,
/// guide, p1–p4, leftPad, rightPad, centerPad, gyro.</param>
/// <param name="Mode">How an analog control behaves ("Mouse", "Camera", "Joystick", "Flick stick"), when known.</param>
/// <param name="FromLayer">True when an action layer changes this control (only on layer views).</param>
public sealed record ControllerControlDto(string Control, string? Mode, IReadOnlyList<ControllerBindingDto> Bindings, bool FromLayer);

/// <param name="Kind">set | layer.</param>
public sealed record ControllerSetDto(string Id, string Name, string Kind, string? ParentId, IReadOnlyList<ControllerControlDto> Controls);

/// <param name="Status">steamInput | none | notSteam | noSteam | unreadable.</param>
/// <param name="SourceKind">personal | template | workshop (when <paramref name="Status"/> is steamInput or unreadable).</param>
public sealed record ControllerLayoutDto(
    string Status,
    string? Title,
    string? Description,
    string? ControllerType,
    string? ControllerLabel,
    string? SourceKind,
    string? TemplateName,
    IReadOnlyList<ControllerSetDto> Sets,
    string? Note)
{
    public static ControllerLayoutDto Simple(string status, string? note = null) => new(status, null, null, null, null, null, null, [], note);
}

/// <summary>
/// Maps a Steam Input configuration (text KeyValues "controller_mappings", version 3) to action sets,
/// layers and per-control bindings with friendly labels. The file is untrusted: sizes, counts and string
/// lengths are capped, unknown parts are skipped, and nothing here touches the disk or the network.
/// </summary>
public static class SteamInputLayout
{
    public const int MaxBytes = 2 * 1024 * 1024;
    public const int MaxDepth = 24;
    private const int MaxGroups = 512, MaxPresets = 64, MaxInputs = 64, MaxActivators = 8, MaxBindings = 8, MaxText = 80;

    /// <summary>Parses VDF text. Throws <see cref="FormatException"/> for anything that isn't a readable layout.</summary>
    public static ControllerLayoutDto Parse(string text, string sourceKind, string? templateName = null)
    {
        if (text.Length > MaxBytes) throw new FormatException("Layout file too large.");
        var root = Vdf.Parse(text, MaxDepth);
        return Map(root, sourceKind, templateName);
    }

    public static ControllerLayoutDto Map(VdfNode root, string sourceKind, string? templateName = null)
    {
        var m = root["controller_mappings"] ?? throw new FormatException("Not a Steam Input layout.");
        if (!m.IsObject) throw new FormatException("Not a Steam Input layout.");
        var version = m.GetString("version");
        if (version is not null && version is not ("2" or "3")) throw new FormatException($"Unsupported layout version {Clip(version)}.");

        var loc = Localization(m);
        string Resolve(string? s) => ResolveText(s, loc);

        var title = Clean(Resolve(m.GetString("title")));
        if (string.IsNullOrEmpty(title)) title = Clean(m.GetString("game"));
        var description = Clean(Resolve(m.GetString("description")), 400);
        var controllerType = Clean(m.GetString("controller_type"), 40);

        // Action sets and their action titles (games using Steam Input's in-game actions).
        var sets = new List<(string Id, string Name)>();
        var actionTitles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (m["actions"] is { IsObject: true } actions)
        {
            foreach (var (setId, node) in actions.Children.Take(MaxPresets))
            {
                if (!node.IsObject) continue;
                sets.Add((setId, Clean(Resolve(node.GetString("title"))) is { Length: > 0 } t ? t : Humanize(setId)));
                foreach (var (_, category) in node.Children)
                {
                    if (!category.IsObject) continue;
                    foreach (var (actionKey, action) in category.Children.Take(256))
                    {
                        var at = action.IsObject ? action.GetString("title") : action.Value;
                        if (Clean(Resolve(at)) is { Length: > 0 } nice) actionTitles.TryAdd(actionKey, nice);
                    }
                }
            }
        }
        var layers = new List<(string Id, string Name, string? Parent)>();
        if (m["action_layers"] is { IsObject: true } layerNode)
        {
            foreach (var (layerId, node) in layerNode.Children.Take(MaxPresets))
            {
                if (!node.IsObject) continue;
                var name = Clean(Resolve(node.GetString("title"))) is { Length: > 0 } t ? t : Humanize(layerId);
                layers.Add((layerId, name, node.GetString("parent_set_name")));
            }
        }

        var groups = new Dictionary<string, VdfNode>(StringComparer.Ordinal);
        foreach (var g in m.Children.Where(c => c.Key.Equals("group", StringComparison.OrdinalIgnoreCase) && c.Value.IsObject).Take(MaxGroups))
        {
            if (g.Value.GetString("id") is { } id) groups.TryAdd(id, g.Value);
        }
        var presets = m.Children.Where(c => c.Key.Equals("preset", StringComparison.OrdinalIgnoreCase) && c.Value.IsObject)
            .Select(c => c.Value).Take(MaxPresets).ToList();
        // Version 2 files (older templates) have one implicit preset: the mapping itself holds group_source_bindings.
        if (presets.Count == 0 && m["group_source_bindings"] is { IsObject: true }) presets.Add(m);
        if (presets.Count == 0) throw new FormatException("Layout has no presets.");

        var presetNames = presets.ToDictionary(p => p.GetString("id") ?? "", p => p.GetString("name") ?? "", StringComparer.Ordinal);
        string NameOfPreset(string presetName) =>
            sets.FirstOrDefault(s => s.Id.Equals(presetName, StringComparison.OrdinalIgnoreCase)).Name
            ?? layers.FirstOrDefault(l => l.Id.Equals(presetName, StringComparison.OrdinalIgnoreCase)).Name
            ?? Humanize(presetName);
        // Preset references in bindings are 1-based ("CHANGE_PRESET 2" is the preset with id 1).
        string? PresetTitle(string? oneBased) =>
            int.TryParse(oneBased, NumberStyles.None, CultureInfo.InvariantCulture, out var n) && presetNames.TryGetValue((n - 1).ToString(CultureInfo.InvariantCulture), out var pn)
                ? NameOfPreset(pn) : null;
        var ctx = new Context(actionTitles, PresetTitle, Resolve);

        // Each preset is one action set (or layer); it activates one group per physical source.
        var byPreset = new List<(string Name, List<Mapped> Controls)>();
        foreach (var preset in presets)
        {
            var name = preset.GetString("name") is { Length: > 0 } given ? given : "Default";
            var setForActions = sets.Any(s => s.Id.Equals(name, StringComparison.OrdinalIgnoreCase))
                ? name : layers.FirstOrDefault(l => l.Id.Equals(name, StringComparison.OrdinalIgnoreCase)).Parent;
            var mapped = new List<Mapped>();
            if (preset["group_source_bindings"] is { IsObject: true } gsb)
            {
                foreach (var (groupId, value) in gsb.Children.Take(64))
                {
                    var parts = (value.Value ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 2 || !parts[1].Equals("active", StringComparison.OrdinalIgnoreCase)) continue;
                    if (!groups.TryGetValue(groupId, out var group)) continue;
                    var modeShift = parts.Length > 2 && parts[2].Equals("modeshift", StringComparison.OrdinalIgnoreCase);
                    MapGroup(parts[0].ToLowerInvariant(), group, modeShift, setForActions, ctx, mapped);
                }
            }
            byPreset.Add((name, mapped));
        }

        var outSets = new List<ControllerSetDto>();
        foreach (var (name, controls) in byPreset)
        {
            var layer = layers.FirstOrDefault(l => l.Id.Equals(name, StringComparison.OrdinalIgnoreCase));
            if (layer.Id is null)
            {
                var set = sets.FirstOrDefault(s => s.Id.Equals(name, StringComparison.OrdinalIgnoreCase));
                outSets.Add(new ControllerSetDto(name, set.Name ?? Humanize(name), "set", null, Merge(controls, null)));
            }
            else
            {
                // A layer sits on top of its parent set: sources it defines replace the parent's.
                var parent = byPreset.FirstOrDefault(p => p.Name.Equals(layer.Parent ?? "", StringComparison.OrdinalIgnoreCase)).Controls;
                outSets.Add(new ControllerSetDto(name, layer.Name, "layer", layer.Parent, Merge(controls, parent)));
            }
        }
        // Sets first (in file order), then layers.
        outSets = [.. outSets.Where(s => s.Kind == "set"), .. outSets.Where(s => s.Kind == "layer")];

        return new ControllerLayoutDto("steamInput", string.IsNullOrEmpty(title) ? null : title, string.IsNullOrEmpty(description) ? null : description,
            controllerType, ControllerLabel(controllerType), sourceKind, templateName, outSets, null);
    }

    /// <summary>"controller_xboxone" → "Xbox One controller".</summary>
    public static string? ControllerLabel(string? type) => type?.ToLowerInvariant() switch
    {
        null or "" => null,
        "controller_xboxone" => "Xbox One / Series controller",
        "controller_xboxelite" => "Xbox Elite controller",
        "controller_xbox360" => "Xbox 360 controller",
        "controller_ps5" => "DualSense (PS5) controller",
        "controller_ps4" => "DualShock 4 (PS4) controller",
        "controller_ps3" => "DualShock 3 (PS3) controller",
        "controller_switch_pro" => "Switch Pro controller",
        "controller_neptune" => "Steam Deck",
        "controller_steamcontroller_gordon" => "Steam Controller",
        "controller_generic" => "Generic controller",
        "controller_mobile_touch" => "Touch controls (Steam Link)",
        var t when t.StartsWith("controller_", StringComparison.Ordinal) => Humanize(t["controller_".Length..]) + " controller",
        var t => Humanize(t),
    };

    // ---------- groups → controls ----------

    private sealed record Context(IReadOnlyDictionary<string, string> ActionTitles, Func<string?, string?> PresetTitle, Func<string?, string> Resolve);

    private sealed record Mapped(string Source, string Control, string? Mode, List<ControllerBindingDto> Bindings);

    private static readonly string[] ControlOrder =
    [
        "a", "b", "x", "y", "lb", "rb", "lt", "rt", "ls", "lsClick", "rs", "rsClick", "dpadUp", "dpadDown", "dpadLeft", "dpadRight",
        "view", "menu", "share", "guide", "p1", "p2", "p3", "p4", "leftPad", "rightPad", "centerPad", "gyro",
    ];

    private static void MapGroup(string source, VdfNode group, bool modeShift, string? setForActions, Context ctx, List<Mapped> into)
    {
        var mode = (group.GetString("mode") ?? "").ToLowerInvariant();
        var settings = group["settings"];
        var stickControl = source switch
        {
            "joystick" => "ls",
            "right_joystick" => "rs",
            "left_trigger" => "lt",
            "right_trigger" => "rt",
            "left_trackpad" => "leftPad",
            "right_trackpad" => "rightPad",
            "center_trackpad" => "centerPad",
            "gyro" => "gyro",
            _ => null,
        };

        Mapped Get(string control)
        {
            var existing = into.FirstOrDefault(x => x.Control == control && x.Source == source);
            if (existing is not null) return existing;
            var created = new Mapped(source, control, control == stickControl ? ModeLabel(mode, settings) : null, []);
            into.Add(created);
            return created;
        }

        // What the analog part does: an in-game analog action, or a gamepad stick/trigger output.
        if (stickControl is not null)
        {
            var target = Get(stickControl);
            if (AnalogAction(group, setForActions, ctx) is { } analog)
                target.Bindings.Add(new ControllerBindingDto(modeShift ? "modeshift" : "analog", null, analog, null, "action"));
            else if (AnalogOutput(mode, settings) is { } output)
                target.Bindings.Add(new ControllerBindingDto(modeShift ? "modeshift" : "analog", null, output, null, "gamepad"));
        }

        // Version 2: "bindings" maps an input straight to one binding (a full press).
        if (group["bindings"] is { IsObject: true } flat)
        {
            foreach (var (inputName, value) in flat.Children.Take(MaxInputs))
            {
                if (value.Value is null) continue;
                var (control, slot) = Locate(source, mode, inputName.ToLowerInvariant());
                if (control is not null && ParseBinding(value.Value, ctx) is { } b)
                    Get(control).Bindings.Add(b with { Activator = modeShift ? "modeshift" : "press", Slot = slot });
            }
        }
        if (group["inputs"] is not { IsObject: true } inputs) return;
        foreach (var (inputName, input) in inputs.Children.Take(MaxInputs))
        {
            if (!input.IsObject) continue;
            var (control, slot) = Locate(source, mode, inputName.ToLowerInvariant());
            if (control is null) continue;
            var bindings = ReadActivators(input, slot, modeShift, ctx);
            if (bindings.Count == 0) continue;
            Get(control).Bindings.AddRange(bindings);
        }
    }

    private static List<ControllerBindingDto> ReadActivators(VdfNode input, string? slot, bool modeShift, Context ctx)
    {
        var result = new List<ControllerBindingDto>();
        if (input["activators"] is not { IsObject: true } activators) return result;
        foreach (var (activatorName, activator) in activators.Children.Take(MaxActivators))
        {
            if (!activator.IsObject || activator["bindings"] is not { IsObject: true } bindings) continue;
            var kind = modeShift ? "modeshift" : ActivatorKind(activatorName);
            foreach (var (key, binding) in bindings.Children.Take(MaxBindings))
            {
                if (!key.Equals("binding", StringComparison.OrdinalIgnoreCase) || binding.Value is null) continue;
                if (ParseBinding(binding.Value, ctx) is { } b) result.Add(b with { Activator = kind, Slot = slot });
            }
        }
        return result;
    }

    /// <summary>Which physical control an input of a group lands on, and where on it.</summary>
    private static (string? Control, string? Slot) Locate(string source, string mode, string input)
    {
        string? Dir(string i) => i switch
        {
            "dpad_north" or "button_y" => "up",
            "dpad_south" or "button_a" => "down",
            "dpad_west" or "button_x" => "left",
            "dpad_east" or "button_b" => "right",
            _ => null,
        };
        switch (source)
        {
            case "button_diamond":
                return (input switch
                {
                    "button_a" or "dpad_south" => "a",
                    "button_b" or "dpad_east" => "b",
                    "button_x" or "dpad_west" => "x",
                    "button_y" or "dpad_north" => "y",
                    _ => null,
                }, null);
            case "dpad":
                if (Dir(input) is { } d) return ("dpad" + char.ToUpperInvariant(d[0]) + d[1..], null);
                return (null, null);
            case "joystick" or "right_joystick":
            {
                var stick = source == "joystick" ? "ls" : "rs";
                if (input == "click") return (stick + "Click", null);
                if (Dir(input) is { } sd) return (stick, sd);
                if (input is "edge" or "outer_ring") return (stick, "outer");
                return (stick, null);
            }
            case "left_trigger" or "right_trigger":
                return (source == "left_trigger" ? "lt" : "rt", null);
            case "switch":
                return (input switch
                {
                    "button_escape" => "menu",   // Steam's name for Start / Menu (≡)
                    "button_menu" => "view",     // and for Back / View (⧉)
                    "left_bumper" => "lb",
                    "right_bumper" => "rb",
                    "button_back_right_upper" => "p1",
                    "button_back_right" => "p2",
                    "button_back_left_upper" => "p3",
                    "button_back_left" => "p4",
                    "button_capture" => "share",
                    "button_steam" or "button_guide" => "guide",
                    _ => null,
                }, null);
            case "left_trackpad" or "right_trackpad" or "center_trackpad" or "gyro":
            {
                var control = source switch { "left_trackpad" => "leftPad", "right_trackpad" => "rightPad", "center_trackpad" => "centerPad", _ => "gyro" };
                if (input == "click") return (control, "click");
                if (Dir(input) is { } pd && mode is "dpad" or "four_buttons") return (control, pd);
                if (input is "edge" or "outer_ring") return (control, "outer");
                return (control, null);
            }
            default:
                return (null, null);
        }
    }

    private static string? ModeLabel(string mode, VdfNode? settings) => mode switch
    {
        "joystick_move" => "Joystick",
        "joystick_camera" => "Camera",
        "joystick_mouse" => "Mouse",
        "absolute_mouse" => "Mouse",
        "mouse_joystick" => "Joystick",
        "mouse_region" => "Mouse region",
        "flickstick" => "Flick stick",
        "gyro_to_mouse" => "Gyro mouse",
        "gyro_to_joystick" or "gyro_to_joystick_camera" => "Gyro camera",
        "scrollwheel" => "Scroll wheel",
        "2dscroll" => "Scroll",
        "dpad" => "Directional pad",
        "four_buttons" => "Buttons",
        "trigger" => "Trigger",
        "single_button" => "Button",
        "radial_menu" => "Radial menu",
        "touch_menu" => "Touch menu",
        "hotbar" => "Hotbar",
        "" => null,
        _ => Humanize(mode),
    };

    private static string? AnalogOutput(string mode, VdfNode? settings)
    {
        var joystick = settings?.GetString("output_joystick");
        var trigger = settings?.GetString("output_trigger");
        return mode switch
        {
            "joystick_move" => joystick switch { "1" => "Right stick", "2" => "Relative stick", _ => "Left stick" },
            "joystick_camera" => "Right stick (camera)",
            "joystick_mouse" or "absolute_mouse" or "gyro_to_mouse" => "Mouse movement",
            "flickstick" => "Mouse turn (flick stick)",
            "scrollwheel" => "Mouse wheel",
            "trigger" => trigger switch { "1" => "Left trigger (analog)", "2" => "Right trigger (analog)", _ => null },
            _ => null,
        };
    }

    private static string? AnalogAction(VdfNode group, string? set, Context ctx)
    {
        if (group["gameactions"] is not { IsObject: true } ga) return null;
        var action = (set is not null ? ga.GetString(set) : null) ?? ga.Children.FirstOrDefault(c => c.Value.Value is not null).Value?.Value;
        if (string.IsNullOrWhiteSpace(action)) return null;
        return ctx.ActionTitles.TryGetValue(action, out var t) ? t : Clean(Humanize(action));
    }

    private static string ActivatorKind(string name) => name.ToLowerInvariant() switch
    {
        "full_press" => "press",
        "long_press" => "long",
        "double_press" => "double",
        "start_press" => "start",
        "release_press" => "release",
        "soft_press" => "soft",
        "chord" or "chorded_press" => "chord",
        "analog" or "analog_output" => "analog",
        _ => "other",
    };

    private static List<ControllerControlDto> Merge(List<Mapped> own, List<Mapped>? parent)
    {
        var result = new List<Mapped>();
        var layerSources = own.Select(o => o.Source).ToHashSet(StringComparer.Ordinal);
        if (parent is not null) result.AddRange(parent.Where(p => !layerSources.Contains(p.Source)));
        result.AddRange(own);
        return result
            .GroupBy(r => r.Control)
            .Select(g => new ControllerControlDto(
                g.Key,
                g.Select(x => x.Mode).FirstOrDefault(x => x is not null),
                g.SelectMany(x => x.Bindings).Distinct().ToList(),
                parent is not null && g.Any(x => own.Contains(x))))
            .Where(c => c.Bindings.Count > 0 || c.Mode is not null)
            .OrderBy(c => Array.IndexOf(ControlOrder, c.Control) is var i && i < 0 ? int.MaxValue : i)
            .ToList();
    }

    // ---------- bindings ----------

    /// <summary>
    /// Turns one binding string into friendly words. Format: "&lt;command&gt; &lt;args…&gt;[, label[, icon…]]",
    /// e.g. "key_press SPACE, Jump" → label "Jump", detail "Space". Returns null for empty bindings.
    /// </summary>
    public static ControllerBindingDto? ParseBinding(string raw, IReadOnlyDictionary<string, string>? actionTitles = null, Func<string?, string?>? presetTitle = null) =>
        ParseBinding(raw, new Context(actionTitles ?? new Dictionary<string, string>(), presetTitle ?? (_ => null), s => s ?? ""));

    private static ControllerBindingDto? ParseBinding(string raw, Context ctx)
    {
        if (raw.Length > 400) raw = raw[..400];
        var comma = raw.IndexOf(',');
        var command = (comma < 0 ? raw : raw[..comma]).Trim();
        var customRaw = comma < 0 ? null : raw[(comma + 1)..].Split(',')[0].Trim();
        var custom = customRaw is { Length: > 1 } && customRaw[0] == '#' ? Clean(ctx.Resolve(customRaw), 60) : Clean(customRaw, 60);
        var parts = command.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return null;
        var verb = parts[0].ToLowerInvariant();
        var arg = parts.Length > 1 ? parts[1] : null;

        (string Out, string Kind)? output = verb switch
        {
            "key_press" when arg is not null => (KeyName(arg), "key"),
            "mouse_button" when arg is not null => (MouseButton(arg), "mouse"),
            "mouse_wheel" when arg is not null => (MouseWheel(arg), "mouse"),
            "xinput_button" when arg is not null => (GamepadButton(arg), "gamepad"),
            "game_action" when parts.Length > 2 => (ctx.ActionTitles.TryGetValue(parts[2], out var t) ? t : Clean(Humanize(parts[2])), "action"),
            "game_action" when arg is not null => (ctx.ActionTitles.TryGetValue(arg, out var t2) ? t2 : Clean(Humanize(arg)), "action"),
            "controller_action" when arg is not null => ControllerAction(arg, parts.Length > 2 ? parts[2] : null, ctx),
            "mode_shift" when arg is not null => ($"Mode shift: {SourceName(arg)}", "mode"),
            "empty_binding" => null,
            _ => (Clean(Humanize(command)), "other"),
        };
        if (output is null || string.IsNullOrWhiteSpace(output.Value.Out)) return null;
        var (text, kind) = output.Value;
        // A custom label is the name the config's author gave the action; the output stays visible as detail.
        return string.IsNullOrEmpty(custom) || custom.Equals(text, StringComparison.OrdinalIgnoreCase)
            ? new ControllerBindingDto("press", null, text, null, kind)
            : new ControllerBindingDto("press", null, custom, text, kind);
    }

    private static (string, string)? ControllerAction(string action, string? arg, Context ctx) => action.ToLowerInvariant() switch
    {
        "screenshot" => ("Screenshot", "system"),
        "change_preset" => (ctx.PresetTitle(arg) is { } t ? $"Switch to {t}" : "Switch action set", "set"),
        "add_layer" => (ctx.PresetTitle(arg) is { } t ? $"Turn on {t}" : "Turn on a layer", "layer"),
        "hold_layer" => (ctx.PresetTitle(arg) is { } t ? $"Hold for {t}" : "Hold a layer", "layer"),
        "remove_layer" => (ctx.PresetTitle(arg) is { } t ? $"Turn off {t}" : "Turn off a layer", "layer"),
        "show_keyboard" => ("On-screen keyboard", "system"),
        "camera_reset" => ("Reset camera", "system"),
        "mouse_position" => ("Move cursor", "system"),
        "turn_off_controller" => ("Turn off controller", "system"),
        "toggle_magnifier" or "magnifier" => ("Magnifier", "system"),
        "show_quick_access" or "quick_access_menu" => ("Quick access menu", "system"),
        "steam_menu" or "show_steam_menu" => ("Steam menu", "system"),
        "empty_binding" => null,
        var a => (Clean(Humanize(a)), "system"),
    };

    private static readonly Dictionary<string, string> Keys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["SPACE"] = "Space", ["RETURN"] = "Enter", ["ENTER"] = "Enter", ["ESCAPE"] = "Esc", ["TAB"] = "Tab", ["BACKSPACE"] = "Backspace",
        ["LEFT_SHIFT"] = "Left Shift", ["RIGHT_SHIFT"] = "Right Shift", ["LEFT_CONTROL"] = "Left Ctrl", ["RIGHT_CONTROL"] = "Right Ctrl",
        ["LEFT_ALT"] = "Left Alt", ["RIGHT_ALT"] = "Right Alt", ["LEFT_WINDOWS"] = "Windows", ["RIGHT_WINDOWS"] = "Windows", ["LWIN"] = "Windows",
        ["CAPSLOCK"] = "Caps Lock", ["CAPS_LOCK"] = "Caps Lock", ["UP_ARROW"] = "↑", ["DOWN_ARROW"] = "↓", ["LEFT_ARROW"] = "←", ["RIGHT_ARROW"] = "→",
        ["INSERT"] = "Insert", ["DELETE"] = "Delete", ["HOME"] = "Home", ["END"] = "End", ["PAGE_UP"] = "Page Up", ["PAGEUP"] = "Page Up",
        ["PAGE_DOWN"] = "Page Down", ["PAGEDOWN"] = "Page Down", ["SEMICOLON"] = ";", ["SINGLE_QUOTE"] = "'", ["COMMA"] = ",", ["PERIOD"] = ".",
        ["FORWARD_SLASH"] = "/", ["BACKSLASH"] = "\\", ["LEFT_BRACKET"] = "[", ["RIGHT_BRACKET"] = "]", ["DASH"] = "-", ["MINUS"] = "-",
        ["EQUALS"] = "=", ["BACK_TICK"] = "`", ["PRINTSCREEN"] = "Print Screen", ["SCROLL_LOCK"] = "Scroll Lock", ["PAUSE"] = "Pause",
        ["NUMLOCK"] = "Num Lock", ["KEYPAD_PLUS"] = "Numpad +", ["KEYPAD_MINUS"] = "Numpad -", ["KEYPAD_MULTIPLY"] = "Numpad *",
        ["KEYPAD_DIVIDE"] = "Numpad /", ["KEYPAD_ENTER"] = "Numpad Enter", ["KEYPAD_PERIOD"] = "Numpad .", ["VOLUP"] = "Volume up",
        ["VOLDOWN"] = "Volume down", ["MUTE"] = "Mute",
    };

    /// <summary>"LEFT_SHIFT" → "Left Shift", "KEYPAD_4" → "Numpad 4", "F5" → "F5", "w" → "W".</summary>
    public static string KeyName(string key)
    {
        key = Clip(key, 32);
        if (Keys.TryGetValue(key, out var known)) return known;
        if (key.Length == 1) return key.ToUpperInvariant();
        if (key.StartsWith("KEYPAD_", StringComparison.OrdinalIgnoreCase)) return "Numpad " + Humanize(key[7..]);
        if (key.Length <= 3 && (key[0] is 'F' or 'f') && key[1..].All(char.IsAsciiDigit)) return key.ToUpperInvariant();
        return Humanize(key);
    }

    private static string MouseButton(string b) => b.ToUpperInvariant() switch
    {
        "LEFT" => "Left click",
        "RIGHT" => "Right click",
        "MIDDLE" => "Middle click",
        "BACK" or "X1" => "Mouse back",
        "FORWARD" or "X2" => "Mouse forward",
        var x => $"Mouse {Humanize(Clip(x, 20)).ToLowerInvariant()}",
    };

    private static string MouseWheel(string w) => w.ToUpperInvariant() switch
    {
        "SCROLL_UP" => "Scroll up",
        "SCROLL_DOWN" => "Scroll down",
        "SCROLL_LEFT" => "Scroll left",
        "SCROLL_RIGHT" => "Scroll right",
        var x => Humanize(Clip(x, 20)),
    };

    /// <summary>Gamepad outputs in Xbox names, the layout VYSTRAL draws.</summary>
    public static string GamepadButton(string b) => b.ToUpperInvariant() switch
    {
        "A" => "A", "B" => "B", "X" => "X", "Y" => "Y",
        "SHOULDER_LEFT" => "LB", "SHOULDER_RIGHT" => "RB",
        "TRIGGER_LEFT" => "LT", "TRIGGER_RIGHT" => "RT",
        "JOYSTICK_LEFT" => "Left stick click", "JOYSTICK_RIGHT" => "Right stick click",
        "DPAD_UP" => "D-pad up", "DPAD_DOWN" => "D-pad down", "DPAD_LEFT" => "D-pad left", "DPAD_RIGHT" => "D-pad right",
        "START" => "Menu", "SELECT" or "BACK" => "View", "GUIDE" => "Guide",
        var x => Humanize(Clip(x, 24)),
    };

    private static string SourceName(string s) => s.ToLowerInvariant() switch
    {
        "button_diamond" => "face buttons",
        "dpad" => "D-pad",
        "joystick" => "left stick",
        "right_joystick" => "right stick",
        "left_trigger" => "left trigger",
        "right_trigger" => "right trigger",
        "left_trackpad" => "left trackpad",
        "right_trackpad" => "right trackpad",
        "gyro" => "gyro",
        var x => Humanize(Clip(x, 24)).ToLowerInvariant(),
    };

    // ---------- text ----------

    private static Dictionary<string, string> Localization(VdfNode m)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (m["localization"]?["english"] is { IsObject: true } en)
            foreach (var (k, v) in en.Children.Take(4000))
                if (v.Value is not null) result.TryAdd(k, v.Value);
        return result;
    }

    private static string ResolveText(string? s, IReadOnlyDictionary<string, string> loc)
    {
        if (string.IsNullOrEmpty(s)) return "";
        if (s[0] != '#') return s;
        var key = s[1..];
        if (loc.TryGetValue(key, out var v)) return v;
        // Steam's own default title/description tokens for saved layouts say nothing useful.
        if (key.StartsWith("Library_", StringComparison.OrdinalIgnoreCase) || key.StartsWith("SettingsController_", StringComparison.OrdinalIgnoreCase)) return "";
        // Valve's own tokens (#Set_Default, #Action_Select) read well without their prefix.
        foreach (var prefix in (string[])["Set_", "Action_", "Button_", "Stick_", "Trigger_", "SettingsController_", "Title_"])
            if (key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && key.Length > prefix.Length) return Humanize(key[prefix.Length..]);
        return Humanize(key);
    }

    /// <summary>"PAGE_UP" → "Page Up", "LeftTrackpad" → "Left Trackpad", "sc_jump" → "Sc Jump".</summary>
    public static string Humanize(string s)
    {
        s = Clip(s, MaxText);
        var sb = new StringBuilder(s.Length + 8);
        var startWord = true;
        var shouting = s.All(ch => !char.IsLetter(ch) || char.IsUpper(ch));
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (c is '_' or '-' or ':' || char.IsWhiteSpace(c))
            {
                if (sb.Length > 0 && sb[^1] != ' ') sb.Append(' ');
                startWord = true;
                continue;
            }
            if (char.IsUpper(c) && i > 0 && char.IsLower(s[i - 1]) && sb.Length > 0 && sb[^1] != ' ') { sb.Append(' '); startWord = true; }
            sb.Append(startWord ? char.ToUpperInvariant(c) : shouting ? char.ToLowerInvariant(c) : c);
            startWord = false;
        }
        return sb.ToString().Trim();
    }

    /// <summary>Strips control characters and markup-ish brackets, collapses whitespace, caps the length.</summary>
    public static string Clean(string? s, int max = MaxText)
    {
        if (string.IsNullOrWhiteSpace(s)) return "";
        var sb = new StringBuilder(Math.Min(s.Length, max + 1));
        var space = false;
        foreach (var c in s)
        {
            if (char.IsControl(c) || char.IsWhiteSpace(c) || char.GetUnicodeCategory(c) is UnicodeCategory.Format)
            {
                space = sb.Length > 0;
                continue;
            }
            if (c is '<' or '>') continue;
            if (space) { sb.Append(' '); space = false; }
            sb.Append(c);
            if (sb.Length >= max) break;
        }
        var result = sb.ToString().Trim();
        return result.Length >= max ? result[..(max - 1)].TrimEnd() + "…" : result;
    }

    private static string Clip(string s, int max = MaxText) => s.Length <= max ? s : s[..max];
}
