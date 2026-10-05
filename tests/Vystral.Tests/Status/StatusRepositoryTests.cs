using Dapper;
using Microsoft.Data.Sqlite;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Media;
using Vystral.Tests.Support;
using Xunit;

namespace Vystral.Tests.Status;

public sealed class StatusRepositoryTests : IDisposable
{
    private readonly TestDb _t = new();

    public void Dispose() => _t.Dispose();

    private string AddGame(string title = "Status Game") => _t.Repo.AddManualGame(title, $@"C:\Games\{title}\{title}.exe", null);

    [Theory]
    [InlineData(null, true)]
    [InlineData("backlog", true)]
    [InlineData("playing", true)]
    [InlineData("beaten", true)]
    [InlineData("completed", true)]
    [InlineData("abandoned", true)]
    [InlineData("", false)]
    [InlineData("Playing", false)]
    [InlineData("finished", false)]
    [InlineData("beaten ", false)]
    public void Only_the_five_statuses_or_null_are_valid(string? status, bool valid) => Assert.Equal(valid, GameStatus.IsValid(status));

    [Fact]
    public void SetStatus_rejects_unknown_values_without_writing()
    {
        var id = AddGame();
        Assert.Throws<ArgumentException>(() => _t.Repo.SetStatus(id, "done"));
        Assert.Empty(_t.Repo.GetStatusHistory());
        Assert.Null(_t.Repo.LoadSnapshot((_, _) => null).Games.Single().Status);
    }

    [Fact]
    public void SetStatus_returns_null_for_unknown_games() => Assert.Null(_t.Repo.SetStatus(LibraryRepository.NewId(), "playing"));

    [Fact]
    public void SetStatus_updates_the_game_writes_history_and_audits()
    {
        var id = AddGame();
        var at = new DateTimeOffset(2026, 3, 1, 12, 0, 0, TimeSpan.Zero);
        var change = _t.Repo.SetStatus(id, "playing", at)!;

        Assert.True(change.Changed);
        Assert.Null(change.Previous);
        Assert.Equal("playing", change.Status);
        Assert.Equal(at.ToString("O"), change.ChangedAt);

        var h = Assert.Single(_t.Repo.GetStatusHistory());
        Assert.Equal((id, "playing", at.ToString("O")), (h.GameId, h.Status, h.At));
        Assert.Contains(_t.Repo.RecentAudit(5), a => a.Action == "game.setStatus" && a.Detail == $"{id}: (none) -> playing");
    }

    [Fact]
    public void Setting_the_same_status_again_is_a_no_op()
    {
        var id = AddGame();
        _t.Repo.SetStatus(id, "backlog");
        var again = _t.Repo.SetStatus(id, "backlog")!;
        Assert.False(again.Changed);
        Assert.Equal("backlog", again.Previous);
        Assert.Single(_t.Repo.GetStatusHistory());
    }

    [Fact]
    public void Clearing_records_a_null_history_row_and_clears_the_snapshot()
    {
        var id = AddGame();
        var t0 = DateTimeOffset.UtcNow.AddDays(-3);
        _t.Repo.SetStatus(id, "playing", t0);
        _t.Repo.SetStatus(id, "beaten", t0.AddDays(1));
        var cleared = _t.Repo.SetStatus(id, null, t0.AddDays(2))!;

        Assert.Equal("beaten", cleared.Previous);
        Assert.Equal(new string?[] { "playing", "beaten", null }, _t.Repo.GetStatusHistory().Select(h => h.Status));
        var g = _t.Repo.LoadSnapshot((_, _) => null).Games.Single();
        Assert.Null(g.Status);
        Assert.Null(g.StatusChangedAt);
    }

    [Fact]
    public void Snapshot_includes_status_and_changed_time()
    {
        var a = AddGame("Alpha");
        var b = AddGame("Beta");
        var at = new DateTimeOffset(2026, 5, 2, 8, 30, 0, TimeSpan.Zero);
        _t.Repo.SetStatus(a, "completed", at);
        var games = _t.Repo.LoadSnapshot((_, _) => null).Games.ToDictionary(g => g.Id);
        Assert.Equal("completed", games[a].Status);
        Assert.Equal(at.ToString("O"), games[a].StatusChangedAt);
        Assert.Null(games[b].Status);
        Assert.Null(games[b].StatusChangedAt);
    }

    [Fact]
    public void History_is_ordered_and_skips_games_that_no_longer_exist()
    {
        var keep = AddGame("Keep");
        var gone = AddGame("Gone");
        var t0 = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        _t.Repo.SetStatus(keep, "playing", t0.AddDays(2));
        _t.Repo.SetStatus(gone, "backlog", t0.AddDays(1));
        _t.Repo.SetStatus(keep, "backlog", t0);
        Assert.True(_t.Repo.RemoveManualGame(gone));

        var h = _t.Repo.GetStatusHistory();
        Assert.All(h, e => Assert.Equal(keep, e.GameId));
        Assert.Equal(new[] { "backlog", "playing" }, h.Select(e => e.Status));
    }

