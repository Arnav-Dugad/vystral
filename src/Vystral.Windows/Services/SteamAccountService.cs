using System.Collections.Concurrent;
using System.Text.Json;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Parsing;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;

namespace Vystral.Windows.Services;

public sealed record SteamAccountDto(string SteamId, string PersonaName, bool MostRecent);

/// <summary>Result of testing the key. Outcome: ok | invalidKey | privateProfile | rateLimited | unavailable | malformed | noAccount.</summary>
public sealed record SteamTestResultDto(string Outcome, string Message, int? GameCount, string At);

public sealed record SteamApiStatusDto(
    bool LocalOnly,
    bool SteamInstalled,
    bool Configured,
    string? KeyMasked,
    IReadOnlyList<SteamAccountDto> Accounts,
    string? SteamId,
    string? LastSync,
    int OwnedCount,
    SteamTestResultDto? LastTest,
    bool Syncing);

public sealed record AchievementDto(
    string ApiName,
    string Name,
    string? Description,
    bool Hidden,
    bool Achieved,
    string? UnlockedAt,
    double? GlobalPercent,
    string? Icon);

/// <summary>Status: ok | none | private | error | notSteam | notConnected | noAccount | localOnly.</summary>
public sealed record AchievementsDto(
    string Status,
    string? Message,
    string? FetchedAt,
    IReadOnlyList<AchievementDto> Achievements,
    int Unlocked,
    int Total);

/// <summary>
/// Opt-in Steam Web API features: owned games and achievements for the user's own account,
/// using a key the user created. Everything is refused when privacy.localOnly is on, and
/// network work pauses while a game is running.
/// </summary>
public sealed class SteamAccountService
{
    public static readonly TimeSpan AchievementMaxAge = TimeSpan.FromHours(6);
    internal const string SteamIdKey = "steam.webApi.steamId";
    internal const string LastSyncKey = "steam.webApi.lastSync";
    internal const string LastTestKey = "steam.webApi.lastTest";

    private readonly SteamApiKeyStore _keys;
    private readonly SteamWebApiClient _api;
    private readonly LibraryRepository _repo;
    private readonly SettingsService _settings;
    private readonly ArtworkService _artwork;
    private readonly Func<string?> _steamPath;
    private readonly IEventSink _events;
    private readonly SemaphoreSlim _syncLock = new(1, 1);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _appLocks = new(StringComparer.Ordinal);
    private CancellationTokenSource? _backgroundCts;

    public Func<bool> IsGameActive { get; set; } = () => false;

    public SteamAccountService(SteamApiKeyStore keys, SteamWebApiClient api, LibraryRepository repo, SettingsService settings,
        ArtworkService artwork, Func<string?> steamPath, IEventSink events)
    {
        _keys = keys;
        _api = api;
        _repo = repo;
        _settings = settings;
        _artwork = artwork;
        _steamPath = steamPath;
        _events = events;
    }

    private bool LocalOnly => _settings.GetBool("privacy.localOnly");
    private bool DataSaverActive => _artwork.SkipDownloads?.Invoke() == true;
    public bool IsSyncing => _syncLock.CurrentCount == 0;

    // ---------- Status & account ----------

    public SteamApiStatusDto Status()
    {
        var accounts = ReadAccounts();
        SteamTestResultDto? lastTest = null;
        if (_repo.GetInternalValue(LastTestKey) is { } raw)
        {
            try { lastTest = JsonSerializer.Deserialize<SteamTestResultDto>(raw); } catch (JsonException) { }
        }
        return new SteamApiStatusDto(LocalOnly, _steamPath() is not null, _keys.IsConfigured, _keys.MaskedSuffix, accounts,
            SelectedSteamId(accounts), _repo.GetInternalValue(LastSyncKey), _repo.OwnedSteamCount(), lastTest, IsSyncing);
    }

    /// <summary>The confirmed account, else the most recently signed-in one on this PC.</summary>
    public string? SelectedSteamId(IReadOnlyList<SteamAccountDto>? accounts = null)
    {
        var chosen = _repo.GetInternalValue(SteamIdKey);
        if (chosen is not null) return chosen;
        accounts ??= ReadAccounts();
        return (accounts.FirstOrDefault(a => a.MostRecent) ?? accounts.FirstOrDefault())?.SteamId;
    }

