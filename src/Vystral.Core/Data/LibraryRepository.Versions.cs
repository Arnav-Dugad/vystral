using System.Globalization;
using System.Text.RegularExpressions;
using Dapper;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;

namespace Vystral.Core.Data;

/// <summary>Track D1: a version a store reported for one copy during a scan.</summary>
/// <param name="Kind">steamBuild | xboxPackage.</param>
public sealed record ObservedVersion(string Platform, string PlatformGameId, string Kind, string Value, DateTimeOffset? StoreUpdated);

/// <summary>
/// Track D1: one version of one copy, as VYSTRAL saw it. <see cref="Baseline"/> = the first version seen for that copy
/// (not an update: VYSTRAL doesn't know when it arrived). <see cref="StoreUpdated"/> = when the store says it was installed.
/// </summary>
public sealed record VersionHistoryEntry(string InstallationId, string Platform, string Kind, string Value, string Seen, string? StoreUpdated, bool Baseline);

public static partial class ObservedVersions
{
    public const string SteamBuild = "steamBuild";
    public const string XboxPackage = "xboxPackage";
    /// <summary>Rows kept per copy and kind (oldest pruned).</summary>
    public const int KeepPerCopy = 100;

    [GeneratedRegex(@"^[0-9]{1,20}\z")]
    private static partial Regex Build();

    [GeneratedRegex(@"^[0-9]{1,9}(\.[0-9]{1,9}){0,3}\z")]
    private static partial Regex PackageVersion();

    /// <summary>The versions in successful scan results worth recording (validated: digits and dots only, short).</summary>
    public static IReadOnlyList<ObservedVersion> From(IReadOnlyList<AdapterScanResult> results)
    {
        var list = new List<ObservedVersion>();
        foreach (var r in results.Where(r => r.Succeeded))
        {
            foreach (var i in r.Installations)
            {
                if (i.State != InstallState.Installed) continue;
                if (r.Platform == PlatformId.Steam && i.BuildId is { } b && Build().IsMatch(b) && b != "0")
                    list.Add(new ObservedVersion(r.Platform.Key(), i.PlatformGameId, SteamBuild, b, i.BuildUpdated));
                else if (r.Platform == PlatformId.Xbox && i.Version is { } v && PackageVersion().IsMatch(v))
                    list.Add(new ObservedVersion(r.Platform.Key(), i.PlatformGameId, XboxPackage, v, i.InstalledAt));
            }
        }
        return list;
    }
}

public sealed partial class LibraryRepository
{
    /// <summary>
    /// Track D1: records each copy's version when it differs from the newest one recorded (the first sighting is the
    /// baseline). One transaction; unknown copies are skipped. Returns how many rows were added.
    /// </summary>
    public int RecordVersions(IReadOnlyList<ObservedVersion> observed, DateTimeOffset? now = null)
    {
        if (observed.Count == 0) return 0;
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var seen = (now ?? DateTimeOffset.UtcNow).ToString("O");
        var added = 0;
        foreach (var o in observed)
        {
            var instId = conn.ExecuteScalar<string?>("SELECT id FROM installations WHERE platform=@p AND platform_game_id=@g",
                new { p = o.Platform, g = o.PlatformGameId }, tx);
            if (instId is null) continue;
            var latest = conn.ExecuteScalar<string?>("SELECT value FROM installation_versions WHERE installation_id=@instId AND kind=@k ORDER BY id DESC LIMIT 1",
                new { instId, k = o.Kind }, tx);
            if (latest == o.Value) continue;
            conn.Execute("INSERT INTO installation_versions(installation_id, kind, value, seen, store_updated) VALUES (@instId, @k, @v, @seen, @upd)",
                new { instId, k = o.Kind, v = o.Value, seen, upd = o.StoreUpdated?.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) }, tx);
            conn.Execute("""
                DELETE FROM installation_versions WHERE installation_id=@instId AND kind=@k AND id NOT IN
                  (SELECT id FROM installation_versions WHERE installation_id=@instId AND kind=@k ORDER BY id DESC LIMIT @keep)
                """, new { instId, k = o.Kind, keep = ObservedVersions.KeepPerCopy }, tx);
            added++;
        }
        tx.Commit();
        return added;
    }

    /// <summary>Track D1: every recorded version of a game's copies, oldest first.</summary>
    public IReadOnlyList<VersionHistoryEntry> GetVersionHistory(string gameId)
    {
        using var conn = db.Open();
        var rows = conn.Query<(long Id, string InstallationId, string Platform, string Kind, string Value, string Seen, string? StoreUpdated)>("""
            SELECT v.id, v.installation_id, i.platform, v.kind, v.value, v.seen, v.store_updated
            FROM installation_versions v JOIN installations i ON i.id = v.installation_id
            WHERE i.game_id = @gameId ORDER BY v.id
            """, new { gameId }).ToList();
        var first = new HashSet<(string, string)>();
        return rows.Select(r => new VersionHistoryEntry(r.InstallationId, r.Platform, r.Kind, r.Value, r.Seen, r.StoreUpdated,
            first.Add((r.InstallationId, r.Kind)))).ToList();
    }
}
