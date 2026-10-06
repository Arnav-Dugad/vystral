using Vystral.Core.Controller;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Xunit;

namespace Vystral.Tests.Controller;

public sealed class SteamInputLayoutTests
{
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "SteamInput", name));

    private static ControllerControlDto Control(ControllerSetDto set, string id) => Assert.Single(set.Controls, c => c.Control == id);

    [Fact]
    public void Template_maps_every_source_to_xbox_controls_with_friendly_labels()
    {
        var layout = SteamInputLayout.Parse(Fixture("template_wasd.vdf"), "template");

        Assert.Equal("steamInput", layout.Status);
        Assert.Equal("Keyboard (WASD) and Mouse", layout.Title); // "#Title" resolved from the English localization
        Assert.Equal("controller_xboxone", layout.ControllerType);
        Assert.Equal("Xbox One / Series controller", layout.ControllerLabel);
        var set = Assert.Single(layout.Sets);
        Assert.Equal(("Default", "set"), (set.Name, set.Kind));

        var a = Assert.Single(Control(set, "a").Bindings);
        Assert.Equal(new ControllerBindingDto("press", null, "Jump", "Space", "key"), a);
        Assert.Equal(new ControllerBindingDto("press", null, "E", null, "key"), Assert.Single(Control(set, "b").Bindings));
        var x = Control(set, "x").Bindings;
        Assert.Contains(new ControllerBindingDto("press", null, "Reload", "R", "key"), x);
        Assert.Contains(new ControllerBindingDto("long", null, "Left Ctrl", null, "key"), x);

        Assert.Equal("Weapon 1", Assert.Single(Control(set, "dpadUp").Bindings).Label);
        Assert.Equal("F5", Assert.Single(Control(set, "dpadRight").Bindings).Label);

        var ls = Control(set, "ls");
        Assert.Equal("Directional pad", ls.Mode);
        Assert.Contains(ls.Bindings, b => b is { Slot: "up", Label: "Move Forward", Detail: "W" });
        Assert.Contains(ls.Bindings, b => b is { Slot: "down", Label: "S" });
        Assert.Equal(("Sprint", "Left Shift"), (Control(set, "lsClick").Bindings[0].Label, Control(set, "lsClick").Bindings[0].Detail));

        Assert.Equal("Right click", Assert.Single(Control(set, "lt").Bindings).Label);
        Assert.Equal("Left click", Assert.Single(Control(set, "rt").Bindings).Label);
        Assert.Equal(("Menu", "Esc"), (Control(set, "menu").Bindings[0].Label, Control(set, "menu").Bindings[0].Detail)); // button_escape = ≡
        Assert.Equal(("Map", "Tab"), (Control(set, "view").Bindings[0].Label, Control(set, "view").Bindings[0].Detail));   // button_menu = ⧉
        Assert.Equal("Scroll down", Control(set, "lb").Bindings[0].Detail);
        Assert.Equal("F", Control(set, "p4").Bindings[0].Label);
        Assert.Equal(new ControllerBindingDto("press", null, "Screenshot", null, "system"), Control(set, "share").Bindings[0]);

        // Active right stick group (mouse); the inactive flick-stick group is ignored.
        var rs = Control(set, "rs");
        Assert.Equal("Mouse", rs.Mode);
        Assert.Contains(rs.Bindings, b => b is { Activator: "analog", Label: "Mouse movement" });
        Assert.Equal("Middle click", Control(set, "rsClick").Bindings[0].Label);
        // Inactive right trackpad group: not present.
        Assert.DoesNotContain(set.Controls, c => c.Control == "rightPad");
        // Controls come in a stable order.
        Assert.Equal("a", set.Controls[0].Control);
    }

    [Fact]
    public void In_game_actions_resolve_titles_sets_and_layers()
    {
        var layout = SteamInputLayout.Parse(Fixture("personal_actions.vdf"), "personal");

        Assert.Equal("My layout", layout.Title);
        Assert.Equal(["On foot", "Menus", "Driving"], layout.Sets.Select(s => s.Name));
        Assert.Equal(["set", "set", "layer"], layout.Sets.Select(s => s.Kind));
        var onFoot = layout.Sets[0];
        Assert.Equal(new ControllerBindingDto("press", null, "Jump", null, "action"), Control(onFoot, "a").Bindings[0]);
        var x = Control(onFoot, "x").Bindings;
        Assert.Contains(new ControllerBindingDto("press", null, "Interact", null, "action"), x);
        Assert.Contains(new ControllerBindingDto("double", null, "Menus", "Switch to Menus", "set"), x);
        Assert.Equal(new ControllerBindingDto("press", null, "Hold for Driving", null, "layer"), Control(onFoot, "y").Bindings[0]);
        Assert.Equal("Move", Assert.Single(Control(onFoot, "ls").Bindings).Label);
        Assert.Equal("Look around", Assert.Single(Control(onFoot, "rs").Bindings).Label);
        Assert.Equal("Pause", Control(onFoot, "menu").Bindings[0].Label);
        Assert.Equal("Open map", Control(onFoot, "view").Bindings[0].Label);
        Assert.All(onFoot.Controls, c => Assert.False(c.FromLayer));

        var menus = layout.Sets[1];
        Assert.Equal(["Select", "Back"], menus.Controls.Select(c => c.Bindings[0].Label));

        var driving = layout.Sets[2];
        Assert.Equal("InGame", driving.ParentId);
        var a = Control(driving, "a");
        Assert.True(a.FromLayer);
        Assert.Equal(new ControllerBindingDto("press", null, "Handbrake", "A", "gamepad"), Assert.Single(a.Bindings)); // the layer replaces the face buttons
        Assert.DoesNotContain(driving.Controls, c => c.Control == "x"); // whole source replaced, not merged button by button
        Assert.Equal("Accelerate", Control(driving, "rt").Bindings[0].Label);
        Assert.True(Control(driving, "rt").FromLayer);
        var ls = Control(driving, "ls"); // inherited from the parent set
        Assert.False(ls.FromLayer);
        Assert.Equal("Move", ls.Bindings[0].Label);
    }

    [Fact]
    public void Version_2_layouts_and_localized_labels()
    {
        const string v2 = """
            "controller_mappings"
            {
                "version" "2"
                "title" "#Title"
                "group" { "id" "0" "mode" "four_buttons" "bindings" { "button_A" "key_press SPACE, Jump" "button_B" "game_action Default fire, #Fire" } }
                "group" { "id" "1" "mode" "joystick_move" }
                "group_source_bindings" { "0" "button_diamond active" "1" "joystick active" }
                "Localization" { "english" { "Title" "Keyboard (WASD) and Mouse" "Fire" "Shoot" } }
            }
            """;
        var layout = SteamInputLayout.Parse(v2, "template");
        Assert.Equal("Keyboard (WASD) and Mouse", layout.Title);
        var set = Assert.Single(layout.Sets);
        Assert.Equal("Default", set.Name);
        Assert.Equal(("Jump", "Space"), (Control(set, "a").Bindings[0].Label, Control(set, "a").Bindings[0].Detail));
        Assert.Equal("Shoot", Control(set, "b").Bindings[0].Label); // "#Fire" resolved from the file's localization
        Assert.Equal("Left stick", Control(set, "ls").Bindings[0].Label);

        // Steam's default title for saved layouts isn't shown.
        var saved = SteamInputLayout.Parse("\"controller_mappings\" { \"version\" \"3\" \"title\" \"#Library_ControllerSaveDefaultTitle\" \"preset\" { \"id\" \"0\" \"name\" \"\" } }", "personal");
        Assert.Null(saved.Title);
        Assert.Equal("Default", saved.Sets[0].Name);
    }

    [Theory]
    [InlineData("key_press SPACE", "Space", null, "key")]
    [InlineData("key_press LEFT_SHIFT", "Left Shift", null, "key")]
    [InlineData("key_press KEYPAD_4", "Numpad 4", null, "key")]
    [InlineData("key_press w, ", "W", null, "key")]
    [InlineData("key_press RETURN, Confirm, icon.png", "Confirm", "Enter", "key")]
    [InlineData("mouse_button LEFT", "Left click", null, "mouse")]
    [InlineData("mouse_wheel SCROLL_UP, Next weapon", "Next weapon", "Scroll up", "mouse")]
    [InlineData("xinput_button shoulder_left", "LB", null, "gamepad")]
    [InlineData("xinput_button JOYSTICK_RIGHT", "Right stick click", null, "gamepad")]
    [InlineData("xinput_button start", "Menu", null, "gamepad")]
    [InlineData("xinput_button select", "View", null, "gamepad")]
    [InlineData("controller_action SCREENSHOT", "Screenshot", null, "system")]
    [InlineData("controller_action camera_reset 180 66 90, , ", "Reset camera", null, "system")]
    [InlineData("controller_action show_keyboard", "On-screen keyboard", null, "system")]
    [InlineData("controller_action CHANGE_PRESET 9 0 1", "Switch action set", null, "set")]
    [InlineData("mode_shift joystick 14", "Mode shift: left stick", null, "mode")]
    [InlineData("game_action Default fire_weapon", "Fire Weapon", null, "action")]
    public void Bindings_read_as_plain_words(string raw, string label, string? detail, string kind)
    {
        var b = SteamInputLayout.ParseBinding(raw);
        Assert.NotNull(b);
        Assert.Equal((label, detail, kind), (b.Label, b.Detail, b.Kind));
    }

    [Fact]
    public void Untrusted_labels_are_cleaned_and_capped()
    {
        var b = SteamInputLayout.ParseBinding("key_press A, <b>Boom</b>\u0007" + new string('x', 200))!;
        Assert.DoesNotContain('<', b.Label);
        Assert.DoesNotContain('\u0007', b.Label);
        Assert.True(b.Label.Length <= 60);
        Assert.Null(SteamInputLayout.ParseBinding("   "));
        Assert.Null(SteamInputLayout.ParseBinding("empty_binding"));
    }

    [Theory]
    [InlineData("\"something_else\" { \"a\" \"b\" }")]
    [InlineData("\"controller_mappings\" { \"version\" \"9\" \"preset\" { \"id\" \"0\" } }")]
    [InlineData("\"controller_mappings\" { \"version\" \"3\" }")] // no presets
    [InlineData("\"controller_mappings\" { \"version\" \"3\" ")]   // truncated
    public void Malformed_layouts_are_rejected(string text) =>
        Assert.Throws<FormatException>(() => SteamInputLayout.Parse(text, "personal"));

    [Fact]
    public void Deep_or_huge_files_are_rejected()
    {
        var deep = string.Concat(Enumerable.Repeat("\"k\" {", 30)) + string.Concat(Enumerable.Repeat("}", 30));
        Assert.Throws<FormatException>(() => SteamInputLayout.Parse("\"controller_mappings\" {" + deep + "}", "personal"));
        Assert.Throws<FormatException>(() => SteamInputLayout.Parse(new string(' ', SteamInputLayout.MaxBytes + 1), "personal"));
    }

    [Fact]
    public void Humanize_and_controller_labels()
    {
        Assert.Equal("Page Up", SteamInputLayout.Humanize("PAGE_UP"));
        Assert.Equal("Left Trackpad", SteamInputLayout.Humanize("LeftTrackpad"));
        Assert.Equal("DualSense (PS5) controller", SteamInputLayout.ControllerLabel("controller_ps5"));
        Assert.Equal("Steam Deck", SteamInputLayout.ControllerLabel("controller_neptune"));
        Assert.Equal("Foo Bar controller", SteamInputLayout.ControllerLabel("controller_foo_bar"));
    }
}