    public IReadOnlyList<SteamAccountDto> ReadAccounts()
    {
        var steam = _steamPath();
        if (steam is null) return [];
        var file = Path.Combine(steam, "config", "loginusers.vdf");
        try
        {
            return File.Exists(file) ? ParseLoginUsers(File.ReadAllText(file)) : [];
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    /// <summary>
    /// Reads SteamID64 and display name for each account that signed in on this PC. Login names
    /// and every other field are ignored.
    /// </summary>
    internal static IReadOnlyList<SteamAccountDto> ParseLoginUsers(string text)
    {
        try
        {
            var users = Vdf.Parse(text)["users"];
            if (users is null) return [];
            var list = new List<SteamAccountDto>();
            foreach (var (id, node) in users.Children)
            {
                if (!node.IsObject || !IsSteamId64(id)) continue;
                var persona = node.GetString("PersonaName");
                list.Add(new SteamAccountDto(id, string.IsNullOrWhiteSpace(persona) ? "Steam account" : persona.Length > 64 ? persona[..64] : persona,
                    node.GetString("MostRecent") == "1"));
            }
            return list.OrderByDescending(a => a.MostRecent).ToList();
        }
        catch (FormatException)
        {
            return [];
        }
    }

    internal static bool IsSteamId64(string? s) =>
        s is { Length: 17 } && s.All(char.IsAsciiDigit) && s.StartsWith("7656119", StringComparison.Ordinal);

    public void SelectAccount(string steamId)
    {
        if (!IsSteamId64(steamId) || ReadAccounts().All(a => a.SteamId != steamId))
            throw new BridgeException("invalid", "That Steam account hasn’t signed in on this PC.");
        if (_repo.GetInternalValue(SteamIdKey) == steamId) return;
        _repo.SetInternalValue(SteamIdKey, steamId);
        // Achievements belong to an account; drop the other account's cache.
        _repo.ClearSteamWebApiCache();
        _repo.SetInternalValue(LastSyncKey, null);
        _repo.Audit("steam.selectAccount", null);
    }

    // ---------- Key ----------

    /// <summary>
    /// Validates a pasted key, tests it with one GetOwnedGames call, and stores it in Credential
    /// Manager only when Steam accepted it. A successful test also imports the owned list.
    /// </summary>
    public async Task<SteamTestResultDto> ConnectAsync(string pasted, string? steamId, CancellationToken ct)
    {
        RequireOnline();
        var key = SteamApiKeyStore.Normalize(pasted)
                  ?? throw new BridgeException("invalid", "A Steam Web API key is 32 characters, using only 0–9 and A–F.");
        if (steamId is not null) SelectAccount(steamId);
        var result = await TestAndSyncAsync(key, ct);
        if (result.Outcome is "ok" or "privateProfile")
        {
            if (!_keys.Set(key)) throw new BridgeException("internal", "Windows Credential Manager didn’t accept the key.");
            if (_repo.GetInternalValue(SteamIdKey) is null && SelectedSteamId() is { } id) _repo.SetInternalValue(SteamIdKey, id);
            _repo.Audit("steam.webApiConnected", null);
        }
        return result;
    }

    public async Task<SteamTestResultDto> TestAsync(CancellationToken ct)
    {
        RequireOnline();
        var key = _keys.Get() ?? throw new BridgeException("invalid", "Connect a Steam Web API key first.");
        return await TestAndSyncAsync(key, ct);
    }

    public void Disconnect()
    {
        _backgroundCts?.Cancel();
        _keys.Clear();
        _repo.ClearSteamWebApiCache();
        _repo.SetInternalValue(LastSyncKey, null);
        _repo.SetInternalValue(LastTestKey, null);
        _repo.SetInternalValue(SteamIdKey, null);
        _repo.Audit("steam.webApiDisconnected", null);
    }

    private async Task<SteamTestResultDto> TestAndSyncAsync(string key, CancellationToken ct)
    {
        var steamId = SelectedSteamId();
        SteamTestResultDto result;
        if (steamId is null)
        {
            result = new("noAccount", "No Steam account has signed in on this PC yet. Sign in to Steam once, then try again.", null, Stamp());
        }
        else
        {
            result = await SyncCoreAsync(steamId, ct, key);
        }
        _repo.SetInternalValue(LastTestKey, JsonSerializer.Serialize(result));
        return result;
    }

    // ---------- Owned games ----------

    public async Task<SteamTestResultDto> SyncAsync(CancellationToken ct)
    {
        RequireOnline();
        if (!_keys.IsConfigured) throw new BridgeException("invalid", "Connect a Steam Web API key first.");
        var steamId = SelectedSteamId() ?? throw new BridgeException("invalid", "No Steam account has signed in on this PC.");
        var result = await SyncCoreAsync(steamId, ct, null);
        _repo.SetInternalValue(LastTestKey, JsonSerializer.Serialize(result));
        return result;
    }

    private async Task<SteamTestResultDto> SyncCoreAsync(string steamId, CancellationToken ct, string? keyOverride)
    {
        if (IsGameActive()) throw new BridgeException("busy", "VYSTRAL doesn’t contact Steam while a game is running.");
        if (!await _syncLock.WaitAsync(0, ct)) throw new BridgeException("busy", "A Steam sync is already running.");
        try
        {
            var owned = await _api.GetOwnedGamesAsync(steamId, ct, keyOverride);
            var report = _repo.ApplyOwnedSteamGames(owned);
            _repo.SetInternalValue(LastSyncKey, Stamp());
            Log.Info("steamapi", "Owned games synced", report);
            _events.Emit("library.changed", new { reason = "steamOwned" });
            StartBackgroundAchievements();
            var added = report.Added > 0 ? $" {report.Added} not-installed {(report.Added == 1 ? "game was" : "games were")} added to your library." : "";
            return new("ok", $"Steam lists {report.Owned:N0} {(report.Owned == 1 ? "game" : "games")} on this account.{added}", report.Owned, Stamp());
        }
        catch (SteamApiException ex)
        {
            return new(ex.Outcome switch
            {
                SteamApiOutcome.InvalidKey => "invalidKey",
                SteamApiOutcome.PrivateProfile => "privateProfile",
                SteamApiOutcome.RateLimited => "rateLimited",
                SteamApiOutcome.Unavailable => "unavailable",
                _ => "malformed",
            }, ex.Message, null, Stamp());
        }
        finally
        {
            _syncLock.Release();
        }
    }

    // ---------- Achievements ----------

    public async Task<AchievementsDto> GetAchievementsAsync(string gameId, CancellationToken ct)
    {
        var inst = _repo.GetSteamInstallation(gameId);
        if (inst is null) return Empty("notSteam", null);
        if (!_keys.IsConfigured) return Empty("notConnected", null);
        var steamId = SelectedSteamId();
        if (steamId is null) return Empty("noAccount", "No Steam account has signed in on this PC.");

        var fetch = _repo.GetAchievementFetch(inst.AppId);
        var stale = fetch is null || fetch.SteamId != steamId || DateTimeOffset.UtcNow - fetch.Fetched > AchievementMaxAge;
        string? note = null;
        if (LocalOnly)
        {
            if (fetch is null || fetch.SteamId != steamId) return Empty("localOnly", null);
            note = "Offline mode is on, so these are the achievements saved on this PC.";
        }
        else if (stale && IsGameActive())
        {
            note = fetch is null ? null : "Showing saved achievements. VYSTRAL doesn’t contact Steam while a game is running.";
            if (fetch is null) return Empty("error", "VYSTRAL doesn’t contact Steam while a game is running. Try again after you close the game.");
        }
        else
        {
            var gate = _appLocks.GetOrAdd(inst.AppId, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(ct);
            try
            {
                fetch = _repo.GetAchievementFetch(inst.AppId);
                stale = fetch is null || fetch.SteamId != steamId || DateTimeOffset.UtcNow - fetch.Fetched > AchievementMaxAge;
                if (stale)
                {
                    var error = await RefreshAppAsync(inst.AppId, steamId, ct);
                    if (error is not null) note = error;
                }
                if (!DataSaverActive) await CacheIconsAsync(gameId, inst.AppId, ct);
            }
            finally
            {
                gate.Release();
            }
            fetch = _repo.GetAchievementFetch(inst.AppId);
        }
        return Build(gameId, inst.AppId, fetch, note);
    }

    private AchievementsDto Build(string gameId, string appId, AchievementFetchInfo? fetch, string? note)
    {
        if (fetch is null) return Empty("error", note ?? "Steam couldn’t provide achievements right now. Try again later.");
        var rows = _repo.GetAchievements(appId);
        var list = rows.Select(r =>
        {
            var file = r.Achieved ? r.IconFile ?? r.IconGrayFile : r.IconGrayFile ?? r.IconFile;
            return new AchievementDto(r.ApiName, r.DisplayName,
                r.Hidden && !r.Achieved ? null : r.Description, r.Hidden, r.Achieved, r.UnlockTime?.ToString("O"), r.GlobalPercent,
                _artwork.CachedFileExists(file) ? ArtworkService.Url(gameId, file!) : null);
        }).ToList();
        var status = fetch.Status switch
        {
            "ok" => list.Count == 0 ? "none" : "ok",
            "none" => "none",
            "private" => list.Count > 0 ? "ok" : "private",
            _ => list.Count > 0 ? "ok" : "error",
        };
        var message = note ?? (fetch.Status == "private" && list.Count > 0 ? "Your profile’s game details are now private, so these are the achievements saved earlier." : fetch.Message);
        return new AchievementsDto(status, message, fetch.Fetched.ToString("O"), list, list.Count(a => a.Achieved), list.Count);
    }

    private static AchievementsDto Empty(string status, string? message) => new(status, message, null, [], 0, 0);

    /// <summary>Fetches schema, progress and rarity for one app. Returns a user-facing problem, or null.</summary>
    private async Task<string?> RefreshAppAsync(string appId, string steamId, CancellationToken ct)
    {
        try
        {
            var schema = await _api.GetSchemaAsync(appId, ct);
            if (schema.Count == 0)
            {
                _repo.SaveAchievements(appId, steamId, "none", null, null);
                return null;
            }
            var player = await _api.GetPlayerAchievementsAsync(steamId, appId, ct);
            var global = await _api.GetGlobalPercentagesAsync(appId, ct);
            _repo.SaveAchievements(appId, steamId, "ok", null, SteamWebApiClient.Merge(schema, player, global));
            return null;
        }
        catch (SteamApiException ex)
        {
            switch (ex.Outcome)
            {
                case SteamApiOutcome.PrivateProfile:
                    _repo.SaveAchievements(appId, steamId, "private", ex.Message, null);
                    return null;
                case SteamApiOutcome.NoStats:
                    _repo.SaveAchievements(appId, steamId, "none", null, null);
                    return null;
                case SteamApiOutcome.InvalidKey:
                    return "Steam no longer accepts your Web API key. Check it in Settings → Library & stores.";
                default:
                    // Not recorded as fetched, so the next look retries.
                    return ex.Message;
            }
        }
    }

    private async Task CacheIconsAsync(string gameId, string appId, CancellationToken ct)
    {
        var rows = _repo.GetAchievements(appId);
        var wanted = rows.Select(r => r.Achieved ? (r.ApiName, Gray: false, Url: r.IconUrl, File: r.IconFile) : (r.ApiName, Gray: true, Url: r.IconGrayUrl, File: r.IconGrayFile))
            .Where(w => w.Url is not null && !_artwork.CachedFileExists(w.File))
            .Take(600).ToList();
        if (wanted.Count == 0) return;
        using var gate = new SemaphoreSlim(4, 4);
        await Task.WhenAll(wanted.Select(async w =>
        {
            await gate.WaitAsync(ct);
            try
            {
                if (await _artwork.CacheAchievementIconAsync(gameId, w.Url!, ct) is { } file)
                    _repo.SetAchievementIconFile(appId, w.ApiName, w.Gray, file);
            }
            finally
            {
                gate.Release();
            }
        }));
    }

    /// <summary>
    /// After a sync, refreshes stale achievements for played games in the background: one app at
    /// a time through the rate-limited client, paused while a game runs, stopped on rate limits.
    /// Icons are only downloaded when a game's achievements are opened.
    /// </summary>
    public void StartBackgroundAchievements()
    {
        if (LocalOnly || !_settings.GetBool("steam.webApi.backgroundAchievements") || !_keys.IsConfigured || DataSaverActive) return;
        var steamId = SelectedSteamId();
        if (steamId is null) return;
        _backgroundCts?.Cancel();
        var cts = _backgroundCts = new CancellationTokenSource();
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(8), cts.Token);
                var attempted = new HashSet<string>(StringComparer.Ordinal);
                var refreshed = 0;
                while (!cts.IsCancellationRequested && attempted.Count < 400)
                {
                    var batch = _repo.AppsNeedingAchievementRefresh(steamId, DateTimeOffset.UtcNow - AchievementMaxAge, 20)
                        .Where(attempted.Add).ToList();
                    if (batch.Count == 0) break;
                    foreach (var appId in batch)
                    {
                        while (IsGameActive() && !cts.IsCancellationRequested) await Task.Delay(TimeSpan.FromSeconds(15), cts.Token);
                        if (LocalOnly || !_keys.IsConfigured) return;
                        var gate = _appLocks.GetOrAdd(appId, _ => new SemaphoreSlim(1, 1));
                        await gate.WaitAsync(cts.Token);
                        string? problem;
                        try { problem = await RefreshAppAsync(appId, steamId, cts.Token); }
                        finally { gate.Release(); }
                        if (problem is not null)
                        {
                            Log.Info("steamapi", "Background achievement refresh stopped", new { refreshed });
                            return;
                        }
                        refreshed++;
                    }
                }
                if (refreshed > 0)
                {
                    Log.Info("steamapi", "Background achievement refresh finished", new { refreshed });
                    _events.Emit("steam.achievementsUpdated", new { count = refreshed });
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Error("steamapi", "Background achievement refresh failed", ex); }
        }, cts.Token);
    }

    public void StopBackground() => _backgroundCts?.Cancel();

    private void RequireOnline()
    {
        if (LocalOnly) throw new BridgeException("forbidden", "Offline mode is on (Settings → Privacy), so VYSTRAL doesn’t contact Steam.");
    }

    private static string Stamp() => DateTimeOffset.UtcNow.ToString("O");
}
