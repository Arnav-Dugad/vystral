using System.Text.Json;
using System.Text.Json.Nodes;
using Vystral.Windows.Ai;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track C5 parameter records.
public sealed record AiProviderParams(string Provider);
public sealed record AiConnectParams(string Provider, string Key, string? BaseUrl);
public sealed record AiLinkParams(string Provider, string Link);
public sealed record AiQuestionParams(string Question);
public sealed record AiJournalRunParams(JsonElement Spec, string Label);
public sealed record AiPatchParams(string GameId, string Gid, bool? Refresh);
public sealed record AiTonightParams(string? Mood, int? Minutes, string? Note, bool? IncludeSubs);
public sealed record AiSentenceParams(string Sentence);
public sealed record AiDuplicateParams(string GameIdA, string GameIdB);
public sealed record AiCaptionParams(string SessionId, bool? Refresh, bool? Ask);

public sealed record AiCloudStatusDto(string Provider, IReadOnlyList<CloudAiProviderDto> Providers, bool LocalOnly, bool LocalEnabled, AiEngineDto Active,
    IReadOnlyList<AiFeatureDto> Features);

/// <summary>
/// Track C5: optional cloud AI providers (Claude, ChatGPT, Gemini, any OpenAI-compatible HTTPS endpoint) and the
/// AI-assisted features (Ask the Journal, patch note summaries, "what should I play tonight?", smart collections from a
/// sentence, duplicate explanations, session recap captions). Keys never reach the page; every link is fixed natively.
/// </summary>
public sealed partial class AppBackend
{
    private CloudAiService _cloudAi = null!;
    private AiRouter _aiRouter = null!;
    private AiFeaturesService _aiFeatures = null!;

    public CloudAiService CloudAi => _cloudAi;

    private static readonly Dictionary<(string Provider, string Link), string> AiLinks = new()
    {
        [("anthropic", "keys")] = "https://console.anthropic.com/settings/keys",
        [("anthropic", "privacy")] = "https://www.anthropic.com/legal/privacy",
        [("openai", "keys")] = "https://platform.openai.com/api-keys",
        [("openai", "privacy")] = "https://openai.com/policies/privacy-policy/",
        [("gemini", "keys")] = "https://aistudio.google.com/apikey",
        [("gemini", "privacy")] = "https://ai.google.dev/gemini-api/terms",
    };

