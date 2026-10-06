using System.Text.Json;
using System.Text.Json.Nodes;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Services;

public sealed class MetadataServiceTests
{
    private static string Details(string appId, JsonObject data, bool success = true) =>
        new JsonObject { [appId] = new JsonObject { ["success"] = success, ["data"] = data } }.ToJsonString();

    // ---------- ParseDetails ----------

    [Fact]
    public void ParseDetails_returns_null_when_success_is_false()
    {
        Assert.Null(MetadataService.ParseDetails("10", """{"10":{"success":false}}"""));
        Assert.Null(MetadataService.ParseDetails("10", Details("10", new JsonObject { ["name"] = "x" }, success: false)));
    }

    [Theory]
    [InlineData("""{}""")]
    [InlineData("""{"20":{"success":true,"data":{"name":"Other"}}}""")]
    [InlineData("""{"10":{"data":{"name":"x"}}}""")]
    [InlineData("""{"10":{"success":"true","data":{"name":"x"}}}""")]
    [InlineData("""{"10":{"success":true}}""")]
    public void ParseDetails_returns_null_for_missing_or_mismatched_entries(string json) =>
        Assert.Null(MetadataService.ParseDetails("10", json));

    [Fact]
    public void ParseDetails_throws_JsonException_for_invalid_json()
    {
        Assert.ThrowsAny<JsonException>(() => MetadataService.ParseDetails("10", "<html>rate limited</html>"));
    }

    [Fact]
    public void ParseDetails_maps_a_realistic_payload()
    {
        var json = """
            {"1145360":{"success":true,"data":{
              "type":"game","name":"Hades","steam_appid":1145360,
              "short_description":"Defy the god of the dead as you hack and slash out of the Underworld in this <strong>rogue-like</strong> dungeon crawler &amp; more.",
              "developers":["Supergiant Games"],
              "publishers":["Supergiant Games"],
              "genres":[{"id":"1","description":"Action"},{"id":"23","description":"Indie"},{"id":"3","description":"RPG"}],
              "release_date":{"coming_soon":false,"date":"17 Sep, 2020"}
            }}}
            """;

        var d = MetadataService.ParseDetails("1145360", json)!;

        Assert.Equal("Hades", d.Name);
        Assert.Equal("Defy the god of the dead as you hack and slash out of the Underworld in this rogue-like dungeon crawler & more.", d.Description);
        Assert.Equal(["Supergiant Games"], d.Developers);
        Assert.Equal(["Supergiant Games"], d.Publishers);
        Assert.Equal(["Action", "Indie", "RPG"], d.Genres);
        Assert.Equal("17 Sep, 2020", d.ReleaseDate);
    }

    [Fact]
    public void ParseDetails_strips_html_tags_and_decodes_entities()
    {
        var d = MetadataService.ParseDetails("1", Details("1", new JsonObject
        {
            ["name"] = "<b>Bold</b> &quot;Name&quot;",
            ["short_description"] = "<p>Line one<br/>line two</p>\n\n<script>alert(1)</script>Tom &amp; Jerry &lt;3 &#169;",
        }))!;

        Assert.Equal("Bold \"Name\"", d.Name);
        Assert.Equal("Line one line two alert(1) Tom & Jerry <3 ©", d.Description);
        Assert.DoesNotContain("<p>", d.Description);
        Assert.DoesNotContain("<script>", d.Description);
    }

    [Fact]
    public void ParseDetails_caps_lengths()
    {
        var d = MetadataService.ParseDetails("1", Details("1", new JsonObject
        {
            ["name"] = new string('n', 500),
            ["short_description"] = new string('d', 5000),
            ["developers"] = new JsonArray(new string('v', 300), "B", "C", "D", "E", "F", "G"),
            ["genres"] = new JsonArray(Enumerable.Range(0, 12).Select(i => (JsonNode)new JsonObject { ["description"] = $"Genre{i}{new string('g', 60)}" }).ToArray()),
            ["release_date"] = new JsonObject { ["date"] = new string('r', 100) },
        }))!;

        Assert.Equal(201, d.Name.Length);
        Assert.EndsWith("…", d.Name);
        Assert.Equal(1201, d.Description!.Length);
        Assert.EndsWith("…", d.Description);
        Assert.Equal(5, d.Developers.Count);
        Assert.Equal(121, d.Developers[0].Length);
        Assert.Equal(8, d.Genres.Count);
        Assert.All(d.Genres, g => Assert.True(g.Length <= 41));
        Assert.Equal(41, d.ReleaseDate!.Length);
    }

