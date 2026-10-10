using System.Text.Json.Nodes;
using Vystral.Windows.Ai;
using Vystral.Windows.Ai.Assistant;
using Vystral.Windows.DataSources;
using Xunit;

namespace Vystral.Tests.Ai;

/// <summary>Track D3: each provider's tool-calling request and its streamed answer, parsed without any network.</summary>
public sealed class AssistantWireTests
{
    private const string ClaudeKey = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";
    private const string OpenAiKey = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789wxyz";
    private const string GeminiKey = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456";
    private static readonly IReadOnlyList<ToolSpec> Tools = AssistantTools.All;

    private static List<AsstMessage> Conversation() =>
    [
        new() { Role = "user", Text = "Which RPGs haven't I started?" },
        new() { Role = "assistant", Text = "Let me check.", Calls = [new AsstToolCall("call_1", "search_library", """{"genres":["RPG"],"neverPlayed":true}""")] },
        new() { Role = "tool", Results = [new AsstToolResult("call_1", "search_library", """{"count":1,"games":[{"title":"Wyrmspire"}]}""", false)] },
    ];

    private static async Task<JsonObject> Body(HttpRequestMessage r) => (JsonNode.Parse(await r.Content!.ReadAsStringAsync()) as JsonObject)!;

    private static AsstRound Decode(CloudAiProvider? p, string stream, List<string>? text = null)
    {
        var d = AssistantWire.Decoder(p);
        foreach (var line in stream.Split('\n'))
            foreach (var t in d.Feed(line)) text?.Add(t);
        return d.Finish();
    }

    [Fact]
    public async Task Claude_request_streams_with_native_tools_and_tool_results_in_a_user_turn()
    {
        using var req = AssistantWire.BuildCloud(CloudAiProvider.Anthropic, ClaudeKey, "claude-sonnet-5-5", "SYS", Conversation(), Tools);
        Assert.Equal("https://api.anthropic.com/v1/messages", req.RequestUri!.AbsoluteUri);
        Assert.Equal(ClaudeKey, req.Headers.GetValues("x-api-key").Single());
        Assert.DoesNotContain(ClaudeKey, req.RequestUri.AbsoluteUri);
        var b = await Body(req);
        Assert.True(b["stream"]!.GetValue<bool>());
        Assert.Equal("SYS", b["system"]!.GetValue<string>());
        Assert.Equal("medium", b["output_config"]!["effort"]!.GetValue<string>());
        Assert.Equal("default", b["fallbacks"]!.GetValue<string>());
        Assert.Equal("ephemeral", b["cache_control"]!["type"]!.GetValue<string>());
        Assert.Null(b["thinking"]);
        Assert.Null(b["tool_choice"]);
        var tools = b["tools"]!.AsArray();
        Assert.Equal(Tools.Count, tools.Count);
        Assert.True(tools[0]!["eager_input_streaming"]!.GetValue<bool>());
        var msgs = b["messages"]!.AsArray();
        Assert.Equal(["user", "assistant", "user"], msgs.Select(m => m!["role"]!.GetValue<string>()));
        Assert.Equal("tool_use", msgs[1]!["content"]![1]!["type"]!.GetValue<string>());
        Assert.True(msgs[1]!["content"]![1]!["input"]!["neverPlayed"]!.GetValue<bool>());
        Assert.Equal("tool_result", msgs[2]!["content"]![0]!["type"]!.GetValue<string>());
        Assert.Equal("call_1", msgs[2]!["content"]![0]!["tool_use_id"]!.GetValue<string>());

        using var final = AssistantWire.BuildCloud(CloudAiProvider.Anthropic, ClaudeKey, "claude-haiku-4-5-20251001", "SYS", Conversation(), Tools, toolsOff: true);
        var fb = await Body(final);
        Assert.Equal("none", fb["tool_choice"]!["type"]!.GetValue<string>());
        Assert.Null(fb["output_config"]);
        Assert.False(final.Headers.Contains("anthropic-beta"));
    }

