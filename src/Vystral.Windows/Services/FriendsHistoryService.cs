using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;

namespace Vystral.Windows.Services;

/// <summary>A friend who played a game in the last two weeks. <c>Key</c> is opaque (never a SteamID); <c>Avatar</c> is an art-host URL.</summary>
public sealed record FriendPlayedDto(string Key, string Name, string? Avatar, int MinutesTwoWeeks);

/// <summary>
/// Status: ok | off | notConnected | noAccount | offline | private | invalidKey | unavailable | rateLimited | notLoaded | notSteam.
/// <c>Checked</c>/<c>PublicFriends</c>: how many public profiles the last round read, of how many.
/// </summary>
public sealed record FriendsHistoryDto(
    string Status,
    string? Message,
    string? FetchedAt,
    bool Refreshing,
    IReadOnlyList<FriendPlayedDto> Friends,
    int TotalMinutes,
    int Checked,
    int PublicFriends,
    int FriendCount);

public sealed class FriendRecentCache
{
    public string Key { get; set; } = "";
    public string Name { get; set; } = "";
    public string? AvatarFile { get; set; }
    public Dictionary<string, int> Games { get; set; } = [];
}

public sealed class FriendsHistoryCache
{
    public int Version { get; set; } = 1;
    public string? Account { get; set; }
    public DateTimeOffset? Fetched { get; set; }
    public int FriendCount { get; set; }
    public int PublicFriends { get; set; }
    public int Checked { get; set; }
    public List<FriendRecentCache> Friends { get; set; } = [];
}

/// <summary>
/// Track W: "3 friends played this in the last two weeks" on game pages (opt-in, <c>friends.gameHistory</c>,
/// off by default). One round reads the user's friends list, their public summaries, then each public
/// friend's recently played games (IPlayerService/GetRecentlyPlayedGames), spaced several seconds apart
/// on the shared Steam Web API lane. A round runs at most every <see cref="MinInterval"/>, only when a game
/// page asks, never offline, in a game or (automatically) with Data saver on; it pauses while a game runs.
/// The result (friends' names, avatar file names and per-app minutes) is cached in one JSON file in the data
/// folder, deleted when the setting is turned off or the account changes.
/// </summary>
public sealed class FriendsHistoryService
{
    public const string SettingKey = "friends.gameHistory";
    public static readonly TimeSpan MinInterval = TimeSpan.FromHours(4);
    public static readonly TimeSpan FriendSpacing = TimeSpan.FromSeconds(3);
    internal const int MaxFriendsPerRound = 150;
    private const long MaxCacheBytes = 4 * 1024 * 1024;

    private readonly SteamApiKeyStore _keys;
    private readonly SteamWebApiClient _api;
    private readonly SettingsService _settings;
    private readonly ArtworkService _artwork;
    private readonly Func<string?> _steamId;
    private readonly IEventSink _events;
    private readonly string _file;
    private readonly Lock _lock = new();
    private FriendsHistoryCache? _cache;
    private bool _loaded;
    private int _refreshing;
    private DateTimeOffset _retryAt = DateTimeOffset.MinValue;
    private int _failures;
    private (string Status, string Message)? _lastError;

    public Func<bool> IsGameActive { get; set; } = () => false;
    public Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;
    /// <summary>Test hook: replaces the pause between friends.</summary>
    internal Func<TimeSpan, CancellationToken, Task> Delay { get; set; } = Task.Delay;

    public FriendsHistoryService(SteamApiKeyStore keys, SteamWebApiClient api, SettingsService settings, ArtworkService artwork, Func<string?> steamId,
        IEventSink events, string cacheFile)
    {
        _keys = keys;
        _api = api;
        _settings = settings;
        _artwork = artwork;
        _steamId = steamId;
        _events = events;
        _file = cacheFile;
    }

    private bool LocalOnly => _settings.GetBool("privacy.localOnly");
    private bool DataSaver => _artwork.SkipDownloads?.Invoke() == true;
    public bool IsRefreshing => Volatile.Read(ref _refreshing) == 1;

