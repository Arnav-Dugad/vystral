using Vystral.Tests.Support;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Services;

/// <summary>Track D5: the "Not interested" list (ui-state/recommend.json).</summary>
public sealed class RecommendStoreTests : IDisposable
{
    private readonly TempDir _dir = new();
    private static readonly DateTimeOffset Now = new(2026, 10, 10, 12, 0, 0, TimeSpan.Zero);
    private const string Game = "game:0123456789abcdef0123456789abcdef";

    public void Dispose() => _dir.Dispose();

    [Theory]
    [InlineData("game:0123456789abcdef0123456789abcdef", true)]
    [InlineData("game:0123456789ABCDEF0123456789abcdef", false)]
    [InlineData("game:../../etc", false)]
    [InlineData("discover:steam-620", true)]
    [InlineData("discover:wd-Q42", true)]
    [InlineData("discover:rawg-the-witcher-3", true)]
    [InlineData("discover:steam-620; rm -rf", false)]
    [InlineData("discover:", false)]
    [InlineData("free:1234567", true)]
    [InlineData("free:12345678901", false)]
    [InlineData("other:1", false)]
    [InlineData(null, false)]
    public void Keys_are_strictly_validated(string? key, bool ok) => Assert.Equal(ok, RecommendStore.IsKey(key));

    [Fact]
    public void Dismissals_are_kept_newest_first_with_clean_features_and_survive_a_restart()
    {
        var store = new RecommendStore(_dir.Path);
        Assert.Empty(store.List());
        store.Dismiss(Game, "  Ashen Crown  ", ["k:rpg", "k:fantasy", "s:ashen crown", "x:bad", "k:\u0001ctl", "k:rpg"], Now);
        store.Dismiss("discover:steam-620", "Portal 2", null, Now.AddMinutes(1));

        var again = new RecommendStore(_dir.Path).List();
        Assert.Equal(["discover:steam-620", Game], again.Select(d => d.Key));
        var first = again[1];
        Assert.Equal("Ashen Crown", first.Title);
        Assert.Equal(["k:rpg", "k:fantasy", "s:ashen crown"], first.Features);
        Assert.True(File.Exists(Path.Combine(_dir.Path, "ui-state", "recommend.json")));
    }

    [Fact]
    public void Dismissing_again_moves_it_to_the_top_without_duplicates_and_undo_removes_it()
    {
        var store = new RecommendStore(_dir.Path);
        store.Dismiss(Game, "A", [], Now);
        store.Dismiss("free:42", "B", [], Now);
        var list = store.Dismiss(Game, "A again", [], Now.AddHours(1));
        Assert.Equal([Game, "free:42"], list.Select(d => d.Key));
        Assert.Equal("A again", list[0].Title);
        Assert.Equal(["free:42"], store.Undismiss(Game).Select(d => d.Key));
        store.Clear();
        Assert.Empty(store.List());
    }

    [Fact]
    public void Invalid_input_is_refused()
    {
        var store = new RecommendStore(_dir.Path);
        Assert.Throws<ArgumentException>(() => store.Dismiss("game:nope", "A", [], Now));
        Assert.Throws<ArgumentException>(() => store.Dismiss(Game, "   ", [], Now));
        Assert.Throws<ArgumentException>(() => store.Dismiss(Game, "bad\u0007title", [], Now));
        Assert.Throws<ArgumentException>(() => store.Undismiss("../x"));
        Assert.Empty(store.List());
    }

    [Fact]
    public void The_list_is_capped_and_titles_and_features_are_trimmed()
    {
        var store = new RecommendStore(_dir.Path);
        for (var i = 0; i < RecommendStore.MaxItems + 20; i++)
            store.Dismiss($"free:{i}", new string('t', 300), Enumerable.Range(0, 30).Select(n => $"k:tag{n}"), Now.AddSeconds(i));
        var list = store.List();
        Assert.Equal(RecommendStore.MaxItems, list.Count);
        Assert.Equal($"free:{RecommendStore.MaxItems + 19}", list[0].Key); // newest kept, oldest dropped
        Assert.Equal(RecommendStore.MaxTitle, list[0].Title.Length);
        Assert.Equal(RecommendStore.MaxFeatures, list[0].Features.Count);
    }

    [Fact]
    public void A_corrupt_or_tampered_file_starts_fresh_or_keeps_only_valid_entries()
    {
        _dir.Write("ui-state/recommend.json", "{ not json");
        Assert.Empty(new RecommendStore(_dir.Path).List());

        _dir.Write("ui-state/recommend.json", """
            {"version":1,"items":[
              {"key":"game:0123456789abcdef0123456789abcdef","title":"Ok","features":["k:rpg","bad"],"at":"2026-10-01T00:00:00Z"},
              {"key":"C:\\\\Windows","title":"Bad key","features":[],"at":"2026-10-01T00:00:00Z"},
              {"key":"free:7","title":"","features":[],"at":"2026-10-01T00:00:00Z"},
              {"key":"free:8","title":"Bad date","features":[],"at":"yesterday"},
              {"key":"game:0123456789abcdef0123456789abcdef","title":"Duplicate","features":[],"at":"2026-10-01T00:00:00Z"}
            ]}
            """);
        var list = new RecommendStore(_dir.Path).List();
        var only = Assert.Single(list);
        Assert.Equal(("Ok", 1), (only.Title, only.Features.Count));
    }
}
