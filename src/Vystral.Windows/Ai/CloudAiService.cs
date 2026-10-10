using System.Text.Json;
using Vystral.Core.Data;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;

namespace Vystral.Windows.Ai;

public sealed record CloudAiTestDto(string Outcome, string Message, string At);

public sealed record CloudAiProviderDto(string Id, string Name, string Company, bool Configured, string? KeyMasked, bool OptedIn,
    string Model, string ModelLabel, IReadOnlyList<string> Models, bool ModelsListed, string? BaseUrl, CloudAiTestDto? LastTest,
    string? PausedUntil, string Host);

public sealed record CloudAiActionDto(CloudAiTestDto Result, CloudAiProviderDto Provider);

/// <summary>
/// Track C5: the optional cloud AI providers. Keys come from Credential Manager on demand and never leave this
/// class (the page only gets "…1234"). Every request goes through one polite lane per provider (spaced, a
/// Retry-After-aware pause on 429, answers size-capped, only the URL path logged), a local budget (at most
/// <see cref="WindowLimit"/> requests per <see cref="Window"/> and <see cref="DailyLimit"/> a day), a whole-request
/// time limit, no redirects (a redirect could carry the key elsewhere), and nothing at all while Offline mode is on.
/// </summary>
public sealed class CloudAiService
{
    public const int WindowLimit = 30;
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(10);
    public const int DailyLimit = 400;
    public static readonly TimeSpan RequestLimit = TimeSpan.FromSeconds(60);

    private readonly SettingsService _settings;
    private readonly LibraryRepository _repo;
    private readonly CloudAiKeyStore _keys;
    private readonly Dictionary<CloudAiProvider, ProviderTransport> _lanes = [];
    private readonly Dictionary<CloudAiProvider, Queue<DateTime>> _recent = [];
    private readonly Dictionary<CloudAiProvider, IReadOnlyList<string>> _models = [];
    private readonly Lock _lock = new();

    public Func<DateTime> UtcNow { get; set; } = () => DateTime.UtcNow;

    public CloudAiService(SettingsService settings, LibraryRepository repo, ISecretStore secrets, HttpClient http)
    {
        _settings = settings;
        _repo = repo;
        _keys = new CloudAiKeyStore(secrets);
        foreach (var p in CloudAiProviders.All)
        {
            _lanes[p] = new ProviderTransport(http, "ai-" + CloudAiProviders.Id(p), CloudAiProviders.Name(p), TimeSpan.FromMilliseconds(1000), 2 * 1024 * 1024)
            {
                RequestTimeout = RequestLimit,
            };
            _recent[p] = new Queue<DateTime>();
        }
    }

    /// <summary>A client for cloud AI: no automatic redirects (custom key headers would follow them) and no client-wide timeout (each request has its own).</summary>
    public static HttpClient CreateHttpClient(HttpClient template)
    {
        var http = new HttpClient(FastConnect.CreateHandler(allowRedirects: false)) { Timeout = Timeout.InfiniteTimeSpan };
        foreach (var ua in template.DefaultRequestHeaders.UserAgent) http.DefaultRequestHeaders.UserAgent.Add(ua);
        return http;
    }

    internal ProviderTransport Lane(CloudAiProvider p) => _lanes[p];

    public bool LocalOnly => _settings.GetBool("privacy.localOnly");

    public bool IsConfigured(CloudAiProvider p) => _keys.IsConfigured(p) && (p != CloudAiProvider.Compatible || BaseUri() is not null);

    public bool OptedIn(CloudAiProvider p) => _settings.GetBool(CloudAiProviders.OptInSetting(p));

    /// <summary>Ready to send: key stored, explicitly opted in, and Offline mode off.</summary>
    public bool IsReady(CloudAiProvider p) => !LocalOnly && OptedIn(p) && IsConfigured(p);

    public Uri? BaseUri() =>
        CloudAiClient.NormalizeBaseUrl(_settings.GetString(CloudAiProviders.CompatibleUrlSetting)) is { } u ? new Uri(u) : null;

