using System.Text.Json;
using Vystral.Windows.Bridge;
using Xunit;

namespace Vystral.Tests.Bridge;

public sealed class BridgeDispatcherTests
{
    public sealed record EchoParams(string Name, int Count);

    public sealed record OptionalParams(string? GameId, bool? Favorite);

    public sealed record ResultShape(string GameId, int TrackedSeconds);

    private readonly BridgeDispatcher _d = new();

    public BridgeDispatcherTests()
    {
        _d.Register("ping", _ => Task.FromResult<object?>("pong"));
        _d.Register("nothing", _ => Task.FromResult<object?>(null));
        _d.Register("shape", _ => Task.FromResult<object?>(new ResultShape("abc", 42)));
        _d.Register<EchoParams>("echo", (p, _) => Task.FromResult<object?>($"{p.Name}x{p.Count}"));
        _d.Register<OptionalParams>("optional", (p, _) => Task.FromResult<object?>(new { p.GameId, p.Favorite }));
        _d.Register("fail.bridge", _ => throw new BridgeException("notFound", "That game no longer exists."));
        _d.Register("fail.internal", _ => throw new InvalidOperationException(@"secret detail C:\Users\me\token.txt"));
        _d.Register("fail.async", async _ => { await Task.Yield(); throw new IOException("disk secret"); });
        _d.Register("fail.cancel", _ => throw new OperationCanceledException());
        _d.Register("fail.json", _ => throw new JsonException("inner json secret"));
        _d.Register("cancellable", ct => { ct.ThrowIfCancellationRequested(); return Task.FromResult<object?>("ran"); });
    }

    private static string Req(string method, string? paramsJson = null, string id = "r1") =>
        paramsJson is null
            ? $$"""{"kind":"req","id":"{{id}}","method":"{{method}}"}"""
            : $$"""{"kind":"req","id":"{{id}}","method":"{{method}}","params":{{paramsJson}}}""";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private Task<JsonElement> Call(string raw) => CallWithToken(raw, Ct);

    private async Task<JsonElement> CallWithToken(string raw, CancellationToken ct)
    {
        var reply = await _d.HandleAsync(raw, ct);
        Assert.NotNull(reply);
        return JsonDocument.Parse(reply).RootElement.Clone();
    }

