using Dapper;
using Microsoft.Data.Sqlite;

namespace Vystral.Core.Data;

public sealed class MigrationException(string message, Exception inner) : Exception(message, inner);

/// <summary>
/// Owns the SQLite file. Uses WAL so the UI can read while a library scan writes, and
/// takes a file backup before applying migrations so a failed upgrade is recoverable.
/// </summary>
public sealed class Database
{
    private readonly string _connectionString;

    public string FilePath { get; }

    /// <param name="pooling">
    /// False for the background tracker: it then holds the file open only for the moment of each
    /// read or write, never in between (see docs/ARCHITECTURE.md, background tracker).
    /// </param>
    public Database(string filePath, bool pooling = true)
    {
        FilePath = filePath;
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = filePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            Pooling = pooling,
        }.ToString();
    }

    public static int LatestVersion => Migrations.All[^1].Version;

    public SqliteConnection Open()
    {
        var conn = new SqliteConnection(_connectionString);
        conn.Open();
        conn.Execute("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        return conn;
    }

    /// <summary>Creates or upgrades the schema. Returns the version before migrating.</summary>
    public int Migrate()
    {
        var isNew = FilePath != ":memory:" && !File.Exists(FilePath);
        using var conn = Open();
        conn.Execute("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
        conn.Execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied TEXT NOT NULL, name TEXT NOT NULL);");
        var current = conn.ExecuteScalar<int?>("SELECT MAX(version) FROM schema_version") ?? 0;
        var pending = Migrations.All.Where(m => m.Version > current).ToList();
        if (pending.Count == 0) return current;

        if (current > 0 && !isNew) BackupBeforeMigration(conn, current);

        foreach (var (version, name, sql) in pending)
        {
            using var tx = conn.BeginTransaction();
            try
            {
                conn.Execute(sql, transaction: tx);
                conn.Execute("INSERT INTO schema_version(version, applied, name) VALUES (@version, @applied, @name)",
                    new { version, applied = DateTimeOffset.UtcNow.ToString("O"), name }, tx);
                tx.Commit();
            }
            catch (Exception ex)
            {
                tx.Rollback();
                throw new MigrationException($"Database migration {version} ({name}) failed; the database was left at version {current}.", ex);
            }
            current = version;
        }
        return pending[0].Version - 1;
    }

    /// <summary>The schema version the file is at (0 when it has none yet). Doesn't migrate.</summary>
    public int SchemaVersion()
    {
        using var conn = Open();
        if (conn.ExecuteScalar<long>("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_version'") == 0) return 0;
        return conn.ExecuteScalar<int?>("SELECT MAX(version) FROM schema_version") ?? 0;
    }

    /// <summary>Runs SQLite's integrity check. Returns "ok" when healthy.</summary>
    public string CheckIntegrity()
    {
        using var conn = Open();
        return string.Join("; ", conn.Query<string>("PRAGMA integrity_check"));
    }

    /// <summary>Consistent online backup using SQLite's backup API (safe while in use).</summary>
    public void BackupTo(string destination)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        using var source = Open();
        using var target = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = destination, Pooling = false }.ToString());
        target.Open();
        source.BackupDatabase(target);
    }

    private void BackupBeforeMigration(SqliteConnection conn, int version)
    {
        var dir = Path.Combine(Path.GetDirectoryName(FilePath)!, "backups");
        var dest = Path.Combine(dir, $"pre-migration-v{version}-{DateTime.UtcNow:yyyyMMddHHmmss}.db");
        Directory.CreateDirectory(dir);
        using var target = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = dest, Pooling = false }.ToString());
        target.Open();
        conn.BackupDatabase(target);
    }
}