    [Fact]
    public void ParseDetails_handles_missing_and_odd_fields()
    {
        var d = MetadataService.ParseDetails("1", Details("1", new JsonObject
        {
            ["short_description"] = "   ",
            ["developers"] = new JsonArray("Real Dev", 42, null, "", "<i></i>"),
            ["publishers"] = "not an array",
            ["genres"] = new JsonArray(
                new JsonObject { ["description"] = "Action" },
                new JsonObject { ["description"] = "Action" },
                new JsonObject { ["id"] = "no description" },
                new JsonObject { ["description"] = "" }),
        }))!;

        Assert.Equal("", d.Name);
        Assert.Null(d.Description);
        Assert.Equal(["Real Dev"], d.Developers);
        Assert.Empty(d.Publishers);
        Assert.Equal(["Action"], d.Genres);
        Assert.Null(d.ReleaseDate);
    }

    // ---------- PickExactMatch ----------

    private static string Search(params (string Type, string Name, int Id)[] items) =>
        new JsonObject
        {
            ["total"] = items.Length,
            ["items"] = new JsonArray(items.Select(i => (JsonNode)new JsonObject { ["type"] = i.Type, ["name"] = i.Name, ["id"] = i.Id }).ToArray()),
        }.ToJsonString();

    [Fact]
    public void PickExactMatch_returns_the_single_exact_normalized_match()
    {
        var json = Search(("app", "Hades II", 1145350), ("app", "Hades", 1145360), ("app", "Hades Soundtrack", 1));
        Assert.Equal("1145360", MetadataService.PickExactMatch("HADES™", json));
    }

    [Fact]
    public void PickExactMatch_uses_normalization_for_roman_numerals_and_articles()
    {
        var json = Search(("app", "FINAL FANTASY VII", 39140), ("app", "FINAL FANTASY VIII", 39150));
        Assert.Equal("39140", MetadataService.PickExactMatch("Final Fantasy 7", json));
        Assert.Equal("292030", MetadataService.PickExactMatch("Witcher 3: Wild Hunt", Search(("app", "The Witcher® 3: Wild Hunt", 292030))));
    }

    [Fact]
    public void PickExactMatch_rejects_near_misses()
    {
        var json = Search(("app", "Hades II", 1), ("app", "Hades Remastered", 2), ("app", "Hades GOTY", 3));
        Assert.Null(MetadataService.PickExactMatch("Hades", json));
    }

    [Fact]
    public void PickExactMatch_requires_same_edition()
    {
        var json = Search(("app", "Skyrim Special Edition", 489830));
        Assert.Null(MetadataService.PickExactMatch("Skyrim", json));
        Assert.Equal("489830", MetadataService.PickExactMatch("Skyrim Special Edition", json));
    }

    [Fact]
    public void PickExactMatch_returns_null_when_ambiguous()
    {
        var json = Search(("app", "Doom", 2280), ("app", "DOOM", 379720));
        Assert.Null(MetadataService.PickExactMatch("Doom", json));
    }

    [Fact]
    public void PickExactMatch_tolerates_the_same_app_listed_twice()
    {
        var json = Search(("app", "Celeste", 504230), ("app", "Celeste", 504230));
        Assert.Equal("504230", MetadataService.PickExactMatch("Celeste", json));
    }

    [Fact]
    public void PickExactMatch_ignores_non_app_types()
    {
        var json = Search(("sub", "Hades", 100), ("bundle", "Hades", 200), ("dlc", "Hades", 300));
        Assert.Null(MetadataService.PickExactMatch("Hades", json));

        var mixed = Search(("bundle", "Hades", 200), ("app", "Hades", 1145360));
        Assert.Equal("1145360", MetadataService.PickExactMatch("Hades", mixed));
    }

    [Theory]
    [InlineData("""{}""")]
    [InlineData("""{"items":null}""")]
    [InlineData("""{"items":{}}""")]
    [InlineData("""{"total":0,"items":[]}""")]
    public void PickExactMatch_returns_null_without_items(string json) =>
        Assert.Null(MetadataService.PickExactMatch("Hades", json));

