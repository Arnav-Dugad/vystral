using System.Text.Json;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Insights;

public sealed class HotkeyAndNotificationTests
{
    [Theory]
    [InlineData("Ctrl+Alt+V", "Ctrl+Alt+V", HotkeyModifiers.Ctrl | HotkeyModifiers.Alt, 0x56u)]
    [InlineData("alt+ctrl+v", "Ctrl+Alt+V", HotkeyModifiers.Ctrl | HotkeyModifiers.Alt, 0x56u)]
    [InlineData("Win+Shift+G", "Shift+Win+G", HotkeyModifiers.Shift | HotkeyModifiers.Win, 0x47u)]
    [InlineData("Ctrl+F12", "Ctrl+F12", HotkeyModifiers.Ctrl, 0x7Bu)]
    [InlineData("Alt+1", "Alt+1", HotkeyModifiers.Alt, 0x31u)]
    [InlineData(" Control + Alt + F1 ", "Ctrl+Alt+F1", HotkeyModifiers.Ctrl | HotkeyModifiers.Alt, 0x70u)]
    public void Valid_shortcuts_parse_to_canonical_form(string text, string canonical, HotkeyModifiers mods, uint vk)
    {
        Assert.True(Hotkey.TryParse(text, out var hk, out var error), error);
        Assert.Equal(canonical, hk!.ToString());
        Assert.Equal(mods, hk.Modifiers);
        Assert.Equal(vk, hk.VirtualKey);
    }

    [Theory]
    [InlineData("")]
    [InlineData("V")]                 // no modifier
    [InlineData("Shift+V")]           // Shift alone would steal typing
    [InlineData("Ctrl+Alt")]          // no key
    [InlineData("Ctrl+V+B")]          // two keys
    [InlineData("Ctrl+Ctrl+V")]
    [InlineData("Ctrl+Alt+Esc")]
    [InlineData("Ctrl+F25")]
    [InlineData("Ctrl+F0")]
    [InlineData("Ctrl+F01")]
    [InlineData("Ctrl+é")]
    public void Invalid_shortcuts_are_rejected_with_a_reason(string text)
    {
        Assert.False(Hotkey.TryParse(text, out var hk, out var error));
        Assert.Null(hk);
        Assert.False(string.IsNullOrWhiteSpace(error));
    }

    [Fact]
    public void Default_shortcut_is_valid_and_matches_the_settings_pattern()
    {
        Assert.True(Hotkey.TryParse(Hotkey.Default, out _, out _));
        Assert.Matches(Hotkey.Pattern, Hotkey.Default);
    }

    // ---------------- notification policy ----------------

    private static readonly string GameId = new('a', 32);
    private static readonly string SessionId = new('b', 32);

    private static NotificationPolicy Policy(Dictionary<string, bool>? overrides = null)
    {
        var settings = new Dictionary<string, bool>
        {
            [NotificationPolicy.Enabled] = true, [NotificationPolicy.Sessions] = true, [NotificationPolicy.Updates] = true,
            [NotificationPolicy.Installs] = true, [NotificationPolicy.Thermal] = true, [NotificationPolicy.OnlyInBackground] = true,
        };
        foreach (var (k, v) in overrides ?? []) settings[k] = v;
        return new NotificationPolicy(k => settings.GetValueOrDefault(k), id => id == GameId ? "Nebula Drift" : null);
    }

    private static JsonElement J(object o) => JsonSerializer.SerializeToElement(o, new JsonSerializerOptions(JsonSerializerDefaults.Web));

    private static JsonElement Ended(int seconds, int? throttled = null) => J(new
    {
        ticket = "t", gameId = GameId, phase = "ended", sessionId = SessionId, durationSeconds = seconds,
        perfSummary = throttled is null ? null : JsonSerializer.Serialize(new { throttledSeconds = throttled }),
    });

    [Fact]
    public void Session_end_notifies_once_with_playtime()
    {
        var p = Policy();
        var n = Assert.Single(p.Evaluate("launch.state", Ended(6120), foreground: false));
        Assert.Equal("Played Nebula Drift · 1h 42m", n.Title);
        Assert.Equal("""{"name":"journal"}""", n.RouteJson);
        Assert.Empty(p.Evaluate("launch.state", Ended(6120), foreground: false));
    }

    [Fact]
    public void Foreground_and_disabled_categories_are_respected()
    {
        Assert.Empty(Policy().Evaluate("launch.state", Ended(600), foreground: true));
        Assert.Single(Policy(new() { [NotificationPolicy.OnlyInBackground] = false }).Evaluate("launch.state", Ended(600), foreground: true));
        Assert.Empty(Policy(new() { [NotificationPolicy.Sessions] = false }).Evaluate("launch.state", Ended(600), foreground: false));
        Assert.Empty(Policy(new() { [NotificationPolicy.Enabled] = false }).Evaluate("launch.state", Ended(600), foreground: false));
        Assert.Empty(Policy().Evaluate("library.changed", J(new { reason = "x" }), foreground: false));
        Assert.Empty(Policy().Evaluate("launch.state", J(new { phase = "running", sessionId = SessionId }), foreground: false));
    }

    [Fact]
    public void Long_thermal_throttling_adds_a_performance_notification()
    {
        var list = Policy().Evaluate("launch.state", Ended(3600, throttled: 252), foreground: false);
        Assert.Equal(2, list.Count);
        Assert.Equal("thermal", list[1].Category);
        Assert.Contains("4m 12s", list[1].Body);
        Assert.Equal($$"""{"name":"performance","sessionId":"{{SessionId}}"}""", list[1].RouteJson);
        Assert.Single(Policy().Evaluate("launch.state", Ended(3600, throttled: 20), foreground: false));
    }

    [Fact]
    public void Update_ready_and_install_finished()
    {
        var p = Policy();
        var u = Assert.Single(p.Evaluate("update.state", J(new { phase = "ready", newVersion = "0.2.0" }), false));
        Assert.Equal("VYSTRAL 0.2.0 is ready", u.Title);
        Assert.Empty(p.Evaluate("update.state", J(new { phase = "ready", newVersion = "0.2.0" }), false));
        Assert.Empty(p.Evaluate("update.state", J(new { phase = "downloading", newVersion = "0.3.0" }), false));

        var i = Assert.Single(p.Evaluate("install.progress", J(new { gameId = GameId, appId = "10", kind = "install", phase = "installed" }), false));
        Assert.Equal("Nebula Drift is installed", i.Title);
        Assert.Equal($$"""{"name":"game","id":"{{GameId}}"}""", i.RouteJson);
        Assert.Empty(p.Evaluate("install.progress", J(new { gameId = GameId, appId = "10", kind = "update", phase = "installed" }), false));
        Assert.Empty(p.Evaluate("install.progress", J(new { gameId = GameId, appId = "11", kind = "install", phase = "downloading" }), false));
    }

    [Theory]
    [InlineData(30, "under a minute")]
    [InlineData(1500, "25m")]
    [InlineData(6120, "1h 42m")]
    public void Playtime_formats(int seconds, string expected) => Assert.Equal(expected, NotificationPolicy.FormatPlaytime(seconds));
}
