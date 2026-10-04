using Microsoft.Data.Sqlite;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;

namespace Vystral.Tests.Support;

/// <summary>A migrated SQLite database in a scratch folder, plus helpers for building scan results.</summary>
public sealed class TestDb : IDisposable
{
    public TempDir Dir { get; } = new();
    public Database Db { get; }
    public LibraryRepository Repo { get; }
    public int MigrateResult { get; }

    public TestDb()
    {
        Db = new Database(Path.Combine(Dir.Path, "vystral.db"));
        MigrateResult = Db.Migrate();
        Repo = new LibraryRepository(Db);
    }

    public void Dispose()
    {
        ReleasePool(Db);
        Dir.Dispose();
    }

    /// <summary>
    /// Pooled connections keep the file open; release them so the folder can be deleted.
    /// Only this database's pool is cleared: ClearAllPools() races with other test classes
    /// running in parallel and disposes their connections mid-use.
    /// </summary>
    public static void ReleasePool(Database db)
    {
        using var conn = db.Open();
        SqliteConnection.ClearPool(conn);
    }

    public static DiscoveredInstallation Install(PlatformId platform, string id, string title, string? installPath = null,
        string? steamAppId = null, InstallState state = InstallState.Installed, int? playtime = null) => new()
    {
        Platform = platform,
        PlatformGameId = id,
        Title = title,
        InstallPath = installPath,
        SteamAppId = steamAppId,
        State = state,
        PlaytimeMinutes = playtime,
        ProcessHints = [$"{id}.exe"],
        Launch = platform switch
        {
            PlatformId.Steam => new LaunchTarget(LaunchKind.Uri, $"steam://rungameid/{id}"),
            PlatformId.Epic => new LaunchTarget(LaunchKind.Uri, $"com.epicgames.launcher://apps/{id}?action=launch&silent=true"),
            PlatformId.Xbox => new LaunchTarget(LaunchKind.PackagedApp, $"{id}_8wekyb3d8bbwe!App"),
            _ => new LaunchTarget(LaunchKind.Executable, $@"C:\Games\{id}\{id}.exe"),
        },
    };

    public static AdapterScanResult Ok(PlatformId platform, params DiscoveredInstallation[] found) => new(platform, true, found);

    public static AdapterScanResult Failed(PlatformId platform, string error = "boom") => new(platform, false, [], error);
}
