using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Vystral.Windows.DataSources;

namespace Vystral.Windows.Ai.Assistant;

/// <summary>A tool call a model made. <c>ArgsJson</c> is the model's raw argument text (validated before anything runs).</summary>
public sealed record AsstToolCall(string Id, string Name, string ArgsJson);

/// <summary>A tool result going back to the model (already capped). <c>Content</c> is JSON text.</summary>
public sealed record AsstToolResult(string CallId, string Name, string Content, bool IsError);

/// <summary>One turn of a conversation in a provider-neutral form. <c>Raw</c> keeps a provider's own assistant content (thinking
/// blocks with signatures, Gemini thought signatures) so it can be sent back unchanged within the same answer.</summary>
public sealed class AsstMessage
{
    public required string Role { get; init; }
    public string Text { get; init; } = "";
    public IReadOnlyList<AsstToolCall> Calls { get; init; } = [];
    public IReadOnlyList<AsstToolResult> Results { get; init; } = [];
    public JsonNode? Raw { get; init; }
}

/// <summary>What one model request produced. <c>Stop</c>: "end" | "tools" | "length" | "refusal".</summary>
public sealed record AsstRound(string Text, IReadOnlyList<AsstToolCall> Calls, string Stop, JsonNode? Raw);

/// <summary>
/// Track D3: the assistant's wire formats. Builds streamed chat requests with native tool calling for Claude (Messages API),
/// ChatGPT and OpenAI-compatible endpoints (Chat Completions), Gemini (<c>streamGenerateContent</c>, SSE) and Ollama
/// (<c>/api/chat</c>), plus a plain-text JSON protocol for models without tool calling. Decoders read each stream into text
/// deltas and tool calls. Pure: no keys are stored and no network is touched here, so everything is unit-tested.
/// </summary>
public static class AssistantWire
{
    public const int ClaudeMaxTokens = 16_000;
    public const int CloudMaxTokens = 8_192;
    public const int CompatibleMaxTokens = 4_096;

    public const string TextToolRules =
        "You can look things up with the tools listed below. To use one, reply with ONLY a JSON object and nothing else: " +
        "{\"tool\":\"tool_name\",\"arguments\":{...}}. You'll then get a message starting with TOOL RESULT. Use one tool at a time. " +
        "When you have what you need, answer the user normally (not as JSON).\nTools:\n";

    // ---------------- Requests ----------------

