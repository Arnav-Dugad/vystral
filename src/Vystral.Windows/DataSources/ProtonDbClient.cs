using System.Globalization;
using System.Net;

namespace Vystral.Windows.DataSources;

/// <summary>ProtonDB's community summary for one Steam app: how well it runs on Linux through Proton.</summary>
/// <param name="Tier">platinum | gold | silver | bronze | borked | pending</param>
public sealed record ProtonSummary(string AppId, string Tier, string? BestReported, string? Trending, double? Score, string? Confidence, int Total);

/// <summary>
/// Track D4: ProtonDB summaries (<c>www.protondb.com/api/v1/reports/summaries/{appid}.json</c>), the keyless JSON
/// protondb.com's own game pages read. Undocumented ("grey"): off by default (<c>dataSources.protondb</c>), asked
/// only when a game page opens, cached for a week, and a failure just hides the badge. The reports are community
/// data published under the ODbL; VYSTRAL shows the summary per user with attribution and never redistributes it.
/// </summary>
public sealed class ProtonDbClient(ProviderTransport transport)
{
    public const string Base = "https://www.protondb.com/api/v1/reports/summaries/";
    public static readonly string[] Tiers = ["platinum", "gold", "silver", "bronze", "borked", "pending"];

    /// <summary>The summary, or null when ProtonDB has no reports for this app (404).</summary>
    public async Task<ProtonSummary?> GetAsync(string appId, CancellationToken ct)
    {
        if (!Identity.IdKinds.IsValid(Identity.IdKinds.Steam, appId)) return null;
        var r = await transport.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri($"{Base}{appId}.json")), ct);
        if (r.Status == HttpStatusCode.NotFound) return null;
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"ProtonDB answered with an unexpected status ({(int)r.Status}).");
        return Parse(appId, r.Body);
    }

    public async Task<string> TestAsync(CancellationToken ct) =>
        await GetAsync("1145360", ct) is { } s ? $"ProtonDB answered ({s.Total.ToString(CultureInfo.InvariantCulture)} reports for the test game)." : "ProtonDB answered without a summary.";

    internal static ProtonSummary? Parse(string appId, string json)
    {
        using var doc = JsonRead.Parse(json, "ProtonDB");
        var e = doc.RootElement;
        var tier = Tier(JsonRead.Str(e, "tier", 20));
        if (tier is null) return null;
        var score = JsonRead.Num(e, "score");
        var total = JsonRead.Long(e, "total") ?? 0;
        var confidence = JsonRead.Str(e, "confidence", 20) is { } c && c is "strong" or "good" or "moderate" or "weak" or "low" or "inadequate" ? c : null;
        return new ProtonSummary(appId, tier, Tier(JsonRead.Str(e, "bestReportedTier", 20)), Tier(JsonRead.Str(e, "trendingTier", 20)),
            score is >= 0 and <= 1 ? Math.Round(score.Value, 2) : null, confidence, (int)Math.Clamp(total, 0, 10_000_000));
    }

    private static string? Tier(string? s) => s is not null && Tiers.Contains(s.ToLowerInvariant()) ? s.ToLowerInvariant() : null;
}
