using System.Net;
using System.Text.Json.Nodes;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.Ai;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Ai;

/// <summary>Track C5: request building and answer parsing for each provider (no real network: a fake handler answers).</summary>
public sealed class CloudAiClientTests
{
    private const string ClaudeKey = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";
    private const string OpenAiKey = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789wxyz";
    private const string GeminiKey = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456";
    private static readonly AiPrompt Prompt = new("SYSTEM", "USER", Json: true, MaxTokens: 1000);

    private static async Task<JsonObject> Body(HttpRequestMessage r) => (JsonNode.Parse(await r.Content!.ReadAsStringAsync()) as JsonObject)!;

    [Fact]
    public async Task Claude_uses_the_messages_api_with_version_header_key_header_and_low_effort()
    {
        using var req = CloudAiClient.BuildChat(CloudAiProvider.Anthropic, ClaudeKey, "claude-sonnet-5-5", Prompt);
        Assert.Equal(HttpMethod.Post, req.Method);
        Assert.Equal("https://api.anthropic.com/v1/messages", req.RequestUri!.AbsoluteUri);
        Assert.Equal("2023-06-01", req.Headers.GetValues("anthropic-version").Single());
        Assert.Equal(ClaudeKey, req.Headers.GetValues("x-api-key").Single());
        Assert.Equal(CloudAiClient.FallbackBeta, req.Headers.GetValues("anthropic-beta").Single());
        Assert.Null(req.Headers.Authorization);
        Assert.DoesNotContain(ClaudeKey, req.RequestUri.AbsoluteUri);
        var b = await Body(req);
        Assert.Equal("claude-sonnet-5-5", b["model"]!.GetValue<string>());
        Assert.Equal("SYSTEM", b["system"]!.GetValue<string>());
        Assert.Equal("USER", b["messages"]![0]!["content"]!.GetValue<string>());
        Assert.Equal("user", b["messages"]![0]!["role"]!.GetValue<string>());
        Assert.Equal("low", b["output_config"]!["effort"]!.GetValue<string>());
        Assert.Equal("default", b["fallbacks"]!.GetValue<string>());
        Assert.Null(b["thinking"]); // adaptive by default on these models; never "disabled" or a budget
        Assert.Null(b["temperature"]);
        Assert.Equal(1000, b["max_tokens"]!.GetValue<int>());
    }

    [Fact]
    public async Task Claude_haiku_4_5_gets_no_effort_or_fallback()
    {
        using var req = CloudAiClient.BuildChat(CloudAiProvider.Anthropic, ClaudeKey, "claude-haiku-4-5-20251001", Prompt);
        var b = await Body(req);
        Assert.Null(b["output_config"]);
        Assert.Null(b["fallbacks"]);
        Assert.False(req.Headers.Contains("anthropic-beta"));
    }

    [Fact]
    public async Task Claude_without_fallback_drops_the_beta_header_and_field()
    {
        using var req = CloudAiClient.BuildChat(CloudAiProvider.Anthropic, ClaudeKey, "claude-opus-5-5", Prompt, withFallback: false);
        var b = await Body(req);
        Assert.Null(b["fallbacks"]);
        Assert.False(req.Headers.Contains("anthropic-beta"));
        Assert.Equal("low", b["output_config"]!["effort"]!.GetValue<string>());
    }

    [Fact]
    public async Task OpenAi_uses_chat_completions_with_bearer_key_and_json_mode()
    {
        using var req = CloudAiClient.BuildChat(CloudAiProvider.OpenAi, OpenAiKey, "gpt-5-mini", Prompt);
        Assert.Equal("https://api.openai.com/v1/chat/completions", req.RequestUri!.AbsoluteUri);
        Assert.Equal("Bearer", req.Headers.Authorization!.Scheme);
        Assert.Equal(OpenAiKey, req.Headers.Authorization.Parameter);
        var b = await Body(req);
        Assert.Equal("system", b["messages"]![0]!["role"]!.GetValue<string>());
        Assert.Equal("user", b["messages"]![1]!["role"]!.GetValue<string>());
        Assert.Equal(1000, b["max_completion_tokens"]!.GetValue<int>());
        Assert.Equal("json_object", b["response_format"]!["type"]!.GetValue<string>());
    }

