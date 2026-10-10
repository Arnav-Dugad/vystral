using System.Globalization;
using Dapper;

namespace Vystral.Core.Data;

/// <summary>How much of a database cache there is: rows, approximate bytes, newest and oldest fetch.</summary>
public sealed record DbCacheStats(int Rows, long Bytes, DateTimeOffset? Newest, DateTimeOffset? Oldest);

/// <summary>
/// Track D6: the cache viewer's view of database caches. Only rows that were downloaded and can be downloaded again
/// are ever counted or deleted here (provider answers, cloud catalogues); nothing a user set is touched.
/// </summary>
public sealed partial class LibraryRepository
{
    /// <summary>Provider-cache rows for these providers (prices, deals, Discover shelves…).</summary>
    public DbCacheStats ProviderCacheStats(IReadOnlyCollection<string> providers)
    {
        if (providers.Count == 0) return new DbCacheStats(0, 0, null, null);
        using var conn = db.Open();
        var r = conn.QuerySingle<(long Rows, long? Bytes, string? Newest, string? Oldest)>(
            "SELECT COUNT(*), SUM(LENGTH(body_json) + LENGTH(cache_key)), MAX(fetched), MIN(fetched) FROM provider_cache WHERE provider IN @providers",
            new { providers });
        return new DbCacheStats((int)r.Rows, r.Bytes ?? 0, Time(r.Newest), Time(r.Oldest));
    }

    /// <summary>Deletes provider-cache rows for these providers; returns how many.</summary>
    public int ClearProviderCaches(IReadOnlyCollection<string> providers)
    {
        if (providers.Count == 0) return 0;
        using var conn = db.Open();
        return conn.Execute("DELETE FROM provider_cache WHERE provider IN @providers", new { providers });
    }

    /// <summary>The cloud catalogues (GeForce NOW, Xbox Cloud Gaming) and the Store product names fetched for them.</summary>
    public DbCacheStats CloudCatalogStats()
    {
        using var conn = db.Open();
        var catalog = conn.QuerySingle<(long Rows, long? Bytes)>("SELECT COUNT(*), SUM(LENGTH(title) + LENGTH(entry_id) + LENGTH(links_json)) FROM cloud_catalog");
        var products = conn.QuerySingle<(long Rows, long? Bytes, string? Newest, string? Oldest)>(
            "SELECT COUNT(*), SUM(LENGTH(product_id) + IFNULL(LENGTH(pfn),0) + IFNULL(LENGTH(title),0)), MAX(fetched), MIN(fetched) FROM cloud_products");
        return new DbCacheStats((int)(catalog.Rows + products.Rows), (catalog.Bytes ?? 0) + (products.Bytes ?? 0), Time(products.Newest), Time(products.Oldest));
    }

    /// <summary>Forgets the downloaded cloud catalogues and product names (re-downloaded on the next refresh).</summary>
    public int ClearCloudCatalogs()
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var n = conn.Execute("DELETE FROM cloud_catalog", transaction: tx) + conn.Execute("DELETE FROM cloud_products", transaction: tx);
        tx.Commit();
        return n;
    }

    private static DateTimeOffset? Time(string? s) =>
        s is not null && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t) ? t : null;
}
