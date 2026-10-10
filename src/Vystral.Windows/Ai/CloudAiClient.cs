using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Vystral.Windows.DataSources;

namespace Vystral.Windows.Ai;

/// <summary>One request to a model: VYSTRAL's instructions, the user turn (facts + question), and whether JSON is expected.</summary>
public sealed record AiPrompt(string System, string User, bool Json, int MaxTokens = 2048);

/// <summary>
/// Track C5: builds and reads requests for each cloud provider. Pure and static, so request shapes are unit-tested
/// with a fake HTTP handler; nothing here touches the key store or the network.
/// <list type="bullet">
/// <item>Claude: Messages API (<c>POST https://api.anthropic.com/v1/messages</c>, <c>anthropic-version: 2023-06-01</c>, key in
/// <c>x-api-key</c>). Sonnet 5.5 and Opus 5.5 run with low effort (short phrasing tasks) and server-side refusal fallback.</item>
/// <item>ChatGPT and OpenAI-compatible: Chat Completions with a Bearer key.</item>
/// <item>Gemini: <c>generateContent</c> with the key in the <c>x-goog-api-key</c> header (never in the URL).</item>
/// </list>
/// </summary>
public static partial class CloudAiClient
{
    public static readonly Uri AnthropicBase = new("https://api.anthropic.com/");
    public static readonly Uri OpenAiBase = new("https://api.openai.com/v1/");
    public static readonly Uri GeminiBase = new("https://generativelanguage.googleapis.com/");
    public const string AnthropicVersion = "2023-06-01";
    public const string FallbackBeta = "server-side-fallback-2026-07-01";

    /// <summary>Model names are plain identifiers ("gpt-5-mini", "models/gemini-2.5-flash" is normalised, "org/model:tag").</summary>
    public static bool IsValidModel(string? model) => model is { Length: > 0 and <= 120 } && ModelPattern().IsMatch(model);

    /// <summary>
    /// An OpenAI-compatible base URL: HTTPS only, no credentials, query or fragment, a plain host and an optional path.
    /// Returns the normalised URL (with a trailing slash) or null.
    /// </summary>
    public static string? NormalizeBaseUrl(string? url)
    {
        var u = url?.Trim();
        if (u is null || u.Length is 0 or > 200 || !Uri.TryCreate(u, UriKind.Absolute, out var uri)) return null;
        if (uri.Scheme != Uri.UriSchemeHttps || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0) return null;
        if (uri.HostNameType is not (UriHostNameType.Dns or UriHostNameType.IPv4) || !BaseUrlPattern().IsMatch(u.TrimEnd('/'))) return null;
        var normal = uri.GetLeftPart(UriPartial.Path).TrimEnd('/') + "/";
        return normal.Length <= 201 ? normal : null;
    }

    // ---------------- Generation ----------------

    public static HttpRequestMessage BuildChat(CloudAiProvider provider, string key, string model, AiPrompt prompt, Uri? compatibleBase = null, bool withFallback = true)
    {
        if (!IsValidModel(model)) throw new DataSourceException(DataSourceOutcome.Malformed, "That model name isn’t valid.");
        return provider switch
        {
            CloudAiProvider.Anthropic => Anthropic(key, model, prompt, withFallback),
            CloudAiProvider.Gemini => Gemini(key, model, prompt),
            _ => OpenAiChat(provider, key, model, prompt, compatibleBase),
        };
    }

    /// <summary>Whether a Claude model takes <c>output_config.effort</c> and the server-side fallback (Sonnet 5.5 and Opus 5.5 do; Haiku 4.5 doesn't).</summary>
    public static bool ClaudeSupportsEffort(string model) => model is "claude-sonnet-5-5" or "claude-opus-5-5";

    private static HttpRequestMessage Anthropic(string key, string model, AiPrompt p, bool withFallback)
    {
        var body = new JsonObject
        {
            ["model"] = model,
            ["max_tokens"] = Math.Clamp(p.MaxTokens, 16, 8192),
            ["system"] = p.System,
            ["messages"] = new JsonArray { new JsonObject { ["role"] = "user", ["content"] = p.User } },
        };
        var effort = ClaudeSupportsEffort(model);
        // Short, factual phrasing: adaptive thinking (the default on these models) at low effort keeps answers quick and cheap.
        if (effort) body["output_config"] = new JsonObject { ["effort"] = "low" };
        if (effort && withFallback) body["fallbacks"] = "default";
        var req = new HttpRequestMessage(HttpMethod.Post, new Uri(AnthropicBase, "v1/messages")) { Content = Json(body) };
        req.Headers.Add("x-api-key", key);
        req.Headers.Add("anthropic-version", AnthropicVersion);
        if (effort && withFallback) req.Headers.Add("anthropic-beta", FallbackBeta);
        return req;
    }

