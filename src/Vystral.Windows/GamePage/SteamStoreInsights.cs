using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Windows.DataSources;

namespace Vystral.Windows.GamePage;

/// <summary>Steam's review summary for one window of time, exactly as Steam computes it.</summary>
/// <param name="Score">Steam's 0–9 score bucket (0 = no or too few reviews).</param>
/// <param name="Label">Steam's own words, e.g. "Very Positive" or "4 user reviews".</param>
public sealed record ReviewSummary(int Score, string Label, long Positive, long Total);

/// <summary>Steam store facts for one app in one country: price, Metacritic score, release date as the store shows it.</summary>
public sealed record StoreFacts(
    string AppId, bool Found, long? FinalCents, long? InitialCents, int DiscountPercent, string? Currency, string? Formatted,
    int? Metacritic, string? ReleaseText, bool ComingSoon);

/// <summary>
/// Track C4: public, keyless Steam store endpoints the store's own pages use (grey area: opt-in, cached, spaced on
/// the shared Steam store lane, failing quietly). <c>appreviews</c> gives the review summary (all time, and for a
/// date range); <c>appdetails</c> with filters gives price, Metacritic score and release date for one country.
/// </summary>
public sealed partial class SteamStoreInsightsClient(ProviderTransport transport)
{
    /// <summary>Steam's "Recent reviews" window.</summary>
    public static readonly TimeSpan RecentWindow = TimeSpan.FromDays(30);

    public async Task<ReviewSummary?> GetReviewSummaryAsync(string appId, DateTimeOffset? from, DateTimeOffset? to, CancellationToken ct)
    {
        if (!IsAppId(appId)) return null;
        var range = from is { } f && to is { } t
            ? $"&filter=all&start_date={f.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture)}&end_date={t.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture)}&date_range_type=include"
            : "";
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get,
            new Uri($"https://store.steampowered.com/appreviews/{appId}?json=1&language=all&purchase_type=all&num_per_page=0{range}")), ct);
        if (r.Status is HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests)
            throw new DataSourceException(DataSourceOutcome.RateLimited, "Steam asked VYSTRAL to slow down. Try again in a few minutes.");
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Steam answered with an unexpected status ({(int)r.Status}).");
        return ParseReviewSummary(r.Body);
    }

    public async Task<StoreFacts?> GetStoreFactsAsync(string appId, string country, CancellationToken ct)
    {
        if (!IsAppId(appId)) return null;
        var cc = Country().IsMatch(country) ? country : "US";
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get,
            new Uri($"https://store.steampowered.com/api/appdetails?appids={appId}&filters=price_overview,metacritic,release_date&cc={cc}&l=english")), ct);
        if (r.Status is HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests)
            throw new DataSourceException(DataSourceOutcome.RateLimited, "Steam asked VYSTRAL to slow down. Try again in a few minutes.");
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Steam answered with an unexpected status ({(int)r.Status}).");
        return ParseStoreFacts(r.Body, appId);
    }

    // ---------- Parsing (pure, unit-tested) ----------

    /// <summary><c>{"success":1,"query_summary":{"review_score":9,"review_score_desc":"…","total_positive":…,"total_reviews":…}}</c>.</summary>
    internal static ReviewSummary? ParseReviewSummary(string json)
    {
        using var doc = JsonRead.Parse(json, "Steam");
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object || JsonRead.Long(root, "success") != 1 || JsonRead.Obj(root, "query_summary") is not { } q) return null;
        var total = JsonRead.Long(q, "total_reviews");
        var positive = JsonRead.Long(q, "total_positive");
        if (total is not (>= 0 and <= 100_000_000) || positive is not >= 0 || positive > total) return null;
        var score = JsonRead.Long(q, "review_score") is { } s and >= 0 and <= 9 ? (int)s : 0;
        var label = JsonRead.Str(q, "review_score_desc", 40) is { } l && l.All(c => char.IsLetterOrDigit(c) || c is ' ' or ',' or '.' or '-')
            ? l : total == 0 ? "No user reviews" : $"{total.Value.ToString("N0", CultureInfo.InvariantCulture)} user reviews";
        return new ReviewSummary(score, label, positive.Value, total.Value);
    }

    internal static StoreFacts? ParseStoreFacts(string json, string appId)
    {
        using var doc = JsonRead.Parse(json, "Steam");
        if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty(appId, out var entry) || entry.ValueKind != JsonValueKind.Object) return null;
        if (!entry.TryGetProperty("success", out var ok) || ok.ValueKind != JsonValueKind.True || JsonRead.Obj(entry, "data") is not { } data)
            return new StoreFacts(appId, false, null, null, 0, null, null, null, null, false);
        long? final = null, initial = null;
        var discount = 0;
        string? currency = null, formatted = null;
        if (JsonRead.Obj(data, "price_overview") is { } p && JsonRead.Str(p, "currency", 3) is { } cur && Currency().IsMatch(cur) &&
            JsonRead.Long(p, "final") is { } f and >= 0 and < 100_000_000)
        {
            currency = cur;
            final = f;
            initial = JsonRead.Long(p, "initial") is { } i and >= 0 and < 100_000_000 ? i : null;
            discount = (int)Math.Clamp(JsonRead.Long(p, "discount_percent") ?? 0, 0, 100);
            formatted = JsonRead.Str(p, "final_formatted", 24);
        }
        var meta = JsonRead.Obj(data, "metacritic") is { } mc && JsonRead.Long(mc, "score") is { } m and >= 1 and <= 100 ? (int)m : (int?)null;
        string? release = null;
        var comingSoon = false;
        if (JsonRead.Obj(data, "release_date") is { } rd)
        {
            comingSoon = JsonRead.Bool(rd, "coming_soon");
            release = JsonRead.Str(rd, "date", 40);
        }
        // With these filters appdetails doesn't say "free": no price and not coming soon reads as "not sold on its own".
        return new StoreFacts(appId, true, final, initial, discount, currency, formatted, meta, release, comingSoon);
    }

    private static bool IsAppId(string s) => s.Length is > 0 and <= 10 && s.All(char.IsAsciiDigit) && s[0] != '0';

    [GeneratedRegex(@"\A[A-Z]{2}\z")]
    private static partial Regex Country();

    [GeneratedRegex(@"\A[A-Z]{3}\z")]
    private static partial Regex Currency();
}