    [Fact]
    public void Claude_stream_yields_text_tool_calls_and_keeps_thinking_blocks_to_echo()
    {
        const string sse = """
            event: message_start
            data: {"type":"message_start","message":{"id":"msg_1","content":[]}}

            event: content_block_start
            data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}

            data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}

            data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

            data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Let me "}}

            data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"look."}}

            data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_9","name":"search_library","input":{}}}

            data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"genres\": [\"RP"}}

            data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"G\"]}"}}

            data: {"type":"content_block_stop","index":2}

            data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}

            data: {"type":"message_stop"}
            """;
        var text = new List<string>();
        var r = Decode(CloudAiProvider.Anthropic, sse, text);
        Assert.Equal("Let me look.", string.Concat(text));
        Assert.Equal("tools", r.Stop);
        var call = Assert.Single(r.Calls);
        Assert.Equal("toolu_9", call.Id);
        Assert.Equal("RPG", JsonNode.Parse(call.ArgsJson)!["genres"]![0]!.GetValue<string>());
        var raw = r.Raw!.AsArray();
        Assert.Equal("sig-abc", raw[0]!["signature"]!.GetValue<string>());
        Assert.Equal("RPG", raw[2]!["input"]!["genres"]![0]!.GetValue<string>());

        // Echoed unchanged on the next round of the same answer.
        var msgs = new List<AsstMessage> { new() { Role = "user", Text = "q" }, new() { Role = "assistant", Text = r.Text, Calls = r.Calls, Raw = r.Raw } };
        using var req = AssistantWire.BuildCloud(CloudAiProvider.Anthropic, ClaudeKey, "claude-opus-5-5", "S", msgs, Tools);
        var body = JsonNode.Parse(req.Content!.ReadAsStringAsync().Result)!;
        Assert.Equal("sig-abc", body["messages"]![1]!["content"]![0]!["signature"]!.GetValue<string>());
    }

    [Fact]
    public void Claude_refusals_errors_and_fallbacks_are_handled()
    {
        var refusal = Decode(CloudAiProvider.Anthropic, """
            data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"get_game","input":{}}}
            data: {"type":"message_delta","delta":{"stop_reason":"refusal"}}
            """);
        Assert.Equal("refusal", refusal.Stop);
        Assert.Empty(refusal.Calls);

        Assert.Throws<DataSourceException>(() => Decode(CloudAiProvider.Anthropic, """data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded sk-ant-1234"}}"""));

        // A mid-answer switch to the fallback model: earlier tool_use and thinking blocks are dropped, text stays.
        var fb = Decode(CloudAiProvider.Anthropic, """
            data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Sure, "}}
            data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"get_game","input":{}}}
            data: {"type":"content_block_start","index":2,"content_block":{"type":"fallback"}}
            data: {"type":"content_block_start","index":3,"content_block":{"type":"text","text":"here it is."}}
            data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}
            """);
        Assert.Equal("Sure, here it is.", fb.Text);
        Assert.Empty(fb.Calls);
        Assert.DoesNotContain("tool_use", fb.Raw!.ToJsonString());
        Assert.DoesNotContain("fallback", fb.Raw!.ToJsonString());
    }

    [Fact]
    public async Task OpenAi_and_compatible_requests_use_function_tools_and_tool_messages()
    {
        using var req = AssistantWire.BuildCloud(CloudAiProvider.OpenAi, OpenAiKey, "gpt-5-mini", "SYS", Conversation(), Tools);
        Assert.Equal("https://api.openai.com/v1/chat/completions", req.RequestUri!.AbsoluteUri);
        Assert.Equal("Bearer", req.Headers.Authorization!.Scheme);
        var b = await Body(req);
        Assert.True(b["stream"]!.GetValue<bool>());
        Assert.NotNull(b["max_completion_tokens"]);
        Assert.Equal("function", b["tools"]![0]!["type"]!.GetValue<string>());
        var msgs = b["messages"]!.AsArray();
        Assert.Equal(["system", "user", "assistant", "tool"], msgs.Select(m => m!["role"]!.GetValue<string>()));
        Assert.Equal("search_library", msgs[2]!["tool_calls"]![0]!["function"]!["name"]!.GetValue<string>());
        Assert.Equal("call_1", msgs[3]!["tool_call_id"]!.GetValue<string>());

        using var compat = AssistantWire.BuildCloud(CloudAiProvider.Compatible, OpenAiKey, "openrouter/auto", "SYS", Conversation(), Tools,
            compatibleBase: new Uri("https://openrouter.ai/api/v1/"), toolsOff: true);
        Assert.Equal("https://openrouter.ai/api/v1/chat/completions", compat.RequestUri!.AbsoluteUri);
        var cb = await Body(compat);
        Assert.NotNull(cb["max_tokens"]);
        Assert.Equal("none", cb["tool_choice"]!.GetValue<string>());
    }

