using System.Globalization;
using System.Net;
using System.Text.Json;
using Vystral.Core.Data;
using Vystral.Windows.Services;

namespace Vystral.Windows.Integrations;

public enum SteamApiOutcome
{
    Ok,
    /// <summary>Steam rejected the key (401/403 without a profile error).</summary>
    InvalidKey,
    /// <summary>The key works but the profile's game details are private.</summary>
    PrivateProfile,
    /// <summary>The game has no achievements/stats.</summary>
    NoStats,
    /// <summary>Steam asked us to slow down (429).</summary>
    RateLimited,
    /// <summary>Network trouble or a Steam server error.</summary>
    Unavailable,
    /// <summary>Steam answered with something we couldn't read.</summary>
    Malformed,
}

/// <summary>An expected Steam Web API failure. Messages never contain the key or request URL.</summary>
public sealed class SteamApiException(SteamApiOutcome outcome, string message) : Exception(message)
{
    public SteamApiOutcome Outcome { get; } = outcome;
}

public sealed record SchemaAchievement(string ApiName, string DisplayName, string? Description, bool Hidden, string? Icon, string? IconGray);

public sealed record PlayerAchievement(string ApiName, bool Achieved, DateTimeOffset? UnlockTime);

/// <summary>
/// Minimal client for the documented Steam Web API (api.steampowered.com, HTTPS only).
/// Requests are serialized and spaced at least <see cref="MinSpacing"/> apart; a 429 pauses
/// all requests for the Retry-After period (or one minute). The key is supplied per call by
/// a delegate so it's read from Credential Manager only when needed.
/// </summary>
public sealed class SteamWebApiClient(HttpClient http, Func<string?> apiKey)
{
    public const string Host = "api.steampowered.com";
    public static readonly TimeSpan MinSpacing = TimeSpan.FromMilliseconds(1100);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private DateTime _next = DateTime.MinValue;
    private DateTime _blockedUntil = DateTime.MinValue;

    /// <summary>Test hook: replaces the real delay.</summary>
    internal Func<TimeSpan, CancellationToken, Task> Delay { get; set; } = Task.Delay;

