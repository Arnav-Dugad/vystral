using System.Globalization;
using System.Text.Json.Nodes;
using Vystral.Core.Contracts;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Services;

public sealed class OllamaServiceTests
{
    private static JsonObject? Validate(string json) => OllamaService.ValidateQuery(JsonNode.Parse(json) as JsonObject);

    // ---------- ValidateQuery ----------

    [Theory]
    [InlineData("filter")]
    [InlineData("launch")]
    [InlineData("recommend")]
    public void Known_intents_are_accepted(string intent)
    {
        var r = Validate($$"""{"intent":"{{intent}}"}""")!;
        Assert.Equal(intent, r["intent"]!.GetValue<string>());
        Assert.Single(r);
    }

    [Theory]
    [InlineData("""{"intent":"delete"}""")]
    [InlineData("""{"intent":"FILTER"}""")]
    [InlineData("""{"intent":""}""")]
    [InlineData("""{"intent":null}""")]
    [InlineData("""{"title":"Hades"}""")]
    [InlineData("""{}""")]
    public void Unknown_or_missing_intent_is_rejected(string json) => Assert.Null(Validate(json));

    [Theory]
    [InlineData("""{"intent":5}""")]
    [InlineData("""{"intent":true}""")]
    [InlineData("""{"intent":["filter"]}""")]
    [InlineData("""{"intent":{"value":"filter"}}""")]
    public void Wrongly_typed_intent_is_rejected_without_throwing(string json) => Assert.Null(Validate(json));

    [Fact]
    public void Null_object_is_rejected() => Assert.Null(OllamaService.ValidateQuery(null));

    [Fact]
    public void Full_valid_query_round_trips()
    {
        var r = Validate("""
            {"intent":"filter","title":"Hades","installed":true,"favorite":false,
             "platforms":["steam","epic"],"genres":["Action","Roguelike"],
             "maxSizeGb":50,"minSizeGb":0.5,"notPlayedDays":30,"playedWithinDays":7,"drive":"d"}
            """)!;

        Assert.Equal("filter", r["intent"]!.GetValue<string>());
        Assert.Equal("Hades", r["title"]!.GetValue<string>());
        Assert.True(r["installed"]!.GetValue<bool>());
        Assert.False(r["favorite"]!.GetValue<bool>());
        Assert.Equal(["steam", "epic"], r["platforms"]!.AsArray().Select(p => p!.GetValue<string>()).ToArray());
        Assert.Equal(["Action", "Roguelike"], r["genres"]!.AsArray().Select(p => p!.GetValue<string>()).ToArray());
        Assert.Equal(50, r["maxSizeGb"]!.GetValue<double>());
        Assert.Equal(0.5, r["minSizeGb"]!.GetValue<double>());
        Assert.Equal(30, r["notPlayedDays"]!.GetValue<double>());
        Assert.Equal(7, r["playedWithinDays"]!.GetValue<double>());
        Assert.Equal("D:", r["drive"]!.GetValue<string>());
    }

    [Fact]
    public void Unknown_fields_are_dropped()
    {
        var r = Validate("""{"intent":"launch","command":"format c:","exec":true,"__proto__":{}}""")!;
        Assert.Equal(["intent"], r.Select(p => p.Key).ToArray());
    }

    [Fact]
    public void Bad_platforms_are_filtered_out()
    {
        var r = Validate("""{"intent":"filter","platforms":["steam","psn","EPIC","",null,5,"battlenet","manual","../x"]}""")!;
        Assert.Equal(["steam", "battlenet", "manual"], r["platforms"]!.AsArray().Select(p => p!.GetValue<string>()).ToArray());
    }

    [Fact]
    public void Platforms_that_is_not_an_array_is_dropped()
    {
        Assert.False(Validate("""{"intent":"filter","platforms":"steam"}""")!.ContainsKey("platforms"));
    }

    [Fact]
    public void Genres_are_limited_in_count_and_length()
    {
        var r = Validate($$"""{"intent":"filter","genres":["", "{{new string('g', 41)}}", "A", 7, "B", "C", "D", "E", "F"]}""")!;
        Assert.Equal(["A", "B", "C", "D", "E"], r["genres"]!.AsArray().Select(p => p!.GetValue<string>()).ToArray());
    }

    [Theory]
    [InlineData("0", true)]
    [InlineData("100000", true)]
    [InlineData("12.5", true)]
    [InlineData("-1", false)]
    [InlineData("100000.1", false)]
    [InlineData("1e9", false)]
    [InlineData("\"50\"", false)]
    [InlineData("true", false)]
    [InlineData("null", false)]
    public void Numbers_must_be_in_range(string value, bool kept)
    {
        foreach (var key in new[] { "maxSizeGb", "minSizeGb", "notPlayedDays", "playedWithinDays" })
        {
            var r = Validate($$"""{"intent":"filter","{{key}}":{{value}}}""")!;
            Assert.Equal(kept, r.ContainsKey(key));
            if (kept) Assert.Equal(double.Parse(value, CultureInfo.InvariantCulture), r[key]!.GetValue<double>());
        }
    }

    [Theory]
    [InlineData("d", "D:")]
    [InlineData("D", "D:")]
    [InlineData("e:", "E:")]
    [InlineData("Z:", "Z:")]
    public void Drive_letters_are_normalized(string input, string expected) =>
        Assert.Equal(expected, Validate($$"""{"intent":"filter","drive":"{{input}}"}""")!["drive"]!.GetValue<string>());

    [Theory]
    [InlineData("C:\\\\")]
    [InlineData("CD")]
    [InlineData("1")]
    [InlineData("")]
    [InlineData("C:\\\\Windows")]
    [InlineData("d\\n")]
    public void Invalid_drives_are_dropped(string input) =>
        Assert.False(Validate($$"""{"intent":"filter","drive":"{{input}}"}""")!.ContainsKey("drive"));

