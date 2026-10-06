using System.Text.Json;
using Dapper;
using Microsoft.Data.Sqlite;
using Vystral.Core.Contracts;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Core.Matching;

namespace Vystral.Core.Data;

public sealed record ScanApplyReport(int Added, int Updated, int MarkedMissing, int Merged);

/// <summary>
/// All reads and writes of library data. Every multi-row change runs in a transaction.
/// Platform data is reconciled without ever deleting user-created information.
/// </summary>
public sealed partial class LibraryRepository(Database db)
{
    private static string Now() => DateTimeOffset.UtcNow.ToString("O");
    public static string NewId() => Guid.CreateVersion7().ToString("N");

    // ---------- Reconciliation ----------

    /// <summary>
    /// Applies adapter results. Successful scans update or add installations and mark unseen
    /// ones as Missing. Failed scans change nothing, so a broken integration never wipes history.
    /// </summary>
    public ScanApplyReport ApplyScan(IReadOnlyList<AdapterScanResult> results)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var now = Now();

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

        int added = 0, updated = 0, missing = 0, merged = 0;
        foreach (var result in results.Where(r => r.Succeeded))
        {
            var platformKey = result.Platform.Key();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var found in result.Installations)
            {
                if (!seen.Add(found.PlatformGameId)) continue;
                var existingId = conn.ExecuteScalar<string?>(
                    "SELECT id FROM installations WHERE platform=@p AND platform_game_id=@g",
                    new { p = platformKey, g = found.PlatformGameId }, tx);

                if (existingId is not null)
                {
                    conn.Execute("""
                        UPDATE installations SET title=@Title, install_path=@InstallPath, size_bytes=@SizeBytes,
                            state=@State, launch_kind=@Kind, launch_value=@Value, launch_args=@Args, launch_workdir=@Work,
                            client_required=@ClientRequired,
                            -- Local store files can lack playtime (played on another PC/account): never wipe or lower a known value.
                            imported_last_played=CASE WHEN @LastPlayed IS NULL THEN imported_last_played
                                WHEN imported_last_played IS NULL OR @LastPlayed > imported_last_played THEN @LastPlayed ELSE imported_last_played END,
                            imported_playtime_minutes=CASE WHEN @Playtime IS NULL THEN imported_playtime_minutes
                                WHEN imported_playtime_minutes IS NULL OR @Playtime > imported_playtime_minutes THEN @Playtime ELSE imported_playtime_minutes END,
                            steam_app_id=@SteamAppId,
                            process_hints_json=@Hints, last_seen=@Now
                        WHERE id=@Id
                        """, InstallationParams(found, existingId, null, now), tx);
                    updated++;
                }
                else
                {
                    var decision = matcher.Match(found);
                    var gameId = decision.GameId;
                    if (gameId is null)
                    {
                        gameId = NewId();
                        var title = TitleNormalizer.CleanDisplayTitle(found.Title);
                        conn.Execute("""
                            INSERT INTO games(id, title, sort_title, steam_app_id, added, updated)
                            VALUES (@id, @title, @sort, @steam, @now, @now)
                            """, new { id = gameId, title, sort = TitleNormalizer.SortKey(title), steam = found.SteamAppId, now }, tx);
                        matcher.Add(new MatchCandidate(gameId, title, found.SteamAppId, []));
                        added++;
                    }
                    else
                    {
                        merged++;
                    }
                    conn.Execute("""
                        INSERT INTO installations(id, game_id, platform, platform_game_id, title, install_path, size_bytes, state,
                            launch_kind, launch_value, launch_args, launch_workdir, client_required, imported_last_played,
                            imported_playtime_minutes, steam_app_id, process_hints_json, first_seen, last_seen)
                        VALUES (@Id, @GameId, @Platform, @Pgid, @Title, @InstallPath, @SizeBytes, @State,
                            @Kind, @Value, @Args, @Work, @ClientRequired, @LastPlayed,
                            @Playtime, @SteamAppId, @Hints, @Now, @Now)
                        """, InstallationParams(found, NewId(), gameId, now), tx);
                    matcher.Register(gameId, found.Platform, found.PlatformGameId, found.SteamAppId);
                }

                if (!string.IsNullOrEmpty(found.SteamAppId))
                {
                    conn.Execute("""
                        UPDATE games SET steam_app_id=@s WHERE steam_app_id IS NULL
                          AND id=(SELECT game_id FROM installations WHERE platform=@p AND platform_game_id=@g)
                        """, new { s = found.SteamAppId, p = platformKey, g = found.PlatformGameId }, tx);
                }
            }

