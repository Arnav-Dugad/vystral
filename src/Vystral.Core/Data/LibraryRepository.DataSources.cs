using System.Globalization;
using System.Text.Json;
using Dapper;
using Vystral.Core.Domain;

namespace Vystral.Core.Data;

/// <summary>Fields an opt-in provider may fill when the game doesn't have them yet.</summary>
public sealed record EnrichedFields(string? Description, string? Developer, string? Publisher, string? ReleaseDate, IReadOnlyList<string> Genres);

/// <summary>One cached cross-store identity row (Wikidata).</summary>
public sealed record ExternalIdRow(string KeyKind, string KeyValue, string? WikidataId, string? Label, IReadOnlyDictionary<string, string> Ids, DateTimeOffset Fetched);

/// <summary>One stored enrichment answer from an opt-in provider.</summary>
public sealed record EnrichmentRow(string Source, string? SourceId, string? MatchMethod, double? Confidence, bool Matched, string DataJson, string? Url, DateTimeOffset Fetched);

/// <summary>One AreWeAntiCheatYet entry.</summary>
public sealed record AntiCheatRow(string Store, string StoreId, string Name, string? Slug, string Status, IReadOnlyList<string> AntiCheats, string? Reference, string? DateChanged);

/// <summary>Evidence of when a game was (at the latest) in the library, for the value timeline.</summary>
public sealed record LibraryValueSource(string GameId, string Title, bool Hidden, string? SteamAppId, IReadOnlyList<string> Platforms,
    DateTimeOffset Added, DateTimeOffset? FirstSession, DateTimeOffset? FirstAchievement, DateTimeOffset? StoreLastPlayed);

/// <summary>Track I: data sources (Wikidata identity, IGDB/RAWG enrichment, price and compatibility caches, anti-cheat).</summary>
public sealed partial class LibraryRepository
{
    // ---------- Provider cache (prices, Steam Deck reports) ----------

    public (string Body, DateTimeOffset Fetched, bool Fresh)? GetProviderCache(string provider, string key)
    {
        using var conn = db.Open();
        var row = conn.QuerySingleOrDefault<(string Body, string Fetched, string Expires)?>(
            "SELECT body_json, fetched, expires FROM provider_cache WHERE provider=@provider AND cache_key=@key", new { provider, key });
        if (row is not { } r || !DateTimeOffset.TryParse(r.Fetched, CultureInfo.InvariantCulture, out var fetched) ||
            !DateTimeOffset.TryParse(r.Expires, CultureInfo.InvariantCulture, out var expires)) return null;
        return (r.Body, fetched, expires > DateTimeOffset.UtcNow);
    }

    public void SetProviderCache(string provider, string key, string bodyJson, TimeSpan ttl)
    {
        using var conn = db.Open();
        var now = DateTimeOffset.UtcNow;
        conn.Execute("""
            INSERT INTO provider_cache(provider, cache_key, body_json, fetched, expires) VALUES (@provider, @key, @bodyJson, @fetched, @expires)
            ON CONFLICT(provider, cache_key) DO UPDATE SET body_json=excluded.body_json, fetched=excluded.fetched, expires=excluded.expires
            """, new { provider, key, bodyJson, fetched = now.ToString("O"), expires = (now + ttl).ToString("O") });
    }

    public int ClearProviderCache(string provider)
    {
        using var conn = db.Open();
        return conn.Execute("DELETE FROM provider_cache WHERE provider=@provider", new { provider });
    }

    /// <summary>All cached bodies of one provider whose key is in <paramref name="keys"/> (fresh or not).</summary>
    public IReadOnlyDictionary<string, (string Body, DateTimeOffset Fetched, bool Fresh)> GetProviderCacheMany(string provider, IReadOnlyCollection<string> keys)
    {
        var result = new Dictionary<string, (string, DateTimeOffset, bool)>(StringComparer.Ordinal);
        if (keys.Count == 0) return result;
        using var conn = db.Open();
        var now = DateTimeOffset.UtcNow;
        foreach (var chunk in keys.Chunk(400))
        {
            foreach (var r in conn.Query<(string Key, string Body, string Fetched, string Expires)>(
                         "SELECT cache_key, body_json, fetched, expires FROM provider_cache WHERE provider=@provider AND cache_key IN @chunk",
                         new { provider, chunk }))
            {
                if (DateTimeOffset.TryParse(r.Fetched, CultureInfo.InvariantCulture, out var f) && DateTimeOffset.TryParse(r.Expires, CultureInfo.InvariantCulture, out var e))
                    result[r.Key] = (r.Body, f, e > now);
            }
        }
        return result;
    }

