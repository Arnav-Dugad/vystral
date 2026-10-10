using System.Text.Json.Nodes;
using Vystral.Core.Contracts;
using Vystral.Windows.Ai;
using Vystral.Windows.Recap;
using Vystral.Windows.Subscriptions;
using Xunit;
using static Vystral.Tests.Ai.AiTestData;

namespace Vystral.Tests.Ai;

/// <summary>Track C5: the Ask the Journal query spec, the smart-collection filter spec, and the output guards (hostile inputs included).</summary>
public sealed class AiSpecTests
{
    private static readonly DateOnly Today = new(2026, 10, 10);
    private static readonly TimeZoneInfo Utc = TimeZoneInfo.Utc;

    private static readonly GameDto Ashen = Game("Ashen Crown", ["RPG", "Fantasy"]);
    private static readonly GameDto Nebula = Game("Nebula Drift", ["Racing"], platform: "epic");
    private static readonly GameDto Moss = Game("Moss & Marrow", ["Adventure", "Indie"]);
    private static readonly GameDto[] Games = [Ashen, Nebula, Moss];

    private static JournalSpec? V(string json, out List<string> unmatched) =>
        JournalQuery.Validate(JsonNode.Parse(json) as JsonObject, Games, Today, out unmatched);

    private static JournalSpec? V(string json) => V(json, out _);

    // ---------- Journal spec validation ----------

    [Fact]
    public void A_complete_spec_round_trips()
    {
        var s = V("""{"metric":"sessions","groupBy":"genre","from":"2026-08-01","to":"2026-08-31","games":["ashen crown"],"genres":["rpg"],"platforms":["steam"],"sort":"asc","limit":3}""")!;
        Assert.Equal("sessions", s.Metric);
        Assert.Equal("genre", s.GroupBy);
        Assert.Equal("2026-08-01", s.From);
        Assert.Equal("2026-08-31", s.To);
        Assert.Equal([Ashen.Id], s.GameIds);
        Assert.Equal(["RPG"], s.Genres); // canonical casing from the library
        Assert.Equal(["steam"], s.Platforms);
        Assert.Equal("asc", s.Sort);
        Assert.Equal(3, s.Limit);
    }

    [Fact]
    public void Defaults_apply_when_fields_are_missing()
    {
        var s = V("{}")!;
        Assert.Equal(("playtime", "game", "desc", 10), (s.Metric, s.GroupBy, s.Sort, s.Limit));
        Assert.Null(s.From);
        Assert.Null(s.To);
    }

    [Theory]
    [InlineData("""{"metric":"money"}""")]
    [InlineData("""{"metric":5}""")]
    [InlineData("""{"groupBy":"user; DROP TABLE sessions"}""")]
    [InlineData("""{"groupBy":["game"]}""")]
    [InlineData("""{"from":"August"}""")]
    [InlineData("""{"from":"2026-02-30"}""")]
    [InlineData("""{"to":20260801}""")]
    [InlineData("""{"preset":"forever"}""")]
    [InlineData("""{"limit":"ten"}""")]
    [InlineData("""{"games":"Ashen Crown"}""")]
    [InlineData("""{"games":[1,2]}""")]
    [InlineData("""{"games":["a","b","c","d","e","f"]}""")]
    [InlineData("""{"platforms":["steam","playstation"]}""")]
    [InlineData("""{"sort":"random"}""")]
    [InlineData("""{"from":"2030-01-01"}""")]
    public void Hostile_or_wrong_specs_are_rejected(string json) => Assert.Null(V(json));

    [Fact]
    public void Oversized_objects_are_rejected()
    {
        var o = new JsonObject();
        for (var i = 0; i < 25; i++) o[$"k{i}"] = i;
        Assert.Null(JournalQuery.Validate(o, Games, Today, out _));
        Assert.Null(JournalQuery.Validate(null, Games, Today, out _));
    }

    [Fact]
    public void Dates_are_clamped_swapped_and_presets_resolved()
    {
        var s = V("""{"from":"2026-12-31","to":"1990-01-01"}""")!;
        Assert.Equal("2000-01-01", s.From);
        Assert.Equal("2026-10-10", s.To);
        var lastMonth = V("""{"preset":"lastMonth"}""")!;
        Assert.Equal(("2026-09-01", "2026-09-30"), (lastMonth.From, lastMonth.To));
        var big = V("""{"limit":500}""")!;
        Assert.Equal(20, big.Limit);
    }

    [Fact]
    public void Unknown_titles_and_genres_are_reported_not_invented()
    {
        var s = V("""{"games":["Half-Life 3","Nebula Drift"],"genres":["Horror"]}""", out var unmatched)!;
        Assert.Equal([Nebula.Id], s.GameIds);
        Assert.Empty(s.Genres);
        Assert.Equal(["Half-Life 3", "Horror"], unmatched);
    }

    // ---------- Journal execution ----------

