using System.Text.Json.Nodes;
using Vystral.Core.Contracts;
using Vystral.Windows.Ai;
using Vystral.Windows.Ai.Assistant;
using Vystral.Windows.Recap;
using Xunit;
using static Vystral.Tests.Ai.AiTestData;

namespace Vystral.Tests.Ai;

/// <summary>A fictional host for the assistant's tools: a tiny library, sessions and canned read-method answers.</summary>
internal sealed class FakeAssistantHost : IAssistantHost
{
    public List<GameDto> Games { get; } = [];
    public List<SessionDto> SessionList { get; } = [];
    public Dictionary<string, JsonNode?> Reads { get; } = new(StringComparer.Ordinal);
    public List<string> ReadCalls { get; } = [];
    public JsonObject SettingsObject { get; set; } = [];
    public HashSet<string> FeaturesOff { get; } = [];

    public LibrarySnapshotDto Snapshot() => new(Games, [new CollectionDto("c1", "Cosy", null, 0, null, 1)], [], null);
    public IReadOnlyList<SessionDto> Sessions(string? gameId, int limit) =>
        SessionList.Where(s => gameId is null || s.GameId == gameId).OrderByDescending(s => s.Start, StringComparer.Ordinal).Take(limit).ToList();
    public DateTimeOffset Now { get; set; } = new(2026, 10, 10, 20, 0, 0, TimeSpan.Zero);
    public TimeZoneInfo Zone => TimeZoneInfo.Utc;

    public Task<JsonNode?> ReadAsync(string method, object? args, CancellationToken ct)
    {
        lock (ReadCalls) ReadCalls.Add(method);
        return Task.FromResult(Reads.TryGetValue(method, out var n) ? n?.DeepClone() : null);
    }

    public Task<JsonNode?> DiscoverSearchAsync(string query, CancellationToken ct) => Task.FromResult<JsonNode?>(JsonNode.Parse(
        """{"results":[{"key":"steam-620","title":"Portal 2","year":2011,"stores":["steam"],"priceText":"$9.99","kind":"game","libraryGameId":null}],"sources":[{"name":"IGDB","state":"skipped"}]}"""));

    public IReadOnlyList<TonightCandidate> Tonight(string mood, int minutes, bool includeSubs) =>
        Games.Where(g => !g.Hidden).Take(3).Select((g, i) => new TonightCandidate($"c{i + 1}", "library", g.Id, null, g.Title, g.Genres, true, 2, 45, null, null, null, false, null, 10 - i,
            ["Installed and ready"])).ToList();

    public IReadOnlyDictionary<string, TimeToBeatDto> TimeToBeat() => new Dictionary<string, TimeToBeatDto>();
    public JsonObject Settings() => SettingsObject;
    public bool FeatureEnabled(string feature) => !FeaturesOff.Contains(feature);
}

/// <summary>Track D3: the assistant's tool schemas, argument validation (including hostile input) and the confirmation rules.</summary>
public sealed class AssistantToolsTests
{
    private static ToolSpec T(string name) => AssistantTools.Find(name)!;

    private static ToolValidation V(string name, string json) => AssistantTools.Validate(T(name), AssistantWire.ParseArgsStrict(json));

    [Fact]
    public void Every_tool_has_a_closed_schema_a_label_and_says_what_it_sends()
    {
        Assert.True(AssistantTools.All.Count >= 25);
        Assert.Equal(AssistantTools.All.Count, AssistantTools.All.Select(t => t.Name).Distinct().Count());
        foreach (var t in AssistantTools.All)
        {
            Assert.Matches(@"^[a-z_]{3,40}$", t.Name);
            Assert.False(string.IsNullOrWhiteSpace(t.Label));
            Assert.False(string.IsNullOrWhiteSpace(t.Sends));
            Assert.True(t.Description.Length is > 20 and < 600, t.Name);
            var schema = AssistantTools.Schema(t.Params);
            Assert.Equal("object", schema["type"]!.GetValue<string>());
            Assert.False(schema["additionalProperties"]!.GetValue<bool>());
            var gemini = AssistantTools.Schema(t.Params, gemini: true);
            Assert.Equal("OBJECT", gemini["type"]!.GetValue<string>());
            Assert.Null(gemini["additionalProperties"]);
            Assert.DoesNotContain("\"object\"", gemini.ToJsonString());
        }
    }

