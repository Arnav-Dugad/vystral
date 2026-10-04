using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Vystral.Core.Contracts;
using Vystral.Windows.Bridge;

namespace Vystral.Windows.Services;

public sealed record AiModelDto(string Name, long SizeBytes);

public sealed record AiStatusDto(bool Enabled, bool Running, string? Version, IReadOnlyList<AiModelDto> Models,
    string SelectedModel, bool SelectedModelInstalled, AiRecommendationDto Recommended, string? Problem);

public sealed record AiRecommendationDto(string Name, double DownloadGb, string License, string Why);

/// <summary>
/// Optional local AI through Ollama on localhost. The model only ever *describes* or
/// *proposes*; it cannot run commands. Structured answers are validated here before the UI
/// sees them, and any action they suggest still goes through the normal, user-confirmed bridge.
/// </summary>
public sealed partial class OllamaService
{
    public static readonly AiRecommendationDto Recommended = new("qwen3:4b", 2.5, "Apache-2.0",
        "Small enough for 8 GB laptop GPUs while handling search and recommendations well.");

    private static readonly Uri Base = new("http://127.0.0.1:11434/");
    private readonly HttpClient _http;
    private readonly SettingsService _settings;
    private readonly IEventSink _events;
    private CancellationTokenSource? _pullCts;
    private CancellationTokenSource? _chatCts;

    public Func<bool> IsGameRunning { get; set; } = () => false;

    public OllamaService(SettingsService settings, IEventSink events)
    {
        _settings = settings;
        _events = events;
        _http = new HttpClient { BaseAddress = Base, Timeout = Timeout.InfiniteTimeSpan };
    }

    public static bool IsValidModelName(string name) => name.Length is > 0 and <= 80 && ModelName().IsMatch(name);

