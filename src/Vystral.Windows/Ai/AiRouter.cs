using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;

namespace Vystral.Windows.Ai;

/// <summary>Which AI would answer right now. <c>Engine</c>: "anthropic" | "openai" | "gemini" | "compatible" | "local" | "none".</summary>
public sealed record AiEngineDto(string Engine, string Label, bool Cloud, bool Ready, string? Reason);

/// <summary>An accepted model answer and who wrote it. <c>Note</c> explains a fallback ("Claude couldn't be reached, so local AI answered").</summary>
public sealed record AiAnswer(string Text, string Engine, string Label, bool Cloud, string? Note);

/// <summary>What a feature gets back: the accepted answer, or null with an optional note for the deterministic fallback.</summary>
public sealed record AiOutcome(AiAnswer? Answer, string? Note);

/// <summary>An AI-assisted feature, its setting and exactly what it sends (shown in Settings and next to results).</summary>
public sealed record AiFeatureDto(string Id, string Label, bool Enabled, string Sends, string WithoutAi);

/// <summary>
/// Track C5: routes AI requests to the provider the user picked (Settings → AI): local Ollama, or one cloud provider
/// the user explicitly opted into. If the cloud provider fails (offline, rate limit, bad key, a decline, an unusable
/// answer), local AI is tried when it's turned on; otherwise the feature shows VYSTRAL's own deterministic result.
/// </summary>
public sealed class AiRouter(SettingsService settings, CloudAiService cloud, OllamaService ollama)
{
    public Func<bool> IsGameRunning { get; set; } = () => false;
    public bool SafeMode { get; set; }

    /// <summary>Test hook: replaces the local model call.</summary>
    internal Func<AiPrompt, CancellationToken, Task<string?>>? LocalOverride { get; set; }

    public static readonly (string Id, string Label, string Sends, string WithoutAi, bool Default)[] Features =
    [
        // Track D3: the one Assistant. Its look-ups ("tools") are listed in Settings → AI; journal and tonight are two of them.
        ("assistant", "Assistant",
            "Your messages, the name of the page you’re on (and the game, if you’re on its page), and — only when the Assistant looks something up — what that look-up found: for example game titles, genres, statuses, hours played, sizes, play totals, prices or frame-rate statistics. Before look-up results go to a cloud AI you see exactly what and choose whether to share. Never folder paths, notes, keys or account details.",
            "Without an AI, the Assistant can’t chat; every page still shows VYSTRAL’s own data.", true),
        ("journal", "Play history questions (Assistant)",
            "Your question, today’s date, the names of games and genres in your library (to understand the question), then the totals VYSTRAL calculated for the chart (game titles or dates with hours and session counts).",
            "The Assistant can’t look up your play history; the Journal page still shows it.", true),
        ("patchNotes", "Patch note summaries",
            "The game’s title and the text of the public news post you asked to summarize.",
            "The post’s first key lines are shown instead.", true),
        ("tonight", "What to play tonight (Assistant)",
            "Your mood, the time you have and anything you type, plus up to 8 candidate games VYSTRAL picked: title, genres, your hours, average session length, time to beat, install and subscription status.",
            "VYSTRAL’s own top three picks with their reasons.", true),
        ("smartCollections", "Smart collections from a sentence",
            "Your sentence and the list of genre names in your library.",
            "VYSTRAL’s own query parser builds the filter from your sentence.", true),
        ("duplicates", "Duplicate explanations",
            "The two entries’ titles, stores, release years, developers and the matching facts VYSTRAL found.",
            "The matching facts are listed without a sentence.", true),
        ("recapCaptions", "Session recap captions",
            "The game’s title and that session’s stats: length, time of day, achievements unlocked, average frame rate and how many times you’ve played it.",
            "No caption.", false),
    ];

    public static string FeatureSetting(string id) => $"ai.features.{id}";

    public IReadOnlyList<AiFeatureDto> FeatureList() =>
        Features.Select(f => new AiFeatureDto(f.Id, f.Label, settings.GetBool(FeatureSetting(f.Id)), f.Sends, f.WithoutAi)).ToList();

