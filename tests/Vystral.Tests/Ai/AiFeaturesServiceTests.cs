using System.Net;
using System.Text.Json.Nodes;
using Vystral.Core.Contracts;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.Ai;
using Vystral.Windows.Services;
using Xunit;
using static Vystral.Tests.Ai.AiTestData;

namespace Vystral.Tests.Ai;

/// <summary>Track C5: the features end to end against a fake provider (OpenAI-shaped answers), including every fallback.</summary>
public sealed class AiFeaturesServiceTests : IDisposable
{
    private const string Key = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789wxyz";
    private readonly TestDb _t = new();
    private readonly FakeSecretStore _secrets = new();
    private readonly List<string> _bodies = [];
    private readonly Queue<string> _answers = new();
    private readonly HttpClient _http;
    private readonly SettingsService _settings;
    private readonly CloudAiService _cloud;
    private readonly AiRouter _router;
    private readonly AiFeaturesService _svc;
    private readonly GameDto _ashen = Game("Ashen Crown", ["RPG"]);
    private readonly GameDto _nebula = Game("Nebula Drift", ["Racing"]);
    private readonly List<SessionDto> _sessions = [];

    public AiFeaturesServiceTests()
    {
        _http = new HttpClient(new FakeHandler(r =>
        {
            lock (_bodies) _bodies.Add(r.Content?.ReadAsStringAsync().Result ?? "");
            if (_answers.Count == 0) return FakeHandler.Json(HttpStatusCode.InternalServerError, "{}");
            var content = new JsonObject { ["choices"] = new JsonArray { new JsonObject { ["message"] = new JsonObject { ["content"] = _answers.Dequeue() } } } };
            return FakeHandler.Json(HttpStatusCode.OK, content.ToJsonString());
        }));
        _settings = new SettingsService(_t.Repo);
        _cloud = new CloudAiService(_settings, _t.Repo, _secrets, _http);
        foreach (var p in CloudAiProviders.All) _cloud.Lane(p).Delay = (_, _) => Task.CompletedTask;
        _router = new AiRouter(_settings, _cloud, new OllamaService(_settings, new NullSink()));
        _sessions.Add(Session(_ashen, "2026-08-03T20:00:00Z", 7200));
        _sessions.Add(Session(_nebula, "2026-08-11T19:00:00Z", 1800));
        _svc = new AiFeaturesService(_router, () => new LibrarySnapshotDto([_ashen, _nebula], [], [], null), () => _sessions, Path.Combine(_t.Dir.Path, "ai"))
        {
            Now = () => new DateTimeOffset(2026, 10, 10, 20, 0, 0, TimeSpan.Zero),
            NewsPost = (appId, gid) => appId == "620" && gid == "1"
                ? ("Patch 1.2", DateTimeOffset.UtcNow, [("p", "This update fixes crashes."), ("li", "Fixed a crash on load"), ("li", "Added 2 new maps"), ("li", "Faster saves")])
                : null,
        };
    }

    public void Dispose()
    {
        _http.Dispose();
        _t.Dispose();
    }

    private void UseOpenAi()
    {
        _secrets.Items["VYSTRAL/AI-OpenAI"] = Key;
        _settings.Set("ai.provider", JsonValue.Create("openai"));
        _settings.Set("ai.cloud.openai.optIn", JsonValue.Create(true));
    }

    [Fact]
    public async Task Without_any_ai_the_journal_asks_for_a_ready_made_question_and_sends_nothing()
    {
        var r = await _svc.AskJournalAsync("What did I play most in August?", CancellationToken.None);
        Assert.True(r.NeedsAi);
        Assert.Null(r.Result);
        Assert.Empty(_bodies);
        Assert.Equal("none", r.Engine.Engine);
    }

    [Fact]
    public async Task Ask_the_journal_plans_runs_locally_then_phrases_the_real_numbers()
    {
        UseOpenAi();
        _answers.Enqueue("""{"metric":"playtime","groupBy":"game","from":"2026-08-01","to":"2026-08-31"}""");
        _answers.Enqueue("You played Ashen Crown the most in August 2026, for 2 h.");
        var r = await _svc.AskJournalAsync("What did I play most in August?", CancellationToken.None);
        Assert.False(r.NeedsAi);
        Assert.Equal("Ashen Crown", r.Result!.Rows[0].Label);
        Assert.Equal(7200, r.Result.Rows[0].Value);
        Assert.Equal("You played Ashen Crown the most in August 2026, for 2 h.", r.Answer);
        Assert.Contains("ChatGPT", r.PhrasedBy);
        Assert.Contains("OpenAI", r.Sent);
        // The second request carried VYSTRAL's computed facts; neither carried paths, notes or keys.
        Assert.Contains("Ashen Crown: 2 h", _bodies[1]);
        Assert.All(_bodies, b => Assert.DoesNotContain(Key, b));
    }

