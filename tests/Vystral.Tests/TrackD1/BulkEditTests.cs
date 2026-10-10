using Dapper;
using Vystral.Core.Data;
using Vystral.Tests.Support;
using Vystral.Windows;
using Vystral.Windows.Bridge;
using Xunit;

namespace Vystral.Tests.TrackD1;

public sealed class BulkEditTests : IDisposable
{
    private readonly TestDb _t = new();
    private static readonly DateTimeOffset At = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

    public void Dispose() => _t.Dispose();

    private string AddGame(string title) => _t.Repo.AddManualGame(title, $@"C:\Games\{title}\{title}.exe", null);

    private Vystral.Core.Contracts.GameDto Game(string id) => _t.Repo.LoadSnapshot((_, _) => null).Games.Single(g => g.Id == id);

    [Fact]
    public void Status_changes_every_game_in_one_go_and_undo_restores_status_time_and_history()
    {
        var a = AddGame("Alpha");
        var b = AddGame("Beta");
        var c = AddGame("Gamma");
        var earlier = new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);
        _t.Repo.SetStatus(a, "playing", earlier);
        _t.Repo.SetStatus(c, "beaten", earlier);
        var historyBefore = _t.Repo.GetStatusHistory();

        var result = _t.Repo.BulkEdit([a, b, c], new BulkAction("status", Status: "beaten"), At);

        Assert.Equal(3, result.Requested);
        Assert.Equal(3, result.Found);
        Assert.Equal(2, result.Changed); // Gamma was already beaten
        Assert.All(new[] { a, b, c }, id => Assert.Equal("beaten", Game(id).Status));
        Assert.Equal(At.ToString("O"), Game(b).StatusChangedAt);
        Assert.Equal(historyBefore.Count + 2, _t.Repo.GetStatusHistory().Count);

        Assert.Equal(2, _t.Repo.BulkRestore(new BulkAction("status", Status: "beaten"), result.Before));

