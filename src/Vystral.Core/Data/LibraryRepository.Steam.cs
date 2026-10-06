using System.Text.Json;
using Dapper;
using Vystral.Core.Domain;
using Vystral.Core.Matching;

namespace Vystral.Core.Data;

/// <summary>A game the signed-in Steam account owns, as reported by IPlayerService/GetOwnedGames.</summary>
public sealed record OwnedSteamGame(string AppId, string Name, int? PlaytimeMinutes, DateTimeOffset? LastPlayed);

public sealed record OwnedSyncReport(int Owned, int Added, int Updated, int Restored);

/// <summary>One cached achievement. Icon files are relative to the art cache.</summary>
public sealed record SteamAchievementRow(
    string ApiName,
    string DisplayName,
    string? Description,
    bool Hidden,
    string? IconUrl,
    string? IconGrayUrl,
    string? IconFile,
    string? IconGrayFile,
    bool Achieved,
    DateTimeOffset? UnlockTime,
    double? GlobalPercent,
    int SortOrder);

/// <summary>When achievements for an app were last fetched, for which account, and with what outcome.</summary>
public sealed record AchievementFetchInfo(string AppId, string SteamId, DateTimeOffset Fetched, string Status, string? Message);

/// <summary>A Steam installation row as seen from a game, used by install/uninstall and achievements.</summary>
public sealed record SteamInstallationRef(string InstallationId, string GameId, string AppId, InstallState State, long? SizeBytes, string? InstallPath);

/// <summary>
/// Steam Web API data (owned games, achievements). Owned-but-not-installed games become
/// installations in state <c>notinstalled</c>. The local Steam scan only ever marks rows that
/// were <c>installed</c> as missing, so these rows are never marked missing; when the local
/// scan finds the game installed, ApplyScan updates the same row to <c>installed</c>. Nothing
/// here deletes installations, games or user data.
/// </summary>
public sealed partial class LibraryRepository
{
    private const string SteamKey = "steam";

    /// <summary>
    /// Reconciles the owned-games list with the library. Existing Steam rows keep their state
    /// (installed stays installed); rows the local scan marked missing become notinstalled
    /// because ownership is now known. New appids become notinstalled installations, matched
    /// to existing games with the same conservative rules as a local scan.
    /// </summary>
    public OwnedSyncReport ApplyOwnedSteamGames(IReadOnlyList<OwnedSteamGame> owned)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var now = Now();

        // Our own cache of the owned list: replaced wholesale (it is not user data).
        conn.Execute("DELETE FROM steam_owned", transaction: tx);

        var rows = conn.Query<(string GameId, string Title, string? SteamAppId)>(
            "SELECT id, title, steam_app_id FROM games", transaction: tx).ToList();
        var insts = conn.Query<(string GameId, string Platform, string Pgid)>(
            "SELECT game_id, platform, platform_game_id FROM installations", transaction: tx).ToList();
        var byGame = insts.GroupBy(i => i.GameId).ToDictionary(g => g.Key, g => g.ToList());
        var matcher = new DuplicateMatcher(rows.Select(r => new MatchCandidate(
            r.GameId, r.Title, r.SteamAppId,
            byGame.TryGetValue(r.GameId, out var list)
                ? list.Where(i => PlatformInfo.TryParse(i.Platform, out _))
                      .Select(i => { PlatformInfo.TryParse(i.Platform, out var p); return (p, i.Pgid); }).ToList()
                : [])));

