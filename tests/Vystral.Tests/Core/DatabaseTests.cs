using Dapper;
using Microsoft.Data.Sqlite;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.Support;
using Xunit;

namespace Vystral.Tests.Core;

public sealed class DatabaseTests : IDisposable
{
    private readonly TestDb _t = new();

    public void Dispose() => _t.Dispose();

    [Fact]
    public void Migrate_on_new_database_returns_zero_and_records_schema_version()
    {
        Assert.Equal(0, _t.MigrateResult);
        using var conn = _t.Db.Open();
        var versions = conn.Query<(long Version, string Applied, string Name)>("SELECT version, applied, name FROM schema_version").ToList();
        Assert.Equal(Database.LatestVersion, versions.Max(v => v.Version));
        Assert.Equal(Enumerable.Range(1, Database.LatestVersion).Select(i => (long)i), versions.Select(v => v.Version).Order());
        Assert.All(versions, v => Assert.False(string.IsNullOrWhiteSpace(v.Name)));
        Assert.All(versions, v => Assert.True(DateTimeOffset.TryParse(v.Applied, out _)));
    }

    [Fact]
    public void Migrate_creates_the_expected_tables()
    {
        using var conn = _t.Db.Open();
        var tables = conn.Query<string>("SELECT name FROM sqlite_master WHERE type='table'").ToHashSet();
        foreach (var t in new[] { "games", "installations", "artwork", "sessions", "perf_samples", "collections",
                     "collection_games", "settings", "dismissed_duplicates", "audit_log", "media_folders" })
            Assert.Contains(t, tables);
    }

    [Fact]
    public void Second_migrate_is_a_no_op_returning_current_version()
    {
        Assert.Equal(Database.LatestVersion, _t.Db.Migrate());
        Assert.Equal(Database.LatestVersion, new Database(_t.Db.FilePath).Migrate());
        using var conn = _t.Db.Open();
        Assert.Equal(Database.LatestVersion, conn.ExecuteScalar<long>("SELECT COUNT(*) FROM schema_version"));
        // No migration was pending, so no pre-migration backup was taken.
        Assert.False(Directory.Exists(Path.Combine(_t.Dir.Path, "backups")));
    }

    [Fact]
    public void Migrate_preserves_existing_data()
    {
        _t.Repo.AddManualGame("Keep Me", @"C:\Games\keep\keep.exe", null);
        _t.Db.Migrate();
        Assert.Single(_t.Repo.LoadSnapshot((_, _) => null).Games);
    }

    [Fact]
    public void Open_enables_foreign_keys()
    {
        using var conn = _t.Db.Open();
        Assert.Equal(1L, conn.ExecuteScalar<long>("PRAGMA foreign_keys"));
        Assert.Throws<SqliteException>(() => conn.Execute(
            "INSERT INTO sessions(id, game_id, start, source) VALUES ('s', 'no-such-game', '2024-01-01', 'tracked')"));
    }

    [Fact]
    public void Database_uses_wal_journal_mode()
    {
        using var conn = _t.Db.Open();
        Assert.Equal("wal", conn.ExecuteScalar<string>("PRAGMA journal_mode"));
    }

    [Fact]
    public void CheckIntegrity_reports_ok_on_healthy_database()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "1", "Alpha"))]);
        Assert.Equal("ok", _t.Db.CheckIntegrity());
    }

    [Fact]
    public void BackupTo_produces_a_readable_copy()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam,
            TestDb.Install(PlatformId.Steam, "1", "Alpha"), TestDb.Install(PlatformId.Steam, "2", "Beta"))]);
        _t.Repo.SetSetting("appearance.theme", "\"oled\"");

        var dest = Path.Combine(_t.Dir.Path, "nested", "backup.db");
        _t.Db.BackupTo(dest);

        Assert.True(File.Exists(dest));
        var copy = new Database(dest);
        Assert.Equal("ok", copy.CheckIntegrity());
        var repo = new LibraryRepository(copy);
        Assert.Equal(["Alpha", "Beta"], repo.LoadSnapshot((_, _) => null).Games.Select(g => g.Title).Order().ToArray());
        Assert.Equal("\"oled\"", repo.GetSettings()["appearance.theme"]);
        // Already at the latest version: migrating the copy does nothing.
        Assert.Equal(Database.LatestVersion, copy.Migrate());
        TestDb.ReleasePool(copy);
    }
}
