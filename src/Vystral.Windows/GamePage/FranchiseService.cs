using System.Globalization;
using Vystral.Core.Data;
using Vystral.Core.Matching;
using Vystral.Windows.DataSources;
using Vystral.Windows.Discover;
using Vystral.Windows.Services;

namespace Vystral.Windows.GamePage;

/// <param name="Type">main | expansion | remake | remaster | expanded</param>
/// <param name="GameId">The library game it matched (by Steam app ID, else by exact title), or null when you don't own it.</param>
/// <param name="DiscoverKey">The Discover page for it (steam-… or igdb-…).</param>
/// <param name="Current">The game whose page this is.</param>
public sealed record FranchiseEntryDto(string IgdbId, string Name, string? Date, int? Year, string Type, string? GameId, string DiscoverKey, bool Current, bool HasCover);

/// <summary>Status: ok | none | noKey | off | offline | notMatched | gameRunning | unavailable | rateLimited | invalidKey.</summary>
/// <param name="Kind">series (an IGDB collection) or franchise.</param>
public sealed record FranchiseDto(string Status, string? Message, string? Name, string? Kind, IReadOnlyList<FranchiseEntryDto> Entries, int Owned,
    string? FetchedAt, bool Stale);

public sealed class FranchiseGameEntry
{
    public DateTimeOffset Fetched { get; set; }
    /// <summary>"series:123" / "franchise:45", or null when IGDB lists none.</summary>
    public string? Group { get; set; }
}

public sealed class FranchiseGroupEntry
{
    public DateTimeOffset Fetched { get; set; }
    public string Name { get; set; } = "";
    public List<IgdbSeriesGame> Games { get; set; } = [];
}

/// <summary>
/// Track C4: every game in a series, from IGDB with the user's own Twitch app (only while "Game details" from IGDB is
/// on). A game's series and the series' games are cached as JSON for two weeks; matching to the library happens on
/// each request, so a game you add later lights up without a refetch. Covers are IGDB images copied into the art
/// cache on demand (not in Offline mode or with Data saver).
/// </summary>
public sealed class FranchiseService
{
    public static readonly TimeSpan Ttl = TimeSpan.FromDays(14);
    public static readonly TimeSpan MissTtl = TimeSpan.FromDays(3);
    internal const int MaxGames = 600;
    internal const int MaxGroups = 300;

    private readonly DataSourcesService _sources;
    private readonly LibraryRepository _repo;
    private readonly ArtworkService _artwork;
    private readonly SettingsService _settings;
    private readonly GamePageCache<FranchiseGameEntry> _games;
    private readonly GamePageCache<FranchiseGroupEntry> _groups;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public Func<bool> IsGameActive { get; set; } = () => false;
    public Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

    public FranchiseService(DataSourcesService sources, LibraryRepository repo, ArtworkService artwork, SettingsService settings, string folder)
    {
        _sources = sources;
        _repo = repo;
        _artwork = artwork;
        _settings = settings;
        _games = new GamePageCache<FranchiseGameEntry>(Path.Combine(folder, "igdb-game-series.json"), MaxGames, 1024 * 1024, e => e.Fetched, ValidateGames);
        _groups = new GamePageCache<FranchiseGroupEntry>(Path.Combine(folder, "igdb-series.json"), MaxGroups, 8 * 1024 * 1024, e => e.Fetched, ValidateGroups);
    }

    /// <summary>Track D6: forgets the cached IGDB series (re-downloaded when a game page opens).</summary>
    public void ClearCache()
    {
        _games.Clear();
        _groups.Clear();
    }

    private bool LocalOnly => _settings.GetBool("privacy.localOnly");

    /// <summary>Why IGDB can't be asked right now, or null when it can.</summary>
    private string? Blocked() =>
        LocalOnly ? "offline"
        : !_settings.GetBool("dataSources.enrichment") ? "off"
        : !_sources.HasKey(KeyedProvider.Igdb) ? "noKey"
        : IsGameActive() ? "gameRunning" : null;