    [Fact]
    public void OpenAi_stream_assembles_fragmented_tool_calls()
    {
        var r = Decode(CloudAiProvider.OpenAi, """
            data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_game","arguments":""}}]}}]}
            data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"title\":"}}]}}]}
            data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Hades\"}"}}]}}]}
            data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
            data: [DONE]
            """);
        var c = Assert.Single(r.Calls);
        Assert.Equal("call_a", c.Id);
        Assert.Equal("""{"title":"Hades"}""", c.ArgsJson);
        Assert.Equal("tools", r.Stop);

        var text = new List<string>();
        var t = Decode(CloudAiProvider.OpenAi, """
            data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}
            data: {"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":"stop"}]}
            """, text);
        Assert.Equal("Hello there", t.Text);
        Assert.Equal(["Hello", " there"], text);
        Assert.Equal("refusal", Decode(CloudAiProvider.OpenAi, """data: {"choices":[{"delta":{"refusal":"I can't"},"finish_reason":"stop"}]}""").Stop);

        var full = AssistantWire.ParseOpenAiFull("""{"choices":[{"message":{"content":"Hi","tool_calls":[{"id":"x","function":{"name":"get_health","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}""", "ChatGPT");
        Assert.Equal("get_health", Assert.Single(full.Calls).Name);
    }

    [Fact]
    public async Task Gemini_uses_function_declarations_sse_and_function_responses_without_the_key_in_the_url()
    {
        using var req = AssistantWire.BuildCloud(CloudAiProvider.Gemini, GeminiKey, "gemini-2.5-flash", "SYS", Conversation(), Tools);
        Assert.Equal("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse", req.RequestUri!.AbsoluteUri);
        Assert.DoesNotContain(GeminiKey, req.RequestUri.AbsoluteUri);
        Assert.Equal(GeminiKey, req.Headers.GetValues("x-goog-api-key").Single());
        var b = await Body(req);
        Assert.NotNull(b["tools"]![0]!["functionDeclarations"]);
        var contents = b["contents"]!.AsArray();
        Assert.Equal(["user", "model", "user"], contents.Select(c => c!["role"]!.GetValue<string>()));
        Assert.Equal("search_library", contents[1]!["parts"]![1]!["functionCall"]!["name"]!.GetValue<string>());
        var fr = contents[2]!["parts"]![0]!["functionResponse"]!;
        Assert.Equal("search_library", fr["name"]!.GetValue<string>());
        Assert.Equal(1, fr["response"]!["count"]!.GetValue<int>());
    }

    [Fact]
    public void Gemini_stream_keeps_thought_signatures_for_the_next_round()
    {
        var r = Decode(CloudAiProvider.Gemini, """
            data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Checking"}]}}]}
            data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_wishlist","args":{"onSaleOnly":true}},"thoughtSignature":"TS1"}]},"finishReason":"STOP"}]}
            """);
        Assert.Equal("Checking", r.Text);
        var c = Assert.Single(r.Calls);
        Assert.StartsWith("vy-", c.Id);
        Assert.Contains("TS1", r.Raw!.ToJsonString());
        Assert.Equal("refusal", Decode(CloudAiProvider.Gemini, """data: {"promptFeedback":{"blockReason":"SAFETY"}}""").Stop);
    }

    [Fact]
    public void Ollama_body_and_ndjson_stream_with_tools_and_the_text_fallback()
    {
        var body = AssistantWire.BuildOllama("qwen3:4b", "SYS", Conversation(), Tools);
        Assert.True(body["stream"]!.GetValue<bool>());
        Assert.NotNull(body["tools"]);
        var msgs = body["messages"]!.AsArray();
        Assert.Equal("tool", msgs[^1]!["role"]!.GetValue<string>());
        Assert.Equal("search_library", msgs[^1]!["tool_name"]!.GetValue<string>());

        var r = Decode(null, """
            {"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_storage","arguments":{"limit":5}}}]},"done":false}
            {"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}
            """);
        Assert.Equal("""{"limit":5}""", Assert.Single(r.Calls).ArgsJson);

        var text = AssistantWire.BuildOllama("gemma:2b", "SYS", Conversation(), Tools, textTools: true);
        Assert.Null(text["tools"]);
        Assert.Contains("TOOL RESULT (search_library)", text.ToJsonString());
        Assert.Contains("search_library", text["messages"]![0]!["content"]!.GetValue<string>());
        Assert.Throws<DataSourceException>(() => Decode(null, """{"error":"model 'x' not found"}"""));
    }

    [Theory]
    [InlineData("""{"tool":"get_health","arguments":{}}""", "get_health")]
    [InlineData("```json\n{\"tool\":\"get_storage\",\"arguments\":{\"limit\":3}}\n```", "get_storage")]
    [InlineData("You have 3 games installed.", null)]
    [InlineData("""{"answer":"no tool"}""", null)]
    [InlineData("{not json}", null)]
    public void Text_protocol_tool_calls_are_recognised(string text, string? tool)
    {
        Assert.Equal(tool, AssistantWire.TextToolCall(text, 1)?.Name);
    }
}
