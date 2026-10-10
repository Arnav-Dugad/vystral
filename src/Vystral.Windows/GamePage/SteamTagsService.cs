using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Services;

namespace Vystral.Windows.GamePage;

/// <param name="Weight">Steam's relative weight for the tag on this game (how strongly players applied it).</param>
public sealed record TagDto(int Id, string Name, int Weight);

/// <summary>Status: ok | none | off | notSteam | offline | gameRunning | unavailable | rateLimited.</summary>
public sealed record GameTagsDto(string Status, string? Message, IReadOnlyList<TagDto> Tags, string? FetchedAt, bool Stale);

public sealed record LibraryTagDto(int Id, string Name, int Count);

/// <summary>
/// Status: ok | off | offline | none (no Steam games). <see cref="Games"/> maps a game to its tag ids (strongest first);
/// <see cref="Covered"/> of <see cref="SteamGames"/> Steam games have tags so far; <see cref="Refreshing"/> while more are fetched.
/// </summary>
public sealed record LibraryTagsDto(string Status, string? Message, IReadOnlyList<LibraryTagDto> Tags, IReadOnlyDictionary<string, IReadOnlyList<int>> Games,
    int Covered, int SteamGames, bool Refreshing, string? FetchedAt);

public sealed class AppTagsEntry
{
    public DateTimeOffset Fetched { get; set; }
    /// <summary>[tagId, weight] pairs, strongest first.</summary>
    public List<int[]> Tags { get; set; } = [];
}

public sealed class TagNamesEntry
{
    public DateTimeOffset Fetched { get; set; }
    public string? Version { get; set; }
    public Dictionary<int, string> Names { get; set; } = [];
}

/// <summary>
/// Track C4: Steam's community tags on game pages and as Library filters. Tag ids and weights come from
/// IStoreBrowseService/GetItems (50 apps a request), names from IStoreService/GetTagList, both public Web API services
/// without a key, on the shared Steam lane. Opt-in with <c>dataSources.steamTags</c> and "Fetch game details"; cached as
/// JSON for a week; never fetched in Offline mode or while a game runs. Turning the setting off forgets the cache.
/// </summary>
public sealed class SteamTagsService
{
    public const string SettingKey = "dataSources.steamTags";
    public static readonly TimeSpan Ttl = TimeSpan.FromDays(7);
    internal const int MaxApps = 5000;
    /// <summary>Apps fetched per background run (at 50 a request, 40 requests over a minute or so).</summary>
    internal const int MaxAppsPerRun = 2000;
    internal static readonly TimeSpan RunCooldown = TimeSpan.FromMinutes(10);
    /// <summary>Distinct tags listed for the Library filter.</summary>
    internal const int MaxLibraryTags = 300;

    private readonly SteamWebApiClient _api;
    private readonly SettingsService _settings;
    private readonly Func<IReadOnlyDictionary<string, string>> _steamAppToGame;
    private readonly IEventSink _events;
    private readonly GamePageCache<AppTagsEntry> _apps;
    private readonly GamePageCache<TagNamesEntry> _names;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private int _refreshing;
    private DateTimeOffset _lastRun = DateTimeOffset.MinValue;

    public Func<bool> IsGameActive { get; set; } = () => false;
    public Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

    public SteamTagsService(SteamWebApiClient api, SettingsService settings, Func<IReadOnlyDictionary<string, string>> steamAppToGame, IEventSink events, string folder)
    {
        _api = api;
        _settings = settings;
        _steamAppToGame = steamAppToGame;
        _events = events;
        _apps = new GamePageCache<AppTagsEntry>(Path.Combine(folder, "steam-tags.json"), MaxApps, 8 * 1024 * 1024, e => e.Fetched, ValidateApps);
        _names = new GamePageCache<TagNamesEntry>(Path.Combine(folder, "steam-tag-names.json"), 1, 1024 * 1024, e => e.Fetched, ValidateNames);
    }

    public bool Enabled => _settings.GetBool(SettingKey) && _settings.GetBool("library.fetchMetadata");
    private bool LocalOnly => _settings.GetBool("privacy.localOnly");
    private bool CanFetch => Enabled && !LocalOnly && !IsGameActive();

