using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Windows.Services;

namespace Vystral.Windows.DataSources;

/// <summary>How one game was matched with a provider entry.</summary>
public sealed record ProviderMatch(string SourceId, string Method, double Confidence);

/// <summary>
/// Opt-in enrichment from IGDB and RAWG (only with the user's own credentials). Matching is
/// ID-first: the Steam appid (IGDB external_games / RAWG's Steam store link), then Wikidata's
/// cross-store IDs; an exact-title fallback is used only when it is unambiguous (and agrees on the
/// release year when both sides know it). Only missing fields are filled; nothing the user set or
/// another source already filled is overwritten, and the source of every filled field is recorded.
/// </summary>
public sealed partial class EnrichmentService(LibraryRepository repo, IgdbClient igdb, RawgClient rawg, Func<string, bool> providerReady)
{
    public static readonly TimeSpan Ttl = TimeSpan.FromDays(30);
    public static readonly TimeSpan MissTtl = TimeSpan.FromDays(7);

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>Enriches up to <paramref name="max"/> games per ready provider. Returns how many games got new fields.</summary>
    public async Task<int> RunAsync(int max, Func<bool> shouldPause, CancellationToken ct)
    {
        var changed = 0;
        foreach (var source in new[] { "igdb", "rawg" })
        {
            if (!providerReady(source)) continue;
            foreach (var (gameId, title, appId, release) in repo.GamesNeedingEnrichment(source, Ttl, MissTtl, max))
            {
                while (shouldPause()) await Task.Delay(5000, ct);
                if (!providerReady(source)) break;
                try
                {
                    if ((await EnrichAsync(source, gameId, title, appId, release, ct)).Count > 0) changed++;
                }
                catch (DataSourceException ex) when (ex.Outcome is DataSourceOutcome.RateLimited or DataSourceOutcome.Unavailable or DataSourceOutcome.InvalidKey or DataSourceOutcome.NotConfigured)
                {
                    Log.Warn("enrich", "Enrichment paused for this run", new { source, outcome = ex.Outcome.ToString() });
                    break;
                }
                catch (DataSourceException ex)
                {
                    Log.Warn("enrich", "Enrichment of one game failed", new { source, gameId, outcome = ex.Outcome.ToString() });
                }
            }
        }
        return changed;
    }

    /// <summary>Enriches one game from one source now. Returns the fields that were filled.</summary>
    public async Task<IReadOnlyList<string>> EnrichAsync(string source, string gameId, string title, string? appId, string? releaseDate, CancellationToken ct)
    {
        var year = YearOf(releaseDate);
        if (source == "igdb")
        {
            var match = await MatchIgdbAsync(gameId, title, appId, year, ct);
            if (match is null || !long.TryParse(match.SourceId, NumberStyles.None, CultureInfo.InvariantCulture, out var id))
            {
                repo.SetEnrichment(gameId, "igdb", null, null, null, matched: false, "{}", null);
                return [];
            }
            var game = await igdb.GetGameAsync(id, ct);
            if (game is null)
            {
                repo.SetEnrichment(gameId, "igdb", null, null, null, matched: false, "{}", null);
                return [];
            }
            var ttb = await igdb.GetTimeToBeatAsync(id, ct);
            repo.SetEnrichment(gameId, "igdb", match.SourceId, match.Method, match.Confidence, matched: true, JsonSerializer.Serialize(IgdbFacts(game, ttb), Json), game.Url);
            return repo.ApplyEnrichedFields(gameId, "igdb", match.SourceId, match.Method, match.Confidence,
                new EnrichedFields(game.Summary, game.Developers.FirstOrDefault(), game.Publishers.FirstOrDefault(), game.ReleaseDate, game.Genres));
        }
        else
        {
            var (match, game) = await MatchRawgAsync(gameId, title, appId, year, ct);
            if (match is null || game is null)
            {
                repo.SetEnrichment(gameId, "rawg", null, null, null, matched: false, "{}", null);
                return [];
            }
            repo.SetEnrichment(gameId, "rawg", match.SourceId, match.Method, match.Confidence, matched: true, JsonSerializer.Serialize(RawgFacts(game), Json), game.Url);
            return repo.ApplyEnrichedFields(gameId, "rawg", match.SourceId, match.Method, match.Confidence,
                new EnrichedFields(game.Description, game.Developers.FirstOrDefault(), game.Publishers.FirstOrDefault(), game.Released, game.Genres));
        }
    }