        Assert.Equal("playing", Game(a).Status);
        Assert.Equal(earlier.ToString("O"), Game(a).StatusChangedAt);
        Assert.Null(Game(b).Status);
        Assert.Null(Game(b).StatusChangedAt);
        Assert.Equal("beaten", Game(c).Status);
        Assert.Equal(historyBefore, _t.Repo.GetStatusHistory());
        Assert.Contains(_t.Repo.RecentAudit(5), e => e.Action == "library.bulkUndo");
    }

    [Theory]
    [InlineData("favorite")]
    [InlineData("hidden")]
    [InlineData("played")]
    public void Flags_toggle_and_undo_restores_only_that_flag(string kind)
    {
        var a = AddGame("Alpha");
        var b = AddGame("Beta");
        _t.Repo.UpdateGameFlags(b, favorite: true, hidden: true);
        _t.Repo.BulkEdit([b], new BulkAction("played", Value: true), At.AddDays(-3));

        var action = new BulkAction(kind, Value: true);
        var result = _t.Repo.BulkEdit([a, b], action, At);
        Assert.Equal(1, result.Changed); // Beta already had it
        var ga = Game(a);
        Assert.True(kind switch { "favorite" => ga.Favorite, "hidden" => ga.UserHidden, _ => ga.PlayedMarkedAt == At.ToString("O") });

        // Something else changed meanwhile is kept.
        _t.Repo.UpdateGameFlags(a, rating: 4);
        _t.Repo.BulkRestore(action, result.Before);

        ga = Game(a);
        Assert.False(ga.Favorite);
        Assert.False(ga.UserHidden);
        Assert.Null(ga.PlayedMarkedAt);
        Assert.Equal(4, ga.UserRating);
        var gb = Game(b);
        Assert.True(gb.Favorite && gb.UserHidden);
        Assert.Equal(At.AddDays(-3).ToString("O"), gb.PlayedMarkedAt);
    }

    [Fact]
    public void Collections_add_and_remove_with_exact_undo_and_smart_collections_are_refused()
    {
        var a = AddGame("Alpha");
        var b = AddGame("Beta");
        var col = _t.Repo.CreateCollection("Couch", null, null);
        _t.Repo.SetCollectionMembership(col, b, true);

        var add = new BulkAction("collection", Value: true, CollectionId: col);
        var result = _t.Repo.BulkEdit([a, b], add, At);
        Assert.Equal(1, result.Changed);
        Assert.Contains(col, Game(a).Collections);
        _t.Repo.BulkRestore(add, result.Before);
        Assert.DoesNotContain(col, Game(a).Collections);
        Assert.Contains(col, Game(b).Collections);

        var remove = new BulkAction("collection", Value: false, CollectionId: col);
        result = _t.Repo.BulkEdit([a, b], remove, At);
        Assert.Equal(1, result.Changed);
        Assert.DoesNotContain(col, Game(b).Collections);
        _t.Repo.BulkRestore(remove, result.Before);
        Assert.Contains(col, Game(b).Collections);

        var smart = _t.Repo.CreateCollection("Smart", null, """{"installed":true}""");
        Assert.Throws<BulkEditRefusedException>(() => _t.Repo.BulkEdit([a], new BulkAction("collection", Value: true, CollectionId: smart), At));
        Assert.Throws<BulkEditRefusedException>(() => _t.Repo.BulkEdit([a], new BulkAction("collection", Value: true, CollectionId: LibraryRepository.NewId()), At));
    }

    [Fact]
    public void Unknown_games_are_skipped_invalid_actions_write_nothing_and_size_is_capped()
    {
        var a = AddGame("Alpha");
        var result = _t.Repo.BulkEdit([a, LibraryRepository.NewId(), a], new BulkAction("favorite", Value: true), At);
        Assert.Equal(2, result.Requested); // duplicates collapse
        Assert.Equal(1, result.Found);
        Assert.Equal(1, result.Changed);

        Assert.Throws<ArgumentException>(() => _t.Repo.BulkEdit([a], new BulkAction("status", Status: "finished"), At));
        Assert.Throws<ArgumentException>(() => _t.Repo.BulkEdit([a], new BulkAction("delete"), At));
        var many = Enumerable.Range(0, LibraryRepository.MaxBulkGames + 1).Select(_ => LibraryRepository.NewId()).ToList();
        Assert.Throws<ArgumentException>(() => _t.Repo.BulkEdit(many, new BulkAction("favorite", Value: true), At));
        Assert.Null(Game(a).Status);
    }

    [Fact]
    public void A_played_mark_takes_a_game_out_of_never_played_backlog_candidates()
    {
        var a = AddGame("Alpha");
        Assert.True(_t.Repo.BacklogCandidates().Single(c => c.GameId == a).NeverPlayed);
        _t.Repo.BulkEdit([a], new BulkAction("played", Value: true), At);
        Assert.DoesNotContain(_t.Repo.BacklogCandidates(), c => c.GameId == a);
    }

    [Fact]
    public void Undo_buffer_hands_each_token_out_once_and_forgets_old_or_expired_ones()
    {
        var now = At;
        var buffer = new BulkUndoBuffer(capacity: 2, lifetime: TimeSpan.FromMinutes(15), clock: () => now);
        var action = new BulkAction("favorite", Value: true);
        var first = buffer.Add(action, []);
        var second = buffer.Add(action, []);
        var third = buffer.Add(action, []);
        Assert.Matches("^[0-9a-f]{32}$", third);

        Assert.Null(buffer.Take(first)); // pushed out by capacity
        Assert.NotNull(buffer.Take(second));
        Assert.Null(buffer.Take(second)); // used
        now = now.AddMinutes(16);
        Assert.Null(buffer.Take(third)); // expired
    }

    [Theory]
    [InlineData("status", "beaten", null, null, true)]
    [InlineData("status", null, null, null, true)]
    [InlineData("status", "Beaten", null, null, false)]
    [InlineData("favorite", null, true, null, true)]
    [InlineData("favorite", null, null, null, false)]
    [InlineData("collection", null, true, null, false)]
    [InlineData("collection", null, true, "0123456789abcdef0123456789abcdef", true)]
    [InlineData("delete", null, true, null, false)]
    public void Bridge_validates_the_action(string action, string? status, bool? value, string? collection, bool ok)
    {
        var p = new BulkEditParams(["0123456789abcdef0123456789abcdef"], action, status, value, collection);
        if (ok) Assert.Equal(action, AppBackend.ParseBulkAction(p).Kind);
        else Assert.Throws<BridgeException>(() => AppBackend.ParseBulkAction(p));
    }

    [Fact]
    public void Migration_adds_the_played_mark_and_version_table()
    {
        using var conn = _t.Db.Open();
        Assert.Contains("played_marked", conn.Query<string>("SELECT name FROM pragma_table_info('games')"));
        Assert.Equal(6, conn.Query<string>("SELECT name FROM pragma_table_info('installation_versions')").Count());
    }
}
