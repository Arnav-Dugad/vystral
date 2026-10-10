using Vystral.Windows.DataSources;
using Vystral.Windows.Services;

namespace Vystral.Windows.GamePage;

/// <param name="Percent">Positive share, 0–100, or null with no reviews.</param>
public sealed record ReviewScoreDto(int Score, string Label, long Positive, long Total, double? Percent);

/// <summary>Status: ok | none | off | notSteam | offline | gameRunning | unavailable | rateLimited.</summary>
/// <param name="Trend">up | down | steady, or null when either window has too few reviews to compare honestly.</param>
/// <param name="TrendPoints">Recent minus all-time positive share, in percentage points.</param>
public sealed record ReviewsDto(string Status, string? Message, string? AppId, ReviewScoreDto? AllTime, ReviewScoreDto? Recent, string? Trend,
    double? TrendPoints, string? FetchedAt, bool Stale);

public sealed record PricePointDto(string Day, long Cents);

/// <summary>Status: ok | off | notSteam | offline | gameRunning | unavailable | rateLimited | notFound.</summary>
public sealed record StoreFactsDto(string Status, string? Message, string Country, string? AppId, bool Sold, long? PriceCents, long? RegularCents,
    int Discount, string? Currency, string? PriceText, int? Metacritic, string? ReleaseText, bool ComingSoon, IReadOnlyList<PricePointDto> History,
    string? FetchedAt, bool Stale);

public sealed class ReviewCacheEntry
{
    public DateTimeOffset Fetched { get; set; }
    public ReviewSummary? All { get; set; }
    public ReviewSummary? Recent { get; set; }
}

public sealed class StoreFactsCacheEntry
{
    public DateTimeOffset Fetched { get; set; }
    public StoreFacts? Facts { get; set; }
    /// <summary>Steam prices seen in this country, one point per day, flat runs compacted.</summary>
    public List<WishlistPointDto> History { get; set; } = [];
    public string? HistoryCurrency { get; set; }
}

/// <summary>
/// Track C4: Steam's review snapshot (all time vs the last 30 days, opt-in with <c>dataSources.steamReviews</c> and
/// "Fetch game details") and store facts with a local price history (price, Metacritic, release date; with
/// <c>dataSources.storePrices</c>). Both are cached as JSON for a day, fetched only when a game page asks, never in
/// Offline mode or while a game runs, and a failed refresh keeps showing what was saved (marked stale).
/// </summary>
public sealed class StoreInsightsService
{
    public const string ReviewsSetting = "dataSources.steamReviews";
    public static readonly TimeSpan Ttl = TimeSpan.FromHours(24);
    /// <summary>Fewer reviews than this in either window and the trend arrow isn't shown.</summary>
    public const int MinReviewsForTrend = 10;
    /// <summary>A change smaller than this (percentage points) is "steady".</summary>
    public const double SteadyPoints = 3;
    internal const int MaxEntries = 800;

    private readonly SteamStoreInsightsClient _client;
    private readonly SettingsService _settings;
    private readonly Func<string> _country;
    private readonly GamePageCache<ReviewCacheEntry> _reviews;
    private readonly GamePageCache<StoreFactsCacheEntry> _facts;

    public Func<bool> IsGameActive { get; set; } = () => false;
    public Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

    public StoreInsightsService(SteamStoreInsightsClient client, SettingsService settings, Func<string> country, string folder)
    {
        _client = client;
        _settings = settings;
        _country = country;
        _reviews = new GamePageCache<ReviewCacheEntry>(Path.Combine(folder, "steam-reviews.json"), MaxEntries, 2 * 1024 * 1024, e => e.Fetched, ValidateReviews);
        _facts = new GamePageCache<StoreFactsCacheEntry>(Path.Combine(folder, "store-facts.json"), MaxEntries, 4 * 1024 * 1024, e => e.Fetched, ValidateFacts);
    }

    private bool LocalOnly => _settings.GetBool("privacy.localOnly");
    public bool ReviewsOn => _settings.GetBool(ReviewsSetting) && _settings.GetBool("library.fetchMetadata");
    public bool PricesOn => _settings.GetBool("dataSources.storePrices");

    // ---------- Reviews ----------

