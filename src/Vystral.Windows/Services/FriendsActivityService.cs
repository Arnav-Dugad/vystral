using System.Security.Cryptography;
using System.Text;
using Vystral.Core.Data;
using Vystral.Windows.Integrations;

namespace Vystral.Windows.Services;

/// <summary>
/// One online friend. <c>Key</c> is an opaque hash of the SteamID (the page never sees SteamIDs).
/// State: online | busy | away | snooze | trade | play | offline. <c>GameId</c> is the VYSTRAL game
/// when the friend's game is in this library.
/// </summary>
public sealed record FriendDto(string Key, string Name, string State, string? Avatar, string? AppId, string? GameName, string? GameId, string? LastOnline);

/// <summary>
/// Status: ok | off | notConnected | noAccount | offline | dataSaver | private | invalidKey | unavailable | rateLimited.
/// <c>Friends</c> holds online friends only; <c>RecentlyOnline</c> up to six friends seen in the last two days
/// (for the empty state). <c>Stale</c> = these are the last results VYSTRAL got, not fresh ones.
/// </summary>
public sealed record FriendsActivityDto(
    string Status,
    string? Message,
    string? FetchedAt,
    int FriendCount,
    IReadOnlyList<FriendDto> Friends,
    IReadOnlyList<FriendDto> RecentlyOnline,
    bool Stale,
    string? RetryAt);

/// <summary>
/// Track P: "Friends playing now" on Home (opt-in, <c>home.friendsActivity</c>, off by default).
/// Reads the user's own friends list and their friends' public profile status through the official
/// Steam Web API with the user's own key. The page asks while Home is visible; this service never
/// asks Steam more often than every <see cref="MinInterval"/>, re-reads the friends list itself only
/// every <see cref="FriendListMaxAge"/>, backs off after errors, and never contacts Steam in Offline
/// mode, while a game runs, or (unless the user asks) with Data saver on. Nothing is stored on disk
/// except avatar images in the art cache.
/// </summary>
public sealed class FriendsActivityService
{
    public const string SettingKey = "home.friendsActivity";
    public static readonly TimeSpan MinInterval = TimeSpan.FromSeconds(100);
    public static readonly TimeSpan ManualMinInterval = TimeSpan.FromSeconds(20);
    public static readonly TimeSpan FriendListMaxAge = TimeSpan.FromMinutes(15);
    internal const int MaxAvatarsPerRefresh = 48;

    private readonly SteamApiKeyStore _keys;
    private readonly SteamWebApiClient _api;
    private readonly SettingsService _settings;
    private readonly ArtworkService _artwork;
    private readonly Func<string?> _steamId;
    private readonly Func<IReadOnlyDictionary<string, string>> _appToGame;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private string? _cacheFor;
    private FriendsActivityDto? _last;
    private DateTimeOffset _lastAttempt = DateTimeOffset.MinValue;
    private IReadOnlyList<SteamFriend>? _friendList;
    private DateTimeOffset _friendListAt = DateTimeOffset.MinValue;
    private int _failures;
    private DateTimeOffset _retryAt = DateTimeOffset.MinValue;
    private FriendsActivityDto? _lastError;

    public Func<bool> IsGameActive { get; set; } = () => false;
    public Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

    public FriendsActivityService(SteamApiKeyStore keys, SteamWebApiClient api, SettingsService settings, ArtworkService artwork,
        Func<string?> steamId, Func<IReadOnlyDictionary<string, string>> appToGame)
    {
        _keys = keys;
        _api = api;
        _settings = settings;
        _artwork = artwork;
        _steamId = steamId;
        _appToGame = appToGame;
    }

    private bool DataSaver => _artwork.SkipDownloads?.Invoke() == true;