    // ---------- Cross-store identity (Wikidata) ----------

    public ExternalIdRow? GetExternalIds(string keyKind, string keyValue)
    {
        using var conn = db.Open();
        var r = conn.QuerySingleOrDefault<(string Kind, string Value, string? Qid, string? Label, string Ids, string Fetched)?>(
            "SELECT key_kind, key_value, wikidata_id, label, ids_json, fetched FROM external_ids WHERE key_kind=@keyKind AND key_value=@keyValue",
            new { keyKind, keyValue });
        return r is { } row ? ToExternal(row) : null;
    }

    public IReadOnlyList<ExternalIdRow> AllExternalIds(string keyKind)
    {
        using var conn = db.Open();
        return conn.Query<(string Kind, string Value, string? Qid, string? Label, string Ids, string Fetched)>(
            "SELECT key_kind, key_value, wikidata_id, label, ids_json, fetched FROM external_ids WHERE key_kind=@keyKind", new { keyKind })
            .Select(ToExternal).ToList();
    }

    private static ExternalIdRow ToExternal((string Kind, string Value, string? Qid, string? Label, string Ids, string Fetched) r)
    {
        Dictionary<string, string> ids;
        try { ids = JsonSerializer.Deserialize<Dictionary<string, string>>(r.Ids) ?? []; }
        catch (JsonException) { ids = []; }
        DateTimeOffset.TryParse(r.Fetched, CultureInfo.InvariantCulture, out var fetched);
        return new ExternalIdRow(r.Kind, r.Value, r.Qid, r.Label, ids, fetched);
    }

    public void UpsertExternalIds(string keyKind, string keyValue, string? wikidataId, string? label, IReadOnlyDictionary<string, string> ids)
    {
        using var conn = db.Open();
        conn.Execute("""
            INSERT INTO external_ids(key_kind, key_value, wikidata_id, label, ids_json, fetched) VALUES (@keyKind, @keyValue, @wikidataId, @label, @ids, @now)
            ON CONFLICT(key_kind, key_value) DO UPDATE SET wikidata_id=excluded.wikidata_id, label=excluded.label, ids_json=excluded.ids_json, fetched=excluded.fetched
            """, new { keyKind, keyValue, wikidataId, label, ids = JsonSerializer.Serialize(ids), now = Now() });
    }

    /// <summary>
    /// Steam appids in the library whose identity row is missing or older than its TTL
    /// (<paramref name="foundTtl"/> for rows with an item, <paramref name="missingTtl"/> for "no item").
    /// </summary>
    public IReadOnlyList<string> SteamAppIdsNeedingIdentity(TimeSpan foundTtl, TimeSpan missingTtl, int limit)
    {
        using var conn = db.Open();
        var now = DateTimeOffset.UtcNow;
        var rows = conn.Query<(string AppId, string? Qid, string? Fetched)>("""
            SELECT DISTINCT g.steam_app_id, e.wikidata_id, e.fetched FROM games g
            LEFT JOIN external_ids e ON e.key_kind='steam' AND e.key_value=g.steam_app_id
            WHERE g.steam_app_id IS NOT NULL
            ORDER BY g.favorite DESC, g.sort_title
            """).ToList();
        return rows.Where(r => IsAppId(r.AppId) && (r.Fetched is null || !DateTimeOffset.TryParse(r.Fetched, CultureInfo.InvariantCulture, out var f) ||
                                                    now - f > (r.Qid is null ? missingTtl : foundTtl)))
            .Select(r => r.AppId).Distinct().Take(limit).ToList();
    }

