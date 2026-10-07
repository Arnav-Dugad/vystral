using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Cloud;
using Vystral.Core.Subscriptions;
using Vystral.Windows.Services;

namespace Vystral.Windows.Subscriptions;

/// <summary>A Store product the subscription features have looked up (dates are round-trip strings).</summary>
public sealed class CachedProduct
{
    public string? Title { get; set; }
    public string? Pfn { get; set; }
    /// <summary>The poster's https URL on Microsoft's image CDN (validated), not yet downloaded.</summary>
    public string? Poster { get; set; }
    /// <summary>The downloaded poster, relative to the art cache (<c>_store/…</c>).</summary>
    public string? Art { get; set; }
    /// <summary>Game Pass end date from the Store listing (only read for "Leaving soon" games).</summary>
    public string? End { get; set; }
    public string? EndCheckedAt { get; set; }
    public string At { get; set; } = "";

    public CachedProduct Copy() => (CachedProduct)MemberwiseClone();
}

/// <summary>
/// Track V: the subscription lists VYSTRAL downloaded, kept in one small JSON file in the data folder
/// (<c>subscriptions-cache.json</c>) so no migration is needed. It's a cache: deleting it only means the next refresh
/// downloads again. Everything read back is validated again, as if it came from the network.
/// </summary>
public sealed partial class SubscriptionCache
{
    public const long MaxFileBytes = 8 * 1024 * 1024;
    public const int MaxProducts = 12000;

    public int Version { get; set; } = 1;
    public string? Market { get; set; }
    public string? ListsAt { get; set; }
    public Dictionary<string, List<string>> Lists { get; set; } = [];
    public List<string> Leaving { get; set; } = [];
    public List<string> Recent { get; set; } = [];
    public List<string> Popular { get; set; } = [];
    public Dictionary<string, CachedProduct> Products { get; set; } = [];
    public string? FailAt { get; set; }
    public int Failures { get; set; }
    public string? Error { get; set; }
    /// <summary>Product ID → when a "leaving Game Pass" notification was sent for it (so it's sent once).</summary>
    public Dictionary<string, string> LeavingNotified { get; set; } = [];

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = false };

    /// <summary>A copy whose collections can be changed without disturbing readers of this one (products are copied on write).</summary>
    public SubscriptionCache Clone() => new()
    {
        Version = Version,
        Market = Market,
        ListsAt = ListsAt,
        Lists = new Dictionary<string, List<string>>(Lists, StringComparer.Ordinal),
        Leaving = [.. Leaving],
        Recent = [.. Recent],
        Popular = [.. Popular],
        Products = new Dictionary<string, CachedProduct>(Products, StringComparer.Ordinal),
        FailAt = FailAt,
        Failures = Failures,
        Error = Error,
        LeavingNotified = new Dictionary<string, string>(LeavingNotified, StringComparer.Ordinal),
    };

    public static SubscriptionCache Load(string path)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length == 0 || info.Length > MaxFileBytes) return new SubscriptionCache();
            var cache = JsonSerializer.Deserialize<SubscriptionCache>(File.ReadAllText(path), Json) ?? new SubscriptionCache();
            return cache.Sanitized();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or NotSupportedException)
        {
            Log.Warn("subs", "The subscription cache couldn't be read; starting fresh", new { error = ex.GetType().Name });
            return new SubscriptionCache();
        }
    }

    public void Save(string path)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json));
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn("subs", "Couldn't save the subscription cache", new { error = ex.GetType().Name });
        }
    }

    /// <summary>Drops anything that isn't a known list, a valid product ID, a valid poster URL or a safe art path.</summary>
    internal SubscriptionCache Sanitized()
    {
        var clean = new SubscriptionCache
        {
            Market = CloudIds.IsMarket(Market) ? Market : null,
            ListsAt = Date(ListsAt),
            FailAt = Date(FailAt),
            Failures = Math.Clamp(Failures, 0, 100),
            Error = Error is { Length: <= 300 } e ? e : null,
        };
        foreach (var key in SubscriptionPlans.CatalogKeys)
            if (Lists?.TryGetValue(key, out var ids) == true && ids is not null) clean.Lists[key] = Ids(ids, SubscriptionCatalogClient.MaxPerList);
        clean.Leaving = Ids(Leaving, SubscriptionCatalogClient.MaxSiglItems);
        clean.Recent = Ids(Recent, SubscriptionCatalogClient.MaxSiglItems);
        clean.Popular = Ids(Popular, SubscriptionCatalogClient.MaxSiglItems);
        foreach (var (id, p) in (Products ?? []).Take(MaxProducts))
        {
            if (!CloudIds.IsProductId(id) || p is null || Date(p.At) is not { } at) continue;
            clean.Products[id] = new CachedProduct
            {
                Title = p.Title is { Length: > 0 and <= 200 } t && !t.Any(char.IsControl) ? t : null,
                Pfn = CloudIds.IsPackageFamilyName(p.Pfn) ? p.Pfn : null,
                Poster = SubscriptionCatalogClient.SafeImageUrl(p.Poster),
                Art = p.Art is not null && ArtPath().IsMatch(p.Art) ? p.Art : null,
                End = Date(p.End),
                EndCheckedAt = Date(p.EndCheckedAt),
                At = at,
            };
        }
        foreach (var (id, at) in (LeavingNotified ?? []).Take(2000))
            if (CloudIds.IsProductId(id) && Date(at) is { } d) clean.LeavingNotified[id] = d;
        return clean;
    }

    private static List<string> Ids(IEnumerable<string>? ids, int max) =>
        (ids ?? []).Where(CloudIds.IsProductId).Distinct(StringComparer.Ordinal).Take(max).ToList();

    private static string? Date(string? s) =>
        s is { Length: <= 40 } && DateTimeOffset.TryParse(s, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var d)
            ? d.ToString("O") : null;

    public static DateTimeOffset? ParseDate(string? s) =>
        s is not null && DateTimeOffset.TryParse(s, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var d) ? d : null;

    [GeneratedRegex(@"\A_store[\\/][0-9a-f]{12}\.(?:jpg|png|webp)\z")]
    private static partial Regex ArtPath();
}