    private static readonly SessionDto[] Sessions =
    [
        Session(Ashen, "2026-08-03T20:00:00Z", 7200),
        Session(Ashen, "2026-08-10T21:00:00Z", 3600),
        Session(Nebula, "2026-08-11T19:00:00Z", 1800),
        Session(Moss, "2026-07-30T18:00:00Z", 9000),   // July: outside
        Session(Nebula, "2026-09-02T10:00:00Z", 600),  // September: outside
    ];

    [Fact]
    public void What_did_I_play_most_in_august()
    {
        var spec = V("""{"metric":"playtime","groupBy":"game","from":"2026-08-01","to":"2026-08-31"}""")!;
        var r = JournalQuery.Execute(spec, Sessions, Games, [], Utc);
        Assert.Equal(2, r.Rows.Count);
        Assert.Equal(("Ashen Crown", 10800.0), (r.Rows[0].Label, r.Rows[0].Value));
        Assert.Equal(Ashen.Id, r.Rows[0].GameId);
        Assert.Equal(12600, r.Total);
        Assert.Equal(3, r.Sessions);
        Assert.Equal("August 2026", r.RangeLabel);
        Assert.Equal("bar", r.Chart);
        Assert.Equal("Ashen Crown leads August 2026 with 3 h. In total you played 3 h 30 min across 3 sessions.", JournalQuery.PlainAnswer(r));
    }

    [Fact]
    public void Time_groups_are_filled_in_order()
    {
        var spec = V("""{"metric":"sessions","groupBy":"weekday","from":"2026-08-01","to":"2026-08-31"}""")!;
        var r = JournalQuery.Execute(spec, Sessions, Games, [], Utc);
        Assert.Equal(7, r.Rows.Count);
        Assert.Equal("Mon", r.Rows[0].Label);
        Assert.Equal(2, r.Rows[0].Value); // 3 and 10 August 2026 were Mondays
        Assert.Equal("column", r.Chart);
        var months = JournalQuery.Execute(V("""{"groupBy":"month","from":"2026-07-01","to":"2026-09-30"}""")!, Sessions, Games, [], Utc);
        Assert.Equal(["Jul 2026", "Aug 2026", "Sep 2026"], months.Rows.Select(x => x.Label));
    }

    [Fact]
    public void Platform_and_genre_filters_apply()
    {
        var epic = JournalQuery.Execute(V("""{"groupBy":"none","platforms":["epic"]}""")!, Sessions, Games, [], Utc);
        Assert.Equal(2400, epic.Total);
        var rpg = JournalQuery.Execute(V("""{"groupBy":"game","genres":["RPG"]}""")!, Sessions, Games, [], Utc);
        Assert.Single(rpg.Rows);
    }

    [Fact]
    public void Empty_results_say_so()
    {
        var r = JournalQuery.Execute(V("""{"from":"2025-01-01","to":"2025-01-31","groupBy":"month"}""")!, Sessions, Games, [], Utc);
        Assert.Equal(0, r.Sessions);
        Assert.Contains("No tracked sessions", JournalQuery.PlainAnswer(r));
        var allTimeEmpty = JournalQuery.Execute(V("""{"groupBy":"day"}""")!, [], Games, [], Utc);
        Assert.Empty(allTimeEmpty.Rows);
    }

    // ---------- Number guard ----------

    [Theory]
    [InlineData("Ashen Crown led with 3 h, out of 3 h 30 min in total.", true)]
    [InlineData("Ashen Crown led with 3.5 hours.", false)]
    [InlineData("You played 86% of the time on Ashen Crown.", false)]
    [InlineData("Ashen Crown was your favourite in August.", true)]
    [InlineData("You played 12 sessions.", false)]
    public void Only_numbers_vystral_provided_may_appear(string answer, bool ok)
    {
        const string facts = "Range: August 2026\nTotal: 3 h 30 min across 3 sessions in 2 games\n- Ashen Crown: 3 h\n- Nebula Drift: 30 min";
        Assert.Equal(ok, AiText.OnlyKnownNumbers(answer, facts));
    }

    [Theory]
    [InlineData("Here you go:\n```json\n{\"a\":1}\n```", true)]
    [InlineData("{\"a\":1}", true)]
    [InlineData("no json here", false)]
    [InlineData("{broken", false)]
    [InlineData("[1,2,3]", false)]
    public void Extracts_the_first_json_object(string text, bool found) => Assert.Equal(found, AiText.ExtractObject(text) is not null);

    [Fact]
    public void Clean_strips_control_bidi_and_markdown()
    {
        Assert.Equal("Hello world", AiText.Clean("**Hello**‮ \u0007world", 100));
        Assert.Equal("abc…", AiText.Clean("abcdef", 3));
    }

    // ---------- Smart collection filter spec ----------

    private static readonly string[] Known = ["Casual", "Simulation", "Puzzle", "RPG"];

