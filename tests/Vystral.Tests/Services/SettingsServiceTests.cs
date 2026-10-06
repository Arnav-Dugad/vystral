using System.Text.Json.Nodes;
using Vystral.Tests.Support;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Services;

public sealed class SettingsServiceTests : IDisposable
{
    private readonly TestDb _t = new();
    private readonly SettingsService _s;

    public SettingsServiceTests() => _s = new SettingsService(_t.Repo);

    public void Dispose() => _t.Dispose();

    private static JsonNode J(string json) => JsonNode.Parse(json)!;

    [Fact]
    public void GetAll_contains_every_default()
    {
        var all = _s.GetAll();
        Assert.Equal("obsidian", all["appearance.theme"]!.GetValue<string>());
        Assert.Equal("auto", all["appearance.accent"]!.GetValue<string>());
        Assert.True(all["appearance.livingCanvas"]!.GetValue<bool>());
        Assert.Equal(0.7, all["appearance.canvasIntensity"]!.GetValue<double>());
        Assert.Equal(180, all["appearance.gridSize"]!.GetValue<double>());
        Assert.Equal("qwen3:4b", all["ai.model"]!.GetValue<string>());
        Assert.False(all["ai.enabled"]!.GetValue<bool>());
        Assert.False(all["onboarding.completed"]!.GetValue<bool>());
        Assert.False(all["moments.enabled"]!.GetValue<bool>());
        Assert.False(all["privacy.localOnly"]!.GetValue<bool>());
        Assert.IsType<JsonObject>(all["library.platformsEnabled"]);
        Assert.Empty(all["library.platformsEnabled"]!.AsObject());
        Assert.True(all["notifications.achievements"]!.GetValue<bool>());
        Assert.True(all["performance.backgroundApps"]!.GetValue<bool>());
        Assert.True(all["canvas.followTrailer"]!.GetValue<bool>());
        Assert.True(all["home.liveTiles"]!.GetValue<bool>());
        Assert.False(all["sound.ambient"]!.GetValue<bool>());
        Assert.Equal(0.35, all["sound.ambientVolume"]!.GetValue<double>());
        Assert.True(all["dataSources.cheapshark"]!.GetValue<bool>());
        Assert.Equal("US", all["dataSources.priceCountry"]!.GetValue<string>());
        Assert.Equal(59, all.Count); // 28 original + Track A/C (5) + Track B (10) + Track F (2) + Track E (1) + Track K (3) + Track I (7) + Track H (1) + Track M (2)
    }

    [Fact]
    public void GetAll_returns_a_copy()
    {
        var all = _s.GetAll();
        all["library.platformsEnabled"]!.AsObject()["steam"] = false;
        all["appearance.theme"] = "light";
        Assert.True(_s.IsPlatformEnabled("steam"));
        Assert.Equal("obsidian", _s.GetString("appearance.theme"));
    }

    [Theory]
    [InlineData("nope")]
    [InlineData("library.lastScan")]
    [InlineData("APPEARANCE.THEME")]
    [InlineData("")]
    public void Unknown_key_is_rejected(string key)
    {
        Assert.Equal($"Unknown setting '{key}'.", _s.Set(key, J("true")));
        Assert.DoesNotContain(key, _t.Repo.GetSettings().Keys);
    }

    [Theory]
    [InlineData("appearance.livingCanvas", "\"true\"")]
    [InlineData("appearance.livingCanvas", "1")]
    [InlineData("appearance.livingCanvas", "{}")]
    [InlineData("appearance.theme", "true")]
    [InlineData("appearance.theme", "[\"oled\"]")]
    [InlineData("appearance.gridSize", "\"200\"")]
    [InlineData("ai.model", "42")]
    [InlineData("library.platformsEnabled", "true")]
    [InlineData("library.platformsEnabled", "[]")]
    public void Wrong_type_is_rejected(string key, string json)
    {
        var before = _s.GetAll()[key]!.ToJsonString();
        Assert.Equal($"Invalid value for '{key}'.", _s.Set(key, J(json)));
        Assert.Equal(before, _s.GetAll()[key]!.ToJsonString());
    }