    [Fact]
    public void Provider_declarations_have_each_providers_shape()
    {
        var claude = AssistantTools.ForClaude(AssistantTools.All, stream: true);
        Assert.All(claude.OfType<JsonObject>(), t =>
        {
            Assert.NotNull(t["input_schema"]);
            Assert.True(t["eager_input_streaming"]!.GetValue<bool>());
        });
        Assert.Null(AssistantTools.ForClaude(AssistantTools.All, stream: false)[0]!["eager_input_streaming"]);
        var openai = AssistantTools.ForOpenAi(AssistantTools.All);
        Assert.All(openai.OfType<JsonObject>(), t => Assert.Equal("function", t["type"]!.GetValue<string>()));
        var gemini = AssistantTools.ForGemini(AssistantTools.All);
        Assert.Single(gemini);
        Assert.Equal(AssistantTools.All.Count, gemini[0]!["functionDeclarations"]!.AsArray().Count);
        // Gemini rejects an empty OBJECT schema: tools without arguments leave "parameters" out.
        Assert.Null(gemini[0]!["functionDeclarations"]!.AsArray().First(d => d!["name"]!.GetValue<string>() == "get_subscriptions")!["parameters"]);
        Assert.Contains("search_library", AssistantTools.ForText(AssistantTools.All));
    }

    [Fact]
    public void Good_arguments_are_cleaned_and_typed()
    {
        var v = V("search_library", """{"genres":["RPG","RPG"," Indie "],"installed":true,"limit":5,"sort":"mostPlayed"}""");
        Assert.True(v.Ok, v.Error);
        Assert.Equal(["RPG", "Indie"], v.Args!["genres"]!.AsArray().Select(n => n!.GetValue<string>()));
        Assert.Equal(5L, v.Args["limit"]!.GetValue<long>());
        Assert.True(V("search_library", "{}").Ok);
        Assert.True(V("get_subscriptions", "").Ok);
        Assert.True(V("query_journal", """{"metric":"sessions","groupBy":"weekday","from":"2026-08-01","to":"2026-08-31"}""").Ok);
        Assert.True(V("create_smart_collection", """{"name":"Cosy","filter":{"genresAny":["Puzzle"],"installed":true}}""").Ok);
    }