    /// <summary>A streamed chat request to a cloud provider. <paramref name="toolsOff"/> keeps the tools declared but stops new calls (final round).</summary>
    public static HttpRequestMessage BuildCloud(CloudAiProvider p, string key, string model, string system, IReadOnlyList<AsstMessage> messages,
        IReadOnlyList<ToolSpec> tools, Uri? compatibleBase = null, bool withFallback = true, bool textTools = false, bool toolsOff = false)
    {
        if (!CloudAiClient.IsValidModel(model)) throw new DataSourceException(DataSourceOutcome.Malformed, "That model name isn’t valid.");
        if (textTools) system += "\n\n" + TextToolRules + AssistantTools.ForText(tools);
        var native = !textTools && tools.Count > 0;
        HttpRequestMessage req;
        switch (p)
        {
            case CloudAiProvider.Anthropic:
            {
                var body = new JsonObject
                {
                    ["model"] = model,
                    ["max_tokens"] = ClaudeMaxTokens,
                    ["system"] = system,
                    ["messages"] = ClaudeMessages(messages, textTools),
                    ["stream"] = true,
                    // The tool list and instructions repeat on every round of an answer: cache them.
                    ["cache_control"] = new JsonObject { ["type"] = "ephemeral" },
                };
                if (native)
                {
                    body["tools"] = AssistantTools.ForClaude(tools, stream: true);
                    if (toolsOff) body["tool_choice"] = new JsonObject { ["type"] = "none" };
                }
                var effort = CloudAiClient.ClaudeSupportsEffort(model);
                // Several steps with tools: medium effort (adaptive thinking is on by default on these models).
                if (effort) body["output_config"] = new JsonObject { ["effort"] = "medium" };
                if (effort && withFallback) body["fallbacks"] = "default";
                req = new HttpRequestMessage(HttpMethod.Post, new Uri(CloudAiClient.AnthropicBase, "v1/messages")) { Content = Json(body) };
                req.Headers.Add("x-api-key", key);
                req.Headers.Add("anthropic-version", CloudAiClient.AnthropicVersion);
                if (effort && withFallback) req.Headers.Add("anthropic-beta", CloudAiClient.FallbackBeta);
                break;
            }
            case CloudAiProvider.Gemini:
            {
                var body = new JsonObject
                {
                    ["systemInstruction"] = new JsonObject { ["parts"] = new JsonArray { new JsonObject { ["text"] = system } } },
                    ["contents"] = GeminiContents(messages, textTools),
                    ["generationConfig"] = new JsonObject { ["maxOutputTokens"] = CloudMaxTokens },
                };
                if (native)
                {
                    body["tools"] = AssistantTools.ForGemini(tools);
                    if (toolsOff) body["toolConfig"] = new JsonObject { ["functionCallingConfig"] = new JsonObject { ["mode"] = "NONE" } };
                }
                req = new HttpRequestMessage(HttpMethod.Post,
                    new Uri(CloudAiClient.GeminiBase, $"v1beta/models/{Uri.EscapeDataString(model)}:streamGenerateContent?alt=sse")) { Content = Json(body) };
                req.Headers.Add("x-goog-api-key", key);
                break;
            }
            default:
            {
                var compatible = p == CloudAiProvider.Compatible;
                var baseUri = compatible
                    ? compatibleBase ?? throw new DataSourceException(DataSourceOutcome.NotConfigured, "Add the endpoint’s address first.")
                    : CloudAiClient.OpenAiBase;
                var body = new JsonObject
                {
                    ["model"] = model,
                    ["messages"] = OpenAiMessages(system, messages, textTools),
                    ["stream"] = true,
                };
                body[compatible ? "max_tokens" : "max_completion_tokens"] = compatible ? CompatibleMaxTokens : CloudMaxTokens;
                if (native)
                {
                    body["tools"] = AssistantTools.ForOpenAi(tools);
                    if (toolsOff) body["tool_choice"] = "none";
                }
                req = new HttpRequestMessage(HttpMethod.Post, new Uri(baseUri, "chat/completions")) { Content = Json(body) };
                req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", key);
                break;
            }
        }
        req.Headers.Accept.ParseAdd("text/event-stream");
        return req;
    }

    /// <summary>A streamed Ollama <c>/api/chat</c> body. Native tools unless <paramref name="textTools"/>.</summary>
    public static JsonObject BuildOllama(string model, string system, IReadOnlyList<AsstMessage> messages, IReadOnlyList<ToolSpec> tools,
        bool textTools = false, bool toolsOff = false)
    {
        if (textTools) system += "\n\n" + TextToolRules + AssistantTools.ForText(tools);
        var msgs = new JsonArray { new JsonObject { ["role"] = "system", ["content"] = system } };
        foreach (var m in messages)
        {
            if (textTools) { AddText(msgs, m, "content", "assistant"); continue; }
            switch (m.Role)
            {
                case "user":
                    msgs.Add(new JsonObject { ["role"] = "user", ["content"] = m.Text });
                    break;
                case "assistant":
                    if (m.Raw is JsonObject raw) { msgs.Add(raw.DeepClone()); break; }
                    if (m.Text.Length == 0 && m.Calls.Count == 0) break;
                    var o = new JsonObject { ["role"] = "assistant", ["content"] = m.Text };
                    if (m.Calls.Count > 0)
                        o["tool_calls"] = new JsonArray(m.Calls.Select(c => (JsonNode)new JsonObject
                        {
                            ["function"] = new JsonObject { ["name"] = c.Name, ["arguments"] = ParseArgs(c.ArgsJson) },
                        }).ToArray());
                    msgs.Add(o);
                    break;
                case "tool":
                    foreach (var r in m.Results) msgs.Add(new JsonObject { ["role"] = "tool", ["content"] = r.Content, ["tool_name"] = r.Name });
                    break;
            }
        }
        var body = new JsonObject
        {
            ["model"] = model,
            ["messages"] = msgs,
            ["stream"] = true,
            ["think"] = false,
            ["options"] = new JsonObject { ["temperature"] = 0.3, ["num_ctx"] = 16384 },
        };
        if (!textTools && !toolsOff && tools.Count > 0) body["tools"] = AssistantTools.ForOpenAi(tools);
        return body;
    }