    [Fact]
    public async Task Compatible_uses_the_users_base_url_and_plain_max_tokens()
    {
        var baseUri = new Uri(CloudAiClient.NormalizeBaseUrl("https://openrouter.ai/api/v1")!);
        using var req = CloudAiClient.BuildChat(CloudAiProvider.Compatible, OpenAiKey, "meta-llama/llama-3.3-70b-instruct", Prompt, baseUri);
        Assert.Equal("https://openrouter.ai/api/v1/chat/completions", req.RequestUri!.AbsoluteUri);
        var b = await Body(req);
        Assert.Equal(1000, b["max_tokens"]!.GetValue<int>());
        Assert.Null(b["response_format"]);
    }

    [Fact]
    public async Task Gemini_sends_the_key_as_a_header_never_in_the_url()
    {
        using var req = CloudAiClient.BuildChat(CloudAiProvider.Gemini, GeminiKey, "gemini-2.5-flash", Prompt);
        Assert.Equal("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", req.RequestUri!.AbsoluteUri);
        Assert.DoesNotContain("key=", req.RequestUri.Query);
        Assert.Equal(GeminiKey, req.Headers.GetValues("x-goog-api-key").Single());
        var b = await Body(req);
        Assert.Equal("SYSTEM", b["systemInstruction"]!["parts"]![0]!["text"]!.GetValue<string>());
        Assert.Equal("USER", b["contents"]![0]!["parts"]![0]!["text"]!.GetValue<string>());
        Assert.Equal("application/json", b["generationConfig"]!["responseMimeType"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("../../v1/admin")]
    [InlineData("model with spaces")]
    [InlineData("")]
    [InlineData("model?x=1")]
    public void Invalid_model_names_never_build_a_request(string model) =>
        Assert.Throws<DataSourceException>(() => CloudAiClient.BuildChat(CloudAiProvider.OpenAi, OpenAiKey, model, Prompt));

    [Theory]
    [InlineData("https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/")]
    [InlineData("https://api.groq.com/openai/v1/", "https://api.groq.com/openai/v1/")]
    [InlineData("https://localhost:8443/v1", "https://localhost:8443/v1/")]
    [InlineData("http://openrouter.ai/api/v1", null)]
    [InlineData("https://user:pass@openrouter.ai/api/v1", null)]
    [InlineData("https://openrouter.ai/api/v1?key=abc", null)]
    [InlineData("https://openrouter.ai/api/v1#x", null)]
    [InlineData("ftp://openrouter.ai/", null)]
    [InlineData("file:///C:/Windows", null)]
    [InlineData("javascript:alert(1)", null)]
    [InlineData("", null)]
    public void Compatible_base_url_must_be_plain_https(string input, string? expected) =>
        Assert.Equal(expected, CloudAiClient.NormalizeBaseUrl(input));

    [Fact]
    public void Parses_claude_text_blocks_and_skips_thinking_and_fallback_blocks()
    {
        var text = CloudAiClient.ParseChat(CloudAiProvider.Anthropic, HttpStatusCode.OK, """
            {"model":"claude-sonnet-5-5","stop_reason":"end_turn","content":[{"type":"thinking","thinking":""},{"type":"text","text":"Hello"},{"type":"text","text":" there"}]}
            """);
        Assert.Equal("Hello there", text);
    }

    [Fact]
    public void Claude_refusal_is_a_friendly_decline() =>
        Assert.Contains("declined", Assert.Throws<DataSourceException>(() =>
            CloudAiClient.ParseChat(CloudAiProvider.Anthropic, HttpStatusCode.OK, """{"stop_reason":"refusal","content":[]}""")).Message);

    [Fact]
    public void Parses_openai_and_gemini_answers()
    {
        Assert.Equal("{\"a\":1}", CloudAiClient.ParseChat(CloudAiProvider.OpenAi, HttpStatusCode.OK,
            """{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"{\"a\":1}"}}]}"""));
        Assert.Equal("Hi", CloudAiClient.ParseChat(CloudAiProvider.Gemini, HttpStatusCode.OK,
            """{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"thinking…","thought":true},{"text":"Hi"}]}}]}"""));
        Assert.Throws<DataSourceException>(() => CloudAiClient.ParseChat(CloudAiProvider.Gemini, HttpStatusCode.OK,
            """{"promptFeedback":{"blockReason":"SAFETY"}}"""));
        Assert.Throws<DataSourceException>(() => CloudAiClient.ParseChat(CloudAiProvider.OpenAi, HttpStatusCode.OK,
            """{"choices":[{"message":{"content":null,"refusal":"I can't help"}}]}"""));
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, DataSourceOutcome.InvalidKey)]
    [InlineData(HttpStatusCode.Forbidden, DataSourceOutcome.InvalidKey)]
    [InlineData(HttpStatusCode.NotFound, DataSourceOutcome.Malformed)]
    [InlineData(HttpStatusCode.Redirect, DataSourceOutcome.Malformed)]
    public void Error_statuses_get_fixed_messages_never_the_providers_text(HttpStatusCode status, DataSourceOutcome outcome)
    {
        // OpenAI's real 401 echoes part of the key; VYSTRAL never shows the provider's error text.
        var ex = Assert.Throws<DataSourceException>(() => CloudAiClient.ParseChat(CloudAiProvider.OpenAi, status,
            """{"error":{"message":"Incorrect API key provided: sk-proj-ABC***wxyz"}}"""));
        Assert.Equal(outcome, ex.Outcome);
        Assert.DoesNotContain("sk-", ex.Message);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("""{"choices":[]}""")]
    [InlineData("""{"choices":[{"message":{"content":""}}]}""")]
    [InlineData("""{"choices":[{"message":{"content":42}}]}""")]
    public void Malformed_answers_throw_a_handled_error(string body) =>
        Assert.Throws<DataSourceException>(() => CloudAiClient.ParseChat(CloudAiProvider.OpenAi, HttpStatusCode.OK, body));

    [Fact]
    public void Openai_model_list_keeps_chat_models_only()
    {
        var models = CloudAiClient.ParseModels(CloudAiProvider.OpenAi, HttpStatusCode.OK, """
            {"data":[{"id":"gpt-5-mini"},{"id":"text-embedding-3-small"},{"id":"gpt-4o-audio-preview"},{"id":"o4-mini"},{"id":"dall-e-3"},
                     {"id":"gpt-4o-realtime-preview"},{"id":"gpt-5"},{"id":"whisper-1"},{"id":"bad id with spaces"}]}
            """);
        Assert.Equal(["o4-mini", "gpt-5-mini", "gpt-5"], models);
    }

    [Fact]
    public void Gemini_model_list_keeps_generate_content_models()
    {
        var models = CloudAiClient.ParseModels(CloudAiProvider.Gemini, HttpStatusCode.OK, """
            {"models":[{"name":"models/gemini-2.5-flash","supportedGenerationMethods":["generateContent","countTokens"]},
                       {"name":"models/text-embedding-004","supportedGenerationMethods":["embedContent"]},
                       {"name":"models/gemini-2.5-pro","supportedGenerationMethods":["generateContent"]},
                       {"name":"models/gemini-embedding-001","supportedGenerationMethods":["generateContent"]}]}
            """);
        Assert.Equal(["gemini-2.5-pro", "gemini-2.5-flash"], models);
    }

    [Fact]
    public void Model_listing_requests_carry_the_key_in_headers()
    {
        using var a = CloudAiClient.BuildModels(CloudAiProvider.Anthropic, ClaudeKey);
        Assert.Equal("https://api.anthropic.com/v1/models?limit=100", a.RequestUri!.AbsoluteUri);
        Assert.Equal(ClaudeKey, a.Headers.GetValues("x-api-key").Single());
        using var g = CloudAiClient.BuildModels(CloudAiProvider.Gemini, GeminiKey);
        Assert.DoesNotContain(GeminiKey, g.RequestUri!.AbsoluteUri);
        using var o = CloudAiClient.BuildModels(CloudAiProvider.OpenAi, OpenAiKey);
        Assert.Equal("https://api.openai.com/v1/models", o.RequestUri!.AbsoluteUri);
    }
}

/// <summary>Track C5: key storage (Credential Manager only), connect/test/disconnect, offline, budget, fallback retry.</summary>
public sealed class CloudAiServiceTests : IDisposable
{
    private const string ClaudeKey = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";
    private readonly TestDb _t = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly List<HttpRequestMessage> _sent = [];
    private Func<HttpRequestMessage, HttpResponseMessage> _respond = _ => FakeHandler.Json(HttpStatusCode.NotFound, "{}");
    private readonly HttpClient _http;
    private readonly SettingsService _settings;
    private readonly CloudAiService _svc;