    /// <summary>
    /// Pairs of separate games that Wikidata lists as the same work (a Steam game and a GOG game
    /// linked by one item). Only ever a suggestion; nothing is merged automatically.
    /// </summary>
    public IReadOnlyList<(string GameIdA, string GameIdB, string Explanation)> WikidataDuplicatePairs()
    {
        using var conn = db.Open();
        var steam = conn.Query<(string GameId, string AppId, string? Ids)>("""
            SELECT g.id, g.steam_app_id, e.ids_json FROM games g
            JOIN external_ids e ON e.key_kind='steam' AND e.key_value=g.steam_app_id
            WHERE e.wikidata_id IS NOT NULL
            """).ToList();
        if (steam.Count == 0) return [];
        var gog = conn.Query<(string GameId, string ProductId)>(
            "SELECT game_id, platform_game_id FROM installations WHERE platform='gog'").ToList();
        var byGog = gog.GroupBy(x => x.ProductId).ToDictionary(x => x.Key, x => x.Select(y => y.GameId).ToHashSet());
        var result = new List<(string, string, string)>();
        foreach (var s in steam)
        {
            Dictionary<string, string>? ids;
            try { ids = JsonSerializer.Deserialize<Dictionary<string, string>>(s.Ids ?? "{}"); }
            catch (JsonException) { continue; }
            if (ids is null || !ids.TryGetValue("gogId", out var gogId) || !byGog.TryGetValue(gogId, out var gameIds)) continue;
            foreach (var other in gameIds.Where(g => g != s.GameId))
            {
                var (a, b) = string.CompareOrdinal(s.GameId, other) < 0 ? (s.GameId, other) : (other, s.GameId);
                result.Add((a, b, "Wikidata lists the Steam and GOG versions as the same game. Merge them only if that’s right for you."));
            }
        }
        return result.Distinct().ToList();
    }

    // ---------- Enrichment (IGDB, RAWG) ----------

    public IReadOnlyList<EnrichmentRow> GetEnrichment(string gameId)
    {
        using var conn = db.Open();
        return conn.Query<(string Source, string? SourceId, string? Method, double? Confidence, long Matched, string Data, string? Url, string Fetched)>(
                "SELECT source, source_id, match_method, confidence, matched, data_json, url, fetched FROM game_enrichment WHERE game_id=@gameId", new { gameId })
            .Select(r => new EnrichmentRow(r.Source, r.SourceId, r.Method, r.Confidence, r.Matched != 0, r.Data, r.Url,
                DateTimeOffset.TryParse(r.Fetched, CultureInfo.InvariantCulture, out var f) ? f : DateTimeOffset.MinValue))
            .ToList();
    }

    public void SetEnrichment(string gameId, string source, string? sourceId, string? matchMethod, double? confidence, bool matched, string dataJson, string? url)
    {
        using var conn = db.Open();
        conn.Execute("""
            INSERT INTO game_enrichment(game_id, source, source_id, match_method, confidence, matched, data_json, url, fetched)
            VALUES (@gameId, @source, @sourceId, @matchMethod, @confidence, @matched, @dataJson, @url, @now)
            ON CONFLICT(game_id, source) DO UPDATE SET source_id=excluded.source_id, match_method=excluded.match_method, confidence=excluded.confidence,
              matched=excluded.matched, data_json=excluded.data_json, url=excluded.url, fetched=excluded.fetched
            """, new { gameId, source, sourceId, matchMethod, confidence, matched, dataJson, url, now = Now() });
    }

    /// <summary>Games without a fresh answer from <paramref name="source"/> (no-match answers are retried after <paramref name="missTtl"/>).</summary>
    public IReadOnlyList<(string GameId, string Title, string? SteamAppId, string? ReleaseDate)> GamesNeedingEnrichment(string source, TimeSpan ttl, TimeSpan missTtl, int limit)
    {
        using var conn = db.Open();
        var now = DateTimeOffset.UtcNow;
        var rows = conn.Query<(string Id, string Title, string? AppId, string? Release, long? Matched, string? Fetched)>("""
            SELECT g.id, g.title, g.steam_app_id, g.release_date, e.matched, e.fetched FROM games g
            LEFT JOIN game_enrichment e ON e.game_id=g.id AND e.source=@source
            WHERE g.hidden = 0
            ORDER BY g.favorite DESC, (e.fetched IS NULL) DESC, g.added DESC
            """, new { source }).ToList();
        return rows.Where(r => r.Fetched is null || !DateTimeOffset.TryParse(r.Fetched, CultureInfo.InvariantCulture, out var f) ||
                               now - f > (r.Matched == 0 ? missTtl : ttl))
            .Take(limit).Select(r => (r.Id, r.Title, r.AppId, r.Release)).ToList();
    }