/// <summary>Finding the layout Steam uses for a game, in a fake Steam folder.</summary>
public sealed class SteamInputLocatorTests : IDisposable
{
    private readonly TempDir _dir = new();
    private string Steam => _dir.Path;
    private const string Account = "1234567";
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "SteamInput", name));
    private string Config(string rel, string text) => _dir.Write(Path.Combine("steamapps", "common", "Steam Controller Configs", Account, "config", rel), text);
    private SteamInputLocator Locator() => new(() => Steam);

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Not_a_Steam_game_or_no_Steam()
    {
        Assert.Equal("notSteam", Locator().Get(null).Status);
        Assert.Equal("notSteam", Locator().Get("../123").Status);
        Assert.Equal("noSteam", new SteamInputLocator(() => null).Get("440").Status);
    }

    [Fact]
    public void No_config_means_the_games_own_controller_support()
    {
        Config("configset_controller_xboxone.vdf", "\"controller_config\" { \"999\" { \"autosave\" \"1\" } }");
        Assert.Equal("none", Locator().Get("440").Status);
    }

    [Fact]
    public void Template_named_in_the_config_set_is_read_from_controller_base()
    {
        Config("configset_controller_xboxone.vdf", "\"controller_config\" { \"440\" { \"template\" \"controller_xboxone_wasd.vdf\" } }");
        _dir.Write(Path.Combine("controller_base", "templates", "controller_xboxone_wasd.vdf"), Fixture("template_wasd.vdf"));

        var layout = Locator().Get("440");
        Assert.Equal(("steamInput", "template", "Keyboard (WASD) and Mouse"), (layout.Status, layout.SourceKind, layout.TemplateName));
    }

    [Fact]
    public void Template_names_that_escape_the_folder_are_ignored()
    {
        Config("configset_controller_xboxone.vdf", "\"controller_config\" { \"440\" { \"template\" \"..\\\\..\\\\evil.vdf\" } }");
        _dir.Write("evil.vdf", Fixture("template_wasd.vdf"));
        Assert.Equal("none", Locator().Get("440").Status);
    }

    [Fact]
    public void Workshop_and_personal_configs()
    {
        Config("configset_controller_xboxone.vdf", """
            "controller_config"
            {
                "440" { "workshop" "2009540442" }
                "620" { "autosave" "1" }
            }
            """);
        _dir.Write(Path.Combine("steamapps", "workshop", "content", "241100", "2009540442", "1000_legacy.bin"), Fixture("personal_actions.vdf"));
        Config(Path.Combine("620", "controller_xboxone.vdf"), Fixture("personal_actions.vdf"));

        Assert.Equal(("steamInput", "workshop"), (Locator().Get("440").Status, Locator().Get("440").SourceKind));
        var personal = Locator().Get("620");
        Assert.Equal(("steamInput", "personal", 3), (personal.Status, personal.SourceKind, personal.Sets.Count));
    }

    [Fact]
    public void Saved_layout_without_a_config_set_entry_and_unreadable_files()
    {
        Config(Path.Combine("730", "controller_ps5.vdf"), Fixture("template_wasd.vdf"));
        Assert.Equal("steamInput", Locator().Get("730").Status);

        Config(Path.Combine("570", "controller_xboxone.vdf"), "\"controller_mappings\" { \"version\" \"3\" ");
        var broken = Locator().Get("570");
        Assert.Equal("unreadable", broken.Status);
        Assert.NotNull(broken.Note);
    }
}