    /// <summary>The text-protocol rendering of a turn (models without tool calling), shared by every provider.</summary>
    private static void AddText(JsonArray msgs, AsstMessage m, string field, string assistantRole)
    {
        string text;
        string role;
        switch (m.Role)
        {
            case "assistant":
                role = assistantRole;
                text = m.Calls.Count > 0
                    ? new JsonObject { ["tool"] = m.Calls[0].Name, ["arguments"] = ParseArgs(m.Calls[0].ArgsJson) }.ToJsonString()
                    : m.Text;
                break;
            case "tool":
                role = "user";
                text = string.Join("\n", m.Results.Select(r => $"TOOL RESULT ({r.Name}){(r.IsError ? " ERROR" : "")}: {r.Content}"));
                break;
            default:
                role = "user";
                text = m.Text;
                break;
        }
        if (text.Length == 0) return;
        msgs.Add(new JsonObject { ["role"] = role, [field] = text });
    }

    private static JsonArray ClaudeMessages(IReadOnlyList<AsstMessage> messages, bool textTools)
    {
        var turns = new List<(string Role, JsonArray Blocks)>();
        void Add(string role, IEnumerable<JsonNode> blocks)
        {
            var list = blocks.ToList();
            if (list.Count == 0) return;
            if (turns.Count > 0 && turns[^1].Role == role) foreach (var b in list) turns[^1].Blocks.Add(b);
            else turns.Add((role, new JsonArray(list.ToArray())));
        }
        foreach (var m in messages)
        {
            if (textTools)
            {
                var tmp = new JsonArray();
                AddText(tmp, m, "content", "assistant");
                foreach (var t in tmp.OfType<JsonObject>())
                    Add(t["role"]!.GetValue<string>(), [new JsonObject { ["type"] = "text", ["text"] = t["content"]!.GetValue<string>() }]);
                continue;
            }
            switch (m.Role)
            {
                case "user":
                    if (m.Text.Length > 0) Add("user", [new JsonObject { ["type"] = "text", ["text"] = m.Text }]);
                    break;
                case "assistant":
                    if (m.Raw is JsonArray raw) { Add("assistant", raw.Select(b => b!.DeepClone())); break; }
                    var blocks = new List<JsonNode>();
                    if (m.Text.Length > 0) blocks.Add(new JsonObject { ["type"] = "text", ["text"] = m.Text });
                    blocks.AddRange(m.Calls.Select(c => (JsonNode)new JsonObject { ["type"] = "tool_use", ["id"] = c.Id, ["name"] = c.Name, ["input"] = ParseArgs(c.ArgsJson) }));
                    Add("assistant", blocks);
                    break;
                case "tool":
                    Add("user", m.Results.Select(r =>
                    {
                        var b = new JsonObject { ["type"] = "tool_result", ["tool_use_id"] = r.CallId, ["content"] = r.Content };
                        if (r.IsError) b["is_error"] = true;
                        return (JsonNode)b;
                    }));
                    break;
            }
        }
        return new JsonArray(turns.Select(t => (JsonNode)new JsonObject { ["role"] = t.Role, ["content"] = t.Blocks }).ToArray());
    }