    public string Model(CloudAiProvider p)
    {
        var chosen = _settings.GetString(CloudAiProviders.ModelSetting(p));
        if (p == CloudAiProvider.Anthropic) return CloudAiProviders.ClaudeModels.Contains(chosen) ? chosen : CloudAiProviders.ClaudeDefault;
        if (CloudAiClient.IsValidModel(chosen)) return chosen;
        lock (_lock)
        {
            if (_models.TryGetValue(p, out var listed) && listed.Count > 0)
            {
                var preferred = p switch
                {
                    CloudAiProvider.OpenAi => CloudAiProviders.OpenAiDefault,
                    CloudAiProvider.Gemini => CloudAiProviders.GeminiDefault,
                    _ => null,
                };
                return preferred is not null && listed.Contains(preferred) ? preferred : preferred ?? listed[0];
            }
        }
        return p switch
        {
            CloudAiProvider.OpenAi => CloudAiProviders.OpenAiDefault,
            CloudAiProvider.Gemini => CloudAiProviders.GeminiDefault,
            _ => "",
        };
    }

    // ---------------- Status ----------------

    public CloudAiProviderDto Status(CloudAiProvider p)
    {
        IReadOnlyList<string> models;
        bool listed;
        lock (_lock) listed = _models.TryGetValue(p, out models!);
        if (p == CloudAiProvider.Anthropic) { models = CloudAiProviders.ClaudeModels; listed = true; }
        models ??= [];
        var model = Model(p);
        return new CloudAiProviderDto(CloudAiProviders.Id(p), CloudAiProviders.Name(p), CloudAiProviders.Company(p), IsConfigured(p), _keys.Masked(p),
            OptedIn(p), model, CloudAiProviders.ModelLabel(model), models, listed,
            p == CloudAiProvider.Compatible ? BaseUri()?.AbsoluteUri : null, LastTest(p), _lanes[p].BlockedUntil?.ToString("O"), Host(p));
    }

    public string Host(CloudAiProvider p) => p switch
    {
        CloudAiProvider.Anthropic => "api.anthropic.com",
        CloudAiProvider.OpenAi => "api.openai.com",
        CloudAiProvider.Gemini => "generativelanguage.googleapis.com",
        _ => BaseUri()?.Host ?? "(not set)",
    };

    private CloudAiTestDto? LastTest(CloudAiProvider p)
    {
        var raw = _repo.GetInternalValue($"ai.cloud.lastTest.{CloudAiProviders.Id(p)}");
        if (raw is null) return null;
        try { return JsonSerializer.Deserialize<CloudAiTestDto>(raw, JsonFileCache.Options); }
        catch (JsonException) { return null; }
    }

    private CloudAiTestDto Record(CloudAiProvider p, DataSourceOutcome outcome, string message)
    {
        var dto = new CloudAiTestDto(char.ToLowerInvariant(outcome.ToString()[0]) + outcome.ToString()[1..], message, DateTimeOffset.UtcNow.ToString("O"));
        _repo.SetInternalValue($"ai.cloud.lastTest.{CloudAiProviders.Id(p)}", JsonSerializer.Serialize(dto, JsonFileCache.Options));
        return dto;
    }

    // ---------------- Connect, test, disconnect, models ----------------