    public CloudAiServiceTests()
    {
        _http = new HttpClient(new FakeHandler(r => { lock (_sent) _sent.Add(r); return _respond(r); }));
        _settings = new SettingsService(_t.Repo);
        _svc = new CloudAiService(_settings, _t.Repo, _secrets, _http);
        foreach (var p in CloudAiProviders.All) _svc.Lane(p).Delay = (_, _) => Task.CompletedTask;
    }

    public void Dispose()
    {
        _http.Dispose();
        _t.Dispose();
    }

    [Fact]
    public async Task Connect_stores_the_key_only_in_the_secret_store_and_only_after_the_provider_accepts_it()
    {
        _respond = _ => FakeHandler.Json(HttpStatusCode.Unauthorized, """{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}""");
        var bad = await _svc.ConnectAsync(CloudAiProvider.Anthropic, ClaudeKey, null, CancellationToken.None);
        Assert.Equal("invalidKey", bad.Result.Outcome);
        Assert.Empty(_secrets.Items);

        _respond = _ => FakeHandler.Json(HttpStatusCode.OK, """{"data":[{"id":"claude-sonnet-5-5"}]}""");
        var ok = await _svc.ConnectAsync(CloudAiProvider.Anthropic, "  " + ClaudeKey + "\n", null, CancellationToken.None);
        Assert.Equal("ok", ok.Result.Outcome);
        Assert.Equal(ClaudeKey, _secrets.Items["VYSTRAL/AI-Anthropic"]);
        Assert.Equal("…abcd", ok.Provider.KeyMasked);
        Assert.False(ok.Provider.OptedIn); // connecting never opts in by itself

        // The key never appears in settings, the database's settings table, the status or the test result.
        var settingsJson = _settings.GetAll().ToJsonString();
        Assert.DoesNotContain(ClaudeKey, settingsJson);
        Assert.DoesNotContain(ClaudeKey, System.Text.Json.JsonSerializer.Serialize(ok));
        Assert.DoesNotContain(ClaudeKey, string.Join("|", _t.Repo.GetSettings().Select(kv => kv.Value)));
    }