    public IReadOnlyDictionary<string, string> GetFieldSources(string gameId)
    {
        using var conn = db.Open();
        return conn.Query<(string Field, string Source)>("SELECT field, source FROM game_field_sources WHERE game_id=@gameId", new { gameId })
            .ToDictionary(r => r.Field, r => r.Source);
    }

    public static readonly string[] EnrichableFields = ["description", "developer", "publisher", "release_date", "genres"];

    /// <summary>
    /// Fills only fields the game doesn't have yet (and that the user hasn't set), recording the
    /// source of each filled field. Returns the names of the fields that were filled.
    /// </summary>
    public IReadOnlyList<string> ApplyEnrichedFields(string gameId, string source, string? sourceId, string matchMethod, double confidence, EnrichedFields f)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var row = conn.QuerySingleOrDefault<(string? Description, string? Developer, string? Publisher, string? Release, string Genres)?>(
            "SELECT description, developer, publisher, release_date, genres_json FROM games WHERE id=@gameId", new { gameId }, tx);
        if (row is not { } g) return [];
        var userFields = conn.Query<string>("SELECT field FROM game_field_sources WHERE game_id=@gameId AND source='user'", new { gameId }, tx).ToHashSet();
        var filled = new List<string>();
        var now = Now();

        void Fill(string field, string column, string? current, string? value)
        {
            if (!string.IsNullOrWhiteSpace(current) || string.IsNullOrWhiteSpace(value) || userFields.Contains(field)) return;
            conn.Execute($"UPDATE games SET {column}=@value, updated=@now WHERE id=@gameId AND ({column} IS NULL OR {column}='')", new { value, now, gameId }, tx);
            filled.Add(field);
        }

