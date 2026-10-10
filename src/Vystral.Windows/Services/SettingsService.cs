using System.Text.Json;
using System.Text.Json.Nodes;
using Vystral.Core.Data;

namespace Vystral.Windows.Services;

/// <summary>
/// Typed, validated application settings. Only keys defined here can be read or written
/// through the bridge, and every value is checked against its definition before storage.
/// </summary>
public sealed class SettingsService
{
    private abstract record Def(string Key, JsonNode Default)
    {
        public abstract bool Validate(JsonNode? value);
    }

    private sealed record BoolDef(string Key, bool D) : Def(Key, JsonValue.Create(D))
    {
        public override bool Validate(JsonNode? v) => v is JsonValue jv && jv.TryGetValue<bool>(out _);
    }

    private sealed record EnumDef(string Key, string D, params string[] Allowed) : Def(Key, JsonValue.Create(D))
    {
        public override bool Validate(JsonNode? v) => v is JsonValue jv && jv.TryGetValue<string>(out var s) && Allowed.Contains(s);
    }

    private sealed record NumberDef(string Key, double D, double Min, double Max) : Def(Key, JsonValue.Create(D))
    {
        public override bool Validate(JsonNode? v) => v is JsonValue jv && jv.TryGetValue<double>(out var d) && d >= Min && d <= Max;
    }

    private sealed record StringDef(string Key, string D, int MaxLength, string? Pattern = null) : Def(Key, JsonValue.Create(D))
    {
        public override bool Validate(JsonNode? v) =>
            v is JsonValue jv && jv.TryGetValue<string>(out var s) && s.Length <= MaxLength &&
            (Pattern is null || System.Text.RegularExpressions.Regex.IsMatch(s, Pattern));
    }

    private sealed record PlatformMapDef(string Key) : Def(Key, new JsonObject())
    {
        public override bool Validate(JsonNode? v) =>
            v is JsonObject o && o.Count <= 16 && o.All(p => p.Key.Length <= 16 && p.Value is JsonValue jv && jv.TryGetValue<bool>(out _));
    }