    [Fact]
    public void Null_value_is_rejected()
    {
        Assert.NotNull(_s.Set("appearance.livingCanvas", null));
        Assert.NotNull(_s.Set("ai.model", null));
    }

    [Theory]
    [InlineData("appearance.theme", "oled", true)]
    [InlineData("appearance.theme", "contrast", true)]
    [InlineData("appearance.theme", "neon", false)]
    [InlineData("appearance.theme", "OLED", false)]
    [InlineData("appearance.theme", "", false)]
    [InlineData("appearance.accent", "rose", true)]
    [InlineData("appearance.accent", "system", true)]
    [InlineData("appearance.accent", "pink", false)]
    [InlineData("appearance.quality", "low", true)]
    [InlineData("motion.reduce", "on", true)]
    [InlineData("motion.reduce", "maybe", false)]
    public void Enum_values_are_validated(string key, string value, bool ok)
    {
        var result = _s.Set(key, JsonValue.Create(value));
        Assert.Equal(ok, result is null);
        Assert.Equal(ok ? value : _s.GetAll()[key]!.GetValue<string>(), _s.GetString(key));
    }

    [Theory]
    [InlineData("appearance.gridSize", "120", true)]
    [InlineData("appearance.gridSize", "280", true)]
    [InlineData("appearance.gridSize", "200.5", true)]
    [InlineData("appearance.gridSize", "119.9", false)]
    [InlineData("appearance.gridSize", "281", false)]
    [InlineData("appearance.gridSize", "-1", false)]
    [InlineData("appearance.canvasIntensity", "0", true)]
    [InlineData("appearance.canvasIntensity", "1", true)]
    [InlineData("appearance.canvasIntensity", "1.01", false)]
    [InlineData("sounds.volume", "0.25", true)]
    [InlineData("sounds.volume", "-0.1", false)]
    [InlineData("sounds.volume", "1e308", false)]
    public void Number_ranges_are_validated(string key, string json, bool ok)
    {
        Assert.Equal(ok, _s.Set(key, J(json)) is null);
        if (ok) Assert.Equal(double.Parse(json, System.Globalization.CultureInfo.InvariantCulture), _s.GetNumber(key));
    }