    private static JsonArray OpenAiMessages(string system, IReadOnlyList<AsstMessage> messages, bool textTools)
    {
        var msgs = new JsonArray { new JsonObject { ["role"] = "system", ["content"] = system } };
        foreach (var m in messages)
        {
            if (textTools) { AddText(msgs, m, "content", "assistant"); continue; }
            switch (m.Role)
            {
                case "user":
                    msgs.Add(new JsonObject { ["role"] = "user", ["content"] = m.Text });
                    break;
                case "assistant":
                    if (m.Raw is JsonObject raw) { msgs.Add(raw.DeepClone()); break; }
                    if (m.Text.Length == 0 && m.Calls.Count == 0) break;
                    var o = new JsonObject { ["role"] = "assistant", ["content"] = m.Text.Length > 0 ? m.Text : null };
                    if (m.Calls.Count > 0) o["tool_calls"] = OpenAiCalls(m.Calls);
                    msgs.Add(o);
                    break;
                case "tool":
                    foreach (var r in m.Results) msgs.Add(new JsonObject { ["role"] = "tool", ["tool_call_id"] = r.CallId, ["content"] = r.Content });
                    break;
            }
        }
        return msgs;
    }

    private static JsonArray OpenAiCalls(IEnumerable<AsstToolCall> calls) =>
        new(calls.Select(c => (JsonNode)new JsonObject
        {
            ["id"] = c.Id,
            ["type"] = "function",
            ["function"] = new JsonObject { ["name"] = c.Name, ["arguments"] = c.ArgsJson },
        }).ToArray());

    private static JsonArray GeminiContents(IReadOnlyList<AsstMessage> messages, bool textTools)
    {
        var turns = new List<(string Role, JsonArray Parts)>();
        void Add(string role, IEnumerable<JsonNode> parts)
        {
            var list = parts.ToList();
            if (list.Count == 0) return;
            if (turns.Count > 0 && turns[^1].Role == role) foreach (var x in list) turns[^1].Parts.Add(x);
            else turns.Add((role, new JsonArray(list.ToArray())));
        }
        foreach (var m in messages)
        {
            if (textTools)
            {
                var tmp = new JsonArray();
                AddText(tmp, m, "content", "model");
                foreach (var t in tmp.OfType<JsonObject>())
                    Add(t["role"]!.GetValue<string>(), [new JsonObject { ["text"] = t["content"]!.GetValue<string>() }]);
                continue;
            }
            switch (m.Role)
            {
                case "user":
                    if (m.Text.Length > 0) Add("user", [new JsonObject { ["text"] = m.Text }]);
                    break;
                case "assistant":
                    if (m.Raw is JsonArray raw) { Add("model", raw.Select(x => x!.DeepClone())); break; }
                    var parts = new List<JsonNode>();
                    if (m.Text.Length > 0) parts.Add(new JsonObject { ["text"] = m.Text });
                    parts.AddRange(m.Calls.Select(c =>
                    {
                        var fc = new JsonObject { ["name"] = c.Name, ["args"] = ParseArgs(c.ArgsJson) };
                        if (!c.Id.StartsWith("vy-", StringComparison.Ordinal)) fc["id"] = c.Id;
                        return (JsonNode)new JsonObject { ["functionCall"] = fc };
                    }));
                    Add("model", parts);
                    break;
                case "tool":
                    Add("user", m.Results.Select(r =>
                    {
                        var fr = new JsonObject { ["name"] = r.Name, ["response"] = ParseArgs(r.Content) is { Count: > 0 } o ? o : new JsonObject { ["result"] = r.Content } };
                        if (!r.CallId.StartsWith("vy-", StringComparison.Ordinal)) fr["id"] = r.CallId;
                        return (JsonNode)new JsonObject { ["functionResponse"] = fr };
                    }));
                    break;
            }
        }
        return new JsonArray(turns.Select(t => (JsonNode)new JsonObject { ["role"] = t.Role, ["parts"] = t.Parts }).ToArray());
    }