    [Fact]
    public void Title_is_kept_only_when_a_short_string()
    {
        Assert.Equal(new string('t', 120), Validate($$"""{"intent":"filter","title":"{{new string('t', 120)}}"}""")!["title"]!.GetValue<string>());
        Assert.False(Validate($$"""{"intent":"filter","title":"{{new string('t', 121)}}"}""")!.ContainsKey("title"));
        Assert.False(Validate("""{"intent":"filter","title":42}""")!.ContainsKey("title"));
    }

    [Fact]
    public void Booleans_must_be_booleans()
    {
        var r = Validate("""{"intent":"filter","installed":"yes","favorite":1}""")!;
        Assert.False(r.ContainsKey("installed"));
        Assert.False(r.ContainsKey("favorite"));
    }

    // ---------- IsValidModelName ----------

    [Theory]
    [InlineData("qwen3:4b")]
    [InlineData("llama3.2")]
    [InlineData("library/llama3:latest")]
    [InlineData("hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M")]
    [InlineData("a")]
    public void Valid_model_names(string name) => Assert.True(OllamaService.IsValidModelName(name));

    [Theory]
    [InlineData("")]
    [InlineData(":4b")]
    [InlineData("-rm")]
    [InlineData(".hidden")]
    [InlineData("/abs/path")]
    [InlineData("a b")]
    [InlineData("a:b:c")]
    [InlineData("a:")]
    [InlineData("model;calc")]
    [InlineData("model\n")]
    [InlineData("mödel")]
    [InlineData("qwen3:4b/../../x")]
    public void Invalid_model_names(string name) => Assert.False(OllamaService.IsValidModelName(name));

    [Fact]
    public void Model_name_length_limit()
    {
        Assert.True(OllamaService.IsValidModelName(new string('a', 80)));
        Assert.False(OllamaService.IsValidModelName(new string('a', 81)));
    }

    // ---------- BuildLibraryContext ----------

    private static InstallationDto Inst(string platform, string state = "installed", string? lastPlayed = null, int? playtime = null) =>
        new("i" + platform, platform, "p", "T", state, null, null, null, false, "Uri", lastPlayed, playtime, null, false, "2025-01-01");

    private static GameDto Game(string title, IReadOnlyList<InstallationDto> installs, IReadOnlyList<string>? genres = null,
        bool hidden = false, long trackedSeconds = 0, string? lastTracked = null) =>
        new(title.ToLowerInvariant(), title, title.ToLowerInvariant(), null, null, null, null, genres ?? [], false, hidden, null, null,
            null, null, null, new ArtworkDto(null, null, null, null, null), installs, [], trackedSeconds, 0, lastTracked, "2025-01-01");

    private static LibrarySnapshotDto Snap(params GameDto[] games) => new(games, [], [], null);

    private static string[] Lines(string context) => context.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.TrimEnd('\r')).ToArray();

    [Fact]
    public void Context_has_header_and_one_line_per_visible_game()
    {
        var ctx = OllamaService.BuildLibraryContext(Snap(
            Game("Hades", [Inst("steam", lastPlayed: "2025-06-01T10:00:00Z", playtime: 90), Inst("epic")], ["Action", "Indie"], trackedSeconds: 5400),
            Game("Secret", [Inst("steam")], hidden: true)));

        var lines = Lines(ctx);
        Assert.Equal("title | platforms | installed | genres | tracked_hours | store_hours | last_played", lines[0]);
        Assert.Equal(2, lines.Length);
        Assert.DoesNotContain("Secret", ctx);
        var h = 1.5.ToString("0.#");
        Assert.Equal($"Hades | steam+epic | yes | Action, Indie | {h} | {h} | 2025-06-01", lines[1]);
    }

    [Fact]
    public void Context_says_unknown_for_missing_data()
    {
        var ctx = OllamaService.BuildLibraryContext(Snap(Game("Mystery", [Inst("gog", state: "missing")])));
        Assert.Equal("Mystery | gog | no | unknown | 0 | unknown | never/unknown", Lines(ctx)[1]);
    }

    [Fact]
    public void Context_handles_games_without_installations()
    {
        var ctx = OllamaService.BuildLibraryContext(Snap(Game("Orphan", [])));
        Assert.Equal("Orphan |  | no | unknown | 0 | unknown | never/unknown", Lines(ctx)[1]);
    }

    [Fact]
    public void Context_uses_latest_of_tracked_and_imported_play_and_orders_by_recency()
    {
        var ctx = OllamaService.BuildLibraryContext(Snap(
            Game("Old", [Inst("steam", lastPlayed: "2020-01-01T00:00:00Z")]),
            Game("Tracked", [Inst("steam", lastPlayed: "2021-01-01T00:00:00Z")], lastTracked: "2025-03-03T00:00:00Z"),
            Game("Middle", [Inst("epic", lastPlayed: "2023-05-05T00:00:00Z")])));

        var lines = Lines(ctx);
        Assert.StartsWith("Tracked", lines[1]);
        Assert.EndsWith("2025-03-03", lines[1]);
        Assert.StartsWith("Middle", lines[2]);
        Assert.StartsWith("Old", lines[3]);
    }

    [Fact]
    public void Context_respects_maxGames()
    {
        var games = Enumerable.Range(0, 20).Select(i => Game($"Game{i:00}", [Inst("steam")])).ToArray();
        Assert.Equal(1 + 5, Lines(OllamaService.BuildLibraryContext(Snap(games), maxGames: 5)).Length);
        Assert.Single(Lines(OllamaService.BuildLibraryContext(Snap())));
    }
}