    private async Task<ProviderMatch?> MatchIgdbAsync(string gameId, string title, string? appId, int? year, CancellationToken ct)
    {
        if (appId is not null && await igdb.FindBySteamAppIdAsync(appId, ct) is { } byApp)
            return new ProviderMatch(byApp.ToString(CultureInfo.InvariantCulture), "steam-appid", 1.0);
        if (WikidataIdsFor(gameId, appId) is { } ids && ids.TryGetValue("igdb", out var slug) && await igdb.FindBySlugAsync(slug, ct) is { } bySlug)
            return new ProviderMatch(bySlug.ToString(CultureInfo.InvariantCulture), "wikidata", 0.95);
        if (IgdbClient.PickExactTitle(title, year, await igdb.SearchAsync(title, ct)) is { } t)
            return new ProviderMatch(t.Id.ToString(CultureInfo.InvariantCulture), "exact-title", t.Confidence);
        return null;
    }

    private async Task<(ProviderMatch?, RawgGame?)> MatchRawgAsync(string gameId, string title, string? appId, int? year, CancellationToken ct)
    {
        if (WikidataIdsFor(gameId, appId) is { } ids && ids.TryGetValue("rawg", out var slug) && await rawg.GetGameAsync(slug, ct) is { } bySlug)
            return (new ProviderMatch(bySlug.Id.ToString(CultureInfo.InvariantCulture), "wikidata", 0.95), bySlug);
        var hits = await rawg.SearchAsync(title, ct);
        if (appId is not null)
        {
            // ID-confirmed: an exact-title candidate that RAWG lists on Steam under this very appid.
            var target = Vystral.Core.Matching.TitleNormalizer.Normalize(title).Full;
            foreach (var hit in hits.Where(h => Vystral.Core.Matching.TitleNormalizer.Normalize(h.Name).Full == target).Take(3))
                if (await rawg.HasSteamAppAsync(hit.Id, appId, ct) && await rawg.GetGameAsync(hit.Slug, ct) is { } g)
                    return (new ProviderMatch(g.Id.ToString(CultureInfo.InvariantCulture), "steam-appid", 1.0), g);
        }
        if (RawgClient.PickExactTitle(title, year, hits) is { } t && await rawg.GetGameAsync(t.Hit.Slug, ct) is { } byTitle)
            return (new ProviderMatch(byTitle.Id.ToString(CultureInfo.InvariantCulture), "exact-title", t.Confidence), byTitle);
        return (null, null);
    }

    private IReadOnlyDictionary<string, string>? WikidataIdsFor(string gameId, string? appId)
    {
        if (appId is not null && repo.GetExternalIds("steam", appId) is { WikidataId: not null } s) return s.Ids;
        var gog = repo.GetInstallations(gameId).FirstOrDefault(i => i.Platform == PlatformId.Gog)?.PlatformGameId;
        return gog is not null && repo.GetExternalIds("gog", gog) is { WikidataId: not null } g ? g.Ids : null;
    }

    internal static object IgdbFacts(IgdbGame g, TimeToBeat? ttb) => new
    {
        name = g.Name,
        genres = g.Genres,
        themes = g.Themes,
        gameModes = g.GameModes,
        perspectives = g.Perspectives,
        releaseDate = g.ReleaseDate,
        developers = g.Developers,
        publishers = g.Publishers,
        franchises = g.Franchises,
        series = g.Series,
        similar = g.Similar,
        criticRating = g.AggregatedRating,
        criticRatingCount = g.AggregatedRatingCount,
        totalRating = g.TotalRating,
        totalRatingCount = g.TotalRatingCount,
        timeToBeat = ttb is null ? null : new { hastily = ttb.HastilySeconds, normally = ttb.NormallySeconds, completely = ttb.CompletelySeconds, count = ttb.Count },
    };

    internal static object RawgFacts(RawgGame g) => new
    {
        name = g.Name,
        genres = g.Genres,
        releaseDate = g.Released,
        developers = g.Developers,
        publishers = g.Publishers,
        userRating = g.Rating,
        userRatingCount = g.RatingsCount,
        averagePlaytimeHours = g.AveragePlaytimeHours,
        esrb = g.Esrb,
    };

    internal static int? YearOf(string? releaseDate) =>
        releaseDate is not null && YearPattern().Match(releaseDate) is { Success: true } m ? int.Parse(m.Value, CultureInfo.InvariantCulture) : null;

    [GeneratedRegex(@"(?<![0-9])(19[5-9][0-9]|2[01][0-9]{2})(?![0-9])")]
    private static partial Regex YearPattern();
}
