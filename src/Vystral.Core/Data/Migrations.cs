namespace Vystral.Core.Data;

/// <summary>
/// Ordered, append-only schema migrations. Never edit a shipped migration; add a new one.
/// Each migration runs inside its own transaction together with the schema_version bump.
/// </summary>
internal static class Migrations
{
    public static readonly IReadOnlyList<(int Version, string Name, string Sql)> All =
    [
        (1, "initial schema", """
            CREATE TABLE games (
                id                TEXT PRIMARY KEY,
                title             TEXT NOT NULL,
                sort_title        TEXT NOT NULL,
                description       TEXT,
                developer         TEXT,
                publisher         TEXT,
                release_date      TEXT,
                genres_json       TEXT NOT NULL DEFAULT '[]',
                favorite          INTEGER NOT NULL DEFAULT 0,
                hidden            INTEGER NOT NULL DEFAULT 0,
                user_rating       INTEGER,
                notes             TEXT,
                preferred_installation_id TEXT,
                metadata_source   TEXT,
                metadata_fetched  TEXT,
                palette_json      TEXT,
                steam_app_id      TEXT,
                added             TEXT NOT NULL,
                updated           TEXT NOT NULL
            );
            CREATE INDEX ix_games_sort ON games(sort_title);
            CREATE INDEX ix_games_steam ON games(steam_app_id);

            CREATE TABLE installations (
                id                 TEXT PRIMARY KEY,
                game_id            TEXT NOT NULL REFERENCES games(id),
                platform           TEXT NOT NULL,
                platform_game_id   TEXT NOT NULL,
                title              TEXT NOT NULL,
                install_path       TEXT,
                size_bytes         INTEGER,
                state              TEXT NOT NULL,
                launch_kind        TEXT NOT NULL,
                launch_value       TEXT NOT NULL,
                launch_args        TEXT,
                launch_workdir     TEXT,
                client_required    INTEGER NOT NULL DEFAULT 0,
                imported_last_played TEXT,
                imported_playtime_minutes INTEGER,
                steam_app_id       TEXT,
                process_hints_json TEXT NOT NULL DEFAULT '[]',
                manual_link        INTEGER NOT NULL DEFAULT 0,
                user_launch_args   TEXT,
                first_seen         TEXT NOT NULL,
                last_seen          TEXT NOT NULL,
                UNIQUE(platform, platform_game_id)
            );
            CREATE INDEX ix_inst_game ON installations(game_id);

            CREATE TABLE artwork (
                game_id   TEXT NOT NULL REFERENCES games(id),
                kind      TEXT NOT NULL,
                file      TEXT NOT NULL,
                source    TEXT NOT NULL,
                is_user   INTEGER NOT NULL DEFAULT 0,
                updated   TEXT NOT NULL,
                PRIMARY KEY (game_id, kind)
            );

            CREATE TABLE sessions (
                id               TEXT PRIMARY KEY,
                game_id          TEXT NOT NULL REFERENCES games(id),
                installation_id  TEXT,
                start            TEXT NOT NULL,
                end              TEXT,
                duration_seconds INTEGER NOT NULL DEFAULT 0,
                source           TEXT NOT NULL,
                perf_summary_json TEXT
            );
            CREATE INDEX ix_sessions_game ON sessions(game_id, start);
            CREATE INDEX ix_sessions_start ON sessions(start);

            CREATE TABLE perf_samples (
                session_id  TEXT NOT NULL REFERENCES sessions(id),
                t_offset_ms INTEGER NOT NULL,
                cpu_pct     REAL,
                gpu_pct     REAL,
                gpu_mem_mb  REAL,
                ram_mb      REAL,
                gpu_temp_c  REAL,
                PRIMARY KEY (session_id, t_offset_ms)
            ) WITHOUT ROWID;

            CREATE TABLE collections (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                icon       TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                rule_json  TEXT
            );
            CREATE TABLE collection_games (
                collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                game_id       TEXT NOT NULL REFERENCES games(id),
                PRIMARY KEY (collection_id, game_id)
            );

            CREATE TABLE settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE dismissed_duplicates (
                game_a TEXT NOT NULL,
                game_b TEXT NOT NULL,
                PRIMARY KEY (game_a, game_b)
            );

            CREATE TABLE audit_log (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                at      TEXT NOT NULL,
                action  TEXT NOT NULL,
                detail  TEXT
            );

            CREATE TABLE media_folders (
                id   TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                added TEXT NOT NULL
            );
            """),
        (2, "play status tracking and trailer metadata", """
            -- Play status is user data: NULL means "no status". Values are validated by the bridge
            -- (backlog | playing | beaten | completed | abandoned).
            ALTER TABLE games ADD COLUMN status TEXT;
            ALTER TABLE games ADD COLUMN status_changed TEXT;

            -- Every status change, for backlog charts and time-to-beat. No foreign key, so merging or
            -- removing a game never fails on history; readers join on games to skip orphans.
            CREATE TABLE status_history (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id TEXT NOT NULL,
                status  TEXT,
                at      TEXT NOT NULL
            );
            CREATE INDEX ix_status_history_game ON status_history(game_id, at);

            -- Optional store media per game (currently one Steam trailer). format 'none' records that
            -- the store was checked and had nothing usable, so it isn't asked again every visit.
            CREATE TABLE game_media (
                game_id      TEXT NOT NULL,
                kind         TEXT NOT NULL,
                steam_app_id TEXT NOT NULL,
                movie_id     TEXT,
                name         TEXT,
                format       TEXT NOT NULL,
                url          TEXT,
                thumbnail    TEXT,
                highlight    INTEGER NOT NULL DEFAULT 0,
                fetched      TEXT NOT NULL,
                PRIMARY KEY (game_id, kind)
            );
            """),
        (3, "steam web api: owned games and achievements cache", """
            CREATE TABLE steam_owned (
                app_id         TEXT PRIMARY KEY,
                name           TEXT NOT NULL,
                playtime_minutes INTEGER,
                last_played    TEXT,
                synced         TEXT NOT NULL
            );

            CREATE TABLE steam_achievements (
                app_id         TEXT NOT NULL,
                api_name       TEXT NOT NULL,
                display_name   TEXT NOT NULL,
                description    TEXT,
                hidden         INTEGER NOT NULL DEFAULT 0,
                icon_url       TEXT,
                icon_gray_url  TEXT,
                icon_file      TEXT,
                icon_gray_file TEXT,
                achieved       INTEGER NOT NULL DEFAULT 0,
                unlock_time    TEXT,
                global_percent REAL,
                sort_order     INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (app_id, api_name)
            ) WITHOUT ROWID;

            CREATE TABLE steam_achievement_fetch (
                app_id   TEXT PRIMARY KEY,
                steam_id TEXT NOT NULL,
                fetched  TEXT NOT NULL,
                status   TEXT NOT NULL,
                message  TEXT
            );
            """),
        (4, "insights: launch timing, GPU throttling and frame-rate samples", """
            ALTER TABLE sessions ADD COLUMN detect_ms INTEGER;
            ALTER TABLE perf_samples ADD COLUMN gpu_clock_mhz REAL;
            ALTER TABLE perf_samples ADD COLUMN throttle_flags INTEGER;
            ALTER TABLE perf_samples ADD COLUMN fps REAL;
            ALTER TABLE perf_samples ADD COLUMN frame_time_ms REAL;
            ALTER TABLE perf_samples ADD COLUMN frame_time_p99_ms REAL;
            CREATE INDEX ix_sessions_detect ON sessions(installation_id, start) WHERE detect_ms IS NOT NULL;
            """),
        (5, "data insights: GPU driver per session, background apps, memory pressure", """
            -- The GPU and driver the session ran on (read-only: NVML, else the display adapter's registry entry).
            ALTER TABLE sessions ADD COLUMN gpu_driver TEXT;
            ALTER TABLE sessions ADD COLUMN gpu_name TEXT;
            -- System memory load (percent, GlobalMemoryStatusEx) at the background-app snapshots.
            ALTER TABLE sessions ADD COLUMN mem_load_avg REAL;
            ALTER TABLE sessions ADD COLUMN mem_load_max REAL;
            -- How many background-app snapshots were taken (about one every 30 s).
            ALTER TABLE sessions ADD COLUMN bg_snapshots INTEGER;
            CREATE INDEX ix_sessions_driver ON sessions(game_id, gpu_driver) WHERE gpu_driver IS NOT NULL;

            -- Other apps that were among the heaviest while a session ran, aggregated per executable
            -- file name (no paths, no window titles, no command lines). Deleted with the session.
            CREATE TABLE session_background_apps (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                name       TEXT NOT NULL,
                samples    INTEGER NOT NULL,
                avg_mb     REAL,
                max_mb     REAL,
                avg_cpu    REAL,
                PRIMARY KEY (session_id, name)
            ) WITHOUT ROWID;

            -- Executable names the user chose to leave out of the background-app report.
            CREATE TABLE hidden_background_apps (
                name  TEXT PRIMARY KEY,
                added TEXT NOT NULL
            ) WITHOUT ROWID;
            """),
        (6, "data sources: cross-store IDs, enrichment provenance, provider caches, anti-cheat", """
            -- Cross-store identity from Wikidata (CC0), keyed by the store ID it was looked up with
            -- ('steam' appid or 'gog' product ID). wikidata_id NULL with ids_json '{}' records that
            -- Wikidata had no item, so it isn't asked again until the row expires.
            CREATE TABLE external_ids (
                key_kind    TEXT NOT NULL,
                key_value   TEXT NOT NULL,
                wikidata_id TEXT,
                label       TEXT,
                ids_json    TEXT NOT NULL DEFAULT '{}',
                fetched     TEXT NOT NULL,
                PRIMARY KEY (key_kind, key_value)
            ) WITHOUT ROWID;

            -- Which source filled each game field (description, genres, release_date, ...). A field a
            -- source filled is never overwritten by another source; 'user' marks a field the user set.
            CREATE TABLE game_field_sources (
                game_id      TEXT NOT NULL,
                field        TEXT NOT NULL,
                source       TEXT NOT NULL,
                source_id    TEXT,
                match_method TEXT,
                confidence   REAL,
                updated      TEXT NOT NULL,
                PRIMARY KEY (game_id, field)
            ) WITHOUT ROWID;

            -- Facts from opt-in providers (IGDB, RAWG) that have no column in games: themes, modes,
            -- ratings, time to beat, franchises, similar games. Validated and clamped before storage.
            -- matched=0 records a lookup that found no confident match (retried after it expires).
            CREATE TABLE game_enrichment (
                game_id      TEXT NOT NULL,
                source       TEXT NOT NULL,
                source_id    TEXT,
                match_method TEXT,
                confidence   REAL,
                matched      INTEGER NOT NULL DEFAULT 1,
                data_json    TEXT NOT NULL DEFAULT '{}',
                url          TEXT,
                fetched      TEXT NOT NULL,
                PRIMARY KEY (game_id, source)
            ) WITHOUT ROWID;

            -- Small parsed answers from providers (prices, Steam Deck reports), with an expiry.
            CREATE TABLE provider_cache (
                provider  TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                body_json TEXT NOT NULL,
                fetched   TEXT NOT NULL,
                expires   TEXT NOT NULL,
                PRIMARY KEY (provider, cache_key)
            ) WITHOUT ROWID;
            CREATE INDEX ix_provider_cache_expires ON provider_cache(expires);

            -- AreWeAntiCheatYet's public dataset (MIT), one row per store ID it lists.
            CREATE TABLE anticheat_games (
                store           TEXT NOT NULL,
                store_id        TEXT NOT NULL,
                name            TEXT NOT NULL,
                slug            TEXT,
                status          TEXT NOT NULL,
                anticheats_json TEXT NOT NULL DEFAULT '[]',
                reference       TEXT,
                date_changed    TEXT,
                PRIMARY KEY (store, store_id)
            ) WITHOUT ROWID;
            """),
        (7, "cloud play: cached cloud catalogues and Store product identities", """
            -- Track O (opt-in): the last good copy of each cloud catalogue for the user's market, trimmed to what
            -- matching and launching need. Replaced as a whole on each refresh (at most daily); never shipped.
            -- service 'gfn' | 'xbox'; entry_id = GeForce NOW game UUID | Store product ID; launch_key = cmsId | product ID.
            CREATE TABLE cloud_catalog (
                service    TEXT NOT NULL,
                market     TEXT NOT NULL,
                entry_id   TEXT NOT NULL,
                launch_key TEXT,
                title      TEXT NOT NULL,
                play_type  TEXT,
                premium    INTEGER NOT NULL DEFAULT 0,
                links_json TEXT NOT NULL DEFAULT '[]',
                PRIMARY KEY (service, market, entry_id)
            ) WITHOUT ROWID;

            -- Store product ID -> package family name and title (Microsoft's display catalogue), so Xbox copies can be
            -- matched exactly. pfn NULL records a console-only product. Refreshed after 60 days.
            CREATE TABLE cloud_products (
                product_id TEXT PRIMARY KEY,
                pfn        TEXT,
                title      TEXT,
                fetched    TEXT NOT NULL
            ) WITHOUT ROWID;
            """),
        (8, "play data: display per session, controller battery history", """
            -- Track Y: the primary display a session started on (read-only EnumDisplaySettings / DisplayConfig).
            -- NULL when it wasn't recorded (older sessions, metrics off, or Windows didn't say).
            ALTER TABLE sessions ADD COLUMN display_width INTEGER;
            ALTER TABLE sessions ADD COLUMN display_height INTEGER;
            ALTER TABLE sessions ADD COLUMN display_hz INTEGER;
            ALTER TABLE sessions ADD COLUMN display_hdr INTEGER;

            -- Controller battery readings, sampled sparsely (about every 10 minutes while connected, plus on a
            -- change). pad is an opaque hash of the controller's device id; name is what Windows calls it.
            -- Pruned after 90 days. Not session data, so deleting tracked history leaves it alone.
            CREATE TABLE controller_battery (
                pad      TEXT NOT NULL,
                at       TEXT NOT NULL,
                name     TEXT NOT NULL,
                percent  INTEGER NOT NULL,
                charging INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (pad, at)
            ) WITHOUT ROWID;
            CREATE INDEX ix_controller_battery_at ON controller_battery(at);
            """),
    ];
}
