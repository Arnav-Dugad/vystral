using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Vystral.Windows.Services;

namespace Vystral.Windows.Bridge;

/// <summary>An expected failure whose message is safe and useful to show the user.</summary>
public sealed class BridgeException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// The only path from web content into native code. Messages are JSON envelopes
/// <c>{kind:"req", id, method, params}</c>; only registered methods run, parameters are bound
/// to typed records with unknown members rejected, and every handler validates its inputs.
/// </summary>
public sealed partial class BridgeDispatcher
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 32,
    };

    public const int MaxMessageChars = 256 * 1024;

    private readonly Dictionary<string, Func<JsonElement?, CancellationToken, Task<object?>>> _handlers = new(StringComparer.Ordinal);

    public IReadOnlyCollection<string> Methods => _handlers.Keys;

    public void Register(string method, Func<CancellationToken, Task<object?>> handler) =>
        _handlers[method] = (_, ct) => handler(ct);

    public void Register<TParams>(string method, Func<TParams, CancellationToken, Task<object?>> handler) where TParams : class =>
        _handlers[method] = (p, ct) =>
        {
            if (p is null || p.Value.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
                throw new BridgeException("invalid", $"{method} requires parameters.");
            TParams? args;
            try
            {
                args = p.Value.Deserialize<TParams>(Json);
            }
            catch (JsonException)
            {
                throw new BridgeException("invalid", $"Invalid parameters for {method}.");
            }
            return handler(args ?? throw new BridgeException("invalid", $"Invalid parameters for {method}."), ct);
        };

    /// <summary>
    /// Track D3: runs a registered handler from native code (the assistant's read-only tools), with the same parameter
    /// binding and validation as a call from the page. Errors surface as <see cref="BridgeException"/>.
    /// </summary>
    public async Task<object?> InvokeAsync(string method, object? parameters, CancellationToken ct)
    {
        if (!_handlers.TryGetValue(method, out var handler)) throw new BridgeException("unknown", "Unknown command.");
        JsonElement? p = parameters is null ? null : JsonSerializer.SerializeToElement(parameters, Json);
        return await handler(p, ct);
    }

    /// <summary>Handles one raw message from the UI and returns the JSON reply (or null for malformed input).</summary>
    public async Task<string?> HandleAsync(string raw, CancellationToken ct)
    {
        if (raw.Length > MaxMessageChars) return null;
        string? id = null;
        try
        {
            using var doc = JsonDocument.Parse(raw, new JsonDocumentOptions { MaxDepth = 32 });
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("kind", out var kind) || kind.GetString() != "req" ||
                !root.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.String ||
                !root.TryGetProperty("method", out var methodEl) || methodEl.ValueKind != JsonValueKind.String)
                return null;

            id = idEl.GetString();
            if (id is null || !RequestId().IsMatch(id)) return null;
            var method = methodEl.GetString()!;
            if (!_handlers.TryGetValue(method, out var handler))
                return Error(id, "unknown", $"Unknown command '{Truncate(method, 60)}'.");

            JsonElement? parameters = root.TryGetProperty("params", out var p) ? p.Clone() : null;
            var result = await handler(parameters, ct);
            return JsonSerializer.Serialize(new { kind = "res", id, ok = true, result }, Json);
        }
        catch (BridgeException ex)
        {
            return id is null ? null : Error(id, ex.Code, ex.Message);
        }
        catch (JsonException)
        {
            return id is null ? null : Error(id, "invalid", "Malformed request.");
        }
        catch (OperationCanceledException)
        {
            return id is null ? null : Error(id, "cancelled", "The operation was cancelled.");
        }
        catch (Exception ex)
        {
            Log.Error("bridge", "Unhandled bridge error", ex);
            return id is null ? null : Error(id, "internal", "Something went wrong inside VYSTRAL. Details were written to the log.");
        }
    }

    public static string EventJson(string name, object? payload) =>
        JsonSerializer.Serialize(new { kind = "evt", name, payload }, Json);

    private static string Error(string id, string code, string message) =>
        JsonSerializer.Serialize(new { kind = "res", id, ok = false, error = new { code, message } }, Json);

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];

    // ---------- Validation helpers used by handlers ----------

    public static string RequireId(string? id, string what = "id") =>
        id is not null && EntityId().IsMatch(id) ? id : throw new BridgeException("invalid", $"Invalid {what}.");

    public static string RequireText(string? s, int maxLength, string what, bool allowEmpty = false)
    {
        if (s is null || (!allowEmpty && string.IsNullOrWhiteSpace(s))) throw new BridgeException("invalid", $"{what} is required.");
        if (s.Length > maxLength) throw new BridgeException("invalid", $"{what} is too long (max {maxLength} characters).");
        if (s.Any(c => char.IsControl(c) && c is not ('\n' or '\r' or '\t'))) throw new BridgeException("invalid", $"{what} contains invalid characters.");
        return s;
    }

    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,40}\z")]
    private static partial Regex RequestId();

    [GeneratedRegex(@"^[0-9a-f]{32}\z")]
    private static partial Regex EntityId();
}