    [Fact]
    public void Merging_a_game_with_history_still_succeeds()
    {
        _t.Repo.ApplyScan([
            TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "100", "Merge Me")),
            TestDb.Ok(PlatformId.Epic, TestDb.Install(PlatformId.Epic, "abc", "Merge Me Too")),
        ]);
        var games = _t.Repo.LoadSnapshot((_, _) => null).Games;
        var (target, source) = (games[0].Id, games[1].Id);
        _t.Repo.SetStatus(source, "playing");
        Assert.True(_t.Repo.MergeGames(target, source));
        // The source's status and history follow the merge into the surviving game.
        var history = _t.Repo.GetStatusHistory();
        Assert.Single(history);
        Assert.Equal(target, history[0].GameId);
        Assert.Equal("playing", _t.Repo.LoadSnapshot((_, _) => null).Games.Single(g => g.Id == target).Status);
    }

    // ---------- Trailer rows ----------

    [Fact]
    public void Trailer_round_trips_and_none_is_remembered()
    {
        var id = AddGame();
        Assert.Null(_t.Repo.GetTrailer(id));

        var t = new SteamTrailer("620", "81614", "Launch", "mp4", "https://cdn.akamai.steamstatic.com/steam/apps/81614/movie_max.mp4", null, true);
        _t.Repo.SetTrailer(id, "620", t);
        var row = _t.Repo.GetTrailer(id)!.Value;
        Assert.Equal(t, row.Trailer);
        Assert.Equal("620", row.SteamAppId);

        _t.Repo.SetTrailer(id, "620", null);
        var none = _t.Repo.GetTrailer(id)!.Value;
        Assert.Null(none.Trailer);
        Assert.True(DateTimeOffset.UtcNow - none.Fetched < TimeSpan.FromMinutes(1));
    }

    [Fact]
    public void Trailer_for_an_unknown_game_is_ignored()
    {
        var unknown = LibraryRepository.NewId();
        _t.Repo.SetTrailer(unknown, "1", null);
        Assert.Null(_t.Repo.GetTrailer(unknown));
    }
}

public sealed class StatusMigrationTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Migration_2_upgrades_an_existing_v1_database_and_keeps_its_data()
    {
        var path = Path.Combine(_dir.Path, "vystral.db");
        var cs = new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString();
        using (var conn = new SqliteConnection(cs))
        {
            conn.Open();
            conn.Execute("CREATE TABLE schema_version (version INTEGER NOT NULL, applied TEXT NOT NULL, name TEXT NOT NULL);");
            var (version, name, sql) = Migrations.All.Single(m => m.Version == 1);
            conn.Execute(sql);
            conn.Execute("INSERT INTO schema_version VALUES (@version, '2026-01-01T00:00:00Z', @name)", new { version, name });
            conn.Execute("""
                INSERT INTO games(id, title, sort_title, notes, user_rating, favorite, steam_app_id, added, updated)
                VALUES ('0123456789abcdef0123456789abcdef', 'Old Game', 'old game', 'my notes', 4, 1, '620', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                INSERT INTO sessions(id, game_id, start, end, duration_seconds, source)
                VALUES ('fedcba9876543210fedcba9876543210', '0123456789abcdef0123456789abcdef', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z', 3600, 'tracked');
                """);
        }

        var db = new Database(path);
        try
        {
            Assert.Equal(1, db.Migrate());
            var repo = new LibraryRepository(db);
            var g = repo.LoadSnapshot((_, _) => null).Games.Single();
            Assert.Equal(("Old Game", "my notes", 4, true, 3600L, 1), (g.Title, g.Notes, g.UserRating, g.Favorite, g.TrackedSeconds, g.SessionCount));
            Assert.Null(g.Status);
            Assert.Null(g.StatusChangedAt);

            using var conn = db.Open();
            var tables = conn.Query<string>("SELECT name FROM sqlite_master WHERE type='table'").ToHashSet();
            Assert.Contains("status_history", tables);
            Assert.Contains("game_media", tables);
            Assert.Contains(2L, conn.Query<long>("SELECT version FROM schema_version"));
            Assert.True(Directory.EnumerateFiles(Path.Combine(_dir.Path, "backups"), "pre-migration-v1-*.db").Any());

            // The new columns are usable straight away.
            Assert.True(repo.SetStatus(g.Id, "playing")!.Changed);
            Assert.Equal("620", repo.GetSteamAppId(g.Id));
        }
        finally
        {
            TestDb.ReleasePool(db);
        }
    }

    [Fact]
    public void Migrations_are_sorted_and_contiguous()
    {
        var versions = Migrations.All.Select(m => m.Version).ToList();
        Assert.Equal(versions.Order(), versions);
        Assert.Equal(Enumerable.Range(1, versions.Count), versions);
    }
}
