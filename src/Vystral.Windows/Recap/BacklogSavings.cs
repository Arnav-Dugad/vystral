using Vystral.Core.Data;
using Vystral.Windows.DataSources;

namespace Vystral.Windows.Recap;

/// <summary>One backlog game with a cached price: today's best price, the lowest ever, and the difference.</summary>
public sealed record SavingsGameDto(string GameId, string Title, string Provider, string Currency, double Current, string? Shop, double Low, string? LowAt,
    double Saving, string PricedAt, bool Stale);

public sealed record SavingsTotalDto(string Currency, double Total, int Games);

/// <summary>
/// "Estimated savings on your backlog": for backlog and never-played games, today's best price minus the
/// lowest price ever recorded, from prices already cached when the user opened each game's page. An
/// estimate based on past lows, never a prediction and never what the user paid.
/// </summary>
public sealed record BacklogSavingsDto(int Candidates, IReadOnlyList<SavingsGameDto> Games, IReadOnlyList<SavingsTotalDto> Totals, int WithoutData,
    int WithoutSteamId, string Country, string? Reason);

/// <summary>A cached price answer for one game.</summary>
public sealed record CachedQuote(string Provider, PriceQuote Quote, DateTimeOffset Fetched, bool Stale);

/// <summary>Pure savings math (unit-tested).</summary>
public static class BacklogSavings
{
    /// <summary>
    /// Prefers IsThereAnyDeal (the user's price country) over CheapShark (US dollars). A quote counts only with
    /// at least one current offer and a historical low, in the same currency (they come from the same answer).
    /// </summary>
    public static SavingsGameDto? ForGame(BacklogCandidateRow game, IReadOnlyList<CachedQuote> quotes)
    {
        foreach (var q in quotes.OrderBy(q => q.Provider == "itad" ? 0 : 1))
        {
            if (q.Quote.HistoricalLow is not { } low || low < 0 || q.Quote.Offers.Count == 0) continue;
            var best = q.Quote.Offers.Where(o => o.Price >= 0).OrderBy(o => o.Price).FirstOrDefault();
            if (best is null) continue;
            var current = Math.Round(best.Price, 2);
            var saving = Math.Max(0, Math.Round(current - Math.Round(low, 2), 2));
            return new SavingsGameDto(game.GameId, game.Title, q.Provider, q.Quote.Currency, current, best.Shop, Math.Round(low, 2), q.Quote.HistoricalLowAt,
                saving, q.Fetched.ToString("O"), q.Stale);
        }
        return null;
    }

    public static BacklogSavingsDto Build(IReadOnlyList<BacklogCandidateRow> candidates, Func<string, IReadOnlyList<CachedQuote>> quotesFor, string country, string? reason)
    {
        var games = new List<SavingsGameDto>();
        var withoutSteam = 0;
        foreach (var c in candidates)
        {
            if (c.SteamAppId is null)
            {
                withoutSteam++;
                continue;
            }
            if (ForGame(c, quotesFor(c.SteamAppId)) is { } g) games.Add(g);
        }
        var totals = games.GroupBy(g => g.Currency)
            .Select(g => new SavingsTotalDto(g.Key, (double)g.Sum(x => (decimal)x.Saving), g.Count()))
            .OrderByDescending(t => t.Games).ThenBy(t => t.Currency, StringComparer.Ordinal).ToList();
        return new BacklogSavingsDto(candidates.Count, games.OrderByDescending(g => g.Saving).ThenBy(g => g.Title, StringComparer.CurrentCulture).ToList(),
            totals, candidates.Count - games.Count, withoutSteam, country, reason);
    }
}