            // Anything this platform reported before but not now is Missing — kept, not deleted.
            var previous = conn.Query<(string Id, string Pgid)>(
                "SELECT id, platform_game_id FROM installations WHERE platform=@p AND state='installed'",
                new { p = platformKey }, tx);
            foreach (var (id, pgid) in previous)
            {
                if (seen.Contains(pgid)) continue;
                conn.Execute("UPDATE installations SET state='missing' WHERE id=@id", new { id }, tx);
                missing++;
            }
        }

        SetSetting(conn, tx, "library.lastScan", JsonSerializer.Serialize(now));
        tx.Commit();
        return new ScanApplyReport(added, updated, missing, merged);
    }

    private static object InstallationParams(DiscoveredInstallation f, string id, string? gameId, string now) => new
    {
        Id = id,
        GameId = gameId,
        Platform = f.Platform.Key(),
        Pgid = f.PlatformGameId,
        Title = TitleNormalizer.CleanDisplayTitle(f.Title),
        f.InstallPath,
        f.SizeBytes,
        State = f.State.ToString().ToLowerInvariant(),
        Kind = f.Launch.Kind.ToString(),
        f.Launch.Value,
        Args = f.Launch.Arguments,
        Work = f.Launch.WorkingDirectory,
        f.ClientRequired,
        LastPlayed = f.LastPlayed?.ToString("O"),
        Playtime = f.PlaytimeMinutes,
        f.SteamAppId,
        Hints = JsonSerializer.Serialize(f.ProcessHints),
        Now = now,
    };

    // ---------- Snapshot for the UI ----------

    public LibrarySnapshotDto LoadSnapshot(Func<string, string, string?> artworkUrl)
    {
        using var conn = db.Open();
        var games = conn.Query<GameRow>("SELECT * FROM games").ToList();
        var installs = conn.Query<InstallationRow>("SELECT * FROM installations").ToLookup(i => i.game_id);
        var art = conn.Query<(string GameId, string Kind, string File)>("SELECT game_id, kind, file FROM artwork")
            .ToLookup(a => a.GameId);
        var colMembers = conn.Query<(string Cid, string Gid)>("SELECT collection_id, game_id FROM collection_games")
            .ToLookup(c => c.Gid, c => c.Cid);
        var statuses = LoadStatuses(conn);
        var stats = conn.Query<(string GameId, long Secs, int Count, string? Last)>("""
            SELECT game_id, SUM(duration_seconds), COUNT(*), MAX(start) FROM sessions
            WHERE source IN ('tracked','detected','background','cloud-gfn','cloud-xbox') AND end IS NOT NULL GROUP BY game_id
            """).ToDictionary(s => s.GameId);

        var dtos = games.Select(g =>
        {
            var a = art[g.id].ToDictionary(x => x.Kind, x => artworkUrl(g.id, x.File));
            stats.TryGetValue(g.id, out var st);
            return new GameDto(
                g.id, g.title, g.sort_title, g.description, g.developer, g.publisher, g.release_date,
                JsonSerializer.Deserialize<List<string>>(g.genres_json) ?? [],
                g.favorite != 0, g.hidden != 0, g.user_rating, g.notes, g.preferred_installation_id,
                g.metadata_source, g.palette_json,
                new ArtworkDto(a.GetValueOrDefault("cover"), a.GetValueOrDefault("hero"), a.GetValueOrDefault("logo"),
                    a.GetValueOrDefault("header"), a.GetValueOrDefault("icon")),
                installs[g.id].Select(ToDto).ToList(),
                colMembers[g.id].ToList(),
                st.Secs, st.Count, st.Last, g.added,
                Status: statuses.TryGetValue(g.id, out var sv) ? sv.Status : null,
                StatusChangedAt: statuses.TryGetValue(g.id, out var sc) ? sc.Changed : null);
        }).ToList();

        var collections = conn.Query<(string Id, string Name, string? Icon, int Sort, string? Rule, int Count)>("""
            SELECT c.id, c.name, c.icon, c.sort_order, c.rule_json,
                   (SELECT COUNT(*) FROM collection_games cg WHERE cg.collection_id=c.id)
            FROM collections c ORDER BY c.sort_order, c.name
            """).Select(c => new CollectionDto(c.Id, c.Name, c.Icon, c.Sort, c.Rule, c.Count)).ToList();

        var dismissed = conn.Query<(string A, string B)>("SELECT game_a, game_b FROM dismissed_duplicates").ToHashSet();
        var matcher = new DuplicateMatcher(games.Select(g => new MatchCandidate(g.id, g.title, g.steam_app_id, [])));
        var suggestions = matcher.Suggestions()
            .Where(s => !dismissed.Contains((s.GameIdA, s.GameIdB)) && !dismissed.Contains((s.GameIdB, s.GameIdA)))
            .Select(s => new DuplicateSuggestionDto(s.GameIdA, s.GameIdB, s.Explanation)).ToList();
        // Track I: Wikidata's cross-store identity is only ever a suggestion signal (never merges).
        foreach (var (a, b, why) in WikidataDuplicatePairs())
            if (!dismissed.Contains((a, b)) && !dismissed.Contains((b, a)) &&
                !suggestions.Any(s => (s.GameIdA == a && s.GameIdB == b) || (s.GameIdA == b && s.GameIdB == a)))
                suggestions.Add(new DuplicateSuggestionDto(a, b, why));

        var lastScan = conn.ExecuteScalar<string?>("SELECT value FROM settings WHERE key='library.lastScan'");
        return new LibrarySnapshotDto(dtos, collections, suggestions,
            lastScan is null ? null : JsonSerializer.Deserialize<string>(lastScan));
    }

    private static InstallationDto ToDto(InstallationRow i) => new(
        i.id, i.platform, i.platform_game_id, i.title, i.state, i.install_path,
        i.install_path is { Length: >= 2 } p && p[1] == ':' ? p[..2].ToUpperInvariant() : null,
        i.size_bytes, i.client_required != 0, i.launch_kind, i.imported_last_played, i.imported_playtime_minutes,
        i.user_launch_args, i.manual_link != 0, i.last_seen);

    public Installation? GetInstallation(string installationId)
    {
        using var conn = db.Open();
        var row = conn.QuerySingleOrDefault<InstallationRow>("SELECT * FROM installations WHERE id=@installationId", new { installationId });
        return row is null ? null : ToDomain(row);
    }

    public Installation? GetInstallationsByPlatformId(PlatformId platform, string platformGameId)
    {
        using var conn = db.Open();
        var row = conn.QuerySingleOrDefault<InstallationRow>("SELECT * FROM installations WHERE platform=@p AND platform_game_id=@platformGameId",
            new { p = platform.Key(), platformGameId });
        return row is null ? null : ToDomain(row);
    }

    public IReadOnlyList<Installation> GetInstallations(string gameId)
    {
        using var conn = db.Open();
        return conn.Query<InstallationRow>("SELECT * FROM installations WHERE game_id=@gameId", new { gameId }).Select(ToDomain).ToList();
    }

    public Game? GetGame(string gameId)
    {
        using var conn = db.Open();
        var g = conn.QuerySingleOrDefault<GameRow>("SELECT * FROM games WHERE id=@gameId", new { gameId });
        return g is null ? null : new Game
        {
            Id = g.id, Title = g.title, SortTitle = g.sort_title, Description = g.description, Developer = g.developer,
            Publisher = g.publisher, ReleaseDate = g.release_date,
            Genres = JsonSerializer.Deserialize<List<string>>(g.genres_json) ?? [],
            Favorite = g.favorite != 0, Hidden = g.hidden != 0, UserRating = g.user_rating, Notes = g.notes,
            PreferredInstallationId = g.preferred_installation_id, MetadataSource = g.metadata_source,
            PaletteJson = g.palette_json, SteamAppId = g.steam_app_id, Added = DateTimeOffset.Parse(g.added),
        };
    }

    public string? GetUserLaunchArgs(string installationId)
    {
        using var conn = db.Open();
        return conn.ExecuteScalar<string?>("SELECT user_launch_args FROM installations WHERE id=@installationId", new { installationId });
    }

    private static Installation ToDomain(InstallationRow r)
    {
        PlatformInfo.TryParse(r.platform, out var platform);
        Enum.TryParse<InstallState>(r.state, true, out var state);
        Enum.TryParse<LaunchKind>(r.launch_kind, true, out var kind);
        return new Installation
        {
            Id = r.id, GameId = r.game_id, Platform = platform, PlatformGameId = r.platform_game_id, Title = r.title,
            InstallPath = r.install_path, SizeBytes = r.size_bytes, State = state,
            Launch = new LaunchTarget(kind, r.launch_value, r.launch_args, r.launch_workdir),
            ClientRequired = r.client_required != 0,
            ImportedLastPlayed = r.imported_last_played is null ? null : DateTimeOffset.Parse(r.imported_last_played),
            ImportedPlaytimeMinutes = r.imported_playtime_minutes, SteamAppId = r.steam_app_id,
            ProcessHints = JsonSerializer.Deserialize<List<string>>(r.process_hints_json) ?? [],
            FirstSeen = DateTimeOffset.Parse(r.first_seen), LastSeen = DateTimeOffset.Parse(r.last_seen),
            ManualLink = r.manual_link != 0,
        };
    }

    // ---------- User edits ----------

    public bool UpdateGameFlags(string gameId, bool? favorite = null, bool? hidden = null, int? rating = null,
        bool clearRating = false, string? notes = null, bool setNotes = false)
    {
        using var conn = db.Open();
        var n = conn.Execute("""
            UPDATE games SET
              favorite = COALESCE(@fav, favorite),
              hidden = COALESCE(@hid, hidden),
              user_rating = CASE WHEN @clear THEN NULL ELSE COALESCE(@rating, user_rating) END,
              notes = CASE WHEN @setNotes THEN @notes ELSE notes END,
              updated = @now
            WHERE id=@gameId
            """, new { fav = favorite, hid = hidden, rating, clear = clearRating, setNotes, notes, gameId, now = Now() });
        return n == 1;
    }

    public bool SetPreferredInstallation(string gameId, string? installationId)
    {
        using var conn = db.Open();
        if (installationId is not null &&
            conn.ExecuteScalar<int>("SELECT COUNT(*) FROM installations WHERE id=@installationId AND game_id=@gameId", new { installationId, gameId }) == 0)
            return false;
        return conn.Execute("UPDATE games SET preferred_installation_id=@installationId, updated=@now WHERE id=@gameId",
            new { installationId, gameId, now = Now() }) == 1;
    }

    public bool SetUserLaunchArgs(string installationId, string? args)
    {
        using var conn = db.Open();
        return conn.Execute("UPDATE installations SET user_launch_args=@args WHERE id=@installationId", new { args, installationId }) == 1;
    }

    /// <summary>Moves every installation of <paramref name="sourceGameId"/> into <paramref name="targetGameId"/>.
    /// User data (sessions, collections, notes) follows; the emptied game is removed.</summary>
    public bool MergeGames(string targetGameId, string sourceGameId)
    {
        if (targetGameId == sourceGameId) return false;
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        if (conn.ExecuteScalar<int>("SELECT COUNT(*) FROM games WHERE id IN (@targetGameId, @sourceGameId)",
                new { targetGameId, sourceGameId }, tx) != 2) return false;
        var p = new { targetGameId, sourceGameId };
        conn.Execute("UPDATE installations SET game_id=@targetGameId, manual_link=1 WHERE game_id=@sourceGameId", p, tx);
        conn.Execute("UPDATE sessions SET game_id=@targetGameId WHERE game_id=@sourceGameId", p, tx);
        conn.Execute("INSERT OR IGNORE INTO collection_games(collection_id, game_id) SELECT collection_id, @targetGameId FROM collection_games WHERE game_id=@sourceGameId", p, tx);
        conn.Execute("DELETE FROM collection_games WHERE game_id=@sourceGameId", p, tx);
        // Art follows the same rule as SetArtwork: art the user chose wins over downloaded art.
        conn.Execute("""
            INSERT INTO artwork(game_id, kind, file, source, is_user, updated)
            SELECT @targetGameId, kind, file, source, is_user, updated FROM artwork WHERE game_id=@sourceGameId
            ON CONFLICT(game_id, kind) DO UPDATE SET file=excluded.file, source=excluded.source, is_user=excluded.is_user, updated=excluded.updated
            WHERE artwork.is_user = 0 AND excluded.is_user = 1
            """, p, tx);
        conn.Execute("DELETE FROM artwork WHERE game_id=@sourceGameId", p, tx);
        // Per-game data keyed by game id moves too (the target's own rows win), so nothing is orphaned.
        foreach (var table in (string[])["game_media", "game_enrichment", "game_field_sources"])
        {
            conn.Execute($"UPDATE OR IGNORE {table} SET game_id=@targetGameId WHERE game_id=@sourceGameId", p, tx);
            conn.Execute($"DELETE FROM {table} WHERE game_id=@sourceGameId", p, tx);
        }
        // Everything keyed on the Steam app id (trailers, prices, Wikidata, anti-cheat, covers) keeps working.
        conn.Execute("UPDATE games SET steam_app_id = COALESCE(steam_app_id, (SELECT steam_app_id FROM games WHERE id=@sourceGameId)) WHERE id=@targetGameId", p, tx);
        conn.Execute("""
            UPDATE games SET
              favorite = MAX(favorite, (SELECT favorite FROM games WHERE id=@sourceGameId)),
              notes = COALESCE(notes, (SELECT notes FROM games WHERE id=@sourceGameId)),
              user_rating = COALESCE(user_rating, (SELECT user_rating FROM games WHERE id=@sourceGameId))
            WHERE id=@targetGameId
            """, p, tx);
        // Play status and its history follow the merge (the target's own status wins if set).
        conn.Execute("""
            UPDATE games SET
              status = COALESCE(status, (SELECT status FROM games WHERE id=@sourceGameId)),
              status_changed = CASE WHEN status IS NULL THEN (SELECT status_changed FROM games WHERE id=@sourceGameId) ELSE status_changed END
            WHERE id=@targetGameId
            """, p, tx);
        conn.Execute("UPDATE status_history SET game_id=@targetGameId WHERE game_id=@sourceGameId", p, tx);
        conn.Execute("DELETE FROM games WHERE id=@sourceGameId", p, tx);
        Audit(conn, tx, "library.merge", $"{sourceGameId} -> {targetGameId}");
        tx.Commit();
        return true;
    }

    /// <summary>Splits one installation out into its own game entry and pins it there.</summary>
    public string? UnmergeInstallation(string installationId)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var inst = conn.QuerySingleOrDefault<InstallationRow>("SELECT * FROM installations WHERE id=@installationId", new { installationId }, tx);
        if (inst is null) return null;
        if (conn.ExecuteScalar<int>("SELECT COUNT(*) FROM installations WHERE game_id=@g", new { g = inst.game_id }, tx) < 2) return null;
        var newId = NewId();
        var now = Now();
        conn.Execute("INSERT INTO games(id, title, sort_title, steam_app_id, added, updated) VALUES (@newId, @t, @s, @steam, @now, @now)",
            new { newId, t = inst.title, s = TitleNormalizer.SortKey(inst.title), steam = inst.steam_app_id, now }, tx);
        conn.Execute("UPDATE installations SET game_id=@newId, manual_link=1 WHERE id=@installationId", new { newId, installationId }, tx);
        conn.Execute("UPDATE sessions SET game_id=@newId WHERE installation_id=@installationId", new { newId, installationId }, tx);
        conn.Execute("UPDATE games SET preferred_installation_id=NULL WHERE preferred_installation_id=@installationId", new { installationId }, tx);
        // The original keeps a Steam app id only if one of its remaining installations still has it.
        conn.Execute("""
            UPDATE games SET steam_app_id = (SELECT i.steam_app_id FROM installations i WHERE i.game_id=@orig AND i.steam_app_id IS NOT NULL ORDER BY i.first_seen LIMIT 1)
            WHERE id=@orig
            """, new { orig = inst.game_id }, tx);
        // The user just separated these two; don't suggest them as duplicates again.
        var (a, b) = string.CompareOrdinal(inst.game_id, newId) < 0 ? (inst.game_id, newId) : (newId, inst.game_id);
        conn.Execute("INSERT OR IGNORE INTO dismissed_duplicates(game_a, game_b) VALUES (@a, @b)", new { a, b }, tx);
        Audit(conn, tx, "library.unmerge", $"{installationId} -> {newId}");
        tx.Commit();
        return newId;
    }

    public void DismissDuplicate(string a, string b)
    {
        using var conn = db.Open();
        conn.Execute("INSERT OR IGNORE INTO dismissed_duplicates(game_a, game_b) VALUES (@a, @b)", new { a, b });
    }

    public string AddManualGame(string title, string exePath, string? args)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var gameId = NewId();
        var now = Now();
        var clean = TitleNormalizer.CleanDisplayTitle(title);
        conn.Execute("INSERT INTO games(id, title, sort_title, added, updated) VALUES (@gameId, @clean, @sort, @now, @now)",
            new { gameId, clean, sort = TitleNormalizer.SortKey(clean), now }, tx);
        conn.Execute("""
            INSERT INTO installations(id, game_id, platform, platform_game_id, title, install_path, state, launch_kind,
              launch_value, launch_args, launch_workdir, process_hints_json, manual_link, first_seen, last_seen)
            VALUES (@id, @gameId, 'manual', @pgid, @clean, @dir, 'installed', 'Executable', @exePath, @args, @dir, @hints, 1, @now, @now)
            """, new
        {
            id = NewId(), gameId, pgid = NewId(), clean, dir = Path.GetDirectoryName(exePath), exePath, args,
            hints = JsonSerializer.Serialize(new[] { Path.GetFileName(exePath) }), now,
        }, tx);
        Audit(conn, tx, "library.addManual", exePath);
        tx.Commit();
        return gameId;
    }

    /// <summary>Removes a user-added entry from VYSTRAL only. Files on disk are never touched.</summary>
    public bool RemoveManualGame(string gameId)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var platforms = conn.Query<string>("SELECT platform FROM installations WHERE game_id=@gameId", new { gameId }, tx).ToList();
        if (platforms.Count == 0 || platforms.Any(p => p != "manual")) return false;
        foreach (var sql in new[]
                 {
                     "DELETE FROM perf_samples WHERE session_id IN (SELECT id FROM sessions WHERE game_id=@gameId)",
                     "DELETE FROM sessions WHERE game_id=@gameId", "DELETE FROM collection_games WHERE game_id=@gameId",
                     "DELETE FROM artwork WHERE game_id=@gameId", "DELETE FROM installations WHERE game_id=@gameId",
                     "DELETE FROM status_history WHERE game_id=@gameId", "DELETE FROM game_enrichment WHERE game_id=@gameId",
                     "DELETE FROM game_field_sources WHERE game_id=@gameId", "DELETE FROM game_media WHERE game_id=@gameId",
                     "DELETE FROM games WHERE id=@gameId",
                 })
            conn.Execute(sql, new { gameId }, tx);
        Audit(conn, tx, "library.removeManual", gameId);
        tx.Commit();
        return true;
    }

    // ---------- Metadata & artwork ----------

    public void SetArtwork(string gameId, ArtworkKind kind, string file, string source, bool isUser)
    {
        using var conn = db.Open();
        conn.Execute("""
            INSERT INTO artwork(game_id, kind, file, source, is_user, updated) VALUES (@gameId, @kind, @file, @source, @isUser, @now)
            ON CONFLICT(game_id, kind) DO UPDATE SET file=excluded.file, source=excluded.source, is_user=excluded.is_user, updated=excluded.updated
            WHERE artwork.is_user = 0 OR excluded.is_user = 1
            """, new { gameId, kind = kind.ToString().ToLowerInvariant(), file, source, isUser, now = Now() });
    }

    public IReadOnlyDictionary<string, (string File, bool IsUser)> GetArtwork(string gameId)
    {
        using var conn = db.Open();
        return conn.Query<(string Kind, string File, bool IsUser)>("SELECT kind, file, is_user FROM artwork WHERE game_id=@gameId", new { gameId })
            .ToDictionary(a => a.Kind, a => (a.File, a.IsUser));
    }

    public void SetMetadata(string gameId, string source, string? description, string? developer, string? publisher,
        string? releaseDate, IReadOnlyList<string> genres)
    {
        using var conn = db.Open();
        conn.Execute("""
            UPDATE games SET metadata_source=@source, metadata_fetched=@now,
              -- A field another source (IGDB, RAWG, the user) already filled keeps its value, so provenance stays true.
              description=CASE WHEN EXISTS (SELECT 1 FROM game_field_sources f WHERE f.game_id=@gameId AND f.field='description') THEN description ELSE COALESCE(@description, description) END,
              developer=CASE WHEN EXISTS (SELECT 1 FROM game_field_sources f WHERE f.game_id=@gameId AND f.field='developer') THEN developer ELSE COALESCE(@developer, developer) END,
              publisher=CASE WHEN EXISTS (SELECT 1 FROM game_field_sources f WHERE f.game_id=@gameId AND f.field='publisher') THEN publisher ELSE COALESCE(@publisher, publisher) END,
              release_date=CASE WHEN EXISTS (SELECT 1 FROM game_field_sources f WHERE f.game_id=@gameId AND f.field='release_date') THEN release_date ELSE COALESCE(@releaseDate, release_date) END,
              genres_json=CASE WHEN EXISTS (SELECT 1 FROM game_field_sources f WHERE f.game_id=@gameId AND f.field='genres') OR @genres='[]' THEN genres_json ELSE @genres END,
              updated=@now
            WHERE id=@gameId
            """, new { gameId, source, description, developer, publisher, releaseDate, genres = JsonSerializer.Serialize(genres), now = Now() });
    }

    public IReadOnlyList<(string GameId, string Title, string? SteamAppId)> GamesNeedingMetadata(int limit)
    {
        using var conn = db.Open();
        return conn.Query<(string, string, string?)>(
            "SELECT id, title, steam_app_id FROM games WHERE metadata_fetched IS NULL ORDER BY added DESC LIMIT @limit", new { limit }).ToList();
    }

    public void MarkMetadataAttempted(string gameId)
    {
        using var conn = db.Open();
        conn.Execute("UPDATE games SET metadata_fetched=@now WHERE id=@gameId", new { gameId, now = Now() });
    }

    public void SetPalette(string gameId, string paletteJson)
    {
        using var conn = db.Open();
        conn.Execute("UPDATE games SET palette_json=@paletteJson WHERE id=@gameId", new { gameId, paletteJson });
    }

    // ---------- Collections ----------

    public string CreateCollection(string name, string? icon, string? ruleJson)
    {
        using var conn = db.Open();
        var id = NewId();
        var order = conn.ExecuteScalar<int?>("SELECT MAX(sort_order) FROM collections") ?? 0;
        conn.Execute("INSERT INTO collections(id, name, icon, sort_order, rule_json) VALUES (@id, @name, @icon, @order, @ruleJson)",
            new { id, name, icon, order = order + 1, ruleJson });
        return id;
    }

    public bool RenameCollection(string id, string name)
    {
        using var conn = db.Open();
        return conn.Execute("UPDATE collections SET name=@name WHERE id=@id", new { id, name }) == 1;
    }

    public bool DeleteCollection(string id)
    {
        using var conn = db.Open();
        return conn.Execute("DELETE FROM collections WHERE id=@id", new { id }) == 1;
    }

    public void SetCollectionMembership(string collectionId, string gameId, bool member)
    {
        using var conn = db.Open();
        conn.Execute(member
            ? "INSERT OR IGNORE INTO collection_games(collection_id, game_id) SELECT @collectionId, @gameId WHERE EXISTS (SELECT 1 FROM collections WHERE id=@collectionId) AND EXISTS (SELECT 1 FROM games WHERE id=@gameId)"
            : "DELETE FROM collection_games WHERE collection_id=@collectionId AND game_id=@gameId",
            new { collectionId, gameId });
    }

    // ---------- Sessions & performance ----------

    public string StartSession(string gameId, string? installationId, DateTimeOffset start)
    {
        using var conn = db.Open();
        var id = NewId();
        conn.Execute("INSERT INTO sessions(id, game_id, installation_id, start, source) VALUES (@id, @gameId, @installationId, @start, 'tracked')",
            new { id, gameId, installationId, start = start.ToString("O") });
        return id;
    }

    public void EndSession(string sessionId, DateTimeOffset end, int durationSeconds, string? perfSummaryJson)
    {
        using var conn = db.Open();
        conn.Execute("UPDATE sessions SET end=@end, duration_seconds=@durationSeconds, perf_summary_json=@perfSummaryJson WHERE id=@sessionId",
            new { sessionId, end = end.ToString("O"), durationSeconds, perfSummaryJson });
    }

    /// <summary>Closes sessions left open by a crash, using their last perf sample as the best-known end.</summary>
    public int RecoverOpenSessions()
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var open = conn.Query<(string Id, string Start, long? LastMs, int Known)>("""
            SELECT s.id, s.start, (SELECT MAX(t_offset_ms) FROM perf_samples p WHERE p.session_id = s.id), COALESCE(s.duration_seconds, 0)
            FROM sessions s WHERE s.end IS NULL
            """, transaction: tx).ToList();
        foreach (var (id, start, lastMs, known) in open)
        {
            // Best evidence of how long the game ran: the last performance sample or the last recorded heartbeat.
            var duration = Math.Max((int)((lastMs ?? 0) / 1000), known);
            var end = DateTimeOffset.TryParse(start, out var s) ? s.AddSeconds(duration).ToString("O") : start;
            conn.Execute("UPDATE sessions SET duration_seconds=@duration, end=@end WHERE id=@id", new { id, duration, end }, tx);
        }
        tx.Commit();
        return open.Count;
    }

    public void AddPerfSamples(string sessionId, IEnumerable<PerfSampleDto> samples)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        foreach (var s in samples)
        {
            conn.Execute("""
                INSERT OR REPLACE INTO perf_samples(session_id, t_offset_ms, cpu_pct, gpu_pct, gpu_mem_mb, ram_mb, gpu_temp_c)
                VALUES (@sessionId, @T, @Cpu, @Gpu, @GpuMemMb, @RamMb, @GpuTempC)
                """, new { sessionId, s.T, s.Cpu, s.Gpu, s.GpuMemMb, s.RamMb, s.GpuTempC }, tx);
        }
        tx.Commit();
    }

    public IReadOnlyList<SessionDto> ListSessions(string? gameId, int limit)
    {
        using var conn = db.Open();
        var sql = gameId is null
            ? "SELECT * FROM sessions WHERE end IS NOT NULL ORDER BY start DESC LIMIT @limit"
            : "SELECT * FROM sessions WHERE end IS NOT NULL AND game_id=@gameId ORDER BY start DESC LIMIT @limit";
        return conn.Query<SessionRow>(sql, new { gameId, limit })
            .Select(s => new SessionDto(s.id, s.game_id, s.installation_id, s.start, s.end, s.duration_seconds, s.source, s.perf_summary_json))
            .ToList();
    }

    public IReadOnlyList<PerfSampleDto> GetPerfSamples(string sessionId)
    {
        using var conn = db.Open();
        return conn.Query<(int T, double? Cpu, double? Gpu, double? Mem, double? Ram, double? Temp)>(
                "SELECT t_offset_ms, cpu_pct, gpu_pct, gpu_mem_mb, ram_mb, gpu_temp_c FROM perf_samples WHERE session_id=@sessionId ORDER BY t_offset_ms",
                new { sessionId })
            .Select(r => new PerfSampleDto(r.T, r.Cpu, r.Gpu, r.Mem, r.Ram, r.Temp)).ToList();
    }

    /// <summary>Permanently deletes VYSTRAL-tracked history (sessions + samples). Platform data is untouched.</summary>
    public int DeleteTrackedHistory()
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        conn.Execute("DELETE FROM perf_samples", transaction: tx);
        // Track F: background-app names recorded during sessions, and the names the user hid.
        // Hidden background apps are a preference, not history: they stay.
        conn.Execute("DELETE FROM session_background_apps;", transaction: tx);
        var n = conn.Execute("DELETE FROM sessions", transaction: tx);
        Audit(conn, tx, "journal.deleteAll", $"{n} sessions");
        tx.Commit();
        return n;
    }

    // ---------- Settings & audit ----------

    public IReadOnlyDictionary<string, string> GetSettings()
    {
        using var conn = db.Open();
        return conn.Query<(string Key, string Value)>("SELECT key, value FROM settings").ToDictionary(r => r.Key, r => r.Value);
    }

    public void SetSetting(string key, string jsonValue)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        SetSetting(conn, tx, key, jsonValue);
        tx.Commit();
    }

    private static void SetSetting(SqliteConnection conn, SqliteTransaction tx, string key, string jsonValue) =>
        conn.Execute("INSERT INTO settings(key, value) VALUES (@key, @jsonValue) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            new { key, jsonValue }, tx);

    public void Audit(string action, string? detail)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        Audit(conn, tx, action, detail);
        tx.Commit();
    }

    private static void Audit(SqliteConnection conn, SqliteTransaction tx, string action, string? detail) =>
        conn.Execute("INSERT INTO audit_log(at, action, detail) VALUES (@at, @action, @detail)",
            new { at = Now(), action, detail }, tx);

    public IReadOnlyList<(string At, string Action, string? Detail)> RecentAudit(int limit)
    {
        using var conn = db.Open();
        return conn.Query<(string, string, string?)>("SELECT at, action, detail FROM audit_log ORDER BY id DESC LIMIT @limit", new { limit }).ToList();
    }

    // ---------- Media folders ----------

    public IReadOnlyList<(string Id, string Path)> GetMediaFolders()
    {
        using var conn = db.Open();
        return conn.Query<(string, string)>("SELECT id, path FROM media_folders ORDER BY added").ToList();
    }

    public void AddMediaFolder(string path)
    {
        using var conn = db.Open();
        conn.Execute("INSERT OR IGNORE INTO media_folders(id, path, added) VALUES (@id, @path, @now)", new { id = NewId(), path, now = Now() });
    }

    public bool RemoveMediaFolder(string id)
    {
        using var conn = db.Open();
        return conn.Execute("DELETE FROM media_folders WHERE id=@id", new { id }) == 1;
    }

    // Row shapes mirror column names so Dapper maps them without configuration.