    /// <summary>A JSON object from argument text, or an empty object when it isn't one.</summary>
    public static JsonObject ParseArgs(string? json)
    {
        if (string.IsNullOrWhiteSpace(json) || json.Length > 64_000) return [];
        try { return JsonNode.Parse(json, documentOptions: new JsonDocumentOptions { MaxDepth = 16 }) as JsonObject ?? []; }
        catch (JsonException) { return []; }
    }

    /// <summary>Strict parse for validation: null when the text isn't a JSON object.</summary>
    public static JsonNode? ParseArgsStrict(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new JsonObject();
        if (json.Length > AssistantTools.MaxArgsChars * 2) return null;
        try { return JsonNode.Parse(json, documentOptions: new JsonDocumentOptions { MaxDepth = 16 }) as JsonObject; }
        catch (JsonException) { return null; }
    }

    private static StringContent Json(JsonNode body) => new(body.ToJsonString(), Encoding.UTF8, "application/json");

    /// <summary>The text protocol's tool call ({"tool":"name","arguments":{...}}), tolerating a code fence. Null when the text is an answer.</summary>
    public static AsstToolCall? TextToolCall(string text, int n)
    {
        var t = text.Trim();
        if (t.StartsWith("```", StringComparison.Ordinal)) t = t.Trim('`').Trim();
        if (t.StartsWith("json", StringComparison.OrdinalIgnoreCase)) t = t[4..].Trim();
        if (!t.StartsWith('{') || !t.EndsWith('}') || t.Length > AssistantTools.MaxArgsChars * 2) return null;
        try
        {
            if (JsonNode.Parse(t, documentOptions: new JsonDocumentOptions { MaxDepth = 16 }) is not JsonObject o) return null;
            if (AiText.Str(o["tool"]) is not { Length: > 0 and <= 64 } name) return null;
            var args = o["arguments"] ?? new JsonObject();
            return new AsstToolCall($"vy-t{n}", name, args.ToJsonString());
        }
        catch (JsonException) { return null; }
    }

    // ---------------- Decoders ----------------

    public static AsstDecoder Decoder(CloudAiProvider? p) => p switch
    {
        CloudAiProvider.Anthropic => new ClaudeDecoder(),
        CloudAiProvider.Gemini => new GeminiDecoder(),
        null => new OllamaDecoder(),
        _ => new OpenAiDecoder(CloudAiProviders.Name(p.Value)),
    };

    /// <summary>A non-streamed Chat Completions answer (some OpenAI-compatible servers ignore <c>stream</c>).</summary>
    public static AsstRound ParseOpenAiFull(string body, string name)
    {
        using var doc = JsonRead.Parse(body, name);
        var first = JsonRead.Arr(doc.RootElement, "choices").FirstOrDefault();
        if (first.ValueKind != JsonValueKind.Object) throw new DataSourceException(DataSourceOutcome.Malformed, $"{name} sent an answer VYSTRAL couldn’t read.");
        var msg = JsonNode.Parse(JsonRead.Obj(first, "message")?.GetRawText() ?? "{}") as JsonObject ?? [];
        var finish = JsonRead.Str(first, "finish_reason");
        var text = AiText.Str(msg["content"]) ?? "";
        var calls = (msg["tool_calls"] as JsonArray ?? []).OfType<JsonObject>()
            .Select((c, i) => new AsstToolCall(AiText.Str(c["id"]) ?? $"vy-{i}", AiText.Str(c["function"]?["name"]) ?? "", AiText.Str(c["function"]?["arguments"]) ?? "{}"))
            .Where(c => c.Name.Length > 0).ToList();
        var refused = AiText.Str(msg["refusal"]) is { Length: > 0 } || finish == "content_filter";
        var raw = new JsonObject { ["role"] = "assistant", ["content"] = text.Length > 0 ? text : null };
        if (calls.Count > 0) raw["tool_calls"] = OpenAiCalls(calls);
        return new AsstRound(text, calls, refused ? "refusal" : calls.Count > 0 ? "tools" : finish == "length" ? "length" : "end", raw);
    }