    public async Task<ReviewsDto> GetReviewsAsync(string? appId, bool refresh, CancellationToken ct)
    {
        if (!ReviewsOn) return Reviews("off", null, appId, null, false);
        if (!GamePageIds.IsAppId(appId)) return Reviews("notSteam", null, null, null, false);
        var cached = _reviews.Get(appId!);
        if (cached is not null && Now() - cached.Fetched < Ttl && !refresh) return Reviews("ok", null, appId, cached, false);
        if (LocalOnly) return Reviews("offline", "Offline mode is on, so VYSTRAL doesn’t ask Steam for reviews.", appId, cached, true);
        if (IsGameActive()) return Reviews("gameRunning", "VYSTRAL doesn’t contact Steam while a game is running.", appId, cached, true);
        try
        {
            var to = Now();
            var all = await _client.GetReviewSummaryAsync(appId!, null, null, ct);
            ReviewSummary? recent = null;
            // The recent window only matters when the game has reviews at all (saves a request for brand-new games).
            if (all is { Total: > 0 }) recent = await _client.GetReviewSummaryAsync(appId!, to - SteamStoreInsightsClient.RecentWindow, to, ct);
            var entry = new ReviewCacheEntry { Fetched = to, All = all, Recent = recent };
            _reviews.Set(appId!, entry);
            return Reviews("ok", null, appId, entry, false);
        }
        catch (DataSourceException ex)
        {
            Log.Warn("gamepage", "Steam reviews unavailable", new { outcome = ex.Outcome.ToString() });
            return Reviews(GamePageIds.Status(ex.Outcome), ex.Message, appId, cached, true);
        }
    }

    private static ReviewsDto Reviews(string status, string? message, string? appId, ReviewCacheEntry? e, bool stale)
    {
        if (e is null) return new ReviewsDto(status, message, appId, null, null, null, null, null, false);
        var all = Score(e.All);
        var recent = Score(e.Recent);
        var (trend, points) = Trend(e.All, e.Recent);
        var effective = status == "ok" && (e.All is null || e.All.Total == 0) ? "none" : status;
        return new ReviewsDto(effective, message, appId, all, recent, trend, points, e.Fetched.ToString("O"), stale);
    }

    private static ReviewScoreDto? Score(ReviewSummary? s) =>
        s is null ? null : new ReviewScoreDto(s.Score, s.Label, s.Positive, s.Total, s.Total > 0 ? Math.Round(s.Positive * 100.0 / s.Total, 1) : null);

    /// <summary>Recent vs all-time positive share. Needs enough reviews on both sides; within ±<see cref="SteadyPoints"/> is steady.</summary>
    internal static (string? Trend, double? Points) Trend(ReviewSummary? all, ReviewSummary? recent)
    {
        if (all is null || recent is null || all.Total < MinReviewsForTrend || recent.Total < MinReviewsForTrend) return (null, null);
        var diff = Math.Round(recent.Positive * 100.0 / recent.Total - all.Positive * 100.0 / all.Total, 1);
        return (diff >= SteadyPoints ? "up" : diff <= -SteadyPoints ? "down" : "steady", diff);
    }

    /// <summary>The store page's reviews section, built natively from a validated appid.</summary>
    public static Uri? ReviewsUrl(string? appId) => GamePageIds.IsAppId(appId) ? new Uri($"https://store.steampowered.com/app/{appId}/#app_reviews_hash") : null;

    // ---------- Store facts and price history ----------

    public async Task<StoreFactsDto> GetFactsAsync(string? appId, bool refresh, CancellationToken ct)
    {
        var country = _country();
        if (!PricesOn) return Facts("off", null, country, appId, null, false);
        if (!GamePageIds.IsAppId(appId)) return Facts("notSteam", null, country, null, null, false);
        var key = $"{country}:{appId}";
        var cached = _facts.Get(key);
        if (cached is not null && Now() - cached.Fetched < Ttl && !refresh) return Facts("ok", null, country, appId, cached, false);
        if (LocalOnly) return Facts("offline", "Offline mode is on, so VYSTRAL doesn’t ask Steam for prices.", country, appId, cached, true);
        if (IsGameActive()) return Facts("gameRunning", "VYSTRAL doesn’t contact Steam while a game is running.", country, appId, cached, true);
        try
        {
            var facts = await _client.GetStoreFactsAsync(appId!, country, ct);
            var entry = new StoreFactsCacheEntry { Fetched = Now(), Facts = facts, History = cached?.History ?? [] };
            Record(entry, Now());
            _facts.Set(key, entry);
            return Facts(facts is { Found: true } ? "ok" : "notFound", null, country, appId, entry, false);
        }
        catch (DataSourceException ex)
        {
            Log.Warn("gamepage", "Steam store facts unavailable", new { outcome = ex.Outcome.ToString() });
            return Facts(GamePageIds.Status(ex.Outcome), ex.Message, country, appId, cached, true);
        }
    }