    /// <param name="keyOverride">A key being tested before it is stored; otherwise the stored key is used.</param>
    public async Task<IReadOnlyList<OwnedSteamGame>> GetOwnedGamesAsync(string steamId, CancellationToken ct, string? keyOverride = null)
    {
        var key = keyOverride is not null && SteamApiKeyStore.IsValidFormat(keyOverride) ? keyOverride : RequireKey();
        var (status, body) = await GetAsync(
            $"IPlayerService/GetOwnedGames/v1/?key={key}&steamid={RequireSteamId(steamId)}&include_appinfo=1&include_played_free_games=1&format=json", ct);
        if (status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new SteamApiException(SteamApiOutcome.InvalidKey, "Steam didn’t accept this Web API key. Check that you copied all 32 characters from steamcommunity.com/dev/apikey.");
        EnsureOk(status);
        return ParseOwnedGames(body);
    }

    public async Task<IReadOnlyList<PlayerAchievement>> GetPlayerAchievementsAsync(string steamId, string appId, CancellationToken ct)
    {
        var key = RequireKey();
        var (status, body) = await GetAsync(
            $"ISteamUserStats/GetPlayerAchievements/v1/?key={key}&steamid={RequireSteamId(steamId)}&appid={RequireAppId(appId)}&l=english&format=json", ct);
        return ParsePlayerAchievements(status, body);
    }

    public async Task<IReadOnlyList<SchemaAchievement>> GetSchemaAsync(string appId, CancellationToken ct)
    {
        var key = RequireKey();
        var (status, body) = await GetAsync($"ISteamUserStats/GetSchemaForGame/v2/?key={key}&appid={RequireAppId(appId)}&l=english&format=json", ct);
        if (status is HttpStatusCode.Unauthorized) throw new SteamApiException(SteamApiOutcome.InvalidKey, "Steam didn’t accept the Web API key.");
        if (status is HttpStatusCode.BadRequest or HttpStatusCode.Forbidden or HttpStatusCode.NotFound) return [];
        EnsureOk(status);
        return ParseSchema(body);
    }

    /// <summary>Global unlock percentages (public, no key).</summary>
    public async Task<IReadOnlyDictionary<string, double>> GetGlobalPercentagesAsync(string appId, CancellationToken ct)
    {
        var (status, body) = await GetAsync($"ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid={RequireAppId(appId)}&format=json", ct);
        if (status is HttpStatusCode.BadRequest or HttpStatusCode.Forbidden or HttpStatusCode.NotFound) return new Dictionary<string, double>();
        EnsureOk(status);
        return ParseGlobalPercentages(body);
    }

    // ---------- Transport ----------

    private async Task<(HttpStatusCode Status, string Body)> GetAsync(string pathAndQuery, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var now = DateTime.UtcNow;
            if (_blockedUntil > now)
                throw new SteamApiException(SteamApiOutcome.RateLimited, "Steam asked VYSTRAL to slow down. Try again in a minute.");
            if (_next > now) await Delay(_next - now, ct);
            _next = DateTime.UtcNow + MinSpacing;

            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri($"https://{Host}/{pathAndQuery}"));
            // One limit for sending and reading the body (HttpClient.Timeout stops at the headers here).
            using var timeout = Services.RequestTimeouts.Link(ct, Services.RequestTimeouts.Json);
            HttpResponseMessage response;
            try
            {
                response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            }
            catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException && !ct.IsCancellationRequested)
            {
                // Log only the endpoint name, never the query (it contains the key).
                Log.Warn("steamapi", "Request failed", new { endpoint = Endpoint(pathAndQuery), error = ex.GetType().Name });
                throw new SteamApiException(SteamApiOutcome.Unavailable, "VYSTRAL couldn’t reach Steam. Check your connection and try again.");
            }
            using (response)
            {
                if (response.StatusCode == HttpStatusCode.TooManyRequests)
                {
                    var wait = response.Headers.RetryAfter?.Delta ?? TimeSpan.FromMinutes(1);
                    _blockedUntil = DateTime.UtcNow + (wait < TimeSpan.FromSeconds(5) ? TimeSpan.FromSeconds(5) : wait > TimeSpan.FromHours(1) ? TimeSpan.FromHours(1) : wait);
                    Log.Warn("steamapi", "Rate limited by Steam", new { endpoint = Endpoint(pathAndQuery), seconds = (int)wait.TotalSeconds });
                    throw new SteamApiException(SteamApiOutcome.RateLimited, "Steam asked VYSTRAL to slow down. Try again in a minute.");
                }
                if (response.Content.Headers.ContentLength > 8 * 1024 * 1024)
                    throw new SteamApiException(SteamApiOutcome.Malformed, "Steam sent an unexpectedly large response.");
                string body;
                try { body = await response.Content.ReadAsStringAsync(timeout.Token); }
                catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException && !ct.IsCancellationRequested)
                {
                    Log.Warn("steamapi", "Reading the answer failed", new { endpoint = Endpoint(pathAndQuery), error = ex.GetType().Name });
                    throw new SteamApiException(SteamApiOutcome.Unavailable, "Steam stopped answering. Check your connection and try again.");
                }
                if (body.Length > 8 * 1024 * 1024) throw new SteamApiException(SteamApiOutcome.Malformed, "Steam sent an unexpectedly large response.");
                return (response.StatusCode, body);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private static string Endpoint(string pathAndQuery) => pathAndQuery.Split('?')[0];

    private string RequireKey() =>
        apiKey() is { } k && SteamApiKeyStore.IsValidFormat(k)
            ? k
            : throw new SteamApiException(SteamApiOutcome.InvalidKey, "No Steam Web API key is set up.");

    internal static string RequireSteamId(string steamId) =>
        steamId.Length == 17 && steamId.All(char.IsAsciiDigit) && steamId.StartsWith("7656119", StringComparison.Ordinal)
            ? steamId
            : throw new ArgumentException("Invalid SteamID64.", nameof(steamId));

    internal static string RequireAppId(string appId) =>
        appId.Length is > 0 and <= 10 && appId.All(char.IsAsciiDigit) ? appId : throw new ArgumentException("Invalid appid.", nameof(appId));

    private static void EnsureOk(HttpStatusCode status)
    {
        if ((int)status >= 500) throw new SteamApiException(SteamApiOutcome.Unavailable, "Steam’s Web API is having trouble right now. Try again later.");
        if (status != HttpStatusCode.OK) throw new SteamApiException(SteamApiOutcome.Malformed, $"Steam answered with an unexpected status ({(int)status}).");
    }

    // ---------- Parsing (pure, unit-tested) ----------