    /// <summary>Reads one stream, a line at a time, into text deltas and a final <see cref="AsstRound"/>.</summary>
    public abstract class AsstDecoder
    {
        /// <summary>Text to show, from one line of the stream (SSE "data:" line or NDJSON object).</summary>
        public abstract IEnumerable<string> Feed(string line);
        public abstract AsstRound Finish();

        protected static JsonObject? Data(string line, bool sse)
        {
            var l = line.Trim();
            if (sse)
            {
                if (!l.StartsWith("data:", StringComparison.Ordinal)) return null;
                l = l[5..].Trim();
                if (l is "" or "[DONE]") return null;
            }
            if (l.Length == 0 || l[0] != '{') return null;
            try { return JsonNode.Parse(l, documentOptions: new JsonDocumentOptions { MaxDepth = 32 }) as JsonObject; }
            catch (JsonException) { return null; }
        }
    }

    private sealed class ClaudeDecoder : AsstDecoder
    {
        private readonly SortedDictionary<int, JsonObject> _blocks = [];
        private readonly Dictionary<int, StringBuilder> _json = [];
        private int _boundary = -1;
        private string? _stop;

        public override IEnumerable<string> Feed(string line)
        {
            if (Data(line, sse: true) is not { } d) yield break;
            switch (AiText.Str(d["type"]))
            {
                case "error":
                {
                    var kind = AiText.Str(d["error"]?["type"]);
                    throw new DataSourceException(DataSourceOutcome.Unavailable, kind == "overloaded_error"
                        ? "Claude is very busy right now. Try again in a moment."
                        : "Claude stopped partway through the answer. Try again.");
                }
                case "content_block_start":
                {
                    var i = Index(d);
                    if (d["content_block"] is not JsonObject cb) yield break;
                    var block = cb.DeepClone().AsObject();
                    var type = AiText.Str(block["type"]);
                    if (type == "fallback") { _boundary = i; yield break; }
                    if (type == "tool_use") { block["input"] = new JsonObject(); _json[i] = new StringBuilder(); }
                    if (type == "text" && AiText.Str(block["text"]) is { Length: > 0 } t0) yield return t0;
                    _blocks[i] = block;
                    break;
                }
                case "content_block_delta":
                {
                    var i = Index(d);
                    if (!_blocks.TryGetValue(i, out var block) || d["delta"] is not JsonObject delta) yield break;
                    switch (AiText.Str(delta["type"]))
                    {
                        case "text_delta" when AiText.Str(delta["text"]) is { } t:
                            block["text"] = (AiText.Str(block["text"]) ?? "") + t;
                            yield return t;
                            break;
                        case "input_json_delta" when AiText.Str(delta["partial_json"]) is { } pj && _json.TryGetValue(i, out var sb):
                            if (sb.Length + pj.Length <= 64_000) sb.Append(pj);
                            break;
                        case "thinking_delta" when AiText.Str(delta["thinking"]) is { } th:
                            block["thinking"] = (AiText.Str(block["thinking"]) ?? "") + th;
                            break;
                        case "signature_delta" when AiText.Str(delta["signature"]) is { } sig:
                            block["signature"] = sig;
                            break;
                    }
                    break;
                }
                case "message_delta":
                    if (AiText.Str(d["delta"]?["stop_reason"]) is { } stop) _stop = stop;
                    break;
            }
        }

        private static int Index(JsonObject d) => AiText.Num(d["index"]) is { } n ? (int)n : 0;