    /// <summary>
    /// Checks a pasted key with the provider's free models list and stores it only if the provider accepts it.
    /// For the compatible endpoint, <paramref name="baseUrl"/> is saved too (it isn't a secret).
    /// </summary>
    public async Task<CloudAiActionDto> ConnectAsync(CloudAiProvider p, string pastedKey, string? baseUrl, CancellationToken ct)
    {
        CloudAiTestDto result;
        try
        {
            RequireOnline(p);
            var key = CloudAiKeyStore.Normalize(pastedKey)
                      ?? throw new DataSourceException(DataSourceOutcome.InvalidKey, "That doesn’t look like an API key. Copy it again, without spaces.");
            if (CloudAiKeyStore.Mismatch(p, key) is { } hint) throw new DataSourceException(DataSourceOutcome.InvalidKey, hint);
            Uri? compatible = null;
            if (p == CloudAiProvider.Compatible)
            {
                var normal = CloudAiClient.NormalizeBaseUrl(baseUrl)
                             ?? throw new DataSourceException(DataSourceOutcome.Malformed, "The address must start with https:// and contain no password, “?” or “#”. For example https://openrouter.ai/api/v1");
                compatible = new Uri(normal);
            }
            var models = await ListAsync(p, key, compatible, ct);
            if (compatible is not null && _settings.Set(CloudAiProviders.CompatibleUrlSetting, compatible.AbsoluteUri.TrimEnd('/')) is { } err)
                throw new DataSourceException(DataSourceOutcome.Malformed, err);
            if (!_keys.Set(p, key)) throw new DataSourceException(DataSourceOutcome.Unavailable, "Windows Credential Manager didn’t save the key. Try again.");
            lock (_lock) _models[p] = models;
            _lanes[p].ResetPause();
            _repo.Audit("ai.cloud.connect", CloudAiProviders.Id(p));
            result = Record(p, DataSourceOutcome.Ok, p == CloudAiProvider.Anthropic
                ? "Saved. Anthropic accepted the key."
                : models.Count > 0 ? $"Saved. {CloudAiProviders.Company(p)} lists {models.Count} models for this key." : "Saved. The key was accepted.");
        }
        catch (DataSourceException ex)
        {
            result = Record(p, ex.Outcome, ex.Message);
        }
        return new CloudAiActionDto(result, Status(p));
    }

    /// <summary>"Test": one tiny generation with the chosen model (a few tokens), so the whole path is proven.</summary>
    public async Task<CloudAiActionDto> TestAsync(CloudAiProvider p, CancellationToken ct)
    {
        CloudAiTestDto result;
        try
        {
            RequireOnline(p);
            if (!IsConfigured(p)) throw new DataSourceException(DataSourceOutcome.NotConfigured, "No key is saved for this provider yet.");
            var model = Model(p);
            if (!CloudAiClient.IsValidModel(model)) throw new DataSourceException(DataSourceOutcome.NotConfigured, "Choose a model first.");
            var started = DateTime.UtcNow;
            var text = await SendAsync(p, new AiPrompt("You are a connection test. Reply with the single word OK.", "Reply with OK.", Json: false, MaxTokens: 512), ct);
            var ms = (int)(DateTime.UtcNow - started).TotalMilliseconds;
            result = Record(p, DataSourceOutcome.Ok, $"{CloudAiProviders.ModelLabel(model)} answered in {ms / 1000.0:0.0} s.");
            _ = text;
        }
        catch (DataSourceException ex)
        {
            result = Record(p, ex.Outcome, ex.Message);
        }
        return new CloudAiActionDto(result, Status(p));
    }

    public CloudAiProviderDto Disconnect(CloudAiProvider p)
    {
        _keys.Clear(p);
        lock (_lock) _models.Remove(p);
        _settings.Set(CloudAiProviders.OptInSetting(p), System.Text.Json.Nodes.JsonValue.Create(false));
        if (_settings.GetString(CloudAiProviders.ProviderSetting) == CloudAiProviders.Id(p))
            _settings.Set(CloudAiProviders.ProviderSetting, System.Text.Json.Nodes.JsonValue.Create("local"));
        _repo.SetInternalValue($"ai.cloud.lastTest.{CloudAiProviders.Id(p)}", null);
        _repo.Audit("ai.cloud.disconnect", CloudAiProviders.Id(p));
        return Status(p);
    }

    /// <summary>Lists the provider's models with the stored key (cached in memory; Claude's choices are fixed).</summary>
    public async Task<CloudAiProviderDto> RefreshModelsAsync(CloudAiProvider p, CancellationToken ct)
    {
        if (p == CloudAiProvider.Anthropic) return Status(p);
        RequireOnline(p);
        var key = _keys.Get(p) ?? throw new DataSourceException(DataSourceOutcome.NotConfigured, "No key is saved for this provider yet.");
        var models = await ListAsync(p, key, p == CloudAiProvider.Compatible ? BaseUri() : null, ct);
        lock (_lock) _models[p] = models;
        return Status(p);
    }