    /// <summary>Friends who played <paramref name="appId"/> recently; may start a background round when the cache is old.</summary>
    public FriendsHistoryDto ForApp(string? appId, CancellationToken life)
    {
        if (!_settings.GetBool(SettingKey)) return Empty("off", null);
        if (!_keys.IsConfigured) return Empty("notConnected", null);
        if (_steamId() is not { } steamId) return Empty("noAccount", "No Steam account has signed in on this PC yet.");
        if (appId is null) return Empty("notSteam", null);
        var cache = Cache(steamId);
        string? note = null;
        if (LocalOnly) note = "Offline mode is on, so these are the results saved on this PC.";
        else if (IsGameActive()) note = "VYSTRAL doesn’t contact Steam while a game is running.";
        else if (cache?.Fetched is not { } f || Now() - f > MinInterval)
        {
            if (DataSaver && cache?.Fetched is not null) note = "Data saver is on, so friends’ recent games refresh only when you turn it off.";
            else if (!DataSaver || cache?.Fetched is null) StartRound(steamId, life);
        }
        if (cache?.Fetched is null)
        {
            if (LocalOnly) return Empty("offline", "Offline mode is on, so VYSTRAL doesn’t ask Steam what your friends played.");
            if (_lastError is { } e && !IsRefreshing) return Empty(e.Status, e.Message);
            return Empty("notLoaded", null) with { Refreshing = IsRefreshing };
        }
        List<FriendPlayedDto> friends;
        lock (_lock)
        {
            friends = cache.Friends.Where(x => x.Games.ContainsKey(appId))
                .Select(x => new FriendPlayedDto(x.Key, x.Name, _artwork.CachedFileExists(x.AvatarFile) ? ArtworkService.Url("", x.AvatarFile!) : null, x.Games[appId]))
                .OrderByDescending(x => x.MinutesTwoWeeks).ThenBy(x => x.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
        }
        return new FriendsHistoryDto("ok", note ?? _lastError?.Message, cache.Fetched?.ToString("O"), IsRefreshing, friends, friends.Sum(x => x.MinutesTwoWeeks),
            cache.Checked, cache.PublicFriends, cache.FriendCount);
    }

    private static FriendsHistoryDto Empty(string status, string? message) => new(status, message, null, false, [], 0, 0, 0, 0);

    private void StartRound(string steamId, CancellationToken life)
    {
        if (Now() < _retryAt) return;
        if (Interlocked.Exchange(ref _refreshing, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try { await RoundAsync(steamId, life); }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Error("friends", "Friends' recent games round failed", ex); }
            finally
            {
                Volatile.Write(ref _refreshing, 0);
                _events.Emit("friends.historyChanged", new { refreshing = false });
            }
        }, CancellationToken.None);
    }

    /// <summary>One full round (tests call it directly).</summary>
    internal async Task RoundAsync(string steamId, CancellationToken ct)
    {
        try
        {
            var list = await _api.GetFriendListAsync(steamId, ct);
            var summaries = list.Count == 0 ? [] : await _api.GetPlayerSummariesAsync(list.Select(f => f.SteamId).ToList(), ct);
            // Only public profiles can answer; online friends first, then the most recently seen.
            var candidates = Pick(summaries);
            var round = new FriendsHistoryCache
            {
                Account = JsonFileCache.AccountKey(steamId),
                FriendCount = list.Count,
                PublicFriends = summaries.Count(s => s.PublicProfile),
            };
            var avatars = new Dictionary<string, string?>(StringComparer.Ordinal);
            foreach (var s in candidates)
            {
                while (IsGameActive() && !ct.IsCancellationRequested) await Delay(TimeSpan.FromSeconds(15), ct);
                if (LocalOnly || !_settings.GetBool(SettingKey) || !_keys.IsConfigured) return;
                IReadOnlyList<RecentGame>? games;
                try { games = await _api.GetRecentlyPlayedAsync(s.SteamId, ct); }
                catch (SteamApiException ex) when (ex.Outcome is SteamApiOutcome.RateLimited or SteamApiOutcome.Unavailable && round.Checked > 0)
                {
                    // Keep what this round already learned; the rest waits for the next round.
                    Log.Info("friends", "Friends' recent games round stopped early", new { checkedCount = round.Checked });
                    break;
                }
                round.Checked++;
                if (games is { Count: > 0 })
                {
                    if (!DataSaver && s.AvatarUrl is not null && !avatars.ContainsKey(s.SteamId))
                        avatars[s.SteamId] = await _artwork.CacheAvatarAsync(s.AvatarUrl, ct);
                    round.Friends.Add(new FriendRecentCache
                    {
                        Key = FriendsActivityService.OpaqueKey(s.SteamId),
                        Name = s.PersonaName,
                        AvatarFile = avatars.GetValueOrDefault(s.SteamId),
                        Games = games.Take(50).ToDictionary(g => g.AppId, g => g.MinutesTwoWeeks, StringComparer.Ordinal),
                    });
                }
                if (round.Checked % 15 == 0) _events.Emit("friends.historyChanged", new { refreshing = true });
                await Delay(FriendSpacing, ct);
            }
            round.Fetched = Now();
            _artwork.PruneAvatars();
            lock (_lock)
            {
                _cache = round;
                JsonFileCache.Write(_file, round);
            }
            _failures = 0;
            _lastError = null;
            _retryAt = DateTimeOffset.MinValue;
            Log.Info("friends", "Friends' recent games refreshed", new { friends = list.Count, checkedCount = round.Checked, played = round.Friends.Count });
        }
        catch (SteamApiException ex)
        {
            _failures++;
            _retryAt = Now() + FriendsActivityService.Backoff(ex.Outcome, _failures);
            var status = ex.Outcome switch
            {
                SteamApiOutcome.PrivateProfile => "private",
                SteamApiOutcome.InvalidKey => "invalidKey",
                SteamApiOutcome.RateLimited => "rateLimited",
                _ => "unavailable",
            };
            _lastError = (status, ex.Message);
            Log.Info("friends", "Friends' recent games round failed", new { status, failures = _failures });
        }
    }