    /// <summary>The setting was turned off: forget every saved tag.</summary>
    public void Forget()
    {
        _apps.Clear();
        _names.Clear();
    }

    // ---------- One game ----------

    public async Task<GameTagsDto> ForAppAsync(string? appId, bool refresh, CancellationToken ct)
    {
        if (!Enabled) return new GameTagsDto("off", null, [], null, false);
        if (!GamePageIds.IsAppId(appId)) return new GameTagsDto("notSteam", null, [], null, false);
        var cached = _apps.Get(appId!);
        var namesFresh = _names.Get("en") is { } n && Now() - n.Fetched < Ttl;
        if (cached is not null && Now() - cached.Fetched < Ttl && namesFresh && !refresh) return Dto("ok", null, cached, false);
        if (LocalOnly) return Dto("offline", "Offline mode is on, so VYSTRAL doesn’t ask Steam for tags.", cached, true);
        if (IsGameActive()) return Dto("gameRunning", "VYSTRAL doesn’t contact Steam while a game is running.", cached, true);
        await _gate.WaitAsync(ct);
        try
        {
            await EnsureNamesAsync(ct);
            if (cached is null || Now() - cached.Fetched >= Ttl || refresh)
            {
                var got = await _api.GetStoreTagsAsync([appId!], ct);
                cached = Entry(got.FirstOrDefault()?.Tags ?? []);
                _apps.Set(appId!, cached);
            }
            return Dto("ok", null, cached, false);
        }
        catch (SteamApiException ex)
        {
            return Dto(ex.Outcome == SteamApiOutcome.RateLimited ? "rateLimited" : "unavailable", ex.Message, cached, true);
        }
        finally
        {
            _gate.Release();
        }
    }

    private AppTagsEntry Entry(IReadOnlyList<SteamAppTag> tags) =>
        new() { Fetched = Now(), Tags = tags.Take(SteamWebApiClient.MaxTagsPerApp).Select(t => new[] { t.Id, t.Weight }).ToList() };

    private GameTagsDto Dto(string status, string? message, AppTagsEntry? e, bool stale)
    {
        if (e is null) return new GameTagsDto(status, message, [], null, false);
        var names = _names.Get("en")?.Names ?? [];
        var tags = e.Tags.Where(t => names.ContainsKey(t[0])).Select(t => new TagDto(t[0], names[t[0]], t[1])).ToList();
        return new GameTagsDto(status == "ok" && tags.Count == 0 ? "none" : status, message, tags, e.Fetched.ToString("O"), stale);
    }

    private async Task EnsureNamesAsync(CancellationToken ct)
    {
        if (_names.Get("en") is { } n && Now() - n.Fetched < Ttl && n.Names.Count > 0) return;
        var list = await _api.GetTagListAsync(ct);
        if (list.Names.Count < 20) throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s tag list looked incomplete, so it wasn’t used.");
        _names.Set("en", new TagNamesEntry { Fetched = Now(), Version = list.Version, Names = list.Names.ToDictionary() });
    }

    // ---------- The whole library (Library filters) ----------

    public LibraryTagsDto Library()
    {
        var map = _steamAppToGame();
        if (!Enabled) return new LibraryTagsDto("off", null, [], new Dictionary<string, IReadOnlyList<int>>(), 0, map.Count, false, null);
        var names = _names.Get("en")?.Names ?? [];
        var apps = _apps.All();
        var games = new Dictionary<string, IReadOnlyList<int>>(StringComparer.Ordinal);
        var counts = new Dictionary<int, int>();
        DateTimeOffset? newest = null;
        foreach (var (appId, gameId) in map)
        {
            if (!apps.TryGetValue(appId, out var e)) continue;
            var ids = e.Tags.Select(t => t[0]).Where(names.ContainsKey).ToList();
            if (games.TryGetValue(gameId, out var had)) ids = had.Concat(ids).Distinct().ToList(); // one game, several Steam apps
            games[gameId] = ids;
            if (newest is null || e.Fetched > newest) newest = e.Fetched;
        }
        foreach (var ids in games.Values)
            foreach (var id in ids) counts[id] = counts.GetValueOrDefault(id) + 1;
        var tags = counts.OrderByDescending(kv => kv.Value).ThenBy(kv => names[kv.Key], StringComparer.OrdinalIgnoreCase).Take(MaxLibraryTags)
            .Select(kv => new LibraryTagDto(kv.Key, names[kv.Key], kv.Value)).ToList();
        var status = map.Count == 0 ? "none" : LocalOnly && games.Count == 0 ? "offline" : "ok";
        return new LibraryTagsDto(status, null, tags, games, map.Keys.Count(apps.ContainsKey), map.Count, _refreshing == 1, newest?.ToString("O"));
    }