    [Fact]
    public async Task A_key_for_another_provider_is_caught_before_any_request()
    {
        var r = await _svc.ConnectAsync(CloudAiProvider.OpenAi, ClaudeKey, null, CancellationToken.None);
        Assert.Equal("invalidKey", r.Result.Outcome);
        Assert.Contains("Claude key", r.Result.Message);
        Assert.Empty(_sent);
        Assert.Empty(_secrets.Items);
    }

    [Theory]
    [InlineData("short")]
    [InlineData("has spaces in the middle of it 1234567")]
    [InlineData("sk-ant-<script>alert(1)</script>xxxxxxxx")]
    [InlineData("")]
    public async Task Malformed_keys_are_rejected_without_a_request(string key)
    {
        var r = await _svc.ConnectAsync(CloudAiProvider.Anthropic, key, null, CancellationToken.None);
        Assert.Equal("invalidKey", r.Result.Outcome);
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task Compatible_endpoint_requires_https_and_saves_the_url_as_a_setting()
    {
        var bad = await _svc.ConnectAsync(CloudAiProvider.Compatible, "sk-or-v1-ABCDEFGHIJKLMNOPQRSTUVWXYZ", "http://example.com/v1", CancellationToken.None);
        Assert.Equal("malformed", bad.Result.Outcome);
        Assert.Empty(_sent);

        _respond = r =>
        {
            Assert.Equal("https://openrouter.ai/api/v1/models", r.RequestUri!.AbsoluteUri);
            return FakeHandler.Json(HttpStatusCode.OK, """{"data":[{"id":"openrouter/auto"},{"id":"meta-llama/llama-3.3-70b-instruct"}]}""");
        };
        var ok = await _svc.ConnectAsync(CloudAiProvider.Compatible, "sk-or-v1-ABCDEFGHIJKLMNOPQRSTUVWXYZ", "https://openrouter.ai/api/v1", CancellationToken.None);
        Assert.Equal("ok", ok.Result.Outcome);
        Assert.Equal("https://openrouter.ai/api/v1", _settings.GetString("ai.cloud.compatible.url"));
        Assert.Equal("https://openrouter.ai/api/v1/", ok.Provider.BaseUrl);
        Assert.Equal(2, ok.Provider.Models.Count);
    }

    [Fact]
    public async Task Offline_mode_sends_nothing()
    {
        _secrets.Items["VYSTRAL/AI-Anthropic"] = ClaudeKey;
        _settings.Set("ai.cloud.anthropic.optIn", JsonValue.Create(true));
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        Assert.False(_svc.IsReady(CloudAiProvider.Anthropic));
        var ex = await Assert.ThrowsAsync<DataSourceException>(() => _svc.CompleteAsync(CloudAiProvider.Anthropic, new AiPrompt("s", "u", false), CancellationToken.None));
        Assert.Equal(DataSourceOutcome.Offline, ex.Outcome);
        var test = await _svc.TestAsync(CloudAiProvider.Anthropic, CancellationToken.None);
        Assert.Equal("offline", test.Result.Outcome);
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task Nothing_is_sent_without_the_explicit_opt_in()
    {
        _secrets.Items["VYSTRAL/AI-Anthropic"] = ClaudeKey;
        var ex = await Assert.ThrowsAsync<DataSourceException>(() => _svc.CompleteAsync(CloudAiProvider.Anthropic, new AiPrompt("s", "u", false), CancellationToken.None));
        Assert.Equal(DataSourceOutcome.Disabled, ex.Outcome);
        Assert.Empty(_sent);
    }

    [Fact]
    public async Task Test_makes_one_tiny_generation_with_the_chosen_model()
    {
        _secrets.Items["VYSTRAL/AI-Anthropic"] = ClaudeKey;
        _settings.Set("ai.cloud.anthropic.model", JsonValue.Create("claude-opus-5-5"));
        _respond = r =>
        {
            var body = JsonNode.Parse(r.Content!.ReadAsStringAsync().Result)!;
            Assert.Equal("claude-opus-5-5", body["model"]!.GetValue<string>());
            Assert.True(body["max_tokens"]!.GetValue<int>() <= 512);
            return FakeHandler.Json(HttpStatusCode.OK, """{"stop_reason":"end_turn","content":[{"type":"text","text":"OK"}]}""");
        };
        var r = await _svc.TestAsync(CloudAiProvider.Anthropic, CancellationToken.None);
        Assert.Equal("ok", r.Result.Outcome);
        Assert.Contains("Claude Opus 5.5", r.Result.Message);
    }

    [Fact]
    public async Task A_rejected_fallback_beta_is_retried_once_without_it()
    {
        _secrets.Items["VYSTRAL/AI-Anthropic"] = ClaudeKey;
        _settings.Set("ai.cloud.anthropic.optIn", JsonValue.Create(true));
        _respond = r => r.Headers.Contains("anthropic-beta")
            ? FakeHandler.Json(HttpStatusCode.BadRequest, """{"type":"error","error":{"type":"invalid_request_error","message":"fallbacks: not available"}}""")
            : FakeHandler.Json(HttpStatusCode.OK, """{"stop_reason":"end_turn","content":[{"type":"text","text":"fine"}]}""");
        Assert.Equal("fine", await _svc.CompleteAsync(CloudAiProvider.Anthropic, new AiPrompt("s", "u", false), CancellationToken.None));
        Assert.Equal(2, _sent.Count);
    }

    [Fact]
    public void The_local_budget_stops_a_runaway_loop()
    {
        var now = new DateTime(2026, 10, 10, 20, 0, 0, DateTimeKind.Utc);
        _svc.UtcNow = () => now;
        for (var i = 0; i < CloudAiService.WindowLimit; i++) _svc.Spend(CloudAiProvider.OpenAi);
        var ex = Assert.Throws<DataSourceException>(() => _svc.Spend(CloudAiProvider.OpenAi));
        Assert.Equal(DataSourceOutcome.RateLimited, ex.Outcome);
        _svc.Spend(CloudAiProvider.Gemini); // per provider
        now = now.AddMinutes(11);
        _svc.Spend(CloudAiProvider.OpenAi); // the window moved on
    }

    [Fact]
    public async Task Disconnect_removes_the_key_opt_in_and_selection()
    {
        _secrets.Items["VYSTRAL/AI-Gemini"] = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456";
        _settings.Set("ai.cloud.gemini.optIn", JsonValue.Create(true));
        _settings.Set("ai.provider", JsonValue.Create("gemini"));
        var s = _svc.Disconnect(CloudAiProvider.Gemini);
        Assert.False(s.Configured);
        Assert.Empty(_secrets.Items);
        Assert.False(_settings.GetBool("ai.cloud.gemini.optIn"));
        Assert.Equal("local", _settings.GetString("ai.provider"));
        await Task.CompletedTask;
    }

    [Fact]
    public async Task A_429_pauses_the_provider_and_is_a_handled_error()
    {
        _secrets.Items["VYSTRAL/AI-OpenAI"] = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789wxyz";
        _settings.Set("ai.cloud.openai.optIn", JsonValue.Create(true));
        _respond = _ =>
        {
            var r = FakeHandler.Json(HttpStatusCode.TooManyRequests, "{}");
            r.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(30));
            return r;
        };
        var ex = await Assert.ThrowsAsync<DataSourceException>(() => _svc.CompleteAsync(CloudAiProvider.OpenAi, new AiPrompt("s", "u", false), CancellationToken.None));
        Assert.Equal(DataSourceOutcome.RateLimited, ex.Outcome);
        Assert.NotNull(_svc.Status(CloudAiProvider.OpenAi).PausedUntil);
    }

    [Fact]
    public void Model_defaults_when_nothing_is_chosen_or_listed()
    {
        Assert.Equal("claude-sonnet-5-5", _svc.Model(CloudAiProvider.Anthropic));
        Assert.Equal(CloudAiProviders.OpenAiDefault, _svc.Model(CloudAiProvider.OpenAi));
        Assert.Equal(CloudAiProviders.GeminiDefault, _svc.Model(CloudAiProvider.Gemini));
        Assert.Equal("", _svc.Model(CloudAiProvider.Compatible));
        Assert.NotNull(_settings.Set("ai.cloud.anthropic.model", JsonValue.Create("claude-3-opus"))); // not one of the offered IDs
    }
}