    [Theory]
    [InlineData("search_library", """{"genres":"RPG"}""", "must be a list")]
    [InlineData("search_library", """{"limit":500}""", "between")]
    [InlineData("search_library", """{"limit":2.5}""", "whole number")]
    [InlineData("search_library", """{"installed":"yes"}""", "true or false")]
    [InlineData("search_library", """{"sort":"random()"}""", "one of")]
    [InlineData("search_library", """{"status":["backlog","DROP TABLE"]}""", "one of")]
    [InlineData("search_library", """{"text":"a\u0000b"}""", "aren't allowed")]
    [InlineData("search_library", """{"text":"evil‮exe"}""", "aren't allowed")]
    [InlineData("search_library", """{"__proto__":{"x":1}}""", "Unknown argument")]
    [InlineData("search_library", """{"genres":["a","b","c","d","e","f","g","h","i"]}""", "at most 8")]
    [InlineData("get_game", """{"gameId":"../../Windows/System32"}""", "valid id")]
    [InlineData("get_game", """{"gameId":"0000000000000000000000000000000G"}""", "valid id")]
    [InlineData("get_game", """{"gameId":123}""", "must be text")]
    [InlineData("game_facts", "{}", "required")]
    [InlineData("open_page", """{"page":"settings/../../secrets"}""", "one of")]
    [InlineData("open_page", """{"page":"assistant"}""", "one of")]
    [InlineData("set_status", """{"gameId":"0123456789abcdef0123456789abcdef","status":"deleted"}""", "one of")]
    [InlineData("query_journal", """{"from":"31/08/2026"}""", "date like")]
    [InlineData("watch_game", """{"key":"javascript:alert(1)","title":"x"}""", "key from search_store")]
    [InlineData("create_smart_collection", """{"name":"x","filter":{}}""", "at least one field")]
    [InlineData("create_smart_collection", """{"name":"x","filter":{"sql":"1=1"}}""", "Unknown argument")]
    [InlineData("create_smart_collection", """{"name":"x","filter":"genre = rpg"}""", "must be an object")]
    public void Hostile_or_malformed_arguments_are_rejected_with_a_reason(string tool, string json, string reason)
    {
        var v = V(tool, json);
        Assert.False(v.Ok);
        Assert.Contains(reason, v.Error!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Arguments_that_arent_a_json_object_or_are_huge_are_rejected()
    {
        Assert.Null(AssistantWire.ParseArgsStrict("[1,2,3]"));
        Assert.Null(AssistantWire.ParseArgsStrict("{\"text\": "));
        Assert.Null(AssistantWire.ParseArgsStrict("not json"));
        Assert.False(AssistantTools.Validate(T("search_library"), JsonValue.Create("text")).Ok);
        var big = new JsonObject { ["text"] = new string('a', 70) + new string('b', 20) };
        Assert.Contains("too long", AssistantTools.Validate(T("search_library"), big).Error);
        var deep = JsonNode.Parse("""{"name":"x","filter":{"genresAny":[["nested"]]}}""");
        Assert.False(AssistantTools.Validate(T("create_smart_collection"), deep).Ok);
        var huge = new JsonObject { ["name"] = "x", ["gameIds"] = new JsonArray(Enumerable.Range(0, 60).Select(i => (JsonNode)JsonValue.Create(i.ToString("x32"))!).ToArray()) };
        Assert.False(AssistantTools.Validate(T("create_collection"), huge).Ok);
    }

    [Fact]
    public void Actions_are_only_ever_proposed_and_nothing_can_launch_install_or_change_settings_or_keys()
    {
        string[] forbidden = ["launch", "install", "uninstall", "setting", "key", "privacy", "security", "delete", "remove", "connect", "token", "password"];
        foreach (var t in AssistantTools.All)
            foreach (var word in forbidden)
                Assert.False(t.Name.Contains(word, StringComparison.OrdinalIgnoreCase) && t.Kind == ToolKind.Action, $"{t.Name} looks like a forbidden action");
        string[] actions = ["open_page", "open_game", "create_collection", "create_smart_collection", "set_status", "set_favorite", "start_discover_search", "watch_game"];
        Assert.Equal(actions.Order(), AssistantTools.All.Where(t => t.Kind == ToolKind.Action).Select(t => t.Name).Order());
        Assert.All(AssistantTools.All.Where(t => t.Kind == ToolKind.Action), t => Assert.Contains("confirm", t.Description, StringComparison.OrdinalIgnoreCase));
        Assert.Equal("get_settings", AssistantTools.All.Single(t => t.Name.Contains("setting")).Name);
        Assert.Equal(ToolKind.Read, T("get_settings").Kind);

        // Read tools may only call read-only bridge methods.
        string[] writes = ["game.launch", "steam.install", "steam.uninstall", "settings.set", "settings.reset", "collections.create", "game.setFavorite",
            "game.setStatus", "discover.watch", "aiCloud.connect", "dataSources.connect", "steam.connect", "health.fix", "app.openExternal", "data.deleteHistory"];
        Assert.All(writes, m => Assert.DoesNotContain(m, AssistantToolRunner.ReadMethods));
        Assert.All(AssistantToolRunner.ReadMethods, m => Assert.DoesNotMatch(@"\.(set|launch|install|connect|fix|delete|create|watch|open|refresh)", m));
    }

    [Fact]
    public async Task The_runner_refuses_to_run_an_action_and_respects_feature_switches()
    {
        var host = new FakeAssistantHost();
        var runner = new AssistantToolRunner(host);
        var r = await runner.RunAsync(T("set_favorite"), new JsonObject { ["gameId"] = Id(1), ["favorite"] = true }, CancellationToken.None);
        Assert.True(r.IsError);
        host.FeaturesOff.Add("journal");
        var j = await runner.RunAsync(T("query_journal"), [], CancellationToken.None);
        Assert.True(j.IsError);
        Assert.Contains("turned off", j.Summary);
    }

    [Fact]
    public void Proposals_check_what_they_name_and_describe_the_exact_change()
    {
        var a = Game("Ashen Crown", ["RPG"]);
        var b = Game("Nebula Drift", ["Racing"]) with { Favorite = true };
        var snap = new LibrarySnapshotDto([a, b], [], [], null);
        var fav = AssistantActions.Propose(T("set_favorite"), new JsonObject { ["gameId"] = a.Id, ["favorite"] = true }, snap, "act-1");
        Assert.Equal("Add Ashen Crown to favorites", fav.Proposal!.Title);
        Assert.Equal("Ashen Crown", fav.Proposal.Args["title"]!.GetValue<string>());
        var already = AssistantActions.Propose(T("set_favorite"), new JsonObject { ["gameId"] = b.Id, ["favorite"] = true }, snap, "act-2");
        Assert.Null(already.Proposal);
        Assert.Contains("already", already.Error);
        var missing = AssistantActions.Propose(T("open_game"), new JsonObject { ["gameId"] = Id(999) }, snap, "act-3");
        Assert.Null(missing.Proposal);
        var coll = AssistantActions.Propose(T("create_collection"), new JsonObject { ["name"] = "Weekend", ["gameIds"] = new JsonArray(a.Id, Id(998)) }, snap, "act-4");
        Assert.Null(coll.Proposal);
        var ok = AssistantActions.Propose(T("create_collection"), new JsonObject { ["name"] = "Weekend", ["gameIds"] = new JsonArray(a.Id, b.Id) }, snap, "act-5");
        Assert.Contains("2 games", ok.Proposal!.Detail);
        var smart = AssistantActions.Propose(T("create_smart_collection"),
            new JsonObject { ["name"] = "Long RPGs", ["filter"] = new JsonObject { ["genresAny"] = new JsonArray("rpg", "Made-up genre"), ["ttbMinHours"] = 30 } }, snap, "act-6");
        Assert.Equal("RPG", smart.Proposal!.Args["filter"]!["genresAny"]![0]!.GetValue<string>());
        Assert.Contains("Made-up genre", smart.Proposal.Detail);
        var status = AssistantActions.Propose(T("set_status"), new JsonObject { ["gameId"] = a.Id, ["status"] = "playing" }, snap, "act-7");
        Assert.Equal("Mark Ashen Crown as Playing", status.Proposal!.Title);
    }
}