    private static readonly Def[] Definitions =
    [
        new EnumDef("appearance.theme", "obsidian", "obsidian", "oled", "light", "contrast"),
        new EnumDef("appearance.accent", "auto", "auto", "violet", "blue", "cyan", "rose", "amber", "emerald", "system"),
        new BoolDef("appearance.livingCanvas", true),
        new NumberDef("appearance.canvasIntensity", 0.7, 0, 1),
        new EnumDef("appearance.quality", "auto", "auto", "high", "balanced", "low"),
        new NumberDef("appearance.gridSize", 180, 120, 280),
        new EnumDef("motion.reduce", "system", "system", "on", "off"),
        new BoolDef("startup.intro", true),
        new BoolDef("startup.immersive", false),
        new BoolDef("immersive.attract", true),
        new NumberDef("immersive.attractMinutes", 3, 1, 30),
        new BoolDef("launch.cinematic", true),
        new BoolDef("launch.minimizeOnStart", true),
        new BoolDef("launch.restoreOnExit", true),
        new BoolDef("performance.collectMetrics", true),
        new BoolDef("pulse.enabled", false),
        new BoolDef("library.fetchMetadata", true),
        new BoolDef("library.fetchArtwork", true),
        new PlatformMapDef("library.platformsEnabled"),
        new BoolDef("ai.enabled", false),
        new StringDef("ai.model", "qwen3:4b", 80, @"^[a-zA-Z0-9._:\-/]+\z"),
        new BoolDef("updates.autoCheck", true),
        new BoolDef("updates.autoDownload", true),
        new BoolDef("controller.enabled", true),
        new BoolDef("controller.vibration", false),
        new BoolDef("sounds.enabled", false),
        new NumberDef("sounds.volume", 0.4, 0, 1),
        new BoolDef("onboarding.completed", false),
        new BoolDef("privacy.localOnly", false),
        new BoolDef("moments.enabled", false),
        // Track C: data saver and trailers.
        new BoolDef("dataSaver.enabled", false),
        new BoolDef("dataSaver.onMetered", true),
        new BoolDef("trailers.autoplay", true),
        // Track A: Steam Web API (the key itself lives in Windows Credential Manager, never here).
        new BoolDef("steam.webApi.backgroundAchievements", true),
        // Track B: frame-rate capture (opt-in), summon hotkey, Windows notifications.
        new BoolDef("fps.captureEnabled", false),
        new BoolDef("hotkey.enabled", true),
        new StringDef("hotkey.summon", Hotkey.Default, 40, Hotkey.Pattern),
        new BoolDef("notifications.enabled", true),
        new BoolDef("notifications.sessions", true),
        new BoolDef("notifications.updates", true),
        new BoolDef("notifications.installs", true),
        new BoolDef("notifications.thermal", true),
        new BoolDef("notifications.onlyInBackground", true),
        // Track F: achievement unlock notifications, background-app snapshots during sessions.
        new BoolDef("notifications.achievements", true),
        new BoolDef("performance.backgroundApps", true),
        // Track E: the Living Canvas follows a playing hero trailer's colours.
        new BoolDef("canvas.followTrailer", true),
        // Track K: Home live tiles (Steam micro-trailers), ambient mood sound (off by default).
        new BoolDef("home.liveTiles", true),
        new BoolDef("sound.ambient", false),
        new NumberDef("sound.ambientVolume", 0.35, 0, 1),
        // Track I: third-party data sources (user keys live in Windows Credential Manager, never here).
        new BoolDef("dataSources.enrichment", true),
        new BoolDef("dataSources.cheapshark", true),
        new BoolDef("dataSources.wikidata", true),
        new BoolDef("dataSources.steamDeck", true),
        new BoolDef("dataSources.antiCheat", true),
        new BoolDef("dataSources.storePrices", true),
        new StringDef("dataSources.priceCountry", "US", 2, "^[A-Z]{2}$"),
        // Track H: notice games started outside VYSTRAL, and keep tracking them while it is closed (opt-in).
        new BoolDef("tracking.background", false),
        // Track M: anti-cheat notes before launch and on game pages; IGDB time-to-beat bars on library cards.
        new BoolDef("launch.antiCheatNotes", true),
        new BoolDef("library.timeToBeat", true),
        // Track L: Immersive Mode — the cinematic mode switch, couch text scale and TV safe area, the one-time tour.
        new BoolDef("immersive.cinematicSwitch", true),
        new NumberDef("immersive.scale", 1, 1, 1.3),
        new NumberDef("immersive.safeArea", 0, 0, 0.06),
        new BoolDef("immersive.tourDone", false),
        // Track S: the docked on-screen keyboard for text fields when desktop mode is driven by a controller.
        new BoolDef("controller.onScreenKeyboard", true),
        // Track P: friends playing now on Home (opt-in, reads friends' public Steam status), low-disk-space-for-updates notifications.
        new BoolDef("home.friendsActivity", false),
        new BoolDef("notifications.diskSpace", true),
        // Track O: cloud play (opt-in, off by default) — services, market override, GeForce NOW membership, meter reset day, browser.
        new BoolDef("cloud.enabled", false),
        new BoolDef("cloud.gfn", true),
        new BoolDef("cloud.xbox", true),
        new StringDef("cloud.market", "", 2, "^([A-Z]{2})?$"),
        new EnumDef("cloud.gfnPlan", "none", "none", "free", "performance", "ultimate", "daypass"),
        new NumberDef("cloud.resetDay", 1, 1, 31),
        new EnumDef("cloud.browser", "edge", "edge", "default"),
        // Track T: voice-over and captions (Windows' local voices only; off by default), controller glyph family, the Immersive grid's sort.
        new BoolDef("voiceover.enabled", false),
        new BoolDef("voiceover.captionsOnly", false),
        new StringDef("voiceover.voice", "", 200, @"^[^\x00-\x1F\x7F]*\z"),
        new NumberDef("voiceover.rate", 1, 0.5, 2),
        new NumberDef("voiceover.volume", 1, 0, 1),
        new EnumDef("controller.glyphs", "auto", "auto", "xbox", "playstation", "nintendo"),
        new EnumDef("immersive.librarySort", "az", "az", "recent", "played", "added"),
        // Track Y: controller battery history (local only) and the opt-in energy estimate.
        new BoolDef("controller.batteryHistory", true),
        new BoolDef("energy.enabled", false),
        new NumberDef("energy.watts", 0, 0, 3000),
        new NumberDef("energy.price", 0, 0, 1000),
        new StringDef("energy.currency", "", 3, "^([A-Z]{3})?$"),
        // Track X: save locations from PCGamingWiki and Steam Workshop titles (both opt-in, keyless); the Home card for new health issues.
        new BoolDef("dataSources.pcgamingwiki", false),
        new BoolDef("dataSources.workshopTitles", false),
        new BoolDef("home.healthNews", true),
        // Track V: your subscriptions (stored here only), the opt-in public Game Pass lists, cloud services shown,
        // "leaving soon" notifications, what you pay (optional), GeForce NOW queue alerts.
        new StringDef("subs.owned", "", 200, @"^([a-z][a-z0-9-]{1,20}(,[a-z][a-z0-9-]{1,20}){0,11})?\z"),
        new BoolDef("subs.asked", false),
        new BoolDef("subs.catalog", false),
        new BoolDef("subs.cloudShowAll", false),
        new BoolDef("subs.leavingNotify", true),
        new NumberDef("subs.price", 0, 0, 1000),
        new StringDef("subs.currency", "", 3, @"^([A-Z]{3})?\z"),
        new BoolDef("cloud.queueAlerts", true),
        new NumberDef("cloud.queueAlertAt", 5, 1, 50),
        // Track U: universal search also asks Steam's store search, Wikidata and (with your keys) IGDB and RAWG as you type.
        new BoolDef("discover.searchOnline", true),
        // Track C3: Discover's Steam store shelves (trending, deals, new, coming soon, free to play; genre browsing). Opt-in: undocumented store lists.
        new BoolDef("discover.storeShelves", false),
        // Track W: wishlist sync (opt-in), its notifications, friends' recent games on game pages (opt-in), news and patch notes.
        new BoolDef("wishlist.sync", false),
        new BoolDef("notifications.wishlist", true),
        new BoolDef("friends.gameHistory", false),
        new BoolDef("news.patchNotes", true),
        // Track Z: your own Immersive Home row order (row ids joined by '|'; '' = automatic), the screensaver's big clock and its trailer loops.
        new StringDef("immersive.rowOrder", "", 2000, @"^[A-Za-z0-9:_|\-]*\z"),
        new BoolDef("immersive.attractClock", false),
        new BoolDef("immersive.attractTrailers", true),
        // Track AA: the monthly quiet database compaction (VACUUM), only when the PC is idle and plugged in.
        new BoolDef("data.autoCompact", true),
        // Track C4: Steam's review snapshot and community tags on game pages (and tags as Library filters); both also need "Fetch game details".
        new BoolDef("dataSources.steamReviews", true),
        new BoolDef("dataSources.steamTags", true),
    ];