    public bool FeatureEnabled(string id) => settings.GetBool(FeatureSetting(id));

    private CloudAiProvider? ChosenCloud => CloudAiProviders.FromId(settings.GetString(CloudAiProviders.ProviderSetting));

    private bool LocalOn => settings.GetBool("ai.enabled");

    public AiEngineDto Active()
    {
        if (SafeMode) return new AiEngineDto("none", "No AI", false, false, "VYSTRAL is in safe mode.");
        if (ChosenCloud is { } p)
        {
            var name = CloudAiProviders.Name(p);
            var label = $"{name} · {CloudAiProviders.ModelLabel(cloud.Model(p))}";
            if (cloud.IsReady(p)) return new AiEngineDto(CloudAiProviders.Id(p), label, true, true, null);
            var reason = cloud.LocalOnly ? $"{name} is paused while Offline mode is on."
                : !cloud.IsConfigured(p) ? $"No key is saved for {name}."
                : $"{name} isn’t turned on yet (Settings → AI).";
            return LocalOn
                ? new AiEngineDto("local", $"Local AI · {settings.GetString("ai.model")}", false, !IsGameRunning(), reason + " Local AI answers instead.")
                : new AiEngineDto("none", "No AI", false, false, reason);
        }
        if (LocalOn)
            return new AiEngineDto("local", $"Local AI · {settings.GetString("ai.model")}", false, !IsGameRunning(),
                IsGameRunning() ? "Local AI is paused while a game is running." : null);
        return new AiEngineDto("none", "No AI", false, false, "No AI is set up. Choose local AI or a cloud provider in Settings → AI.");
    }

    /// <summary>
    /// Asks the chosen AI. <paramref name="accept"/> validates the raw answer (returning the cleaned text, or null to reject it).
    /// Returns a null answer (never throws for provider trouble) when the feature is off, nothing is set up or every engine failed.
    /// </summary>
    public async Task<AiOutcome> AskAsync(string feature, AiPrompt prompt, Func<string, string?> accept, CancellationToken ct, bool ignoreFeatureSwitch = false)
    {
        if (SafeMode || (!ignoreFeatureSwitch && !FeatureEnabled(feature))) return new AiOutcome(null, null);
        string? note = null;
        if (ChosenCloud is { } p)
        {
            var name = CloudAiProviders.Name(p);
            if (cloud.IsReady(p))
            {
                try
                {
                    var raw = await cloud.CompleteAsync(p, prompt, ct);
                    if (accept(raw) is { } ok)
                        return new AiOutcome(new AiAnswer(ok, CloudAiProviders.Id(p), $"{name} · {CloudAiProviders.ModelLabel(cloud.Model(p))}", true, null), null);
                    note = $"{name}’s answer didn’t match the facts, so it wasn’t used.";
                }
                catch (DataSourceException ex)
                {
                    note = ex.Message;
                }
            }
            else
            {
                note = cloud.LocalOnly ? $"{name} is paused while Offline mode is on." : null;
            }
        }
        if (LocalOn && !IsGameRunning())
        {
            try
            {
                var raw = LocalOverride is { } fake ? await fake(prompt, ct) : await ollama.CompleteAsync(prompt.System, prompt.User, prompt.Json, ct);
                if (raw is not null && accept(raw) is { } ok)
                    return new AiOutcome(new AiAnswer(ok, "local", $"Local AI · {settings.GetString("ai.model")}", false,
                        note is null ? null : note + " Local AI answered instead."), null);
                note ??= "Local AI’s answer didn’t match the facts, so it wasn’t used.";
            }
            catch (Exception ex) when (!ct.IsCancellationRequested &&
                                       ex is BridgeException or HttpRequestException or TaskCanceledException or System.Text.Json.JsonException or InvalidOperationException or NotSupportedException)
            {
                note ??= ex is BridgeException b ? b.Message : "Local AI didn’t answer.";
            }
        }
        return new AiOutcome(null, note);
    }
}