        public override AsstRound Finish()
        {
            var text = new StringBuilder();
            var calls = new List<AsstToolCall>();
            var raw = new JsonArray();
            foreach (var (i, block) in _blocks)
            {
                var type = AiText.Str(block["type"]);
                // After a mid-answer fallback, only text from before the switch carries over; the rest is the new model's.
                if (i < _boundary && type is not "text") continue;
                if (type == "text") text.Append(AiText.Str(block["text"]));
                if (type == "tool_use")
                {
                    var args = _json.TryGetValue(i, out var sb) ? sb.ToString() : "{}";
                    if (args.Length == 0) args = "{}";
                    var id = AiText.Str(block["id"]) ?? $"vy-{i}";
                    calls.Add(new AsstToolCall(id, AiText.Str(block["name"]) ?? "", args));
                    block["input"] = ParseArgs(args);
                }
                if (type == "text" && (AiText.Str(block["text"]) ?? "").Length == 0) continue;
                raw.Add(block.DeepClone());
            }
            var stop = _stop switch
            {
                "refusal" => "refusal",
                "max_tokens" => "length",
                _ => calls.Count > 0 ? "tools" : "end",
            };
            return new AsstRound(text.ToString(), stop is "refusal" ? [] : calls, stop, raw);
        }
    }

    private sealed class OpenAiDecoder(string name) : AsstDecoder
    {
        private readonly StringBuilder _text = new();
        private readonly SortedDictionary<int, (string? Id, string? Name, StringBuilder Args)> _calls = [];
        private string? _finish;
        private bool _refused;

        public override IEnumerable<string> Feed(string line)
        {
            if (Data(line, sse: true) is not { } d) yield break;
            if (d["error"] is JsonObject) throw new DataSourceException(DataSourceOutcome.Unavailable, $"{name} stopped partway through the answer. Try again.");
            if (d["choices"] is not JsonArray { Count: > 0 } choices || choices[0] is not JsonObject c) yield break;
            if (AiText.Str(c["finish_reason"]) is { } f) _finish = f;
            if (c["delta"] is not JsonObject delta) yield break;
            if (AiText.Str(delta["refusal"]) is { Length: > 0 }) _refused = true;
            if (AiText.Str(delta["content"]) is { Length: > 0 } t)
            {
                _text.Append(t);
                yield return t;
            }
            if (delta["tool_calls"] is JsonArray tcs)
                foreach (var tc in tcs.OfType<JsonObject>())
                {
                    var i = AiText.Num(tc["index"]) is { } n ? (int)n : _calls.Count;
                    if (i is < 0 or > 32) continue;
                    var cur = _calls.TryGetValue(i, out var x) ? x : (null, null, new StringBuilder());
                    var id = AiText.Str(tc["id"]) ?? cur.Id;
                    var fname = AiText.Str(tc["function"]?["name"]) ?? cur.Name;
                    if (AiText.Str(tc["function"]?["arguments"]) is { } a && cur.Args.Length + a.Length <= 64_000) cur.Args.Append(a);
                    _calls[i] = (id, fname, cur.Args);
                }
        }

        public override AsstRound Finish()
        {
            var calls = _calls.Select(kv => new AsstToolCall(kv.Value.Id ?? $"vy-{kv.Key}", kv.Value.Name ?? "", kv.Value.Args.Length == 0 ? "{}" : kv.Value.Args.ToString()))
                .Where(c => c.Name.Length > 0).ToList();
            var text = _text.ToString();
            var raw = new JsonObject { ["role"] = "assistant", ["content"] = text.Length > 0 ? text : null };
            if (calls.Count > 0) raw["tool_calls"] = OpenAiCalls(calls);
            var refused = _refused || _finish == "content_filter";
            return new AsstRound(text, refused ? [] : calls, refused ? "refusal" : calls.Count > 0 ? "tools" : _finish == "length" ? "length" : "end", raw);
        }
    }