    private static HttpRequestMessage OpenAiChat(CloudAiProvider provider, string key, string model, AiPrompt p, Uri? compatibleBase)
    {
        var compatible = provider == CloudAiProvider.Compatible;
        var baseUri = compatible ? compatibleBase ?? throw new DataSourceException(DataSourceOutcome.NotConfigured, "Add the endpoint’s address first.") : OpenAiBase;
        var body = new JsonObject
        {
            ["model"] = model,
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = p.System },
                new JsonObject { ["role"] = "user", ["content"] = p.User },
            },
        };
        // OpenAI's current models take max_completion_tokens (reasoning tokens count toward it); many compatible servers only know max_tokens.
        body[compatible ? "max_tokens" : "max_completion_tokens"] = Math.Clamp(p.MaxTokens, 16, 8192);
        if (p.Json && !compatible) body["response_format"] = new JsonObject { ["type"] = "json_object" };
        var req = new HttpRequestMessage(HttpMethod.Post, new Uri(baseUri, "chat/completions")) { Content = Json(body) };
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", key);
        return req;
    }

    private static HttpRequestMessage Gemini(string key, string model, AiPrompt p)
    {
        var config = new JsonObject { ["maxOutputTokens"] = Math.Clamp(p.MaxTokens, 16, 8192) };
        if (p.Json) config["responseMimeType"] = "application/json";
        var body = new JsonObject
        {
            ["systemInstruction"] = new JsonObject { ["parts"] = new JsonArray { new JsonObject { ["text"] = p.System } } },
            ["contents"] = new JsonArray
            {
                new JsonObject { ["role"] = "user", ["parts"] = new JsonArray { new JsonObject { ["text"] = p.User } } },
            },
            ["generationConfig"] = config,
        };
        var req = new HttpRequestMessage(HttpMethod.Post, new Uri(GeminiBase, $"v1beta/models/{Uri.EscapeDataString(model)}:generateContent")) { Content = Json(body) };
        req.Headers.Add("x-goog-api-key", key);
        return req;
    }

    /// <summary>The answer's text. Throws a <see cref="DataSourceException"/> with a friendly message for declines and odd answers.</summary>
    public static string ParseChat(CloudAiProvider provider, HttpStatusCode status, string body)
    {
        var name = CloudAiProviders.Name(provider);
        ThrowForStatus(provider, status);
        using var doc = JsonRead.Parse(body, name);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw Odd(name);
        string text;
        switch (provider)
        {
            case CloudAiProvider.Anthropic:
            {
                if (JsonRead.Str(root, "stop_reason") == "refusal") throw Declined(name);
                var sb = new StringBuilder();
                foreach (var block in JsonRead.Arr(root, "content"))
                    if (block.ValueKind == JsonValueKind.Object && JsonRead.Str(block, "type") == "text" && Raw(block, "text") is { } t)
                        sb.Append(t);
                text = sb.ToString();
                break;
            }
            case CloudAiProvider.Gemini:
            {
                if (JsonRead.Obj(root, "promptFeedback") is { } fb && JsonRead.Str(fb, "blockReason") is not null) throw Declined(name);
                var first = JsonRead.Arr(root, "candidates").FirstOrDefault();
                if (first.ValueKind != JsonValueKind.Object) throw Odd(name);
                if (JsonRead.Str(first, "finishReason") is "SAFETY" or "PROHIBITED_CONTENT" or "BLOCKLIST" or "SPII" or "RECITATION") throw Declined(name);
                var sb = new StringBuilder();
                if (JsonRead.Obj(first, "content") is { } content)
                    foreach (var part in JsonRead.Arr(content, "parts"))
                        if (part.ValueKind == JsonValueKind.Object && !JsonRead.Bool(part, "thought") && Raw(part, "text") is { } t)
                            sb.Append(t);
                text = sb.ToString();
                break;
            }
            default:
            {
                var first = JsonRead.Arr(root, "choices").FirstOrDefault();
                if (first.ValueKind != JsonValueKind.Object) throw Odd(name);
                if (JsonRead.Str(first, "finish_reason") == "content_filter") throw Declined(name);
                var message = JsonRead.Obj(first, "message");
                if (message is { } m && JsonRead.Str(m, "refusal") is { Length: > 0 }) throw Declined(name);
                text = message is { } msg ? Raw(msg, "content") ?? "" : "";
                break;
            }
        }
        text = text.Trim();
        if (text.Length == 0) throw new DataSourceException(DataSourceOutcome.Malformed, $"{name} sent an empty answer.");
        return text;
    }

    /// <summary>A string field as sent (model text is validated by the caller), capped at 20,000 characters.</summary>
    private static string? Raw(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { } s
            ? s.Length > 20_000 ? s[..20_000] : s : null;

    private static DataSourceException Declined(string name) =>
        new(DataSourceOutcome.Malformed, $"{name} declined to answer this one.");

    private static DataSourceException Odd(string name) =>
        new(DataSourceOutcome.Malformed, $"{name} sent an answer VYSTRAL couldn’t read.");

    /// <summary>Maps HTTP errors to fixed messages. Provider error text is never shown: some echo part of the key.</summary>
    public static void ThrowForStatus(CloudAiProvider provider, HttpStatusCode status)
    {
        var name = CloudAiProviders.Name(provider);
        var code = (int)status;
        if (code is >= 200 and < 300) return;
        throw code switch
        {
            401 or 403 => new DataSourceException(DataSourceOutcome.InvalidKey, $"{name} didn’t accept the key. Check it, or create a new one."),
            402 => new DataSourceException(DataSourceOutcome.Unavailable, $"{name} says the account needs credit or billing set up."),
            404 => new DataSourceException(DataSourceOutcome.Malformed, $"{name} doesn’t offer that model to your key. Pick another model in Settings → AI."),
            408 => new DataSourceException(DataSourceOutcome.Unavailable, $"{name} took too long to answer. Try again."),
            413 => new DataSourceException(DataSourceOutcome.Malformed, $"That request was too large for {name}."),
            >= 300 and < 400 => new DataSourceException(DataSourceOutcome.Malformed, $"{name} tried to send VYSTRAL somewhere else. VYSTRAL doesn’t follow redirects with your key."),
            _ => new DataSourceException(DataSourceOutcome.Malformed, $"{name} couldn’t use this request ({code})."),
        };
    }

    // ---------------- Model listing (also the free key check on Connect) ----------------

    public static HttpRequestMessage BuildModels(CloudAiProvider provider, string key, Uri? compatibleBase = null)
    {
        HttpRequestMessage req;
        switch (provider)
        {
            case CloudAiProvider.Anthropic:
                req = new HttpRequestMessage(HttpMethod.Get, new Uri(AnthropicBase, "v1/models?limit=100"));
                req.Headers.Add("x-api-key", key);
                req.Headers.Add("anthropic-version", AnthropicVersion);
                break;
            case CloudAiProvider.Gemini:
                req = new HttpRequestMessage(HttpMethod.Get, new Uri(GeminiBase, "v1beta/models?pageSize=200"));
                req.Headers.Add("x-goog-api-key", key);
                break;
            default:
                var baseUri = provider == CloudAiProvider.Compatible
                    ? compatibleBase ?? throw new DataSourceException(DataSourceOutcome.NotConfigured, "Add the endpoint’s address first.")
                    : OpenAiBase;
                req = new HttpRequestMessage(HttpMethod.Get, new Uri(baseUri, "models"));
                req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", key);
                break;
        }
        return req;
    }

    /// <summary>Model IDs that can chat, newest-looking first for OpenAI/Gemini, capped at 120 (invalid names dropped).</summary>
    public static IReadOnlyList<string> ParseModels(CloudAiProvider provider, HttpStatusCode status, string body)
    {
        ThrowForStatus(provider, status);
        using var doc = JsonRead.Parse(body, CloudAiProviders.Name(provider));
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return [];
        IEnumerable<string> ids = provider switch
        {
            CloudAiProvider.Gemini => JsonRead.Arr(root, "models")
                .Where(m => m.ValueKind == JsonValueKind.Object &&
                            JsonRead.Arr(m, "supportedGenerationMethods").Any(x => x.ValueKind == JsonValueKind.String && x.GetString() == "generateContent"))
                .Select(m => JsonRead.Str(m, "name", 160) ?? "")
                .Select(n => n.StartsWith("models/", StringComparison.Ordinal) ? n[7..] : n)
                .Where(n => n.StartsWith("gemini", StringComparison.Ordinal) && !n.Contains("embedding", StringComparison.Ordinal) &&
                            !n.Contains("image", StringComparison.Ordinal) && !n.Contains("tts", StringComparison.Ordinal)),
            _ => JsonRead.Arr(root, "data")
                .Where(m => m.ValueKind == JsonValueKind.Object)
                .Select(m => JsonRead.Str(m, "id", 160) ?? ""),
        };
        if (provider == CloudAiProvider.OpenAi) ids = ids.Where(IsOpenAiChatModel);
        var list = ids.Where(IsValidModel).Distinct(StringComparer.Ordinal).Take(400).ToList();
        if (provider is CloudAiProvider.OpenAi or CloudAiProvider.Gemini) list.Sort((a, b) => string.CompareOrdinal(b, a));
        return list.Take(120).ToList();
    }

    /// <summary>OpenAI's list mixes in embeddings, audio, image and moderation models; keep the ones Chat Completions can use.</summary>
    internal static bool IsOpenAiChatModel(string id)
    {
        if (!(id.StartsWith("gpt-", StringComparison.Ordinal) || id.StartsWith("chatgpt-", StringComparison.Ordinal) ||
              (id.Length > 1 && id[0] == 'o' && char.IsAsciiDigit(id[1])))) return false;
        string[] exclude = ["audio", "realtime", "tts", "transcribe", "image", "search", "embedding", "instruct", "moderation", "codex", "computer-use", "deep-research"];
        return !exclude.Any(x => id.Contains(x, StringComparison.Ordinal));
    }

    private static StringContent Json(JsonNode body) => new(body.ToJsonString(), Encoding.UTF8, "application/json");

    [GeneratedRegex(@"\A[A-Za-z0-9][A-Za-z0-9._:/\-]{0,119}\z")]
    private static partial Regex ModelPattern();

    [GeneratedRegex(@"\Ahttps://[A-Za-z0-9.\-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~\-/]*)?\z")]
    private static partial Regex BaseUrlPattern();
}