        int added = 0, updated = 0, restored = 0;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var game in owned)
        {
            if (!IsAppId(game.AppId) || string.IsNullOrWhiteSpace(game.Name) || !seen.Add(game.AppId)) continue;
            var lastPlayed = game.LastPlayed?.ToString("O");
            conn.Execute("""
                INSERT INTO steam_owned(app_id, name, playtime_minutes, last_played, synced)
                VALUES (@AppId, @Name, @PlaytimeMinutes, @lastPlayed, @now)
                """, new { game.AppId, game.Name, game.PlaytimeMinutes, lastPlayed, now }, tx);

            var e = conn.Query<(string Id, string State, int? Playtime, string? LastPlayed)>(
                "SELECT id, state, imported_playtime_minutes, imported_last_played FROM installations WHERE platform=@p AND platform_game_id=@g",
                new { p = SteamKey, g = game.AppId }, tx).FirstOrDefault();

            if (e.Id is not null)
            {
                var playtime = MaxNullable(e.Playtime, game.PlaytimeMinutes);
                var last = MaxIso(e.LastPlayed, lastPlayed);
                var state = e.State == "missing" ? "notinstalled" : e.State;
                if (state != e.State) restored++;
                conn.Execute("""
                    UPDATE installations SET imported_playtime_minutes=@playtime, imported_last_played=@last, state=@state
                    WHERE id=@id
                    """, new { playtime, last, state, id = e.Id }, tx);
                updated++;
                continue;
            }

            var found = new DiscoveredInstallation
            {
                Platform = PlatformId.Steam,
                PlatformGameId = game.AppId,
                Title = game.Name,
                LastPlayed = game.LastPlayed,
                PlaytimeMinutes = game.PlaytimeMinutes,
                Launch = new LaunchTarget(LaunchKind.Uri, $"steam://rungameid/{game.AppId}"),
                ClientRequired = true,
                SteamAppId = game.AppId,
                State = InstallState.NotInstalled,
            };
            var gameId = matcher.Match(found).GameId;
            if (gameId is null)
            {
                gameId = NewId();
                var title = TitleNormalizer.CleanDisplayTitle(found.Title);
                conn.Execute("""
                    INSERT INTO games(id, title, sort_title, steam_app_id, added, updated)
                    VALUES (@id, @title, @sort, @steam, @now, @now)
                    """, new { id = gameId, title, sort = TitleNormalizer.SortKey(title), steam = found.SteamAppId, now }, tx);
                matcher.Add(new MatchCandidate(gameId, title, found.SteamAppId, []));
            }
            conn.Execute("""
                INSERT INTO installations(id, game_id, platform, platform_game_id, title, install_path, size_bytes, state,
                    launch_kind, launch_value, launch_args, launch_workdir, client_required, imported_last_played,
                    imported_playtime_minutes, steam_app_id, process_hints_json, first_seen, last_seen)
                VALUES (@Id, @GameId, @Platform, @Pgid, @Title, @InstallPath, @SizeBytes, @State,
                    @Kind, @Value, @Args, @Work, @ClientRequired, @LastPlayed,
                    @Playtime, @SteamAppId, @Hints, @Now, @Now)
                """, InstallationParams(found, NewId(), gameId, now), tx);
            conn.Execute("UPDATE games SET steam_app_id=@s WHERE id=@gameId AND steam_app_id IS NULL",
                new { s = found.SteamAppId, gameId }, tx);
            matcher.Register(gameId, PlatformId.Steam, game.AppId, game.AppId);
            added++;
        }

        Audit(conn, tx, "steam.ownedSync", $"{seen.Count} owned, {added} added, {updated} updated, {restored} restored");
        tx.Commit();
        return new OwnedSyncReport(seen.Count, added, updated, restored);
    }

    /// <summary>After a local scan, owned Steam games the scan marked missing become notinstalled.</summary>
    /// <summary>
    /// Owned Steam games the scan no longer finds become "not installed" — unless their drive isn't
    /// connected (an unplugged external drive): those stay "missing" so the user sees why.
    /// </summary>
    public int RestoreOwnedSteamMissing(Func<string, bool>? driveConnected = null)
    {
        using var conn = db.Open();
        var candidates = conn.Query<(string Id, string? Path)>("""
            SELECT id, install_path FROM installations
            WHERE platform='steam' AND state='missing' AND platform_game_id IN (SELECT app_id FROM steam_owned)
            """).ToList();
        var restore = candidates.Where(c => driveConnected is null || string.IsNullOrEmpty(c.Path) || driveConnected(c.Path!)).Select(c => c.Id).ToList();
        return restore.Count == 0 ? 0 : conn.Execute("UPDATE installations SET state='notinstalled' WHERE id IN @restore", new { restore });
    }

    /// <summary>True when the drive (or share) an install path lives on is present right now.</summary>
    public static bool DriveConnected(string installPath)
    {
        try
        {
            var root = System.IO.Path.GetPathRoot(installPath);
            return !string.IsNullOrEmpty(root) && System.IO.Directory.Exists(root);
        }
        catch (Exception ex) when (ex is ArgumentException or System.IO.IOException or UnauthorizedAccessException) { return false; }
    }

    public int OwnedSteamCount()
    {
        using var conn = db.Open();
        return conn.ExecuteScalar<int>("SELECT COUNT(*) FROM steam_owned");
    }

    /// <summary>The game's Steam installation: installed first, then not installed, then missing.</summary>
    public SteamInstallationRef? GetSteamInstallation(string gameId)
    {
        using var conn = db.Open();
        var row = conn.Query<(string Id, string GameId, string Pgid, string State, long? Size, string? Path)>("""
            SELECT id, game_id, platform_game_id, state, size_bytes, install_path FROM installations
            WHERE game_id=@gameId AND platform='steam'
            ORDER BY CASE state WHEN 'installed' THEN 0 WHEN 'notinstalled' THEN 1 ELSE 2 END
            LIMIT 1
            """, new { gameId }).FirstOrDefault();
        if (row.Id is null || !IsAppId(row.Pgid)) return null;
        Enum.TryParse<InstallState>(row.State, true, out var state);
        return new SteamInstallationRef(row.Id, row.GameId, row.Pgid, state, row.Size, row.Path);
    }

    /// <summary>Steam appid → game id for every Steam installation (any state).</summary>
    public IReadOnlyDictionary<string, string> SteamAppToGame()
    {
        using var conn = db.Open();
        return conn.Query<(string AppId, string GameId)>("SELECT platform_game_id, game_id FROM installations WHERE platform='steam'")
            .GroupBy(r => r.AppId).ToDictionary(g => g.Key, g => g.First().GameId, StringComparer.Ordinal);
    }

    /// <summary>Owned, played apps whose achievements are missing or older than <paramref name="staleBefore"/>.</summary>
    public IReadOnlyList<string> AppsNeedingAchievementRefresh(string steamId, DateTimeOffset staleBefore, int limit)
    {
        using var conn = db.Open();
        return conn.Query<string>("""
            SELECT o.app_id FROM steam_owned o
            LEFT JOIN steam_achievement_fetch f ON f.app_id = o.app_id
            WHERE COALESCE(o.playtime_minutes, 0) > 0
              AND (f.app_id IS NULL OR f.steam_id <> @steamId OR f.fetched < @stale)
            ORDER BY o.last_played DESC
            LIMIT @limit
            """, new { steamId, stale = staleBefore.ToString("O"), limit }).ToList();
    }

    public AchievementFetchInfo? GetAchievementFetch(string appId)
    {
        using var conn = db.Open();
        var v = conn.Query<(string AppId, string SteamId, string Fetched, string Status, string? Message)>(
            "SELECT app_id, steam_id, fetched, status, message FROM steam_achievement_fetch WHERE app_id=@appId", new { appId }).FirstOrDefault();
        return v.AppId is not null && DateTimeOffset.TryParse(v.Fetched, out var at)
            ? new AchievementFetchInfo(v.AppId, v.SteamId, at, v.Status, v.Message)
            : null;
    }

    public IReadOnlyList<SteamAchievementRow> GetAchievements(string appId)
    {
        using var conn = db.Open();
        return conn.Query<AchievementDbRow>("SELECT * FROM steam_achievements WHERE app_id=@appId ORDER BY sort_order", new { appId })
            .Select(r => new SteamAchievementRow(r.api_name, r.display_name, r.description, r.hidden != 0, r.icon_url, r.icon_gray_url,
                r.icon_file, r.icon_gray_file, r.achieved != 0,
                r.unlock_time is not null && DateTimeOffset.TryParse(r.unlock_time, out var t) ? t : null, r.global_percent, r.sort_order))
            .ToList();
    }

    /// <summary>
    /// Records a fetch. On "ok" the achievement list is replaced (keeping already cached icon files
    /// whose URL did not change); on "none" it is cleared; other outcomes keep the previous cache.
    /// </summary>
    public void SaveAchievements(string appId, string steamId, string status, string? message, IReadOnlyList<SteamAchievementRow>? rows)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        if (status == "ok" && rows is not null)
        {
            var previous = conn.Query<(string Api, string? Url, string? File, string? GrayUrl, string? GrayFile)>(
                    "SELECT api_name, icon_url, icon_file, icon_gray_url, icon_gray_file FROM steam_achievements WHERE app_id=@appId",
                    new { appId }, tx)
                .ToDictionary(p => p.Api, StringComparer.Ordinal);
            conn.Execute("DELETE FROM steam_achievements WHERE app_id=@appId", new { appId }, tx);
            foreach (var r in rows.DistinctBy(r => r.ApiName))
            {
                previous.TryGetValue(r.ApiName, out var p);
                conn.Execute("""
                    INSERT INTO steam_achievements(app_id, api_name, display_name, description, hidden, icon_url, icon_gray_url,
                        icon_file, icon_gray_file, achieved, unlock_time, global_percent, sort_order)
                    VALUES (@appId, @ApiName, @DisplayName, @Description, @Hidden, @IconUrl, @IconGrayUrl,
                        @iconFile, @grayFile, @Achieved, @unlock, @GlobalPercent, @SortOrder)
                    """, new
                {
                    appId, r.ApiName, r.DisplayName, r.Description, r.Hidden, r.IconUrl, r.IconGrayUrl,
                    iconFile = r.IconFile ?? (p.Url == r.IconUrl ? p.File : null),
                    grayFile = r.IconGrayFile ?? (p.GrayUrl == r.IconGrayUrl ? p.GrayFile : null),
                    r.Achieved, unlock = r.UnlockTime?.ToString("O"), r.GlobalPercent, r.SortOrder,
                }, tx);
            }
        }
        else if (status == "none")
        {
            conn.Execute("DELETE FROM steam_achievements WHERE app_id=@appId", new { appId }, tx);
        }
        conn.Execute("""
            INSERT INTO steam_achievement_fetch(app_id, steam_id, fetched, status, message) VALUES (@appId, @steamId, @now, @status, @message)
            ON CONFLICT(app_id) DO UPDATE SET steam_id=excluded.steam_id, fetched=excluded.fetched, status=excluded.status, message=excluded.message
            """, new { appId, steamId, now = Now(), status, message }, tx);
        tx.Commit();
    }

    public void SetAchievementIconFile(string appId, string apiName, bool gray, string relativeFile)
    {
        using var conn = db.Open();
        conn.Execute(gray
            ? "UPDATE steam_achievements SET icon_gray_file=@relativeFile WHERE app_id=@appId AND api_name=@apiName"
            : "UPDATE steam_achievements SET icon_file=@relativeFile WHERE app_id=@appId AND api_name=@apiName",
            new { appId, apiName, relativeFile });
    }

    /// <summary>Forgets cached Web API data (owned list and achievements). Installations are kept.</summary>
    public void ClearSteamWebApiCache()
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        conn.Execute("DELETE FROM steam_achievements", transaction: tx);
        conn.Execute("DELETE FROM steam_achievement_fetch", transaction: tx);
        conn.Execute("DELETE FROM steam_owned", transaction: tx);
        Audit(conn, tx, "steam.webApiCleared", null);
        tx.Commit();
    }

    /// <summary>Reads an internal (non-user-facing) value from the settings table.</summary>
    public string? GetInternalValue(string key)
    {
        using var conn = db.Open();
        var raw = conn.ExecuteScalar<string?>("SELECT value FROM settings WHERE key=@key", new { key });
        if (raw is null) return null;
        try { return JsonSerializer.Deserialize<string>(raw); }
        catch (JsonException) { return null; }
    }

    public void SetInternalValue(string key, string? value)
    {
        using var conn = db.Open();
        if (value is null) conn.Execute("DELETE FROM settings WHERE key=@key", new { key });
        else conn.Execute("INSERT INTO settings(key, value) VALUES (@key, @v) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            new { key, v = JsonSerializer.Serialize(value) });
    }

    private static bool IsAppId(string s) => s.Length is > 0 and < 12 && s.All(char.IsAsciiDigit);

    private static int? MaxNullable(int? a, int? b) => a is null ? b : b is null ? a : Math.Max(a.Value, b.Value);

    private static string? MaxIso(string? a, string? b)
    {
        if (a is null) return b;
        if (b is null) return a;
        return DateTimeOffset.TryParse(a, out var da) && DateTimeOffset.TryParse(b, out var dbt) && dbt > da ? b : a;
    }

#pragma warning disable IDE1006
    private sealed class AchievementDbRow
    {
        public string app_id { get; init; } = "";
        public string api_name { get; init; } = "";
        public string display_name { get; init; } = "";
        public string? description { get; init; }
        public long hidden { get; init; }
        public string? icon_url { get; init; }
        public string? icon_gray_url { get; init; }
        public string? icon_file { get; init; }
        public string? icon_gray_file { get; init; }
        public long achieved { get; init; }
        public string? unlock_time { get; init; }
        public double? global_percent { get; init; }
        public int sort_order { get; init; }
    }
#pragma warning restore IDE1006
}
