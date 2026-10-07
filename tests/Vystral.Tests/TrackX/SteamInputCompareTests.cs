using Vystral.Core.Controller;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Xunit;

namespace Vystral.Tests.TrackX;

public sealed class SteamInputCompareTests : IDisposable
{
    private readonly TempDir _dir = new();
    private const string Account = "1234567";
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "SteamInput", name));
    private string Config(string rel, string text) => _dir.Write(Path.Combine("steamapps", "common", "Steam Controller Configs", Account, "config", rel), text);
    private string Template(string name, string text) => _dir.Write(Path.Combine("controller_base", "templates", name), text);
    private SteamInputLocator Locator() => new(() => _dir.Path);

    public void Dispose() => _dir.Dispose();

    /// <summary>The WASD template with Jump moved to Left Shift, E replaced and a progenitor line pointing at the template.</summary>
    /// Steam writes backslashes doubled in KeyValues text, as it does for every path.
    private static string Edited(string progenitor) => Fixture("template_wasd.vdf")
        .Replace("\"title\" \"#Title\"", $"\"title\" \"My layout\"\n\t\"progenitor\" \"{progenitor.Replace("\\", "\\\\")}\"")
        .Replace("key_press SPACE, Jump", "key_press LEFT_SHIFT, Jump")
        .Replace("\"binding\"\t\t\"key_press E\"", "\"binding\"\t\t\"key_press Q\"");

    [Theory]
    [InlineData("templates\\controller_xboxone_wasd.vdf", "template", "controller_xboxone_wasd.vdf")]
    [InlineData("templates/gamepad_fps.vdf", "template", "gamepad_fps.vdf")]
    [InlineData("controller_base\\templates\\x+y.vdf", "template", "x+y.vdf")]
    [InlineData("2009540442", "workshop", "2009540442")]
    public void Progenitor_is_a_template_name_or_a_workshop_id(string raw, string kind, string value) =>
        Assert.Equal((kind, value), SteamInputCompare.Progenitor(raw));

    [Theory]
    [InlineData("")]
    [InlineData("templates\\..\\..\\evil.vdf")]
    [InlineData("C:\\evil.vdf")]
    [InlineData("\\\\server\\share\\x.vdf")]
    [InlineData("templates\\sub\\x.vdf")]
    [InlineData("x.txt")]
    public void Unsafe_or_unknown_progenitors_are_ignored(string raw) => Assert.Null(SteamInputCompare.Progenitor(raw));

    [Fact]
    public void Identical_layouts_are_the_same()
    {
        var a = SteamInputLayout.Parse(Fixture("template_wasd.vdf"), "template");
        var r = SteamInputCompare.Compare(a, a, "title", "Keyboard (WASD) and Mouse");
        Assert.Equal("same", r.Status);
        Assert.Empty(r.Differences);
        Assert.True(r.Unchanged > 10);
    }

    [Fact]
    public void Changed_added_and_removed_bindings_are_listed_in_control_order()
    {
        var baseline = SteamInputLayout.Parse(Fixture("template_wasd.vdf"), "template");
        var yours = SteamInputLayout.Parse(Edited("templates\\controller_xboxone_wasd.vdf"), "personal");
        // Remove D-pad up from yours, and add a gyro binding that the template doesn't have.
        var set = yours.Sets[0];
        var controls = set.Controls.Where(c => c.Control != "dpadUp")
            .Append(new ControllerControlDto("gyro", "Gyro mouse", [new ControllerBindingDto("analog", null, "Fine aim", null, "mouse")], false)).ToList();
        yours = yours with { Sets = [set with { Controls = controls }] };

        var r = SteamInputCompare.Compare(yours, baseline, "progenitor", baseline.Title);
        Assert.Equal("ok", r.Status);
        var a = Assert.Single(r.Differences, d => d.Control == "a");
        Assert.Equal("changed", a.Change);
        Assert.Equal(["Jump (Space)"], a.Before);
        Assert.Equal(["Jump (Left Shift)"], a.After);
        Assert.Equal("changed", Assert.Single(r.Differences, d => d.Control == "b").Change);
        Assert.Equal("removed", Assert.Single(r.Differences, d => d.Control == "dpadUp").Change);
        var gyro = Assert.Single(r.Differences, d => d.Control == "gyro");
        Assert.Equal(("added", "Gyro mouse"), (gyro.Change, gyro.ModeAfter));
        Assert.Equal(["a", "b", "dpadUp", "gyro"], r.Differences.Select(d => d.Control));
        Assert.Empty(r.OnlyInYours);
    }

    [Fact]
    public void Binding_lines_read_like_the_controls_table()
    {
        Assert.Equal("Hold: Left Ctrl", SteamInputCompare.Line(new("long", null, "Left Ctrl", null, "key")));
        Assert.Equal("↑ Move Forward (W)", SteamInputCompare.Line(new("press", "up", "Move Forward", "W", "key")));
        Assert.Equal("Click Double press: Melee", SteamInputCompare.Line(new("double", "click", "Melee", null, "action")));
    }

    [Fact]
    public void Locator_compares_a_personal_layout_with_the_template_it_came_from()
    {
        Template("controller_xboxone_wasd.vdf", Fixture("template_wasd.vdf"));
        Config("configset_controller_xboxone.vdf", "\"controller_config\" { \"440\" { \"autosave\" \"1\" } }");
        Config(Path.Combine("440", "controller_xboxone.vdf"), Edited("templates\\controller_xboxone_wasd.vdf"));

        var r = Locator().Compare("440");
        Assert.Equal(("ok", "progenitor", "Keyboard (WASD) and Mouse"), (r.Status, r.Basis, r.DefaultName));
        Assert.Equal(2, r.Differences.Count);
        Assert.Equal("My layout", r.Yours!.Title);
    }

    [Fact]
    public void Without_a_progenitor_the_controller_default_is_used()
    {
        Template("controller_xboxone_gamepad_joystick.vdf", Fixture("template_wasd.vdf").Replace("Keyboard (WASD) and Mouse", "Gamepad"));
        Config(Path.Combine("620", "controller_xboxone.vdf"), Edited("").Replace("\"progenitor\" \"\"", ""));
        var r = Locator().Compare("620");
        Assert.Equal(("ok", "controllerDefault", "Gamepad"), (r.Status, r.Basis, r.DefaultName));
    }

    [Fact]
    public void Template_users_and_missing_templates()
    {
        Template("controller_xboxone_wasd.vdf", Fixture("template_wasd.vdf"));
        Config("configset_controller_xboxone.vdf", "\"controller_config\" { \"440\" { \"template\" \"controller_xboxone_wasd.vdf\" } }");
        var same = Locator().Compare("440");
        Assert.Equal(("same", "self"), (same.Status, same.Basis));

        Config(Path.Combine("730", "controller_xboxone.vdf"), Edited("templates\\missing.vdf"));
        File.Delete(Path.Combine(_dir.Path, "controller_base", "templates", "controller_xboxone_wasd.vdf"));
        Assert.Equal("noDefault", Locator().Compare("730").Status);

        Assert.Equal("notSteamInput", Locator().Compare("999").Status);
        Assert.Equal("notSteamInput", Locator().Compare("../1").Status);
    }

    [Fact]
    public void A_progenitor_that_tries_to_leave_the_templates_folder_is_not_read()
    {
        _dir.Write("evil.vdf", Fixture("template_wasd.vdf"));
        Config(Path.Combine("440", "controller_xboxone.vdf"), Edited("templates\\..\\..\\evil.vdf"));
        var r = Locator().Compare("440");
        Assert.NotEqual("progenitor", r.Basis);
    }
}