    // ---------- Malformed answers (used to throw and stop every later enrichment run on the same game) ----------

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("42")]
    [InlineData("""{"items":[null, 1, "x", []]}""")]
    [InlineData("""{"items":[{"type":"app","name":"Hades"}]}""")]
    [InlineData("""{"items":[{"type":"app","name":"Hades","id":null}]}""")]
    [InlineData("""{"items":[{"type":"app","name":"Hades","id":{"x":1}}]}""")]
    [InlineData("""{"items":[{"type":"app","name":"Hades","id":"../1"}]}""")]
    [InlineData("""{"items":[{"type":1,"name":"Hades","id":1}]}""")]
    [InlineData("""{"items":[{"type":"app","name":["Hades"],"id":1}]}""")]
    public void PickExactMatch_never_throws_on_wrongly_shaped_answers(string json) =>
        Assert.Null(MetadataService.PickExactMatch("Hades", json));

    [Fact]
    public void PickExactMatch_skips_broken_items_but_keeps_a_good_one() =>
        Assert.Equal("1145360", MetadataService.PickExactMatch("Hades", """{"items":[null,{"type":"app","name":"Hades"},{"type":"app","name":"Hades","id":1145360}]}"""));

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("""{"10":null}""")]
    [InlineData("""{"10":[]}""")]
    [InlineData("""{"10":{"success":true,"data":null}}""")]
    [InlineData("""{"10":{"success":true,"data":[]}}""")]
    [InlineData("""{"10":{"success":true,"data":"x"}}""")]
    public void ParseDetails_returns_null_for_wrongly_shaped_answers(string json) =>
        Assert.Null(MetadataService.ParseDetails("10", json));

    [Fact]
    public void ParseDetails_skips_wrongly_typed_fields()
    {
        var d = MetadataService.ParseDetails("10", """
            {"10":{"success":true,"data":{"name":5,"short_description":null,"developers":"Valve","publishers":[1,"Valve",null],
              "genres":[null,"Action",{"description":7},{"description":"RPG"},{"id":1}],"release_date":"2020"}}}
            """)!;
        Assert.Equal("5", d.Name);
        Assert.Null(d.Description);
        Assert.Empty(d.Developers);
        Assert.Equal(["Valve"], d.Publishers);
        Assert.Equal(["7", "RPG"], d.Genres);
        Assert.Null(d.ReleaseDate);
    }

    [Fact]
    public async Task A_malformed_answer_marks_the_game_looked_up_so_the_next_run_moves_on()
    {
        using var t = new Vystral.Tests.Support.TestDb();
        var game = t.Repo.AddManualGame("Odd Game", @"C:\Games\odd\odd.exe", null);
        var requests = 0;
        using var http = new HttpClient(new Vystral.Tests.SteamAccount.FakeHandler(_ =>
        {
            Interlocked.Increment(ref requests);
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new StringContent("null") };
        }));
        var art = new ArtworkService(new AppPaths(Path.Combine(t.Dir.Path, "data")), t.Repo, http);
        var metadata = new MetadataService(t.Repo, art, http);

        Assert.Equal(0, await metadata.EnrichAsync(5, fetchArtwork: false, () => false, TestContext.Current.CancellationToken));

        Assert.DoesNotContain(t.Repo.GamesNeedingMetadata(10), g => g.GameId == game);
        Assert.Equal(1, requests);
    }

    // ---------- Clean ----------

    [Theory]
    [InlineData("plain", 100, "plain")]
    [InlineData("  lots   of\n\nspace\t ", 100, "lots of space")]
    [InlineData("<a href=\"x\">link</a>", 100, "link")]
    [InlineData("a&nbsp;b", 100, "a b")]
    [InlineData("&lt;b&gt;not a tag&lt;/b&gt;", 100, "<b>not a tag</b>")]
    [InlineData("", 10, "")]
    [InlineData("abcdefghij", 10, "abcdefghij")]
    [InlineData("abcdefghijk", 10, "abcdefghij…")]
    [InlineData("abcd efghijk", 5, "abcd…")]
    public void Clean_strips_markup_collapses_space_and_truncates(string input, int max, string expected) =>
        Assert.Equal(expected, MetadataService.Clean(input, max));
}