    /// <summary>For a library game: IGDB's id from its enrichment match, else by its Steam app ID.</summary>
    public async Task<FranchiseDto> ForLibraryGameAsync(string gameId, bool refresh, CancellationToken ct)
    {
        var game = _repo.GetGame(gameId);
        if (game is null) return Empty("notMatched", "That game is no longer in your library.");
        long? igdb = _repo.GetEnrichment(gameId).FirstOrDefault(e => e.Source == "igdb" && e.Matched) is { SourceId: { } sid } &&
                     long.TryParse(sid, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0 ? parsed : null;
        return await ForAsync(igdb, game.SteamAppId, refresh, ct);
    }

    /// <summary>For a Discover page: the IGDB id in its key, else by Steam app ID.</summary>
    public async Task<FranchiseDto> ForDiscoverAsync(string key, string? steamAppId, bool refresh, CancellationToken ct)
    {
        var ids = DiscoverKeys.IdsFromKey(key);
        return await ForAsync(ids.Igdb, ids.Steam ?? (GamePageIds.IsAppId(steamAppId) ? steamAppId : null), refresh, ct);
    }

    private async Task<FranchiseDto> ForAsync(long? igdbId, string? steamAppId, bool refresh, CancellationToken ct)
    {
        var blocked = Blocked();
        var cacheKey = igdbId is { } known ? known.ToString(CultureInfo.InvariantCulture) : steamAppId is not null ? $"steam:{steamAppId}" : null;
        if (cacheKey is null) return Empty(blocked is "off" or "noKey" ? blocked : "notMatched", null);
        var cached = _games.Get(cacheKey);
        var group = cached?.Group is { } gk ? _groups.Get(gk) : null;
        var fresh = cached is not null && Now() - cached.Fetched < (cached.Group is null ? MissTtl : Ttl) && (cached.Group is null || group is not null && Now() - group.Fetched < Ttl);
        if (fresh && !refresh) return Build("ok", null, cached!, group, igdbId, false);
        if (blocked is not null)
            return cached is not null ? Build(blocked, Message(blocked), cached, group, igdbId, true) : Empty(blocked, Message(blocked));

        await _gate.WaitAsync(ct);
        try
        {
            var id = igdbId ?? (steamAppId is not null ? await _sources.Igdb.FindBySteamAppIdAsync(steamAppId, ct) : null);
            if (id is null)
            {
                var miss = new FranchiseGameEntry { Fetched = Now(), Group = null };
                _games.Set(cacheKey, miss);
                return Empty("notMatched", "IGDB doesn’t list this game, so its series isn’t known.");
            }
            var series = await _sources.Igdb.GetSeriesOfAsync(id.Value, ct);
            var entry = new FranchiseGameEntry { Fetched = Now(), Group = series is null ? null : $"{series.Kind}:{series.Id.ToString(CultureInfo.InvariantCulture)}" };
            FranchiseGroupEntry? groupEntry = null;
            if (series is not null)
            {
                groupEntry = _groups.Get(entry.Group!);
                if (groupEntry is null || Now() - groupEntry.Fetched >= Ttl || refresh)
                {
                    groupEntry = new FranchiseGroupEntry { Fetched = Now(), Name = series.Name, Games = (await _sources.Igdb.GetSeriesGamesAsync(series, ct)).ToList() };
                    _groups.Set(entry.Group!, groupEntry);
                }
            }
            _games.Set(cacheKey, entry);
            if (igdbId is null) _games.Set(id.Value.ToString(CultureInfo.InvariantCulture), entry);
            return Build("ok", null, entry, groupEntry, id, false);
        }
        catch (DataSourceException ex)
        {
            var status = ex.Outcome == DataSourceOutcome.NotConfigured ? "noKey" : GamePageIds.Status(ex.Outcome);
            Log.Warn("gamepage", "IGDB series lookup failed", new { outcome = ex.Outcome.ToString() });
            return cached is not null ? Build(status, ex.Message, cached, group, igdbId, true) : Empty(status, ex.Message);
        }
        finally
        {
            _gate.Release();
        }
    }

    private static string? Message(string status) => status switch
    {
        "offline" => "Offline mode is on, so VYSTRAL doesn’t ask IGDB.",
        "gameRunning" => "VYSTRAL doesn’t contact IGDB while a game is running.",
        _ => null,
    };

    private static FranchiseDto Empty(string status, string? message) => new(status, message, null, null, [], 0, null, false);

    private FranchiseDto Build(string status, string? message, FranchiseGameEntry entry, FranchiseGroupEntry? group, long? currentIgdb, bool stale)
    {
        if (group is null) return new FranchiseDto(status == "ok" ? "none" : status, message, null, null, [], 0, entry.Fetched.ToString("O"), stale);
        var library = Library();
        var entries = group.Games.Select(g =>
        {
            var owned = g.SteamAppId is { } a && library.BySteam.TryGetValue(a, out var bySteam) ? bySteam
                : library.ByTitle.TryGetValue(TitleNormalizer.Normalize(g.Name).Full, out var byTitle) ? byTitle : null;
            return new FranchiseEntryDto(g.Id.ToString(CultureInfo.InvariantCulture), g.Name, g.Date, g.Year, TypeName(g.GameType), owned,
                g.SteamAppId is { } s ? $"steam-{s}" : $"igdb-{g.Id.ToString(CultureInfo.InvariantCulture)}", currentIgdb == g.Id, g.CoverId is not null);
        }).ToList();
        var kind = entry.Group?.StartsWith("series:", StringComparison.Ordinal) == true ? "series" : "franchise";
        return new FranchiseDto(entries.Count < 2 && status == "ok" ? "none" : status, message, group.Name, kind, entries,
            entries.Count(e => e.GameId is not null), group.Fetched.ToString("O"), stale);
    }

    internal static string TypeName(int gameType) => gameType switch
    {
        4 => "expansion",
        8 => "remake",
        9 => "remaster",
        10 => "expanded",
        _ => "main",
    };

    private (IReadOnlyDictionary<string, string> BySteam, IReadOnlyDictionary<string, string> ByTitle) Library()
    {
        var bySteam = _repo.SteamAppToGame();
        var byTitle = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var g in _repo.LibraryValueSources().Where(g => !g.Hidden))
        {
            var key = TitleNormalizer.Normalize(g.Title).Full;
            if (key.Length > 0) byTitle.TryAdd(key, g.GameId);
        }
        return (bySteam, byTitle);
    }