    public async Task<AiStatusDto> GetStatusAsync(CancellationToken ct)
    {
        var enabled = _settings.GetBool("ai.enabled");
        var selected = _settings.GetString("ai.model");
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromMilliseconds(1500));
            var version = (await _http.GetFromJsonAsync<JsonObject>("api/version", cts.Token))?["version"]?.GetValue<string>();
            var tags = await _http.GetFromJsonAsync<JsonObject>("api/tags", cts.Token);
            var models = (tags?["models"] as JsonArray ?? [])
                .OfType<JsonObject>()
                .Select(m => new AiModelDto(m["name"]?.GetValue<string>() ?? "?", m["size"]?.GetValue<long>() ?? 0))
                .ToList();
            var installed = models.Any(m => m.Name == selected || m.Name == selected + ":latest");
            return new AiStatusDto(enabled, true, version, models, selected, installed, Recommended, null);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            return new AiStatusDto(enabled, false, null, [], selected, false, Recommended,
                "Ollama isn't running on this PC. Install it from ollama.com and start it to use local AI. Everything else in VYSTRAL works without it.");
        }
    }

    /// <summary>Downloads a model. Only called after the UI showed the size and the user confirmed.</summary>
    public async Task PullAsync(string model)
    {
        if (!IsValidModelName(model)) throw new BridgeException("invalid", "That model name isn't valid.");
        _pullCts?.Cancel();
        var cts = _pullCts = new CancellationTokenSource();
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "api/pull") { Content = JsonContent.Create(new { model, stream = true }) };
            using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            res.EnsureSuccessStatusCode();
            await foreach (var obj in ReadNdjson(res, cts.Token))
            {
                _events.Emit("ai.pull", new
                {
                    model,
                    status = obj["status"]?.GetValue<string>(),
                    total = obj["total"]?.GetValue<long>(),
                    completed = obj["completed"]?.GetValue<long>(),
                    error = obj["error"]?.GetValue<string>(),
                });
            }
            _events.Emit("ai.pull", new { model, status = "done" });
        }
        catch (OperationCanceledException)
        {
            _events.Emit("ai.pull", new { model, status = "cancelled" });
        }
        catch (HttpRequestException ex)
        {
            _events.Emit("ai.pull", new { model, status = "error", error = $"Download failed: {ex.Message}" });
        }
    }

    public void CancelPull() => _pullCts?.Cancel();

    /// <summary>Streams an assistant answer grounded in the provided library context.</summary>
    public async Task ChatAsync(string requestId, IReadOnlyList<(string Role, string Content)> history, string libraryContext)
    {
        EnsureAllowed();
        _chatCts?.Cancel();
        var cts = _chatCts = new CancellationTokenSource();
        var messages = new JsonArray
        {
            new JsonObject { ["role"] = "system", ["content"] = SystemPrompt + "\n\nLIBRARY DATA (verified, from this PC):\n" + libraryContext },
        };
        foreach (var (role, content) in history.TakeLast(12))
            messages.Add(new JsonObject { ["role"] = role == "assistant" ? "assistant" : "user", ["content"] = content });

        var body = new JsonObject
        {
            ["model"] = _settings.GetString("ai.model"),
            ["messages"] = messages,
            ["stream"] = true,
            ["think"] = false,
            ["options"] = new JsonObject { ["temperature"] = 0.4, ["num_ctx"] = 8192 },
        };
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "api/chat") { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };
            using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            if (!res.IsSuccessStatusCode)
            {
                _events.Emit("ai.chat", new { requestId, done = true, error = await ModelError(res) });
                return;
            }
            await foreach (var obj in ReadNdjson(res, cts.Token))
            {
                if (IsGameRunning())
                {
                    _events.Emit("ai.chat", new { requestId, done = true, error = "Paused because a game is running." });
                    return;
                }
                var delta = obj["message"]?["content"]?.GetValue<string>();
                if (!string.IsNullOrEmpty(delta)) _events.Emit("ai.chat", new { requestId, delta });
            }
            _events.Emit("ai.chat", new { requestId, done = true });
        }
        catch (OperationCanceledException)
        {
            _events.Emit("ai.chat", new { requestId, done = true, error = "Stopped." });
        }
        catch (HttpRequestException)
        {
            _events.Emit("ai.chat", new { requestId, done = true, error = "Ollama stopped responding." });
        }
    }

    public void CancelChat() => _chatCts?.Cancel();

    /// <summary>
    /// Turns a natural-language library query into a validated filter object. Returns null
    /// when the model's output doesn't fit the schema; the UI then falls back to plain search.
    /// </summary>
    public async Task<JsonObject?> ParseQueryAsync(string query, IReadOnlyList<string> knownGenres, CancellationToken ct)
    {
        EnsureAllowed();
        var schema = JsonNode.Parse(QuerySchema)!;
        var body = new JsonObject
        {
            ["model"] = _settings.GetString("ai.model"),
            ["stream"] = false,
            ["think"] = false,
            ["format"] = schema,
            ["options"] = new JsonObject { ["temperature"] = 0 },
            ["messages"] = new JsonArray
            {
                new JsonObject
                {
                    ["role"] = "system",
                    ["content"] = "Convert the user's request about their game library into JSON matching the schema. " +
                                  "Use only these genres if relevant: " + string.Join(", ", knownGenres.Take(60)) +
                                  ". Platforms: steam, xbox, epic, gog, ea, ubisoft, battlenet, manual. Omit fields you are unsure about.",
                },
                new JsonObject { ["role"] = "user", ["content"] = query.Length > 300 ? query[..300] : query },
            },
        };
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(20));
        using var res = await _http.PostAsync("api/chat", new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"), cts.Token);
        if (!res.IsSuccessStatusCode) return null;
        var reply = await res.Content.ReadFromJsonAsync<JsonObject>(cts.Token);
        var content = reply?["message"]?["content"]?.GetValue<string>();
        if (content is null) return null;
        try
        {
            return ValidateQuery(JsonNode.Parse(content) as JsonObject);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    internal static JsonObject? ValidateQuery(JsonObject? o)
    {
        if (o is null) return null;
        var result = new JsonObject();
        var intent = o["intent"]?.GetValue<string>();
        if (intent is not ("filter" or "launch" or "recommend")) return null;
        result["intent"] = intent;
        if (o["title"] is JsonValue t && t.TryGetValue<string>(out var title) && title.Length <= 120) result["title"] = title;
        if (o["installed"] is JsonValue i && i.TryGetValue<bool>(out var inst)) result["installed"] = inst;
        if (o["favorite"] is JsonValue f && f.TryGetValue<bool>(out var fav)) result["favorite"] = fav;
        if (o["platforms"] is JsonArray ps)
            result["platforms"] = new JsonArray(ps.Select(p => p?.GetValue<string>()).Where(p => p is "steam" or "xbox" or "epic" or "gog" or "ea" or "ubisoft" or "battlenet" or "manual").Select(p => (JsonNode)p!).ToArray());
        if (o["genres"] is JsonArray gs)
            result["genres"] = new JsonArray(gs.Select(g => g?.GetValue<string>()).Where(g => g is { Length: > 0 and <= 40 }).Take(5).Select(g => (JsonNode)g!).ToArray());
        foreach (var key in new[] { "maxSizeGb", "minSizeGb", "notPlayedDays", "playedWithinDays" })
            if (o[key] is JsonValue n && n.TryGetValue<double>(out var d) && d is >= 0 and <= 100000) result[key] = d;
        if (o["drive"] is JsonValue dv && dv.TryGetValue<string>(out var drive) && DriveLetter().IsMatch(drive)) result["drive"] = drive.ToUpperInvariant()[..1] + ":";
        return result;
    }

    private void EnsureAllowed()
    {
        if (!_settings.GetBool("ai.enabled")) throw new BridgeException("disabled", "Local AI is turned off in Settings.");
        if (IsGameRunning()) throw new BridgeException("busy", "Local AI is paused while a game is running, to keep your game smooth.");
    }

    private static async Task<string> ModelError(HttpResponseMessage res)
    {
        var text = await res.Content.ReadAsStringAsync();
        return text.Contains("not found", StringComparison.OrdinalIgnoreCase)
            ? "The selected model isn't installed in Ollama yet. Download it from Settings → Local AI."
            : $"Ollama returned an error ({(int)res.StatusCode}).";
    }

    private static async IAsyncEnumerable<JsonObject> ReadNdjson(HttpResponseMessage res,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0) continue;
            JsonObject? obj;
            try { obj = JsonNode.Parse(line) as JsonObject; }
            catch (JsonException) { continue; }
            if (obj is not null) yield return obj;
        }
    }

    /// <summary>Compact, factual context so the model never needs to guess about the library.</summary>
    public static string BuildLibraryContext(LibrarySnapshotDto snapshot, int maxGames = 150)
    {
        var sb = new StringBuilder();
        sb.AppendLine("title | platforms | installed | genres | tracked_hours | store_hours | last_played");
        foreach (var g in snapshot.Games.Where(g => !g.Hidden)
                     .OrderByDescending(g => g.LastTrackedPlay ?? g.Installations.Max(i => i.ImportedLastPlayed) ?? "")
                     .Take(maxGames))
        {
            var store = g.Installations.Max(i => i.ImportedPlaytimeMinutes) is int m ? (m / 60.0).ToString("0.#") : "unknown";
            var last = new[] { g.LastTrackedPlay }.Concat(g.Installations.Select(i => i.ImportedLastPlayed)).Where(x => x is not null).Max() ?? "never/unknown";
            sb.Append(g.Title).Append(" | ").Append(string.Join("+", g.Installations.Select(i => i.Platform).Distinct()))
              .Append(" | ").Append(g.Installations.Any(i => i.State == "installed") ? "yes" : "no")
              .Append(" | ").Append(g.Genres.Count == 0 ? "unknown" : string.Join(", ", g.Genres))
              .Append(" | ").Append((g.TrackedSeconds / 3600.0).ToString("0.#"))
              .Append(" | ").Append(store).Append(" | ").AppendLine(last.Length > 10 ? last[..10] : last);
        }
        return sb.ToString();
    }

    private const string SystemPrompt =
        "You are VYSTRAL's local game-library assistant running on the user's PC. Rules: " +
        "1) Only state facts that appear in LIBRARY DATA; if something is unknown, say it is unknown. " +
        "2) Never invent achievements, playtime, ownership, performance numbers or features. " +
        "3) Clearly label opinions and recommendations as suggestions. " +
        "4) You cannot perform actions; describe what the user can do in VYSTRAL instead. " +
        "5) Be concise and friendly. Use short paragraphs or bullet lists.";

    private const string QuerySchema = """
        {"type":"object","properties":{
          "intent":{"type":"string","enum":["filter","launch","recommend"]},
          "title":{"type":"string"},
          "installed":{"type":"boolean"},
          "favorite":{"type":"boolean"},
          "platforms":{"type":"array","items":{"type":"string"}},
          "genres":{"type":"array","items":{"type":"string"}},
          "maxSizeGb":{"type":"number"},"minSizeGb":{"type":"number"},
          "notPlayedDays":{"type":"number"},"playedWithinDays":{"type":"number"},
          "drive":{"type":"string"}},
         "required":["intent"]}
        """;

    [GeneratedRegex(@"^[a-zA-Z0-9][a-zA-Z0-9._\-/]*(:[a-zA-Z0-9._\-]+)?$")]
    private static partial Regex ModelName();

    [GeneratedRegex(@"^[A-Za-z]:?$")]
    private static partial Regex DriveLetter();
}
