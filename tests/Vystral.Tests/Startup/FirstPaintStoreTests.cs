using System.Text.Json;
using Vystral.Tests.Support;
using Vystral.Windows.Services.Startup;
using Xunit;

namespace Vystral.Tests.Startup;

/// <summary>Track AA: the first-paint snapshot's envelope, versioning and validation.</summary>
public sealed class FirstPaintStoreTests : IDisposable
{
    private static readonly DateTimeOffset Now = new(2026, 10, 7, 12, 0, 0, TimeSpan.Zero);
    private readonly TempDir _dir = new();
    private readonly FirstPaintStore _store;

    public FirstPaintStoreTests() => _store = new FirstPaintStore(_dir.Path);

    public void Dispose() => _dir.Dispose();

    private static JsonElement J(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private const string Payload = """{"v":1,"savedAt":"2026-10-07T11:00:00Z","appearance":{"theme":"light","reduceMotion":"system","quality":"auto"},"model":{"featuredId":null},"games":[{"id":"0123456789abcdef0123456789abcdef","title":"Nebula Drift"}]}""";

    [Fact]
    public void Saves_and_loads_the_same_payload_for_the_same_version()
    {
        _store.Save(J(Payload), "0.7.0", Now);
        var s = _store.Load("0.7.0", Now.AddHours(1), out var reason);
        Assert.Equal("ok", reason);
        Assert.NotNull(s);
        Assert.Equal("0.7.0", s!.AppVersion);
        Assert.Equal("light", s.Theme);
        using var doc = JsonDocument.Parse(s.PayloadJson);
        Assert.Equal("Nebula Drift", doc.RootElement.GetProperty("games")[0].GetProperty("title").GetString());
        Assert.True(File.Exists(Path.Combine(_dir.Path, "ui-state", "first-paint.json")));
        Assert.False(File.Exists(Path.Combine(_dir.Path, "ui-state", "first-paint.json.tmp")));
    }

    [Fact]
    public void Missing_file_is_not_an_error()
    {
        Assert.Null(_store.Load("0.7.0", Now, out var reason));
        Assert.Equal("none", reason);
    }

    [Fact]
    public void Another_version_takes_the_live_path()
    {
        _store.Save(J(Payload), "0.6.0", Now);
        Assert.Null(_store.Load("0.7.0", Now, out var reason));
        Assert.Equal("otherVersion", reason);
    }

    [Theory]
    [InlineData("""{"schema":2,"appVersion":"0.7.0","savedAt":"2026-10-07T11:00:00Z","payload":{"v":1}}""", "otherSchema")]
    [InlineData("""{"appVersion":"0.7.0","savedAt":"2026-10-07T11:00:00Z","payload":{"v":1}}""", "otherSchema")]
    [InlineData("""{"schema":1,"appVersion":"0.7.0","savedAt":"2026-07-01T11:00:00Z","payload":{"v":1}}""", "stale")]
    [InlineData("""{"schema":1,"appVersion":"0.7.0","savedAt":"2026-10-09T11:00:00Z","payload":{"v":1}}""", "stale")]
    [InlineData("""{"schema":1,"appVersion":"0.7.0","savedAt":"yesterday","payload":{"v":1}}""", "corrupt")]
    [InlineData("""{"schema":1,"appVersion":"0.7.0","savedAt":"2026-10-07T11:00:00Z","payload":{"x":1}}""", "corrupt")]
    [InlineData("""{"schema":1,"appVersion":"0.7.0","savedAt":"2026-10-07T11:00:00Z","payload":[1]}""", "corrupt")]
    [InlineData("""{"schema":1,"appVersion":"0.7.0","savedAt":"2026-10""", "corrupt")]
    [InlineData("""[]""", "corrupt")]
    [InlineData("""not json at all""", "corrupt")]
    public void Stale_or_corrupt_envelopes_are_ignored(string text, string expected)
    {
        Assert.Null(FirstPaintStore.Parse(text, "0.7.0", Now, out var reason));
        Assert.Equal(expected, reason);
    }

    [Fact]
    public void A_corrupt_file_on_disk_is_ignored_and_never_throws()
    {
        _dir.Write(Path.Combine("ui-state", "first-paint.json"), "{\"schema\":1,\u0000garbage");
        Assert.Null(_store.Load("0.7.0", Now, out var reason));
        Assert.Equal("corrupt", reason);
    }

    [Theory]
    [InlineData("""{"games":[]}""")]                      // no version
    [InlineData("""{"v":0}""")]                           // bad version
    [InlineData("""{"v":"1"}""")]
    [InlineData("""[1,2,3]""")]                           // not an object
    [InlineData("""{"v":1,"title":"bell\u0007"}""")]      // control characters
    public void Invalid_payloads_are_rejected(string json)
    {
        Assert.Throws<ArgumentException>(() => _store.Save(J(json), "0.7.0", Now));
        Assert.False(File.Exists(_store.FilePath));
    }

    [Fact]
    public void Oversized_or_deep_payloads_are_rejected()
    {
        var big = JsonSerializer.Serialize(new { v = 1, games = Enumerable.Range(0, 400).Select(i => new string('x', 1_000)) });
        Assert.Throws<ArgumentException>(() => _store.Save(J(big), "0.7.0", Now));
        var longList = JsonSerializer.Serialize(new { v = 1, games = Enumerable.Range(0, FirstPaintStore.MaxArrayLength + 1) });
        Assert.Throws<ArgumentException>(() => _store.Save(J(longList), "0.7.0", Now));
        var deep = "{\"v\":1,\"a\":" + string.Concat(Enumerable.Repeat("[", 20)) + string.Concat(Enumerable.Repeat("]", 20)) + "}";
        Assert.Throws<ArgumentException>(() => _store.Save(J(deep), "0.7.0", Now));
    }

    [Fact]
    public void The_script_is_a_json_literal_with_markup_and_line_separators_escaped()
    {
        _store.Save(J("""{"v":1,"title":"</script><script>alert(1)</script> \u2028 & 'q'"}"""), "0.7.0", Now);
        var s = _store.Load("0.7.0", Now, out _)!;
        var script = FirstPaintStore.Script(s);
        Assert.StartsWith("globalThis.__vystralFirstPaint={", script);
        Assert.EndsWith("};", script);
        Assert.DoesNotContain("<", script);
        Assert.DoesNotContain(">", script);
        Assert.DoesNotContain("\u2028", script);
        // Still the same data once parsed.
        var literal = script["globalThis.__vystralFirstPaint=".Length..^1];
        Assert.Equal("</script><script>alert(1)</script> \u2028 & 'q'", JsonDocument.Parse(literal).RootElement.GetProperty("title").GetString());
    }

    [Fact]
    public void Unknown_theme_is_not_passed_on()
    {
        _store.Save(J("""{"v":1,"appearance":{"theme":"neon"}}"""), "0.7.0", Now);
        Assert.Null(_store.Load("0.7.0", Now, out _)!.Theme);
    }

    [Fact]
    public void Clear_removes_the_snapshot()
    {
        _store.Save(J(Payload), "0.7.0", Now);
        _store.Clear();
        Assert.Null(_store.Load("0.7.0", Now, out var reason));
        Assert.Equal("none", reason);
        _store.Clear(); // twice is fine
    }

    [Fact]
    public void Ui_marks_are_converted_to_process_time_and_validated()
    {
        var into = new Dictionary<string, double>();
        Assert.True(StartupTimeline.AddUiMarks(1_000_500, new Dictionary<string, double> { ["script"] = 40, ["firstPaint"] = 90.5, ["Bad Name!"] = 1, ["late"] = 900_000 }, 1_000_000, into));
        Assert.Equal(500, into["ui:origin"]);
        Assert.Equal(540, into["ui:script"]);
        Assert.Equal(590.5, into["ui:firstPaint"]);
        Assert.False(into.ContainsKey("ui:Bad Name!"));
        Assert.False(into.ContainsKey("ui:late"));
        // A page "starting" long after the process, or with too many marks, is refused.
        Assert.False(StartupTimeline.AddUiMarks(1_000_000 + 700_000, new Dictionary<string, double>(), 1_000_000, new Dictionary<string, double>()));
        Assert.False(StartupTimeline.AddUiMarks(1_000_000, Enumerable.Range(0, 30).ToDictionary(i => $"m{i}", i => (double)i), 1_000_000, new Dictionary<string, double>()));
    }
}