    // ---------- Covers ----------

    /// <summary>The art-host URL of one series game's cover, copying it into the art cache the first time. Reason: offline | dataSaver | none.</summary>
    public async Task<(string? Url, string? Reason)> CoverAsync(string igdbId, CancellationToken ct)
    {
        if (!long.TryParse(igdbId, NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id <= 0) return (null, "none");
        var coverId = _groups.All().Values.SelectMany(g => g.Games).FirstOrDefault(g => g.Id == id)?.CoverId;
        if (IgdbClient.CoverUrl(coverId) is not { } url) return (null, "none");
        if (_artwork.CachedDiscoverImage(url) is { } cached) return (cached, null);
        if (LocalOnly) return (null, "offline");
        if (_artwork.SkipDownloads?.Invoke() == true) return (null, "dataSaver");
        return await _artwork.CacheDiscoverImageAsync(url, "cover", ct) is { } got ? (got, null) : (null, "none");
    }

    // ---------- Validation of what comes back from disk ----------

    private static bool IsGroupKey(string? k) =>
        k is not null && k.Split(':') is [var kind, var id] && kind is "series" or "franchise" && id.Length is > 0 and <= 12 && id.All(char.IsAsciiDigit);

    internal static Dictionary<string, FranchiseGameEntry> ValidateGames(Dictionary<string, FranchiseGameEntry> map) =>
        map.Where(kv => kv.Value is not null &&
                        (kv.Key.Length is > 0 and <= 12 && kv.Key.All(char.IsAsciiDigit) || kv.Key.StartsWith("steam:", StringComparison.Ordinal) && GamePageIds.IsAppId(kv.Key[6..])) &&
                        (kv.Value.Group is null || IsGroupKey(kv.Value.Group)))
            .Take(MaxGames).ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);

    internal static Dictionary<string, FranchiseGroupEntry> ValidateGroups(Dictionary<string, FranchiseGroupEntry> map)
    {
        var result = new Dictionary<string, FranchiseGroupEntry>(StringComparer.Ordinal);
        foreach (var (key, e) in map)
        {
            if (result.Count >= MaxGroups) break;
            if (!IsGroupKey(key) || e is null || Integrations.SteamWebApiClient.CleanText(e.Name, 120) is not { } name) continue;
            e.Name = name;
            e.Games = (e.Games ?? []).Where(g => g is not null && g.Id > 0 && g.GameType is >= 0 and <= 30 &&
                                                 (g.Date is null || g.Date.Length == 10 && DateOnly.TryParseExact(g.Date, "yyyy-MM-dd", out _)) &&
                                                 (g.SteamAppId is null || GamePageIds.IsAppId(g.SteamAppId)) && (g.CoverId is null || IgdbClient.IsImageId(g.CoverId)))
                .Select(g => g with { Name = Integrations.SteamWebApiClient.CleanText(g.Name, 160) ?? "", Year = g.Date is null ? null : int.Parse(g.Date[..4], CultureInfo.InvariantCulture) })
                .Where(g => g.Name.Length > 0).DistinctBy(g => g.Id).Take(IgdbClient.MaxSeriesGames).ToList();
            result[key] = e;
        }
        return result;
    }
}