    private readonly LibraryRepository _repo;
    private readonly Dictionary<string, Def> _defs = Definitions.ToDictionary(d => d.Key);
    private readonly Lock _lock = new();
    /// <summary>Serializes writers (database + cache); readers only take <see cref="_lock"/>.</summary>
    private readonly Lock _writeLock = new();
    private Dictionary<string, JsonNode> _values = [];

    public event Action<string>? Changed;

    public SettingsService(LibraryRepository repo)
    {
        _repo = repo;
        Reload();
    }

    public void Reload()
    {
        var loaded = new Dictionary<string, JsonNode>();
        foreach (var (key, raw) in _repo.GetSettings())
        {
            if (!_defs.TryGetValue(key, out var def)) continue;
            try
            {
                var node = JsonNode.Parse(raw);
                if (def.Validate(node)) loaded[key] = node!;
            }
            catch (JsonException)
            {
                // Corrupt value: fall back to default silently; it will be rewritten on next save.
            }
        }
        lock (_lock) _values = loaded;
    }

    public JsonObject GetAll()
    {
        var o = new JsonObject();
        lock (_lock)
        {
            foreach (var def in Definitions)
                o[def.Key] = (_values.TryGetValue(def.Key, out var v) ? v : def.Default).DeepClone();
        }
        return o;
    }

    /// <summary>Validates and stores a value. Returns an error message, or null on success.</summary>
    public string? Set(string key, JsonNode? value)
    {
        if (!_defs.TryGetValue(key, out var def)) return $"Unknown setting '{key}'.";
        if (!def.Validate(value)) return $"Invalid value for '{key}'.";
        // One writer at a time across the database and the cache, so two writes of a key can't end up with
        // the database holding one value and memory the other.
        lock (_writeLock) Store(key, value!);
        Changed?.Invoke(key);
        return null;
    }

    /// <summary>Turns one store's scan on or off (a read-modify-write of the platform map, atomic against other writers).</summary>
    public string? SetPlatformEnabled(string platformKey, bool enabled)
    {
        const string key = "library.platformsEnabled";
        lock (_writeLock)
        {
            var map = Get(key) is JsonObject current ? current.DeepClone().AsObject() : new JsonObject();
            map[platformKey] = enabled;
            if (!_defs[key].Validate(map)) return $"Invalid value for '{key}'.";
            Store(key, map);
        }
        Changed?.Invoke(key);
        return null;
    }

    /// <summary>Callers hold <see cref="_writeLock"/>.</summary>
    private void Store(string key, JsonNode value)
    {
        _repo.SetSetting(key, value.ToJsonString());
        lock (_lock) _values[key] = value.DeepClone();
    }

    public void ResetAll()
    {
        lock (_writeLock)
        {
            foreach (var def in Definitions)
            {
                if (def.Key == "onboarding.completed") continue;
                _repo.SetSetting(def.Key, def.Default.ToJsonString());
            }
            Reload();
        }
        Changed?.Invoke("*");
    }

    public bool GetBool(string key) => Get(key) is JsonValue v && v.TryGetValue<bool>(out var b) && b;
    public string GetString(string key) => Get(key) is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";
    public double GetNumber(string key) => Get(key) is JsonValue v && v.TryGetValue<double>(out var d) ? d : 0;

    public bool IsPlatformEnabled(string platformKey) =>
        Get("library.platformsEnabled") is not JsonObject o || o[platformKey] is not JsonValue v || !v.TryGetValue<bool>(out var b) || b;

    private JsonNode? Get(string key)
    {
        lock (_lock)
        {
            return _values.TryGetValue(key, out var v) ? v : _defs.TryGetValue(key, out var d) ? d.Default : null;
        }
    }
}