    private void RegisterAiFeatureHandlers()
    {
        var secrets = new PerTargetCredentialStore(target =>
        {
            var provider = CloudAiProviders.All.FirstOrDefault(p => CloudAiKeyStore.Target(p) == target);
            return new WindowsCredentialStore(CloudAiKeyStore.Comment(provider));
        });
        _cloudAi = new CloudAiService(Settings, Repository, secrets, CloudAiService.CreateHttpClient(_http));
        _aiRouter = new AiRouter(Settings, _cloudAi, Ai) { IsGameRunning = () => IsGameActive, SafeMode = SafeMode };
        _aiFeatures = new AiFeaturesService(_aiRouter, Library.Snapshot, () => Repository.ListSessions(null, 10000), Path.Combine(Paths.Root, "cache", "ai"))
        {
            TimeToBeat = () => TimeToBeatMap().Games,
            SubsMap = () => _subs?.Map() ?? new Dictionary<string, IReadOnlyList<Subscriptions.SubsBadgeDto>>(),
            SubsIncluded = () => _subs?.Included() ?? [],
            NewsPost = (appId, gid) => _news?.PostForSummary(appId, gid),
        };

        // ---------- Providers ----------
        Dispatcher.Register("aiCloud.status", _ => Task.FromResult<object?>(AiStatus()));
        Dispatcher.Register<AiConnectParams>("aiCloud.connect", async (p, ct) =>
        {
            var provider = RequireAiProvider(p.Provider);
            var key = RequireText(p.Key, 300, "Key");
            var baseUrl = p.BaseUrl is null ? null : RequireText(p.BaseUrl, 200, "Address");
            var r = await _cloudAi.ConnectAsync(provider, key, baseUrl, ct);
            _events.Emit("aiCloud.changed", AiStatus());
            return r;
        });
        Dispatcher.Register<AiProviderParams>("aiCloud.test", async (p, ct) => await _cloudAi.TestAsync(RequireAiProvider(p.Provider), ct));
        Dispatcher.Register<AiProviderParams>("aiCloud.disconnect", (p, _) =>
        {
            _cloudAi.Disconnect(RequireAiProvider(p.Provider));
            var status = AiStatus();
            _events.Emit("aiCloud.changed", status);
            return Task.FromResult<object?>(status);
        });
        Dispatcher.Register<AiProviderParams>("aiCloud.models", async (p, ct) =>
            await Run(() => _cloudAi.RefreshModelsAsync(RequireAiProvider(p.Provider), ct)));
        Dispatcher.Register<AiLinkParams>("aiCloud.openLink", (p, _) =>
        {
            if (!AiLinks.TryGetValue((p.Provider, p.Link), out var url)) throw new BridgeException("invalid", "Unknown link.");
            _shell.OpenUri(new Uri(url));
            return Task.FromResult<object?>(true);
        });

        // ---------- Features ----------
        Dispatcher.Register<AiQuestionParams>("aix.journalAsk", async (p, ct) =>
            await _aiFeatures.AskJournalAsync(RequireText(p.Question, 300, "Question"), ct));
        Dispatcher.Register<AiJournalRunParams>("aix.journalRun", (p, _) =>
        {
            var raw = p.Spec.ValueKind == JsonValueKind.Object ? p.Spec.GetRawText() : throw new BridgeException("invalid", "Invalid question.");
            if (raw.Length > 4000) throw new BridgeException("invalid", "Invalid question.");
            var spec = JsonNode.Parse(raw) as JsonObject ?? throw new BridgeException("invalid", "Invalid question.");
            return Task.FromResult<object?>(_aiFeatures.RunJournal(spec, RequireText(p.Label, 120, "Label")));
        });
        Dispatcher.Register<AiPatchParams>("aix.patchSummary", async (p, ct) =>
        {
            var game = Repository.GetGame(RequireId(p.GameId)) ?? throw new BridgeException("notFound", "That game is no longer in your library.");
            var appId = game.SteamAppId ?? throw new BridgeException("notFound", "This game isn’t from Steam.");
            return await _aiFeatures.SummarizePostAsync(appId, RequireGid(p.Gid), game.Title, p.Refresh ?? false, ct);
        });
        Dispatcher.Register<AiTonightParams>("aix.tonight", async (p, ct) =>
        {
            var mood = p.Mood is null ? "any" : TonightPlanner.Moods.Contains(p.Mood) ? p.Mood : throw new BridgeException("invalid", "Unknown mood.");
            var minutes = Math.Clamp(p.Minutes ?? 60, 15, 600);
            var note = p.Note is null ? null : RequireText(p.Note, 300, "Note", allowEmpty: true);
            return await _aiFeatures.TonightAsync(mood, minutes, note, p.IncludeSubs ?? true, ct);
        });
        Dispatcher.Register<AiSentenceParams>("aix.smartFilter", async (p, ct) =>
            await _aiFeatures.SmartFilterAsync(RequireText(p.Sentence, 200, "Description"), ct));
        Dispatcher.Register<AiDuplicateParams>("aix.explainDuplicate", async (p, ct) =>
        {
            var a = RequireId(p.GameIdA);
            var b = RequireId(p.GameIdB);
            if (a == b) throw new BridgeException("invalid", "Pick two different games.");
            var snapshot = Library.Snapshot();
            var ga = snapshot.Games.FirstOrDefault(g => g.Id == a) ?? throw new BridgeException("notFound", "That game is no longer in your library.");
            var gb = snapshot.Games.FirstOrDefault(g => g.Id == b) ?? throw new BridgeException("notFound", "That game is no longer in your library.");
            return await _aiFeatures.ExplainDuplicateAsync(ga, gb, Repository.GetGame(a)?.SteamAppId, Repository.GetGame(b)?.SteamAppId, ct);
        });
        Dispatcher.Register<AiCaptionParams>("aix.recapCaption", async (p, ct) =>
        {
            var row = Repository.GetRecapSession(RequireId(p.SessionId, "session")) ?? throw new BridgeException("notFound", "That session is no longer in your journal.");
            var replay = Replay(row);
            var history = Repository.ListSessions(row.GameId, 10000);
            var number = history.Count(s => DateTimeOffset.TryParse(s.Start, out var st) && st <= row.Start);
            var total = Library.Snapshot().Games.FirstOrDefault(g => g.Id == row.GameId)?.TrackedSeconds ?? row.DurationSeconds;
            var facts = new CaptionFacts(row.Id, row.Title, TimeZoneInfo.ConvertTime(row.Start, TimeZoneInfo.Local), row.DurationSeconds,
                replay.Session.Perf.FpsAvg, replay.Achievements.Select(x => x.Name).ToList(), Math.Max(1, number), total / 3600.0);
            return await _aiFeatures.CaptionAsync(facts, p.Refresh ?? false, p.Ask ?? false, ct);
        });
        Dispatcher.Register("aix.clearCache", _ => { _aiFeatures.ClearCaches(); return Task.FromResult<object?>(true); });
    }

    private AiCloudStatusDto AiStatus() => new(
        Settings.GetString(CloudAiProviders.ProviderSetting) is { Length: > 0 } p ? p : "local",
        CloudAiProviders.All.Select(_cloudAi.Status).ToList(),
        _cloudAi.LocalOnly,
        Settings.GetBool("ai.enabled"),
        _aiRouter.Active(),
        _aiRouter.FeatureList());

    private static CloudAiProvider RequireAiProvider(string? id) =>
        CloudAiProviders.FromId(id) ?? throw new BridgeException("invalid", "Unknown AI provider.");
}