    private static void AssertError(JsonElement reply, string code)
    {
        Assert.Equal("res", reply.GetProperty("kind").GetString());
        Assert.False(reply.GetProperty("ok").GetBoolean());
        Assert.Equal(code, reply.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Successful_call_returns_result_envelope()
    {
        var reply = await Call(Req("ping", id: "abc-123_X"));
        Assert.Equal("res", reply.GetProperty("kind").GetString());
        Assert.Equal("abc-123_X", reply.GetProperty("id").GetString());
        Assert.True(reply.GetProperty("ok").GetBoolean());
        Assert.Equal("pong", reply.GetProperty("result").GetString());
    }

    [Fact]
    public async Task Null_result_is_serialized_explicitly()
    {
        var raw = await _d.HandleAsync(Req("nothing"), Ct);
        Assert.Equal("""{"kind":"res","id":"r1","ok":true,"result":null}""", raw);
    }

    [Fact]
    public async Task Results_are_serialized_in_camel_case()
    {
        var reply = await Call(Req("shape"));
        var result = reply.GetProperty("result");
        Assert.Equal("abc", result.GetProperty("gameId").GetString());
        Assert.Equal(42, result.GetProperty("trackedSeconds").GetInt32());
    }

    [Fact]
    public async Task Unknown_method_returns_unknown_error()
    {
        var reply = await Call(Req("library.dropTables"));
        AssertError(reply, "unknown");
        Assert.Equal("r1", reply.GetProperty("id").GetString());
        Assert.Contains("library.dropTables", reply.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Unknown_method_name_is_truncated_in_the_message()
    {
        var longName = new string('m', 500);
        var reply = await Call(Req(longName));
        var message = reply.GetProperty("error").GetProperty("message").GetString()!;
        Assert.Contains(new string('m', 60), message);
        Assert.DoesNotContain(new string('m', 61), message);
    }

    [Fact]
    public async Task Method_lookup_is_case_sensitive()
    {
        AssertError(await Call(Req("PING")), "unknown");
    }

    [Theory]
    [InlineData("")]
    [InlineData("{not json")]
    [InlineData("null")]
    [InlineData("42")]
    [InlineData("\"req\"")]
    [InlineData("[{\"kind\":\"req\",\"id\":\"1\",\"method\":\"ping\"}]")]
    [InlineData("{\"kind\":\"req\",\"id\":\"1\",\"method\":\"ping\"")]
    public async Task Malformed_json_returns_null(string raw) => Assert.Null(await _d.HandleAsync(raw, Ct));

    [Theory]
    [InlineData("{\"id\":\"1\",\"method\":\"ping\"}")]
    [InlineData("{\"kind\":\"evt\",\"id\":\"1\",\"method\":\"ping\"}")]
    [InlineData("{\"kind\":\"res\",\"id\":\"1\",\"method\":\"ping\"}")]
    [InlineData("{\"kind\":\"req\",\"method\":\"ping\"}")]
    [InlineData("{\"kind\":\"req\",\"id\":1,\"method\":\"ping\"}")]
    [InlineData("{\"kind\":\"req\",\"id\":null,\"method\":\"ping\"}")]
    [InlineData("{\"kind\":\"req\",\"id\":\"1\"}")]
    [InlineData("{\"kind\":\"req\",\"id\":\"1\",\"method\":7}")]
    public async Task Missing_or_wrong_envelope_fields_return_null(string raw) =>
        Assert.Null(await _d.HandleAsync(raw, Ct));

    [Fact]
    public async Task Non_string_kind_returns_null_without_throwing()
    {
        Assert.Null(await _d.HandleAsync("{\"kind\":1,\"id\":\"1\",\"method\":\"ping\"}", Ct));
    }

    [Theory]
    [InlineData("")]
    [InlineData("has space")]
    [InlineData("semi;colon")]
    [InlineData("quote\\\"")]
    [InlineData("dot.ted")]
    [InlineData("ünï")]
    [InlineData("12345678901234567890123456789012345678901")]
    [InlineData("abc\\n")]
    public async Task Invalid_request_id_returns_null(string id)
    {
        var raw = $$"""{"kind":"req","id":"{{id}}","method":"ping"}""";
        Assert.Null(await _d.HandleAsync(raw, Ct));
    }

    [Fact]
    public async Task Forty_character_id_is_accepted()
    {
        var id = new string('a', 40);
        Assert.Equal(id, (await Call(Req("ping", id: id))).GetProperty("id").GetString());
    }

    [Fact]
    public async Task Oversized_message_returns_null_even_if_valid()
    {
        var padding = new string(' ', BridgeDispatcher.MaxMessageChars);
        Assert.Null(await _d.HandleAsync(Req("ping") + padding, Ct));

        var exactlyMax = Req("ping");
        exactlyMax += new string(' ', BridgeDispatcher.MaxMessageChars - exactlyMax.Length);
        Assert.NotNull(await _d.HandleAsync(exactlyMax, Ct));
    }

    [Fact]
    public async Task Excessively_nested_json_is_rejected()
    {
        var deep = new string('[', 100) + new string(']', 100);
        Assert.Null(await _d.HandleAsync($$"""{"kind":"req","id":"1","method":"ping","params":{{deep}}}""", Ct));
    }

    [Fact]
    public async Task Typed_params_bind_case_insensitively_from_camel_case()
    {
        var reply = await Call(Req("echo", """{"name":"Hades","count":3}"""));
        Assert.True(reply.GetProperty("ok").GetBoolean());
        Assert.Equal("Hadesx3", reply.GetProperty("result").GetString());
    }

    [Fact]
    public async Task Optional_params_may_be_omitted()
    {
        var reply = await Call(Req("optional", "{}"));
        Assert.True(reply.GetProperty("ok").GetBoolean());
        Assert.Equal(JsonValueKind.Null, reply.GetProperty("result").GetProperty("gameId").ValueKind);
    }

    [Fact]
    public async Task Unknown_member_in_params_is_rejected()
    {
        var reply = await Call(Req("echo", """{"name":"x","count":1,"isAdmin":true}"""));
        AssertError(reply, "invalid");
        Assert.Equal("Invalid parameters for echo.", reply.GetProperty("error").GetProperty("message").GetString());
    }

    [Theory]
    [InlineData("""{"name":"x","count":"three"}""")]
    [InlineData("""{"name":5,"count":1}""")]
    [InlineData("\"just a string\"")]
    [InlineData("[1,2]")]
    [InlineData("""{"name":"x","count":1.5}""")]
    public async Task Wrongly_typed_params_are_rejected(string paramsJson) =>
        AssertError(await Call(Req("echo", paramsJson)), "invalid");

    [Theory]
    [InlineData(null)]
    [InlineData("null")]
    public async Task Missing_params_for_typed_handler_are_rejected(string? paramsJson)
    {
        var reply = await Call(Req("echo", paramsJson));
        AssertError(reply, "invalid");
        Assert.Contains("requires parameters", reply.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Params_are_ignored_by_parameterless_handlers()
    {
        var reply = await Call(Req("ping", """{"anything":1}"""));
        Assert.True(reply.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task BridgeException_code_and_message_are_propagated()
    {
        var reply = await Call(Req("fail.bridge"));
        AssertError(reply, "notFound");
        Assert.Equal("That game no longer exists.", reply.GetProperty("error").GetProperty("message").GetString());
    }

    [Theory]
    [InlineData("fail.internal", "secret")]
    [InlineData("fail.async", "disk secret")]
    public async Task Unexpected_exceptions_become_internal_without_leaking_details(string method, string secret)
    {
        var raw = await _d.HandleAsync(Req(method), Ct);
        Assert.NotNull(raw);
        Assert.DoesNotContain(secret, raw);
        Assert.DoesNotContain("Users", raw);
        var reply = JsonDocument.Parse(raw).RootElement;
        AssertError(reply, "internal");
        Assert.Contains("log", reply.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Json_exceptions_from_handlers_become_invalid_without_leaking_details()
    {
        var raw = await _d.HandleAsync(Req("fail.json"), Ct);
        Assert.DoesNotContain("secret", raw);
        AssertError(JsonDocument.Parse(raw!).RootElement, "invalid");
    }

    [Fact]
    public async Task Cancellation_is_reported_as_cancelled()
    {
        AssertError(await Call(Req("fail.cancel")), "cancelled");

        using var cts = new CancellationTokenSource();
        cts.Cancel();
        AssertError(await CallWithToken(Req("cancellable"), cts.Token), "cancelled");
    }

    [Fact]
    public void Methods_lists_registered_handlers_and_re_registration_replaces()
    {
        Assert.Contains("ping", _d.Methods);
        Assert.Contains("echo", _d.Methods);
        var count = _d.Methods.Count;
        _d.Register("ping", _ => Task.FromResult<object?>("pong2"));
        Assert.Equal(count, _d.Methods.Count);
    }

    [Fact]
    public async Task Re_registered_handler_is_used()
    {
        _d.Register("ping", _ => Task.FromResult<object?>("pong2"));
        Assert.Equal("pong2", (await Call(Req("ping"))).GetProperty("result").GetString());
    }

    // ---------- Validation helpers ----------

    [Fact]
    public void RequireId_accepts_32_lowercase_hex()
    {
        const string id = "0123456789abcdef0123456789abcdef";
        Assert.Equal(id, BridgeDispatcher.RequireId(id));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0123456789ABCDEF0123456789ABCDEF")]
    [InlineData("0123456789abcdef0123456789abcde")]
    [InlineData("0123456789abcdef0123456789abcdef0")]
    [InlineData("0123456789abcdef0123456789abcdeg")]
    [InlineData("../../../../etc/passwd")]
    [InlineData("0123456789abcdef0123456789abcdef\n")]
    [InlineData(" 0123456789abcdef0123456789abcdef")]
    public void RequireId_rejects_anything_else(string? id)
    {
        var ex = Assert.Throws<BridgeException>(() => BridgeDispatcher.RequireId(id, "gameId"));
        Assert.Equal("invalid", ex.Code);
        Assert.Equal("Invalid gameId.", ex.Message);
    }

    [Theory]
    [InlineData("Hello")]
    [InlineData("multi\nline\r\nwith\ttab")]
    [InlineData("Ünïcödé ✓")]
    public void RequireText_accepts_normal_text(string s) => Assert.Equal(s, BridgeDispatcher.RequireText(s, 100, "Note"));

    [Theory]
    [InlineData(null, "Note is required.")]
    [InlineData("", "Note is required.")]
    [InlineData("   ", "Note is required.")]
    [InlineData("bad\0char", "Note contains invalid characters.")]
    [InlineData("esc\u001b", "Note contains invalid characters.")]
    [InlineData("bell\u0007", "Note contains invalid characters.")]
    public void RequireText_rejects_missing_or_invalid(string? s, string message)
    {
        var ex = Assert.Throws<BridgeException>(() => BridgeDispatcher.RequireText(s, 100, "Note"));
        Assert.Equal("invalid", ex.Code);
        Assert.Equal(message, ex.Message);
    }

    [Fact]
    public void RequireText_enforces_max_length()
    {
        Assert.Equal(new string('a', 10), BridgeDispatcher.RequireText(new string('a', 10), 10, "Title"));
        var ex = Assert.Throws<BridgeException>(() => BridgeDispatcher.RequireText(new string('a', 11), 10, "Title"));
        Assert.Equal("Title is too long (max 10 characters).", ex.Message);
    }

    [Fact]
    public void RequireText_allowEmpty_permits_blank_but_not_null()
    {
        Assert.Equal("", BridgeDispatcher.RequireText("", 10, "Args", allowEmpty: true));
        Assert.Equal("  ", BridgeDispatcher.RequireText("  ", 10, "Args", allowEmpty: true));
        Assert.Throws<BridgeException>(() => BridgeDispatcher.RequireText(null, 10, "Args", allowEmpty: true));
    }

    [Fact]
    public void EventJson_has_kind_name_and_camel_case_payload()
    {
        var json = BridgeDispatcher.EventJson("library.changed", new { GameCount = 3, LastScan = (string?)null });
        Assert.Equal("""{"kind":"evt","name":"library.changed","payload":{"gameCount":3,"lastScan":null}}""", json);
    }

    [Fact]
    public void EventJson_with_null_payload_keeps_the_property()
    {
        Assert.Equal("""{"kind":"evt","name":"ping","payload":null}""", BridgeDispatcher.EventJson("ping", null));
    }

    [Fact]
    public void EventJson_escapes_html_sensitive_characters()
    {
        var json = BridgeDispatcher.EventJson("x", new { text = "</script><img onerror=alert(1)>" });
        Assert.DoesNotContain("</script>", json);
        Assert.Equal("</script><img onerror=alert(1)>", JsonDocument.Parse(json).RootElement.GetProperty("payload").GetProperty("text").GetString());
    }
}