    /// <summary>Starts a background fill of missing or week-old tags for the library's Steam games. False when nothing to do or not allowed now.</summary>
    public bool StartRefresh(CancellationToken ct)
    {
        if (!CanFetch || Now() - _lastRun < RunCooldown) return false;
        var apps = _apps.All();
        var due = _steamAppToGame().Keys.Where(GamePageIds.IsAppId)
            .Where(a => !apps.TryGetValue(a, out var e) || Now() - e.Fetched >= Ttl).Take(MaxAppsPerRun).ToList();
        if (due.Count == 0) return false;
        if (Interlocked.CompareExchange(ref _refreshing, 1, 0) != 0) return false;
        _lastRun = Now();
        _ = Task.Run(async () =>
        {
            var done = 0;
            try
            {
                await _gate.WaitAsync(ct);
                try
                {
                    await EnsureNamesAsync(ct);
                    foreach (var chunk in due.Chunk(SteamWebApiClient.StoreItemsBatch))
                    {
                        if (!CanFetch) break;
                        var got = (await _api.GetStoreTagsAsync(chunk, ct)).ToDictionary(t => t.AppId, StringComparer.Ordinal);
                        // Apps Steam didn't return (delisted, region-locked) are remembered as "no tags" so they aren't asked again for a week.
                        _apps.SetMany(chunk.Select(a => new KeyValuePair<string, AppTagsEntry>(a, Entry(got.TryGetValue(a, out var t) ? t.Tags : []))));
                        done += chunk.Length;
                    }
                }
                finally
                {
                    _gate.Release();
                }
            }
            catch (OperationCanceledException) { }
            catch (SteamApiException ex) { Log.Warn("gamepage", "Steam tags refresh stopped", new { outcome = ex.Outcome.ToString(), done }); }
            catch (Exception ex) { Log.Warn("gamepage", "Steam tags refresh failed", ex: ex); }
            finally
            {
                Interlocked.Exchange(ref _refreshing, 0);
                _events.Emit("tags.changed", new { done });
            }
        }, CancellationToken.None);
        return true;
    }

    // ---------- Validation of what comes back from disk ----------

    internal static Dictionary<string, AppTagsEntry> ValidateApps(Dictionary<string, AppTagsEntry> map)
    {
        var result = new Dictionary<string, AppTagsEntry>(StringComparer.Ordinal);
        foreach (var (appId, e) in map)
        {
            if (result.Count >= MaxApps) break;
            if (!GamePageIds.IsAppId(appId) || e is null) continue;
            e.Tags = (e.Tags ?? []).Where(t => t is { Length: 2 } && t[0] is > 0 and <= 100_000_000 && t[1] is >= 0 and <= 1_000_000)
                .DistinctBy(t => t[0]).Take(SteamWebApiClient.MaxTagsPerApp).ToList();
            result[appId] = e;
        }
        return result;
    }

    internal static Dictionary<string, TagNamesEntry> ValidateNames(Dictionary<string, TagNamesEntry> map)
    {
        if (!map.TryGetValue("en", out var e) || e is null) return [];
        e.Names = (e.Names ?? []).Where(kv => kv.Key is > 0 and <= 100_000_000).Take(SteamWebApiClient.MaxTagNames)
            .Select(kv => (kv.Key, Name: SteamWebApiClient.CleanText(kv.Value, 40))).Where(x => x.Name is not null)
            .ToDictionary(x => x.Key, x => x.Name!);
        if (e.Version is { } v && (v.Length > 24 || !v.All(char.IsAsciiLetterOrDigit))) e.Version = null;
        return new Dictionary<string, TagNamesEntry> { ["en"] = e };
    }
}
