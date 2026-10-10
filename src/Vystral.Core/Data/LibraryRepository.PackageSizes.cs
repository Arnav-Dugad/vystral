using Dapper;

namespace Vystral.Core.Data;

/// <summary>Track C1: an installed packaged game whose size is unknown or was measured for another package version.</summary>
public sealed record PackageSizeWork(string InstallationId, string InstallPath, string? Version);

public sealed partial class LibraryRepository
{
    /// <summary>
    /// Installed Xbox packages that need a size: never measured, or measured for a different package version
    /// (an update changes the size; nothing else should trigger a re-measure).
    /// </summary>
    public IReadOnlyList<PackageSizeWork> PackagesNeedingSize()
    {
        using var conn = db.Open();
        return conn.Query<(string Id, string Path, string? Version)>("""
            SELECT id, install_path, package_version FROM installations
            WHERE platform='xbox' AND state='installed' AND install_path IS NOT NULL
              AND (size_bytes IS NULL OR COALESCE(size_version, '') <> COALESCE(package_version, ''))
            ORDER BY last_seen DESC
            """).Select(r => new PackageSizeWork(r.Id, r.Path, r.Version)).ToList();
    }

    /// <summary>Stores a measured size for the version it was measured at. Ignored if the row moved meanwhile.</summary>
    public bool SetMeasuredSize(string installationId, string installPath, long bytes, string? version)
    {
        if (bytes < 0) return false;
        using var conn = db.Open();
        return conn.Execute("""
            UPDATE installations SET size_bytes=@bytes, size_version=@v
            WHERE id=@installationId AND install_path=@installPath AND platform='xbox'
            """, new { installationId, installPath, bytes, v = version ?? "" }) == 1;
    }
}