    /// <summary>
    /// GetOwnedGames returns <c>{"response":{}}</c> (no game_count) when the profile's game
    /// details are private, which is reported as <see cref="SteamApiOutcome.PrivateProfile"/>.
    /// </summary>
    internal static IReadOnlyList<OwnedSteamGame> ParseOwnedGames(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("response", out var response) || response.ValueKind != JsonValueKind.Object)
                throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s owned-games answer couldn’t be read.");
            if (!response.TryGetProperty("game_count", out _))
                throw new SteamApiException(SteamApiOutcome.PrivateProfile,
                    "Your Steam profile’s game details are private, so Steam won’t list your games. In Steam, open Profile → Edit Profile → Privacy Settings and set “Game details” to Public, then test again.");
            var result = new List<OwnedSteamGame>();
            if (!response.TryGetProperty("games", out var games) || games.ValueKind != JsonValueKind.Array) return result;
            foreach (var g in games.EnumerateArray())
            {
                if (g.ValueKind != JsonValueKind.Object) continue;
                var appId = g.TryGetProperty("appid", out var a) && a.TryGetInt64(out var id) && id > 0 ? id.ToString(CultureInfo.InvariantCulture) : null;
                var name = g.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString()?.Trim() : null;
                if (appId is null || string.IsNullOrEmpty(name) || name.Length > 300) continue;
                int? minutes = g.TryGetProperty("playtime_forever", out var p) && p.TryGetInt32(out var m) && m > 0 ? m : null;
                DateTimeOffset? last = g.TryGetProperty("rtime_last_played", out var r) && r.TryGetInt64(out var t) && t > 0
                    ? DateTimeOffset.FromUnixTimeSeconds(t) : null;
                result.Add(new OwnedSteamGame(appId, name, minutes, last));
            }
            return result;
        }
        catch (JsonException)
        {
            throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s owned-games answer couldn’t be read.");
        }
    }

    internal static IReadOnlyList<PlayerAchievement> ParsePlayerAchievements(HttpStatusCode status, string json)
    {
        JsonElement stats;
        JsonDocument? doc = null;
        try
        {
            try { doc = JsonDocument.Parse(json); }
            catch (JsonException) { doc = null; }

            if (doc is null || !doc.RootElement.TryGetProperty("playerstats", out stats) || stats.ValueKind != JsonValueKind.Object)
            {
                if (status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                    throw new SteamApiException(SteamApiOutcome.InvalidKey, "Steam didn’t accept the Web API key.");
                if ((int)status >= 500) throw new SteamApiException(SteamApiOutcome.Unavailable, "Steam’s Web API is having trouble right now. Try again later.");
                throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s achievements answer couldn’t be read.");
            }

            var success = stats.TryGetProperty("success", out var s) && s.ValueKind == JsonValueKind.True;
            if (!success)
            {
                var error = stats.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() ?? "" : "";
                if (error.Contains("not public", StringComparison.OrdinalIgnoreCase) || error.Contains("private", StringComparison.OrdinalIgnoreCase))
                    throw new SteamApiException(SteamApiOutcome.PrivateProfile, "Your Steam profile’s game details are private, so Steam won’t share achievements.");
                if (error.Contains("no stats", StringComparison.OrdinalIgnoreCase) || status == HttpStatusCode.BadRequest)
                    throw new SteamApiException(SteamApiOutcome.NoStats, "This game has no Steam achievements.");
                if (status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                    throw new SteamApiException(SteamApiOutcome.InvalidKey, "Steam didn’t accept the Web API key.");
                throw new SteamApiException(SteamApiOutcome.Unavailable, "Steam couldn’t provide achievements for this game right now.");
            }

            var result = new List<PlayerAchievement>();
            if (!stats.TryGetProperty("achievements", out var list) || list.ValueKind != JsonValueKind.Array) return result;
            foreach (var a in list.EnumerateArray())
            {
                if (a.ValueKind != JsonValueKind.Object) continue;
                var api = a.TryGetProperty("apiname", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
                if (string.IsNullOrEmpty(api) || api.Length > 200) continue;
                var achieved = a.TryGetProperty("achieved", out var ac) && ac.TryGetInt32(out var v) && v == 1;
                DateTimeOffset? at = achieved && a.TryGetProperty("unlocktime", out var ut) && ut.TryGetInt64(out var t) && t > 0
                    ? DateTimeOffset.FromUnixTimeSeconds(t) : null;
                result.Add(new PlayerAchievement(api, achieved, at));
            }
            return result;
        }
        finally
        {
            doc?.Dispose();
        }
    }

    internal static IReadOnlyList<SchemaAchievement> ParseSchema(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var result = new List<SchemaAchievement>();
            if (!doc.RootElement.TryGetProperty("game", out var game) || game.ValueKind != JsonValueKind.Object ||
                !game.TryGetProperty("availableGameStats", out var stats) || stats.ValueKind != JsonValueKind.Object ||
                !stats.TryGetProperty("achievements", out var list) || list.ValueKind != JsonValueKind.Array)
                return result;
            foreach (var a in list.EnumerateArray())
            {
                if (a.ValueKind != JsonValueKind.Object) continue;
                var api = Str(a, "name");
                if (string.IsNullOrEmpty(api) || api.Length > 200) continue;
                var display = Str(a, "displayName");
                var hidden = a.TryGetProperty("hidden", out var h) && (h.ValueKind == JsonValueKind.Number ? h.TryGetInt32(out var hv) && hv != 0 : h.ValueKind == JsonValueKind.True);
                result.Add(new SchemaAchievement(api, Clip(string.IsNullOrWhiteSpace(display) ? api : display!, 200)!, Clip(Str(a, "description"), 1000),
                    hidden, Str(a, "icon"), Str(a, "icongray")));
            }
            return result;
        }
        catch (JsonException)
        {
            throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s achievement list couldn’t be read.");
        }
    }

    /// <summary>Percentages may be numbers or numeric strings depending on the API revision.</summary>
    internal static IReadOnlyDictionary<string, double> ParseGlobalPercentages(string json)
    {
        var result = new Dictionary<string, double>(StringComparer.Ordinal);
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("achievementpercentages", out var root) ||
                !root.TryGetProperty("achievements", out var list) || list.ValueKind != JsonValueKind.Array)
                return result;
            foreach (var a in list.EnumerateArray())
            {
                var name = Str(a, "name");
                if (string.IsNullOrEmpty(name) || !a.TryGetProperty("percent", out var p)) continue;
                double? value = p.ValueKind switch
                {
                    JsonValueKind.Number when p.TryGetDouble(out var d) => d,
                    JsonValueKind.String when double.TryParse(p.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => d,
                    _ => null,
                };
                if (value is >= 0 and <= 100) result[name] = Math.Round(value.Value, 2);
            }
        }
        catch (JsonException)
        {
            // Rarity is optional; an unreadable answer simply means no percentages.
        }
        return result;
    }

    /// <summary>Combines schema, player progress and global rarity into cache rows (schema order).</summary>
    internal static IReadOnlyList<SteamAchievementRow> Merge(IReadOnlyList<SchemaAchievement> schema, IReadOnlyList<PlayerAchievement> player,
        IReadOnlyDictionary<string, double> global)
    {
        var progress = player.GroupBy(p => p.ApiName).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var rows = new List<SteamAchievementRow>();
        var order = 0;
        foreach (var s in schema)
        {
            progress.TryGetValue(s.ApiName, out var p);
            rows.Add(new SteamAchievementRow(s.ApiName, s.DisplayName, s.Description, s.Hidden, SafeIconUrl(s.Icon), SafeIconUrl(s.IconGray),
                null, null, p?.Achieved ?? false, p?.UnlockTime, global.TryGetValue(s.ApiName, out var pct) ? pct : null, order++));
        }
        // Achievements the player has but the schema omitted (rare) are still shown, by API name.
        foreach (var p in player.Where(p => schema.All(s => s.ApiName != p.ApiName)))
            rows.Add(new SteamAchievementRow(p.ApiName, p.ApiName, null, false, null, null, null, null, p.Achieved, p.UnlockTime,
                global.TryGetValue(p.ApiName, out var pct) ? pct : null, order++));
        return rows;
    }

    /// <summary>Only HTTPS URLs on Steam's own CDNs are kept for icon downloads.</summary>
    internal static string? SafeIconUrl(string? url)
    {
        if (url is null || url.Length > 400 || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return null;
        var host = uri.Host.ToLowerInvariant();
        var trusted = host is "steamcdn-a.akamaihd.net" or "steamcommunity-a.akamaihd.net" or "media.steampowered.com" ||
                      host.EndsWith(".steamstatic.com", StringComparison.Ordinal);
        return trusted && !uri.UserInfo.Contains(':') && uri.IsDefaultPort ? uri.AbsoluteUri : null;
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string? Clip(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..max];
}
