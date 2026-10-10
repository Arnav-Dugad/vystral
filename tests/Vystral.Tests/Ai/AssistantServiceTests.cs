using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.Ai;
using Vystral.Windows.Ai.Assistant;
using Vystral.Windows.Services;
using Xunit;
using static Vystral.Tests.Ai.AiTestData;

namespace Vystral.Tests.Ai;

/// <summary>Track D3: whole answers against fake providers: streaming, tool loops, approvals before sharing, proposals, fallbacks.</summary>
public sealed class AssistantServiceTests : IDisposable
{
    private const string ClaudeKey = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";
    private readonly TestDb _t = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly Queue<Func<HttpRequestMessage, HttpResponseMessage>> _cloudAnswers = new();
    private readonly Queue<Func<HttpRequestMessage, HttpResponseMessage>> _localAnswers = new();
    private readonly List<string> _cloudBodies = [];
    private readonly List<string> _localBodies = [];
    private readonly List<JsonObject> _events = [];
    private readonly SettingsService _settings;
    private readonly CloudAiService _cloud;
    private readonly AssistantService _svc;
    private readonly FakeAssistantHost _host = new();
    private readonly HttpClient _http;
    private readonly HttpClient _local;

    public AssistantServiceTests()
    {
        _http = new HttpClient(new FakeHandler(r => Answer(r, _cloudAnswers, _cloudBodies)));
        _local = new HttpClient(new FakeHandler(r => Answer(r, _localAnswers, _localBodies))) { BaseAddress = new Uri("http://127.0.0.1:11434/") };
        _settings = new SettingsService(_t.Repo);
        _cloud = new CloudAiService(_settings, _t.Repo, _secrets, _http);
        var router = new AiRouter(_settings, _cloud, new OllamaService(_settings, new NullSink()));
        _host.Games.Add(Game("Ashen Crown", ["RPG"], trackedSeconds: 7200, sessions: 2));
        _host.Games.Add(Game("Nebula Drift", ["Racing"]));
        _svc = new AssistantService(_settings, _cloud, router, _host, (name, payload) =>
        {
            Assert.Equal(AssistantService.EventName, name);
            lock (_events) _events.Add(JsonSerializer.SerializeToNode(payload, Vystral.Windows.Bridge.BridgeDispatcher.Json)!.AsObject());
        }, _local) { ApprovalTimeout = TimeSpan.FromSeconds(10) };
    }

    public void Dispose()
    {
        _http.Dispose();
        _local.Dispose();
        _t.Dispose();
    }

    private static HttpResponseMessage Answer(HttpRequestMessage r, Queue<Func<HttpRequestMessage, HttpResponseMessage>> q, List<string> bodies)
    {
        lock (bodies) bodies.Add(r.Content?.ReadAsStringAsync().Result ?? "");
        lock (q) return q.Count == 0 ? new HttpResponseMessage(HttpStatusCode.InternalServerError) { Content = new StringContent("{}") } : q.Dequeue()(r);
    }