#pragma warning disable IDE1006
    private sealed class GameRow
    {
        public string id { get; init; } = "";
        public string title { get; init; } = "";
        public string sort_title { get; init; } = "";
        public string? description { get; init; }
        public string? developer { get; init; }
        public string? publisher { get; init; }
        public string? release_date { get; init; }
        public string genres_json { get; init; } = "[]";
        public long favorite { get; init; }
        public long hidden { get; init; }
        public int? user_rating { get; init; }
        public string? notes { get; init; }
        public string? preferred_installation_id { get; init; }
        public string? metadata_source { get; init; }
        public string? metadata_fetched { get; init; }
        public string? palette_json { get; init; }
        public string? steam_app_id { get; init; }
        public string added { get; init; } = "";
        public string updated { get; init; } = "";
    }

    private sealed class InstallationRow
    {
        public string id { get; init; } = "";
        public string game_id { get; init; } = "";
        public string platform { get; init; } = "";
        public string platform_game_id { get; init; } = "";
        public string title { get; init; } = "";
        public string? install_path { get; init; }
        public long? size_bytes { get; init; }
        public string state { get; init; } = "";
        public string launch_kind { get; init; } = "";
        public string launch_value { get; init; } = "";
        public string? launch_args { get; init; }
        public string? launch_workdir { get; init; }
        public long client_required { get; init; }
        public string? imported_last_played { get; init; }
        public int? imported_playtime_minutes { get; init; }
        public string? steam_app_id { get; init; }
        public string process_hints_json { get; init; } = "[]";
        public long manual_link { get; init; }
        public string? user_launch_args { get; init; }
        public string first_seen { get; init; } = "";
        public string last_seen { get; init; } = "";
    }

    private sealed class SessionRow
    {
        public string id { get; init; } = "";
        public string game_id { get; init; } = "";
        public string? installation_id { get; init; }
        public string start { get; init; } = "";
        public string? end { get; init; }
        public int duration_seconds { get; init; }
        public string source { get; init; } = "";
        public string? perf_summary_json { get; init; }
    }
#pragma warning restore IDE1006
}
