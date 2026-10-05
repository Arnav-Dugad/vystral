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
    ];
}