    private static HttpResponseMessage Sse(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "text/event-stream") };

    private static HttpResponseMessage Ndjson(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/x-ndjson") };

    private const string NL = "\n\n";

    private static string ClaudeText(string text) =>
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}" + NL +
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":" + JsonSerializer.Serialize(text) + "}}" + NL +
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}" + NL;

    private static string ClaudeTool(string name, string args) =>
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"" + name + "\",\"input\":{}}}" + NL +
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":" + JsonSerializer.Serialize(args) + "}}" + NL +
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}" + NL;

    private void UseClaude()
    {
        _secrets.Items["VYSTRAL/AI-Anthropic"] = ClaudeKey;
        _settings.Set("ai.provider", JsonValue.Create("anthropic"));
        _settings.Set("ai.cloud.anthropic.optIn", JsonValue.Create(true));
    }

    private static AsstChatInput Ask(string text, bool shareApproved = false) =>
        new("r1", [new AsstInMessage("user", text)], new AsstContext("library", null, null), shareApproved);

    private List<JsonObject> Events(string type)
    {
        lock (_events) return _events.Where(e => e["type"]!.GetValue<string>() == type).ToList();
    }

    private string Text() => string.Concat(Events("delta").Select(e => e["text"]!.GetValue<string>()));

    private async Task<JsonObject> WaitFor(string type)
    {
        for (var i = 0; i < 200; i++)
        {
            if (Events(type).FirstOrDefault() is { } e) return e;
            await Task.Delay(25);
        }
        throw new TimeoutException($"No {type} event.");
    }

    [Fact]
    public async Task Without_any_ai_the_assistant_says_how_to_set_it_up_and_sends_nothing()
    {
        await _svc.RunAsync(Ask("hi"), CancellationToken.None);
        Assert.True(Events("error").Single()["setup"]!.GetValue<bool>());
        Assert.Empty(_cloudBodies);
        Assert.Empty(_localBodies);
    }

    [Fact]
    public async Task A_cloud_answer_streams_and_says_what_was_sent()
    {
        UseClaude();
        _cloudAnswers.Enqueue(_ => Sse(ClaudeText("Hello from Claude.")));
        await _svc.RunAsync(Ask("hi"), CancellationToken.None);
        Assert.Equal("Hello from Claude.", Text());
        var done = Events("done").Single();
        Assert.True(done["cloud"]!.GetValue<bool>());
        Assert.Contains("Sent to Anthropic", done["sent"]!.GetValue<string>());
        Assert.Contains("No app data was looked up", done["sent"]!.GetValue<string>());
        var body = JsonNode.Parse(_cloudBodies.Single())!;
        Assert.Contains("<context>", body["messages"]![0]!["content"]![0]!["text"]!.GetValue<string>());
        Assert.Contains("the Library", body["messages"]![0]!["content"]![0]!["text"]!.GetValue<string>());
    }

    [Fact]
    public async Task Tool_results_wait_for_the_users_ok_before_going_to_the_cloud()
    {
        UseClaude();
        _cloudAnswers.Enqueue(_ => Sse(ClaudeTool("search_library", """{"genres":["RPG"]}""")));
        _cloudAnswers.Enqueue(_ => Sse(ClaudeText("You have Ashen Crown.")));
        var run = _svc.RunAsync(Ask("my rpgs?"), CancellationToken.None);
        var approval = await WaitFor("approval");
        Assert.Single(_cloudBodies); // nothing sent yet
        var a = approval["approval"]!;
        Assert.Equal("Anthropic", a["company"]!.GetValue<string>());
        Assert.Equal("Library search", a["items"]![0]!["label"]!.GetValue<string>());
        Assert.True(_svc.Approve("r1", a["id"]!.GetValue<string>(), allow: true, always: false));
        await run;
        Assert.Equal(2, _cloudBodies.Count);
        Assert.Contains("Ashen Crown", _cloudBodies[1]);
        Assert.Equal("You have Ashen Crown.", Text());
        var tool = Events("tool").Last();
        Assert.Equal("done", tool["call"]!["status"]!.GetValue<string>());
        Assert.Equal("games", tool["card"]!["kind"]!.GetValue<string>());
        Assert.Contains("Library search", Events("done").Single()["sent"]!.GetValue<string>());
    }

    [Fact]
    public async Task Declining_shares_nothing_and_the_model_answers_without_it()
    {
        UseClaude();
        _cloudAnswers.Enqueue(_ => Sse(ClaudeTool("search_library", """{"genres":["RPG"]}""")));
        _cloudAnswers.Enqueue(_ => Sse(ClaudeText("Okay, I won't look.")));
        var run = _svc.RunAsync(Ask("my rpgs?"), CancellationToken.None);
        var approval = await WaitFor("approval");
        _svc.Approve("r1", approval["approval"]!["id"]!.GetValue<string>(), allow: false, always: false);
        await run;
        Assert.DoesNotContain("Ashen Crown", _cloudBodies[1]);
        Assert.Contains("chose not to share", _cloudBodies[1]);
        Assert.Contains(Events("tool"), e => e["call"]!["status"]!.GetValue<string>() == "declined");
    }

    [Fact]
    public async Task Actions_are_proposed_never_run_and_hostile_arguments_go_back_as_errors()
    {
        UseClaude();
        var ashen = _host.Games[0];
        _cloudAnswers.Enqueue(_ => Sse(ClaudeTool("set_favorite", $$"""{"gameId":"{{ashen.Id}}","favorite":true}""")));
        _cloudAnswers.Enqueue(_ => Sse(ClaudeTool("get_game", """{"gameId":"../../etc/passwd"}""")));
        _cloudAnswers.Enqueue(_ => Sse(ClaudeText("I’ve set that up for you to confirm.")));
        await _svc.RunAsync(Ask("favorite ashen crown", shareApproved: true), CancellationToken.None);
        var action = Events("action").Single()["action"]!;
        Assert.Equal("set_favorite", action["tool"]!.GetValue<string>());
        Assert.Equal("Add Ashen Crown to favorites", action["title"]!.GetValue<string>());
        Assert.False(_host.Games[0].Favorite); // nothing changed
        Assert.Contains("proposed", _cloudBodies[1]);
        Assert.Contains("Don't say it's done", _cloudBodies[1]);
        Assert.Contains("is_error", _cloudBodies[2]);
        Assert.Contains("valid id", _cloudBodies[2]);
        Assert.Empty(_host.ReadCalls);
    }

    [Fact]
    public async Task ChatGPT_and_Gemini_run_the_same_tool_loop_through_their_own_formats()
    {
        _secrets.Items["VYSTRAL/AI-OpenAI"] = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789wxyz";
        _settings.Set("ai.provider", JsonValue.Create("openai"));
        _settings.Set("ai.cloud.openai.optIn", JsonValue.Create(true));
        _cloudAnswers.Enqueue(_ => Sse("""
            data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"get_storage","arguments":"{\"limit\":3}"}}]}}]}

            data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

            data: [DONE]

            """));
        _cloudAnswers.Enqueue(_ => Sse("""
            data: {"choices":[{"index":0,"delta":{"content":"Your C: drive is fine."},"finish_reason":"stop"}]}

            data: [DONE]

            """));
        await _svc.RunAsync(Ask("space?", shareApproved: true), CancellationToken.None);
        Assert.Equal("Your C: drive is fine.", Text());
        var second = JsonNode.Parse(_cloudBodies[1])!;
        Assert.Equal("tool", second["messages"]!.AsArray().Last()!["role"]!.GetValue<string>());
        Assert.Equal("call_x", second["messages"]!.AsArray().Last()!["tool_call_id"]!.GetValue<string>());

        _events.Clear();
        _cloudBodies.Clear();
        _secrets.Items["VYSTRAL/AI-Gemini"] = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456";
        _settings.Set("ai.provider", JsonValue.Create("gemini"));
        _settings.Set("ai.cloud.gemini.optIn", JsonValue.Create(true));
        _cloudAnswers.Enqueue(_ => Sse("""
            data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_health","args":{}},"thoughtSignature":"SIG"}]},"finishReason":"STOP"}]}

            """));
        _cloudAnswers.Enqueue(_ => Sse("""
            data: {"candidates":[{"content":{"role":"model","parts":[{"text":"All healthy."}]},"finishReason":"STOP"}]}

            """));
        await _svc.RunAsync(Ask("health?", shareApproved: true), CancellationToken.None);
        Assert.Equal("All healthy.", Text());
        Assert.Contains("SIG", _cloudBodies[1]); // the thought signature goes back with the function call
        Assert.Contains("functionResponse", _cloudBodies[1]);
    }

    [Fact]
    public async Task Offline_mode_pauses_cloud_use()
    {
        UseClaude();
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        await _svc.RunAsync(Ask("hi"), CancellationToken.None);
        Assert.Empty(_cloudBodies);
        Assert.Contains("Offline mode", Events("error").Single()["message"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_failing_cloud_provider_falls_back_to_local_ai_when_it_is_on()
    {
        UseClaude();
        _settings.Set("ai.enabled", JsonValue.Create(true));
        _cloudAnswers.Enqueue(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("""{"error":"bad key sk-ant-1234"}""") });
        _localAnswers.Enqueue(_ => Ndjson("""
            {"message":{"role":"assistant","content":"Local here."},"done":false}
            {"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}
            """));
        await _svc.RunAsync(Ask("hi"), CancellationToken.None);
        Assert.Equal("Local here.", Text());
        var done = Events("done").Single();
        Assert.False(done["cloud"]!.GetValue<bool>());
        Assert.Contains("didn’t accept the key", done["note"]!.GetValue<string>());
        Assert.DoesNotContain("1234", done.ToJsonString());
    }

    [Fact]
    public async Task Local_models_without_tool_calling_use_the_json_text_protocol()
    {
        _settings.Set("ai.enabled", JsonValue.Create(true));
        _localAnswers.Enqueue(_ => new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("""{"error":"gemma does not support tools"}""") });
        _localAnswers.Enqueue(_ => Ndjson("""
            {"message":{"role":"assistant","content":"{\"tool\":\"search_library\","},"done":false}
            {"message":{"role":"assistant","content":"\"arguments\":{\"genres\":[\"RPG\"]}}"},"done":true}
            """));
        _localAnswers.Enqueue(_ => Ndjson("""{"message":{"role":"assistant","content":"Ashen Crown is your RPG."},"done":true}"""));
        await _svc.RunAsync(Ask("my rpgs?"), CancellationToken.None);
        Assert.Equal("Ashen Crown is your RPG.", Text()); // the JSON tool call itself is never shown
        Assert.Null(JsonNode.Parse(_localBodies[1])!["tools"]);
        Assert.Contains("TOOL RESULT (search_library)", _localBodies[2]);
        Assert.Empty(Events("approval")); // local AI: nothing leaves the PC, nothing to approve
        Assert.Contains("Nothing left your computer", Events("done").Single()["sent"]!.GetValue<string>());
    }

    [Fact]
    public async Task Local_ai_is_paused_while_a_game_runs()
    {
        _settings.Set("ai.enabled", JsonValue.Create(true));
        _svc.IsGameRunning = () => true;
        await _svc.RunAsync(Ask("hi"), CancellationToken.None);
        Assert.Single(Events("error"));
        Assert.Empty(_localBodies);
    }

    [Fact]
    public async Task Turning_the_assistant_off_stops_it()
    {
        UseClaude();
        _settings.Set("ai.features.assistant", JsonValue.Create(false));
        await _svc.RunAsync(Ask("hi"), CancellationToken.None);
        Assert.Contains("turned off", Events("error").Single()["message"]!.GetValue<string>());
        Assert.Empty(_cloudBodies);
    }

    [Fact]
    public void Context_names_the_page_and_game_but_only_real_games()
    {
        var game = _host.Games[0];
        Assert.Contains($"“Ashen Crown” (gameId {game.Id})", _svc.Context(new AsstContext("game", game.Id, null)));
        Assert.DoesNotContain("gameId", _svc.Context(new AsstContext("game", Id(4242), null)));
        Assert.Equal("call_1-xscript", AssistantService.SafeId("call_1-x<script>"));
        Assert.Equal("abc", AssistantService.SafeId("a<b>c"));
    }

    private sealed class NullSink : Vystral.Windows.Bridge.IEventSink
    {
        public void Emit(string eventName, object? payload) { }
    }
}