    public async Task<FriendsActivityDto> GetAsync(bool force, CancellationToken ct)
    {
        if (!_settings.GetBool(SettingKey)) { Forget(); return Empty("off", null); }
        if (!_keys.IsConfigured) { Forget(); return Empty("notConnected", null); }
        var steamId = _steamId();
        if (steamId is null) { Forget(); return Empty("noAccount", "No Steam account has signed in on this PC yet."); }
        if (_settings.GetBool("privacy.localOnly"))
            return Empty("offline", "Offline mode is on, so VYSTRAL doesn’t ask Steam what your friends are playing.");

        await _gate.WaitAsync(ct);
        try
        {
            if (_cacheFor != steamId) { Forget(); _cacheFor = steamId; }
            var now = Now();
            var age = now - _lastAttempt;

            if (IsGameActive())
                return Cached("VYSTRAL doesn’t contact Steam while a game is running.") ?? Empty("unavailable", "VYSTRAL doesn’t contact Steam while a game is running.");
            // Backing off; "Try again" (force) still gets through, at most every ManualMinInterval.
            if (now < _retryAt && !(force && age >= ManualMinInterval))
                return _lastError is { Status: "private" or "invalidKey" } e ? e with { RetryAt = _retryAt.ToString("O") } : Cached(_lastError?.Message) ?? _lastError ?? Empty("unavailable", null);
            if (DataSaver && !force)
                return Cached("Data saver is on, so friends refresh only when you ask.") ?? Empty("dataSaver", "Data saver is on, so VYSTRAL doesn’t check on its own.");
            if (_last is not null && age < (force ? ManualMinInterval : MinInterval)) return _last;

            _lastAttempt = now;
            try
            {
                var fresh = await RefreshAsync(steamId, ct);
                _failures = 0;
                _retryAt = DateTimeOffset.MinValue;
                _lastError = null;
                _last = fresh;
                return fresh;
            }
            catch (SteamApiException ex)
            {
                _failures++;
                _retryAt = now + Backoff(ex.Outcome, _failures);
                var status = ex.Outcome switch
                {
                    SteamApiOutcome.PrivateProfile => "private",
                    SteamApiOutcome.InvalidKey => "invalidKey",
                    SteamApiOutcome.RateLimited => "rateLimited",
                    _ => "unavailable",
                };
                Log.Info("friends", "Friends refresh failed", new { status, failures = _failures });
                _lastError = Empty(status, ex.Message) with { RetryAt = _retryAt.ToString("O") };
                if (status is "private" or "invalidKey") { _last = null; _friendList = null; return _lastError; }
                return Cached(ex.Message) ?? _lastError;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>2, 4, 8, 16, 30 minutes for passing trouble; longer for problems only the user can fix.</summary>
    internal static TimeSpan Backoff(SteamApiOutcome outcome, int failures) => outcome switch
    {
        SteamApiOutcome.PrivateProfile => TimeSpan.FromMinutes(10),
        SteamApiOutcome.InvalidKey => TimeSpan.FromMinutes(30),
        _ => TimeSpan.FromMinutes(Math.Min(30, 2 * Math.Pow(2, Math.Clamp(failures - 1, 0, 4)))),
    };

    /// <summary>Forgets everything in memory (setting turned off, key removed, account switched).</summary>
    public void Forget()
    {
        _last = null;
        _lastError = null;
        _friendList = null;
        _friendListAt = DateTimeOffset.MinValue;
        _lastAttempt = DateTimeOffset.MinValue;
        _retryAt = DateTimeOffset.MinValue;
        _failures = 0;
        _cacheFor = null;
    }

    private async Task<FriendsActivityDto> RefreshAsync(string steamId, CancellationToken ct)
    {
        var now = Now();
        if (_friendList is null || now - _friendListAt > FriendListMaxAge)
        {
            _friendList = await _api.GetFriendListAsync(steamId, ct);
            _friendListAt = now;
        }
        if (_friendList.Count == 0)
            return new FriendsActivityDto("ok", null, now.ToString("O"), 0, [], [], false, null);

        var summaries = await _api.GetPlayerSummariesAsync(_friendList.Select(f => f.SteamId).ToList(), ct);
        IReadOnlyDictionary<string, string> library;
        try { library = _appToGame(); }
        catch (Exception ex) { Log.Warn("friends", "Couldn't map Steam apps to games", ex: ex); library = new Dictionary<string, string>(); }

        var (online, recent) = Select(summaries, now);
        var avatars = DataSaver ? new Dictionary<string, string?>() : await CacheAvatarsAsync(online.Concat(recent).Take(MaxAvatarsPerRefresh), ct);
        FriendDto Map(SteamPlayerSummary s) => new(
            OpaqueKey(s.SteamId), s.PersonaName, StateName(s.PersonaState),
            avatars.TryGetValue(s.SteamId, out var a) && a is not null ? ArtworkService.Url("", a) : null,
            s.GameAppId, s.GameName,
            s.GameAppId is not null && library.TryGetValue(s.GameAppId, out var gid) ? gid : null,
            s.LastLogoff?.ToString("O"));
        _artwork.PruneAvatars();
        return new FriendsActivityDto("ok", null, now.ToString("O"), _friendList.Count, online.Select(Map).ToList(), recent.Select(Map).ToList(), false, null);
    }

    /// <summary>
    /// Online friends (playing first, then by state and name) capped at 200, and, only when nobody is
    /// online, up to six friends who were online in the last 48 hours (most recent first).
    /// </summary>
    internal static (List<SteamPlayerSummary> Online, List<SteamPlayerSummary> Recent) Select(IReadOnlyList<SteamPlayerSummary> all, DateTimeOffset now)
    {
        var online = all.Where(s => s.PersonaState != 0)
            .OrderByDescending(s => s.GameAppId is not null || s.GameName is not null)
            .ThenBy(s => s.PersonaState == 1 ? 0 : s.PersonaState is 5 or 6 ? 1 : 2)
            .ThenBy(s => s.PersonaName, StringComparer.CurrentCultureIgnoreCase)
            .Take(200).ToList();
        var recent = online.Count > 0 ? [] : all
            .Where(s => s.PersonaState == 0 && s.LastLogoff is { } l && now - l < TimeSpan.FromHours(48) && l <= now + TimeSpan.FromMinutes(5))
            .OrderByDescending(s => s.LastLogoff).Take(6).ToList();
        return (online, recent);
    }

    private async Task<Dictionary<string, string?>> CacheAvatarsAsync(IEnumerable<SteamPlayerSummary> who, CancellationToken ct)
    {
        var result = new Dictionary<string, string?>(StringComparer.Ordinal);
        using var lane = new SemaphoreSlim(4, 4);
        var list = who.Where(s => s.AvatarUrl is not null).ToList();
        var files = await Task.WhenAll(list.Select(async s =>
        {
            await lane.WaitAsync(ct);
            try { return await _artwork.CacheAvatarAsync(s.AvatarUrl!, ct); }
            finally { lane.Release(); }
        }));
        for (var i = 0; i < list.Count; i++) result[list[i].SteamId] = files[i];
        return result;
    }

    internal static string StateName(int personaState) => personaState switch
    {
        1 => "online",
        2 => "busy",
        3 => "away",
        4 => "snooze",
        5 => "trade",
        6 => "play",
        _ => "offline",
    };

    internal static string OpaqueKey(string steamId) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("vystral-friend:" + steamId)))[..16];

    private FriendsActivityDto? Cached(string? note) =>
        _last is null ? null : _last with { Stale = true, Message = note ?? _last.Message };

    private static FriendsActivityDto Empty(string status, string? message) => new(status, message, null, 0, [], [], false, null);
}
