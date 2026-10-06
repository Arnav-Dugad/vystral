using System.Globalization;
using System.Text.Json;
using Dapper;
using Vystral.Core.Cloud;
using Vystral.Core.Domain;

namespace Vystral.Core.Data;

/// <summary>A cached Store product identity (display catalogue).</summary>
public sealed record CloudProductRow(string ProductId, string? Pfn, string? Title, DateTimeOffset Fetched);

/// <summary>Track O: cloud play. Cached catalogues (migration 7) and cloud sessions (the existing sessions table).</summary>
public sealed partial class LibraryRepository
{
    private static readonly JsonSerializerOptions CloudJson = new(JsonSerializerDefaults.Web);

    /// <summary>Replaces a service's cached catalogue with a fresh one for <paramref name="market"/> (other markets' rows go too).</summary>
    public void ReplaceCloudCatalog(string service, string market, IReadOnlyList<CloudCatalogEntry> entries)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        conn.Execute("DELETE FROM cloud_catalog WHERE service=@service", new { service }, tx);
        conn.Execute("""
            INSERT OR REPLACE INTO cloud_catalog(service, market, entry_id, launch_key, title, play_type, premium, links_json)
            VALUES (@Service, @market, @EntryId, @LaunchKey, @Title, @PlayType, @Premium, @Links)
            """, entries.Select(e => new
        {
            e.Service, market, e.EntryId, e.LaunchKey, e.Title, e.PlayType, Premium = e.Premium ? 1 : 0,
            Links = JsonSerializer.Serialize(e.Links, CloudJson),
        }), tx);
        tx.Commit();
    }

    public IReadOnlyList<CloudCatalogEntry> GetCloudCatalog(string service, string market)
    {
        using var conn = db.Open();
        return conn.Query<(string EntryId, string? LaunchKey, string Title, string? PlayType, long Premium, string Links)>(
                "SELECT entry_id, launch_key, title, play_type, premium, links_json FROM cloud_catalog WHERE service=@service AND market=@market",
                new { service, market })
            .Select(r => new CloudCatalogEntry(service, r.EntryId, r.LaunchKey, r.Title, r.PlayType, r.Premium != 0, ReadLinks(r.Links)))
            .ToList();
    }

    public int CloudCatalogCount(string service, string market)
    {
        using var conn = db.Open();
        return conn.ExecuteScalar<int>("SELECT COUNT(*) FROM cloud_catalog WHERE service=@service AND market=@market", new { service, market });
    }

    private static IReadOnlyList<CloudStoreLink> ReadLinks(string json)
    {
        try { return JsonSerializer.Deserialize<List<CloudStoreLink>>(json, CloudJson) ?? []; }
        catch (JsonException) { return []; }
    }

    public IReadOnlyDictionary<string, CloudProductRow> GetCloudProducts()
    {
        using var conn = db.Open();
        return conn.Query<(string Id, string? Pfn, string? Title, string Fetched)>("SELECT product_id, pfn, title, fetched FROM cloud_products")
            .Select(r => new CloudProductRow(r.Id, r.Pfn, r.Title,
                DateTimeOffset.TryParse(r.Fetched, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var f) ? f : DateTimeOffset.MinValue))
            .ToDictionary(r => r.ProductId, StringComparer.Ordinal);
    }

    public void UpsertCloudProducts(IReadOnlyList<CloudProductRow> rows)
    {
        if (rows.Count == 0) return;
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        conn.Execute("""
            INSERT INTO cloud_products(product_id, pfn, title, fetched) VALUES (@ProductId, @Pfn, @Title, @At)
            ON CONFLICT(product_id) DO UPDATE SET pfn=excluded.pfn, title=excluded.title, fetched=excluded.fetched
            """, rows.Select(r => new { r.ProductId, r.Pfn, r.Title, At = r.Fetched.ToString("O") }), tx);
        tx.Commit();
    }

    /// <summary>Every game with its copies (any state), for cloud matching. Hidden games are left out.</summary>
    public IReadOnlyList<CloudLibraryGame> GetCloudLibrary()
    {
        using var conn = db.Open();
        var games = conn.Query<(string Id, string Title, string? SteamAppId)>("SELECT id, title, steam_app_id FROM games WHERE hidden = 0").ToList();
        var copies = conn.Query<(string GameId, string Platform, string Pgid, string Title)>(
            "SELECT game_id, platform, platform_game_id, title FROM installations").ToLookup(c => c.GameId);
        return games.Select(g => new CloudLibraryGame(g.Id, g.Title, g.SteamAppId,
            copies[g.Id].Select(c => new CloudLibraryCopy(c.Platform, c.Pgid, c.Title)).ToList())).ToList();
    }

    /// <summary>Finished cloud sessions of one source that ended after <paramref name="since"/>.</summary>
    public IReadOnlyList<CloudSpan> CloudSpansSince(string source, DateTimeOffset since)
    {
        using var conn = db.Open();
        return conn.Query<(string Start, string? End, int Duration)>(
                "SELECT start, end, duration_seconds FROM sessions WHERE source=@source AND end IS NOT NULL AND end >= @since",
                new { source, since = since.ToUniversalTime().AddDays(-2).ToString("O") })
            .Select(r => DateTimeOffset.TryParse(r.Start, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var s)
                ? new CloudSpan(s, s.AddSeconds(Math.Max(0, r.Duration)))
                : (CloudSpan?)null)
            .Where(s => s is { } x && x.End > since)
            .Select(s => s!.Value)
            .ToList();
    }

    /// <summary>The newest finished cloud session of a source, or null.</summary>
    public (string GameId, DateTimeOffset Start, int Duration)? LastCloudSession(string source)
    {
        using var conn = db.Open();
        var rows = conn.Query<(string GameId, string Start, int Duration)>(
            "SELECT game_id, start, duration_seconds FROM sessions WHERE source=@source AND end IS NOT NULL ORDER BY start DESC LIMIT 1", new { source }).ToList();
        return rows is [var r] && DateTimeOffset.TryParse(r.Start, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var s)
            ? (r.GameId, s, r.Duration) : null;
    }

    /// <summary>Starts a cloud session (no installation: nothing runs on this PC).</summary>
    public string StartCloudSession(string gameId, string service, DateTimeOffset start) =>
        StartSession(gameId, null, start, CloudServices.SessionSource(service));
}