    [Theory]
    [InlineData("qwen3:4b")]
    [InlineData("llama3.2:3b-instruct-q4_K_M")]
    [InlineData("hf.co/user/model:latest")]
    [InlineData("mistral")]
    public void Valid_model_names_are_accepted(string model)
    {
        Assert.Null(_s.Set("ai.model", JsonValue.Create(model)));
        Assert.Equal(model, _s.GetString("ai.model"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("bad model")]
    [InlineData("model;rm -rf /")]
    [InlineData("model$(calc)")]
    [InlineData("qwen3:4b\n")]
    [InlineData("ünïcode")]
    public void Invalid_model_names_are_rejected(string model)
    {
        Assert.NotNull(_s.Set("ai.model", JsonValue.Create(model)));
        Assert.Equal("qwen3:4b", _s.GetString("ai.model"));
    }

    [Fact]
    public void Model_name_length_is_limited()
    {
        Assert.Null(_s.Set("ai.model", JsonValue.Create(new string('a', 80))));
        Assert.NotNull(_s.Set("ai.model", JsonValue.Create(new string('a', 81))));
    }

    [Fact]
    public void Platform_map_is_validated()
    {
        Assert.Null(_s.Set("library.platformsEnabled", J("""{"steam":false,"epic":true}""")));
        Assert.NotNull(_s.Set("library.platformsEnabled", J("""{"steam":"no"}""")));
        Assert.NotNull(_s.Set("library.platformsEnabled", J("""{"steam":{"nested":true}}""")));
        Assert.NotNull(_s.Set("library.platformsEnabled", J($$"""{"{{new string('k', 17)}}":true}""")));
        var tooMany = new JsonObject();
        for (var i = 0; i < 17; i++) tooMany[$"p{i}"] = true;
        Assert.NotNull(_s.Set("library.platformsEnabled", tooMany));
    }

    [Fact]
    public void Values_persist_across_instances()
    {
        Assert.Null(_s.Set("appearance.theme", JsonValue.Create("light")));
        Assert.Null(_s.Set("appearance.gridSize", J("220")));
        Assert.Null(_s.Set("ai.enabled", JsonValue.Create(true)));

        var fresh = new SettingsService(_t.Repo);
        Assert.Equal("light", fresh.GetString("appearance.theme"));
        Assert.Equal(220, fresh.GetNumber("appearance.gridSize"));
        Assert.True(fresh.GetBool("ai.enabled"));
        Assert.Equal("\"light\"", _t.Repo.GetSettings()["appearance.theme"]);
    }

    [Fact]
    public void Corrupt_or_invalid_stored_values_fall_back_to_defaults()
    {
        _t.Repo.SetSetting("appearance.theme", "\"neon\"");
        _t.Repo.SetSetting("appearance.gridSize", "{broken");
        _t.Repo.SetSetting("ai.model", "\"bad model\"");
        _t.Repo.SetSetting("unknown.key", "true");

        var fresh = new SettingsService(_t.Repo);
        Assert.Equal("obsidian", fresh.GetString("appearance.theme"));
        Assert.Equal(180, fresh.GetNumber("appearance.gridSize"));
        Assert.Equal("qwen3:4b", fresh.GetString("ai.model"));
        Assert.False(fresh.GetAll().ContainsKey("unknown.key"));
    }

    [Fact]
    public void Reload_picks_up_external_changes()
    {
        _t.Repo.SetSetting("startup.intro", "false");
        Assert.True(_s.GetBool("startup.intro"));
        _s.Reload();
        Assert.False(_s.GetBool("startup.intro"));
    }

    [Fact]
    public void Changed_event_fires_for_successful_sets_only()
    {
        var changes = new List<string>();
        _s.Changed += changes.Add;
        _s.Set("sounds.enabled", JsonValue.Create(true));
        _s.Set("sounds.enabled", JsonValue.Create("yes"));
        _s.Set("nope", JsonValue.Create(true));
        Assert.Equal(["sounds.enabled"], changes);
    }

    [Fact]
    public void ResetAll_restores_defaults_but_keeps_onboarding_completed()
    {
        _s.Set("appearance.theme", JsonValue.Create("oled"));
        _s.Set("ai.enabled", JsonValue.Create(true));
        _s.Set("onboarding.completed", JsonValue.Create(true));
        _s.Set("library.platformsEnabled", J("""{"steam":false}"""));
        var changes = new List<string>();
        _s.Changed += changes.Add;

        _s.ResetAll();

        Assert.Equal("obsidian", _s.GetString("appearance.theme"));
        Assert.False(_s.GetBool("ai.enabled"));
        Assert.True(_s.IsPlatformEnabled("steam"));
        Assert.True(_s.GetBool("onboarding.completed"));
        Assert.Equal(["*"], changes);

        var fresh = new SettingsService(_t.Repo);
        Assert.Equal("obsidian", fresh.GetString("appearance.theme"));
        Assert.True(fresh.GetBool("onboarding.completed"));
    }

    [Fact]
    public void Typed_getters_return_neutral_values_for_unknown_keys_or_wrong_types()
    {
        Assert.False(_s.GetBool("nope"));
        Assert.Equal("", _s.GetString("nope"));
        Assert.Equal(0, _s.GetNumber("nope"));
        Assert.False(_s.GetBool("appearance.theme"));
        Assert.Equal("", _s.GetString("appearance.livingCanvas"));
    }

    [Fact]
    public void IsPlatformEnabled_defaults_to_true_and_respects_explicit_false()
    {
        Assert.True(_s.IsPlatformEnabled("steam"));
        Assert.True(_s.IsPlatformEnabled("epic"));

        Assert.Null(_s.Set("library.platformsEnabled", J("""{"steam":false,"gog":true}""")));

        Assert.False(_s.IsPlatformEnabled("steam"));
        Assert.True(_s.IsPlatformEnabled("gog"));
        Assert.True(_s.IsPlatformEnabled("epic"));
        Assert.False(new SettingsService(_t.Repo).IsPlatformEnabled("steam"));
    }
}