    private sealed class GeminiDecoder : AsstDecoder
    {
        private readonly StringBuilder _text = new();
        private readonly JsonArray _parts = [];
        private readonly List<AsstToolCall> _calls = [];
        private string? _finish;
        private bool _blocked;

        public override IEnumerable<string> Feed(string line)
        {
            if (Data(line, sse: true) is not { } d) yield break;
            if (d["error"] is JsonObject) throw new DataSourceException(DataSourceOutcome.Unavailable, "Gemini stopped partway through the answer. Try again.");
            if (AiText.Str(d["promptFeedback"]?["blockReason"]) is not null) _blocked = true;
            if (d["candidates"] is not JsonArray { Count: > 0 } cands || cands[0] is not JsonObject c) yield break;
            if (AiText.Str(c["finishReason"]) is { } f) _finish = f;
            if (c["content"]?["parts"] is not JsonArray parts) yield break;
            foreach (var part in parts.OfType<JsonObject>())
            {
                if (_parts.Count < 400) _parts.Add(part.DeepClone());
                if (AiText.Bool(part["thought"]) is true) continue;
                if (part["functionCall"] is JsonObject fc && AiText.Str(fc["name"]) is { } fname)
                {
                    var id = AiText.Str(fc["id"]) ?? $"vy-{_calls.Count}";
                    _calls.Add(new AsstToolCall(id, fname, (fc["args"] as JsonObject ?? []).ToJsonString()));
                    continue;
                }
                if (AiText.Str(part["text"]) is { Length: > 0 } t)
                {
                    _text.Append(t);
                    yield return t;
                }
            }
        }

        public override AsstRound Finish()
        {
            var refused = _blocked || _finish is "SAFETY" or "PROHIBITED_CONTENT" or "BLOCKLIST" or "SPII" or "RECITATION";
            return new AsstRound(_text.ToString(), refused ? [] : _calls, refused ? "refusal" : _calls.Count > 0 ? "tools" : _finish == "MAX_TOKENS" ? "length" : "end", _parts);
        }
    }

    private sealed class OllamaDecoder : AsstDecoder
    {
        private readonly StringBuilder _text = new();
        private readonly List<AsstToolCall> _calls = [];
        private readonly JsonArray _rawCalls = [];
        private string? _reason;

        public override IEnumerable<string> Feed(string line)
        {
            if (Data(line, sse: false) is not { } d) yield break;
            if (AiText.Str(d["error"]) is { } err)
                throw new DataSourceException(DataSourceOutcome.Unavailable, err.Contains("not found", StringComparison.OrdinalIgnoreCase)
                    ? "The selected model isn’t installed in Ollama yet. Download it from Settings → AI."
                    : "Ollama stopped partway through the answer. Try again.");
            if (AiText.Str(d["done_reason"]) is { } r) _reason = r;
            if (d["message"] is not JsonObject m) yield break;
            if (m["tool_calls"] is JsonArray tcs)
                foreach (var tc in tcs.OfType<JsonObject>())
                    if (AiText.Str(tc["function"]?["name"]) is { } name && _calls.Count < 16)
                    {
                        var args = tc["function"]?["arguments"] switch
                        {
                            JsonObject o => o.ToJsonString(),
                            JsonValue v when v.TryGetValue<string>(out var s) => s,
                            _ => "{}",
                        };
                        _calls.Add(new AsstToolCall($"vy-o{_calls.Count}", name, args));
                        _rawCalls.Add(tc.DeepClone());
                    }
            if (AiText.Str(m["content"]) is { Length: > 0 } t)
            {
                _text.Append(t);
                yield return t;
            }
        }

        public override AsstRound Finish()
        {
            var text = _text.ToString();
            var raw = new JsonObject { ["role"] = "assistant", ["content"] = text };
            if (_rawCalls.Count > 0) raw["tool_calls"] = _rawCalls.DeepClone();
            return new AsstRound(text, _calls, _calls.Count > 0 ? "tools" : _reason == "length" ? "length" : "end", raw);
        }
    }
}