    [Fact]
    public void Cosy_games_under_20_hours_i_havent_finished()
    {
        var r = SmartFilterSpec.Validate((JsonObject)JsonNode.Parse("""
            {"genresAny":["casual","Simulation","Cozy"],"statusNone":["beaten","completed"],"ttbMaxHours":20,"extra":"ignored"}
            """)!, Known, out var dropped)!;
        Assert.Equal("""{"v":1,"genresAny":["Casual","Simulation"],"statusNone":["beaten","completed"],"ttbMaxHours":20}""", r.ToJsonString());
        Assert.Equal(["Cozy"], dropped);
    }

    [Theory]
    [InlineData("""{}""")]
    [InlineData("""{"genresAny":["Nonexistent"]}""")]
    [InlineData("""{"statusAny":["finished"]}""")]
    [InlineData("""{"ttbMaxHours":-1}""")]
    [InlineData("""{"ttbMaxHours":"20"}""")]
    [InlineData("""{"ttbMaxHours":1e308}""")]
    [InlineData("""{"installed":"yes"}""")]
    [InlineData("""{"platforms":["steam","psn"]}""")]
    [InlineData("""{"releasedFrom":2020,"releasedTo":2010}""")]
    [InlineData("""{"genresAny":"RPG"}""")]
    [InlineData("""{"v":2,"installed":true}""")]
    [InlineData("""{"titleIncludes":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}""")]
    public void Invalid_filters_are_rejected(string json) =>
        Assert.Null(SmartFilterSpec.Validate((JsonObject)JsonNode.Parse(json)!, Known, out _));

    [Fact]
    public void Stored_rules_are_canonicalised_and_size_capped()
    {
        Assert.Equal("""{"v":1,"installed":true}""", SmartFilterSpec.Canonical("""{"installed":true,"__proto__":{"x":1}}"""));
        Assert.Null(SmartFilterSpec.Canonical("not json"));
        Assert.Null(SmartFilterSpec.Canonical(new string('{', 5000)));
        Assert.Null(SmartFilterSpec.Canonical("[]"));
    }

    // ---------- Tonight ----------

    [Fact]
    public void Tonight_only_suggests_candidates_and_validates_the_plan()
    {
        var playing = Game("Glasswing", ["Platformer", "Indie"], trackedSeconds: 7200, sessions: 4, status: "playing");
        var done = Game("Kingsfall", ["Strategy"], status: "completed");
        var notInstalled = Game("Northbound", ["Survival"], installed: false);
        var ttb = new Dictionary<string, TimeToBeatDto> { [playing.Id] = new(3 * 3600, null, null, 10, "2026-01-01") };
        var cs = TonightPlanner.Candidates([playing, done, notInstalled, Moss], ttb, new Dictionary<string, IReadOnlyList<SubsBadgeDto>>(), [], "chill", 90, true,
            new DateTimeOffset(2026, 10, 10, 20, 0, 0, TimeSpan.Zero));
        Assert.Equal(["Glasswing", "Moss & Marrow"], cs.Select(c => c.Title));
        Assert.Contains(cs[0].Reasons, r => r.Contains("finish it tonight"));

        var facts = TonightPlanner.Facts(cs, "chill", 90, null);
        var good = TonightPlanner.ValidatePlan((JsonObject)JsonNode.Parse("""{"intro":"Two gentle picks.","picks":[{"ref":"c1","reason":"About 1 h left to the credits."}]}""")!, cs, facts);
        Assert.NotNull(good);
        Assert.Equal(playing.Id, good!.Value.Picks[0].GameId);

        Assert.Null(TonightPlanner.ValidatePlan((JsonObject)JsonNode.Parse("""{"picks":[{"ref":"c9","reason":"Not on the list."}]}""")!, cs, facts));
        Assert.Null(TonightPlanner.ValidatePlan((JsonObject)JsonNode.Parse("""{"picks":[{"ref":"c1","reason":"You have 47 hours left."}]}""")!, cs, facts));
        Assert.Null(TonightPlanner.ValidatePlan((JsonObject)JsonNode.Parse("""{"picks":[]}""")!, cs, facts));
        Assert.Null(TonightPlanner.ValidatePlan((JsonObject)JsonNode.Parse("""{"picks":[{"ref":"c1","reason":"a"},{"ref":"c1","reason":"again"}]}""")!, cs, facts));
    }

    // ---------- Duplicates ----------

    [Fact]
    public void Duplicate_facts_are_deterministic()
    {
        var a = Game("Kingsfall", ["Strategy"], release: "2019-04-02", developer: "Crown & Quill");
        var b = Game("Kingsfall Game of the Year Edition", ["Strategy"], platform: "xbox", release: "2019-11-20", developer: "Crown & Quill");
        var facts = DuplicateFacts.For(a, b, "620", "620");
        Assert.Contains(facts, f => f.Kind == "steamAppId" && f.Supports);
        Assert.Contains(facts, f => f.Kind == "title" && f.Supports);
        Assert.Contains(facts, f => f.Kind == "edition" && !f.Supports);
        Assert.Contains(facts, f => f.Kind == "year" && f.Text.Contains("2019"));
        Assert.Contains(facts, f => f.Kind == "developer");
        Assert.Contains(facts, f => f.Kind == "store" && f.Supports);
    }
}