        Fill("description", "description", g.Description, f.Description);
        Fill("developer", "developer", g.Developer, f.Developer);
        Fill("publisher", "publisher", g.Publisher, f.Publisher);
        Fill("release_date", "release_date", g.Release, f.ReleaseDate);
        if ((g.Genres is "[]" or "") && f.Genres.Count > 0 && !userFields.Contains("genres"))
        {
            conn.Execute("UPDATE games SET genres_json=@genres, updated=@now WHERE id=@gameId", new { genres = JsonSerializer.Serialize(f.Genres), now, gameId }, tx);
            filled.Add("genres");
        }
        foreach (var field in filled)
            conn.Execute("""
                INSERT INTO game_field_sources(game_id, field, source, source_id, match_method, confidence, updated)
                VALUES (@gameId, @field, @source, @sourceId, @matchMethod, @confidence, @now)
                ON CONFLICT(game_id, field) DO UPDATE SET source=excluded.source, source_id=excluded.source_id, match_method=excluded.match_method,
                  confidence=excluded.confidence, updated=excluded.updated
                WHERE game_field_sources.source <> 'user'
                """, new { gameId, field, source, sourceId, matchMethod, confidence, now }, tx);
        tx.Commit();
        return filled;
    }

    // ---------- Anti-cheat (AreWeAntiCheatYet) ----------

    public void ReplaceAntiCheat(IReadOnlyList<AntiCheatRow> rows)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        conn.Execute("DELETE FROM anticheat_games", transaction: tx);
        conn.Execute("""
            INSERT OR REPLACE INTO anticheat_games(store, store_id, name, slug, status, anticheats_json, reference, date_changed)
            VALUES (@Store, @StoreId, @Name, @Slug, @Status, @Json, @Reference, @DateChanged)
            """, rows.Select(r => new { r.Store, r.StoreId, r.Name, r.Slug, r.Status, Json = JsonSerializer.Serialize(r.AntiCheats), r.Reference, r.DateChanged }), tx);
        tx.Commit();
    }

    public int AntiCheatCount()
    {
        using var conn = db.Open();
        return conn.ExecuteScalar<int>("SELECT COUNT(*) FROM anticheat_games");
    }

    public AntiCheatRow? GetAntiCheat(string store, string storeId)
    {
        using var conn = db.Open();
        var r = conn.QuerySingleOrDefault<(string Store, string StoreId, string Name, string? Slug, string Status, string Json, string? Reference, string? Date)?>(
            "SELECT store, store_id, name, slug, status, anticheats_json, reference, date_changed FROM anticheat_games WHERE store=@store AND store_id=@storeId",
            new { store, storeId });
        return r is { } x ? ToAntiCheat(x) : null;
    }

    /// <summary>Anti-cheat entries for every game in the library with a Steam appid.</summary>
    public IReadOnlyList<(string GameId, AntiCheatRow Row)> AntiCheatForLibrary()
    {
        using var conn = db.Open();
        return conn.Query<(string GameId, string Store, string StoreId, string Name, string? Slug, string Status, string Json, string? Reference, string? Date)>("""
            SELECT g.id, a.store, a.store_id, a.name, a.slug, a.status, a.anticheats_json, a.reference, a.date_changed
            FROM games g JOIN anticheat_games a ON a.store='steam' AND a.store_id=g.steam_app_id
            """).Select(r => (r.GameId, ToAntiCheat((r.Store, r.StoreId, r.Name, r.Slug, r.Status, r.Json, r.Reference, r.Date)))).ToList();
    }

    private static AntiCheatRow ToAntiCheat((string Store, string StoreId, string Name, string? Slug, string Status, string Json, string? Reference, string? Date) r)
    {
        List<string> names;
        try { names = JsonSerializer.Deserialize<List<string>>(r.Json) ?? []; }
        catch (JsonException) { names = []; }
        return new AntiCheatRow(r.Store, r.StoreId, r.Name, r.Slug, r.Status, names, r.Reference, r.Date);
    }

    // ---------- Artwork chosen by the user ----------

    /// <summary>Kinds of artwork the user chose for a game, with their source.</summary>
    public IReadOnlyDictionary<string, string> UserArtwork(string gameId)
    {
        using var conn = db.Open();
        return conn.Query<(string Kind, string Source)>("SELECT kind, source FROM artwork WHERE game_id=@gameId AND is_user=1", new { gameId })
            .ToDictionary(r => r.Kind, r => r.Source);
    }

    /// <summary>Forgets user-chosen artwork of one kind so store/default art can take its place again.</summary>
    public bool ResetUserArtwork(string gameId, ArtworkKind kind)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        var n = conn.Execute("DELETE FROM artwork WHERE game_id=@gameId AND kind=@kind AND is_user=1",
            new { gameId, kind = kind.ToString().ToLowerInvariant() }, tx);
        if (n > 0) Audit(conn, tx, "game.resetArtwork", $"{gameId} {kind}");
        tx.Commit();
        return n > 0;
    }

    // ---------- Library value timeline ----------

    public IReadOnlyList<LibraryValueSource> LibraryValueSources()
    {
        using var conn = db.Open();
        var games = conn.Query<(string Id, string Title, long Hidden, string? AppId, string Added)>("SELECT id, title, hidden, steam_app_id, added FROM games").ToList();
        var platforms = conn.Query<(string GameId, string Platform)>("SELECT DISTINCT game_id, platform FROM installations").ToLookup(r => r.GameId, r => r.Platform);
        var lastPlayed = conn.Query<(string GameId, string Last)>("SELECT game_id, imported_last_played FROM installations WHERE imported_last_played IS NOT NULL")
            .ToLookup(r => r.GameId, r => r.Last);
        var sessions = conn.Query<(string GameId, string Start)>("SELECT game_id, MIN(start) FROM sessions WHERE source='tracked' GROUP BY game_id")
            .ToDictionary(r => r.GameId, r => r.Start);
        var achievements = conn.Query<(string AppId, string Unlock)>(
            "SELECT app_id, unlock_time FROM steam_achievements WHERE achieved=1 AND unlock_time IS NOT NULL").ToLookup(r => r.AppId, r => r.Unlock);

        static DateTimeOffset? Earliest(IEnumerable<string> values)
        {
            DateTimeOffset? best = null;
            foreach (var v in values)
                if (DateTimeOffset.TryParse(v, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) && d.Year >= 1990 && (best is null || d < best)) best = d;
            return best;
        }

        return games.Select(g => new LibraryValueSource(
            g.Id, g.Title, g.Hidden != 0, g.AppId, platforms[g.Id].ToList(),
            DateTimeOffset.TryParse(g.Added, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var added) ? added : DateTimeOffset.UtcNow,
            sessions.TryGetValue(g.Id, out var s) ? Earliest([s]) : null,
            g.AppId is null ? null : Earliest(achievements[g.AppId]),
            Earliest(lastPlayed[g.Id]))).ToList();
    }
}