    /// <summary>Adds today's price to the history (one point per UTC day; a currency change starts over).</summary>
    internal static void Record(StoreFactsCacheEntry entry, DateTimeOffset now)
    {
        if (entry.Facts is not { FinalCents: { } cents, Currency: { } currency }) return;
        var day = now.UtcDateTime.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        if (entry.History.Count > 0 && entry.HistoryCurrency is { } had && had != currency) entry.History.Clear();
        entry.HistoryCurrency = currency;
        if (entry.History.Count > 0 && entry.History[^1].Day == day) entry.History[^1] = new WishlistPointDto(day, cents);
        else entry.History.Add(new WishlistPointDto(day, cents));
        WishlistService.Compact(entry.History);
    }

    private static StoreFactsDto Facts(string status, string? message, string country, string? appId, StoreFactsCacheEntry? e, bool stale)
    {
        var f = e?.Facts;
        if (e is null || f is null)
            return new StoreFactsDto(status, message, country, appId, false, null, null, 0, null, null, null, null, false, [], e?.Fetched.ToString("O"), stale);
        var history = f.Currency is not null && e.HistoryCurrency == f.Currency ? e.History.Select(p => new PricePointDto(p.Day, p.Cents)).ToList() : [];
        return new StoreFactsDto(status, message, country, appId, f.FinalCents is not null, f.FinalCents, f.InitialCents, f.DiscountPercent, f.Currency,
            f.Formatted, f.Metacritic, f.ReleaseText, f.ComingSoon, history, e.Fetched.ToString("O"), stale);
    }

    // ---------- Validation of what comes back from disk ----------

    private static ReviewSummary? CleanSummary(ReviewSummary? s) =>
        s is null || s.Total is < 0 or > 100_000_000 || s.Positive < 0 || s.Positive > s.Total || s.Score is < 0 or > 9 ? null
        : s with { Label = Integrations.SteamWebApiClient.CleanText(s.Label, 40) ?? "Steam reviews" };

    internal static Dictionary<string, ReviewCacheEntry> ValidateReviews(Dictionary<string, ReviewCacheEntry> map) =>
        map.Where(kv => GamePageIds.IsAppId(kv.Key) && kv.Value is not null)
            .Select(kv =>
            {
                kv.Value.All = CleanSummary(kv.Value.All);
                kv.Value.Recent = CleanSummary(kv.Value.Recent);
                return kv;
            })
            .Take(MaxEntries).ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);

    internal static Dictionary<string, StoreFactsCacheEntry> ValidateFacts(Dictionary<string, StoreFactsCacheEntry> map)
    {
        var result = new Dictionary<string, StoreFactsCacheEntry>(StringComparer.Ordinal);
        foreach (var (key, e) in map)
        {
            if (result.Count >= MaxEntries) break;
            var parts = key.Split(':');
            if (e is null || parts.Length != 2 || parts[0].Length != 2 || !parts[0].All(char.IsAsciiLetterUpper) || !GamePageIds.IsAppId(parts[1])) continue;
            if (e.Facts is { } f)
            {
                var currencyOk = f.Currency is null || (f.Currency.Length == 3 && f.Currency.All(char.IsAsciiLetterUpper));
                if (f.AppId != parts[1] || !currencyOk || f.FinalCents is < 0 or >= 100_000_000 || f.InitialCents is < 0 or >= 100_000_000 ||
                    f.Metacritic is < 1 or > 100 || f.DiscountPercent is < 0 or > 100) e.Facts = null;
                else e.Facts = f with
                {
                    Formatted = Integrations.SteamWebApiClient.CleanText(f.Formatted, 24),
                    ReleaseText = Integrations.SteamWebApiClient.CleanText(f.ReleaseText, 40),
                };
            }
            e.History = (e.History ?? []).Where(p => p is not null && p.Day is { Length: 10 } && DateOnly.TryParseExact(p.Day, "yyyy-MM-dd", out _) &&
                                                     p.Cents is >= 0 and < 100_000_000).TakeLast(WishlistService.MaxHistory).ToList();
            if (e.HistoryCurrency is not null && (e.HistoryCurrency.Length != 3 || !e.HistoryCurrency.All(char.IsAsciiLetterUpper))) e.HistoryCurrency = null;
            result[key] = e;
        }
        return result;
    }
}