    private async Task<IReadOnlyList<string>> ListAsync(CloudAiProvider p, string key, Uri? compatible, CancellationToken ct)
    {
        Spend(p);
        var res = await _lanes[p].SendAsync(() => CloudAiClient.BuildModels(p, key, compatible), ct);
        return CloudAiClient.ParseModels(p, res.Status, res.Body);
    }

    // ---------------- Generation ----------------

    /// <summary>One completion from <paramref name="p"/>. Throws <see cref="DataSourceException"/> with a friendly message on any failure.</summary>
    public async Task<string> CompleteAsync(CloudAiProvider p, AiPrompt prompt, CancellationToken ct)
    {
        RequireOnline(p);
        if (!OptedIn(p)) throw new DataSourceException(DataSourceOutcome.Disabled, $"{CloudAiProviders.Name(p)} isn’t turned on in Settings → AI.");
        if (!IsConfigured(p)) throw new DataSourceException(DataSourceOutcome.NotConfigured, $"No key is saved for {CloudAiProviders.Name(p)}.");
        return await SendAsync(p, prompt, ct);
    }

    private async Task<string> SendAsync(CloudAiProvider p, AiPrompt prompt, CancellationToken ct)
    {
        var key = _keys.Get(p) ?? throw new DataSourceException(DataSourceOutcome.NotConfigured, $"No key is saved for {CloudAiProviders.Name(p)}.");
        var model = Model(p);
        if (!CloudAiClient.IsValidModel(model)) throw new DataSourceException(DataSourceOutcome.NotConfigured, $"Choose a {CloudAiProviders.Name(p)} model in Settings → AI.");
        var baseUri = p == CloudAiProvider.Compatible ? BaseUri() : null;
        Spend(p);
        var res = await _lanes[p].SendAsync(() => CloudAiClient.BuildChat(p, key, model, prompt, baseUri), ct);
        // The refusal fallback is a beta: if an account can't use it, ask once more without it rather than failing.
        if (p == CloudAiProvider.Anthropic && (int)res.Status == 400 && CloudAiClient.ClaudeSupportsEffort(model) &&
            res.Body.Contains("fallback", StringComparison.OrdinalIgnoreCase))
        {
            Spend(p);
            res = await _lanes[p].SendAsync(() => CloudAiClient.BuildChat(p, key, model, prompt, baseUri, withFallback: false), ct);
        }
        return CloudAiClient.ParseChat(p, res.Status, res.Body);
    }

    /// <summary>The local budget: protects the user's bill from a runaway loop or a stuck button.</summary>
    internal void Spend(CloudAiProvider p)
    {
        lock (_lock)
        {
            var now = UtcNow();
            var q = _recent[p];
            while (q.Count > 0 && now - q.Peek() > TimeSpan.FromDays(1)) q.Dequeue();
            if (q.Count >= DailyLimit)
                throw new DataSourceException(DataSourceOutcome.RateLimited, $"VYSTRAL has sent {DailyLimit} requests to {CloudAiProviders.Name(p)} today, its daily limit. AI features use local summaries until tomorrow.");
            if (q.Count(t => now - t <= Window) >= WindowLimit)
                throw new DataSourceException(DataSourceOutcome.RateLimited, $"That’s a lot of {CloudAiProviders.Name(p)} requests in a few minutes, so VYSTRAL is pausing briefly to protect your bill. Try again in a little while.");
            q.Enqueue(now);
        }
    }

    private void RequireOnline(CloudAiProvider p)
    {
        if (LocalOnly) throw new DataSourceException(DataSourceOutcome.Offline, $"Offline mode is on, so VYSTRAL doesn’t contact {CloudAiProviders.Name(p)}. Turn it off in Settings → Privacy.");
    }
}