    [Fact]
    public async Task Invented_numbers_are_discarded_for_vystrals_own_summary()
    {
        UseOpenAi();
        _answers.Enqueue("""{"metric":"playtime","groupBy":"game","preset":"all"}""");
        _answers.Enqueue("You played Ashen Crown for 14 hours, 80% of your time.");
        var r = await _svc.AskJournalAsync("What did I play most?", CancellationToken.None);
        Assert.Equal(JournalQuery.PlainAnswer(r.Result!), r.Answer);
        Assert.Null(r.PhrasedBy);
        Assert.NotNull(r.Note);
    }

    [Fact]
    public async Task An_unusable_plan_falls_back_gracefully()
    {
        UseOpenAi();
        _answers.Enqueue("""{"metric":"DROP TABLE"}""");
        var r = await _svc.AskJournalAsync("hello", CancellationToken.None);
        Assert.Null(r.Result);
        Assert.False(r.NeedsAi);
        Assert.NotNull(r.Note);
    }

    [Fact]
    public async Task A_provider_outage_falls_back_without_throwing()
    {
        UseOpenAi(); // no queued answers: the fake returns 500
        var t = await _svc.TonightAsync("any", 60, null, true, CancellationToken.None);
        Assert.Null(t.AiLabel);
        Assert.NotEmpty(t.Picks);
        Assert.Contains("trouble", t.Note);
    }

    [Fact]
    public async Task Offline_mode_pauses_cloud_ai_and_features_still_answer()
    {
        UseOpenAi();
        _settings.Set("privacy.localOnly", JsonValue.Create(true));
        var t = await _svc.TonightAsync("any", 60, null, false, CancellationToken.None);
        Assert.Empty(_bodies);
        Assert.NotEmpty(t.Picks);
        Assert.Contains("Offline", t.Engine.Reason);
    }

    [Fact]
    public async Task Patch_summaries_are_cached_per_post_and_checked_against_the_post()
    {
        UseOpenAi();
        _answers.Enqueue("""{"bullets":["Fixes a crash on load.","Adds 2 new maps.","Saves are faster."]}""");
        var first = await _svc.SummarizePostAsync("620", "1", "Portal 2", false, CancellationToken.None);
        Assert.True(first.Ai);
        Assert.Equal(3, first.Bullets.Count);
        var second = await _svc.SummarizePostAsync("620", "1", "Portal 2", false, CancellationToken.None);
        Assert.True(second.Cached);
        Assert.Single(_bodies);

        _answers.Enqueue("""{"bullets":["Adds 12 new maps."]}""");
        var invented = await _svc.SummarizePostAsync("620", "1", "Portal 2", true, CancellationToken.None);
        Assert.False(invented.Ai);
        Assert.Equal(["Fixed a crash on load", "Added 2 new maps", "Faster saves"], invented.Bullets);
    }

    [Fact]
    public async Task Feature_switch_off_means_nothing_is_sent()
    {
        UseOpenAi();
        _settings.Set("ai.features.tonight", JsonValue.Create(false));
        var t = await _svc.TonightAsync("any", 60, null, false, CancellationToken.None);
        Assert.Empty(_bodies);
        Assert.NotEmpty(t.Picks);
    }

    [Fact]
    public async Task Smart_filter_from_a_sentence_is_validated()
    {
        UseOpenAi();
        _answers.Enqueue("""{"name":"Short RPGs","filter":{"genresAny":["RPG"],"ttbMaxHours":20,"statusNone":["beaten","completed"]}}""");
        var r = await _svc.SmartFilterAsync("rpgs under 20 hours I haven't finished", CancellationToken.None);
        Assert.Equal("Short RPGs", r.Name);
        Assert.Equal(20, r.Filter!["ttbMaxHours"]!.GetValue<double>());

        _answers.Enqueue("""{"name":"x","filter":{"genresAny":["Nope"]}}""");
        var bad = await _svc.SmartFilterAsync("nothing real", CancellationToken.None);
        Assert.Null(bad.Filter);
        Assert.False(bad.NeedsAi);
    }

    [Fact]
    public async Task Recap_captions_only_run_when_switched_on_or_asked()
    {
        UseOpenAi();
        var facts = new CaptionFacts(Id(77), "Ashen Crown", new DateTimeOffset(2026, 8, 3, 21, 0, 0, TimeSpan.Zero), 7200, 61.4, ["First Blood"], 4, 12);
        var off = await _svc.CaptionAsync(facts, false, userAsked: false, CancellationToken.None);
        Assert.Null(off.Caption);
        Assert.Empty(_bodies);

        _answers.Enqueue("An evening of 2 h in Ashen Crown, and First Blood to show for it.");
        var asked = await _svc.CaptionAsync(facts, false, userAsked: true, CancellationToken.None);
        Assert.Equal("An evening of 2 h in Ashen Crown, and First Blood to show for it.", asked.Caption);
        var cached = await _svc.CaptionAsync(facts, false, userAsked: false, CancellationToken.None);
        Assert.True(cached.Cached);
    }

    private sealed class NullSink : Vystral.Windows.Bridge.IEventSink
    {
        public void Emit(string name, object? payload) { }
    }
}