    internal static List<SteamPlayerSummary> Pick(IReadOnlyList<SteamPlayerSummary> summaries) =>
        summaries.Where(s => s.PublicProfile)
            .OrderByDescending(s => s.PersonaState != 0)
            .ThenByDescending(s => s.LastLogoff ?? DateTimeOffset.MinValue)
            .Take(MaxFriendsPerRound).ToList();

    private FriendsHistoryCache? Cache(string steamId)
    {
        lock (_lock)
        {
            if (!_loaded)
            {
                _cache = Validate(JsonFileCache.Read<FriendsHistoryCache>(_file, MaxCacheBytes));
                _loaded = true;
            }
            if (_cache is not null && _cache.Account != JsonFileCache.AccountKey(steamId))
            {
                _cache = null;
                JsonFileCache.Delete(_file);
            }
            return _cache;
        }
    }

    /// <summary>Removes the cache (setting turned off, key removed).</summary>
    public void Forget()
    {
        lock (_lock)
        {
            _cache = null;
            _loaded = true;
            JsonFileCache.Delete(_file);
        }
        _lastError = null;
        _failures = 0;
        _retryAt = DateTimeOffset.MinValue;
    }

    internal static FriendsHistoryCache? Validate(FriendsHistoryCache? c)
    {
        if (c is null || c.Version != 1 || c.Account is not { Length: 16 } || !c.Account.All(char.IsAsciiHexDigitLower)) return null;
        c.Friends = (c.Friends ?? []).Where(f => f is not null && f.Key is { Length: 16 } && f.Key.All(char.IsAsciiHexDigitLower))
            .DistinctBy(f => f.Key).Take(MaxFriendsPerRound).ToList();
        foreach (var f in c.Friends)
        {
            f.Name = SteamWebApiClient.CleanText(f.Name, 64) ?? "Steam friend";
            f.AvatarFile = IsAvatarFile(f.AvatarFile) ? f.AvatarFile : null;
            f.Games = (f.Games ?? []).Where(g => g.Key is { Length: > 0 and <= 10 } && g.Key.All(char.IsAsciiDigit) && g.Value is > 0 and <= 20160)
                .Take(50).ToDictionary(g => g.Key, g => g.Value, StringComparer.Ordinal);
        }
        c.Checked = Math.Clamp(c.Checked, 0, MaxFriendsPerRound);
        c.FriendCount = Math.Clamp(c.FriendCount, 0, SteamWebApiClient.MaxFriends);
        c.PublicFriends = Math.Clamp(c.PublicFriends, 0, SteamWebApiClient.MaxFriends);
        return c;
    }

    /// <summary>"_avatars\&lt;12 hex&gt;.jpg|png|webp", exactly as <see cref="ArtworkService.CacheAvatarAsync"/> names them.</summary>
    internal static bool IsAvatarFile(string? f)
    {
        if (f is null) return false;
        var name = f.Replace('\\', '/');
        var prefix = ArtworkService.AvatarFolder + "/";
        if (!name.StartsWith(prefix, StringComparison.Ordinal)) return false;
        var file = name[prefix.Length..];
        var dot = file.IndexOf('.');
        return dot == 12 && file[..dot].All(char.IsAsciiHexDigitLower) && file[dot..] is ".jpg" or ".png" or ".webp";
    }
}
