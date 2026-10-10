using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Data;
using Vystral.Core.Matching;
using Vystral.Windows.Discover;
using Vystral.Windows.Services;

namespace Vystral.Windows.DataSources.Identity;

// ---------- Bridge DTOs (camelCase; mirrored in ui/src/bridge/types.identity.ts) ----------

public sealed record IdEvidenceDto(string Source, string Method, double Confidence);

/// <param name="Level">certain | high | good | medium | low — the same words the page shows.</param>
/// <param name="Status">native | pinned | matched | suggested | conflict</param>
/// <param name="Used">True when VYSTRAL uses this ID for features (native, your choice, or matched with high confidence).</param>
public sealed record ResolvedIdDto(string Kind, string Label, string Value, double Confidence, string Level, string Status, bool Used,
    IReadOnlyList<IdEvidenceDto> Evidence, string? Name, bool Link);

public sealed record IdCandidateDto(string Kind, string Value, string? Name, int? Year, double Confidence, IReadOnlyList<string> Sources);

/// <param name="Status">
/// native (a Steam game) | matched (a Steam app is used, labelled as matched) | pinned (you chose the Steam app) | notOnSteam (you said
/// it isn't on Steam) | suggested (a likely Steam app, not used until you confirm) | conflict (sources disagree) | none (nothing found) | notChecked
/// </param>
/// <param name="Reason">Why matching can't run right now: off | offline | gameRunning | null.</param>
public sealed record ResolvedIdentityDto(string GameId, string Status, ResolvedIdDto? Steam, IReadOnlyList<ResolvedIdDto> Ids,
    IReadOnlyList<IdCandidateDto> SteamCandidates, IReadOnlyList<string> Asked, string? CheckedAt, bool CanCheck, string? Reason);

public sealed record SteamSearchHitDto(string AppId, string Name);

/// <summary>The Steam app a library game's Steam-keyed features use, and whether it's the game's own.</summary>
/// <param name="Status">native | pinned | matched</param>
public sealed record ResolvedSteamApp(string AppId, bool Native, string Status, double Confidence);

/// <summary>What one resolution run found (cached in provider_cache "identity", per game).</summary>
public sealed class IdentityCacheEntry
{
    public int V { get; set; } = 1;
    /// <summary>The normalized title the evidence was gathered for; a renamed game is looked up again.</summary>
    public string TitleKey { get; set; } = "";
    public List<IdEvidence> Evidence { get; set; } = [];
    /// <summary>Sources that were asked (whether or not they found anything).</summary>
    public List<string> Asked { get; set; } = [];
    /// <summary>The Steam app matching settled on, for library-wide maps (Library tag filters).</summary>
    public string? SteamUsed { get; set; }
}

/// <summary>
/// Track D4: the cross-store identity resolver. For every library game it gathers evidence of the same game's Steam
/// app ID, IGDB ID, RAWG slug, GOG product ID and Wikidata item — from the store itself, Wikidata (by store ID or by
/// title and year), IGDB and RAWG (with the user's keys), Steam's store search (exact title, then the year on the app's
/// page) and GOG's catalogue (opt-in) — and merges it with <see cref="IdentityMerge"/>. A matched Steam app ID with high
/// confidence lets Steam-keyed features (reviews, tags, trailers, prices, news, Deck) work for Xbox, Epic, GOG, EA,
/// Ubisoft, Battle.net and manual games, always labelled as Steam data for the matched app. The user can confirm,
/// correct or reject a match; that choice is final. Nothing is fetched in Offline mode, while a game runs, or with
/// <c>dataSources.identityMatch</c> off, and each source still needs its own switch (or key).
/// </summary>
public sealed partial class IdentityResolverService
{
    public const string SettingKey = "dataSources.identityMatch";
    public const string CacheProvider = "identity";
    public const string PinProvider = "identity-pin";
    public static readonly TimeSpan FoundTtl = TimeSpan.FromDays(30);
    public static readonly TimeSpan MissTtl = TimeSpan.FromDays(7);
    private static readonly TimeSpan PinTtl = TimeSpan.FromDays(3650);
    private static readonly TimeSpan MemoryTtl = TimeSpan.FromMinutes(2);

    private readonly LibraryRepository _repo;
    private readonly SettingsService _settings;
    private readonly DataSourcesService _sources;
    private readonly GogCatalogClient _gog;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ConcurrentDictionary<string, (ResolvedSteamApp? App, DateTime At)> _memory = new(StringComparer.Ordinal);

    public Func<bool> IsGameActive { get; set; } = () => false;
    /// <summary>Raised with a game ID after its identity changed (resolved again, or the user corrected it).</summary>
    public event Action<string>? Changed;

    public IdentityResolverService(LibraryRepository repo, SettingsService settings, DataSourcesService sources, GogCatalogClient gog)
    {
        _repo = repo;
        _settings = settings;
        _sources = sources;
        _gog = gog;
    }

    public bool Enabled => _settings.GetBool(SettingKey);
    private bool LocalOnly => _settings.GetBool("privacy.localOnly");

    public string? BlockReason() => !Enabled ? "off" : LocalOnly ? "offline" : IsGameActive() ? "gameRunning" : null;

    // ---------- What features use ----------

    /// <summary>The Steam app for a library game: its own, the one you chose, or a high-confidence match. Null otherwise.</summary>
    public ResolvedSteamApp? SteamAppFor(string gameId)
    {
        if (_memory.TryGetValue(gameId, out var hit) && DateTime.UtcNow - hit.At < MemoryTtl) return hit.App;
        ResolvedSteamApp? app = null;
        var own = _repo.GetSteamAppId(gameId);
        if (IdKinds.IsValid(IdKinds.Steam, own)) app = new ResolvedSteamApp(own!, true, "native", 1);
        else if (_repo.GetIdentityGame(gameId) is { } game)
        {
            var steam = Merge(game, CachedEntry(game)).Ids.FirstOrDefault(i => i.Kind == IdKinds.Steam);
            if (steam is { Status: "pinned" or "matched" or "native" } && IsUsed(steam))
                app = new ResolvedSteamApp(steam.Value, steam.Status == "native", steam.Status, steam.Confidence);
        }
        _memory[gameId] = (app, DateTime.UtcNow);
        return app;
    }

    /// <summary>The app ID only (null for no Steam app): the drop-in replacement for <c>game.SteamAppId</c> in Steam-keyed features.</summary>
    public string? SteamAppIdFor(string gameId) => SteamAppFor(gameId)?.AppId;

    /// <summary>A resolved ID of another kind (IGDB, RAWG, GOG, Wikidata) when it's used, for trailers and links.</summary>
    public string? UsedId(string gameId, string kind)
    {
        if (_repo.GetIdentityGame(gameId) is not { } game) return null;
        var id = Merge(game, CachedEntry(game)).Ids.FirstOrDefault(i => i.Kind == kind);
        return id is not null && IsUsed(id) ? id.Value : null;
    }

    /// <summary>Library games that use a matched or chosen Steam app (not their own): Steam app → game, for library-wide features.</summary>
    public IReadOnlyDictionary<string, string> MatchedSteamApps()
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var pins = _repo.GetProviderCacheAll(PinProvider);
        var cache = Enabled ? _repo.GetProviderCacheAll(CacheProvider) : new Dictionary<string, (string, DateTimeOffset, bool)>();
        foreach (var gameId in cache.Keys.Concat(pins.Keys).Distinct(StringComparer.Ordinal))
        {
            if (!GameId().IsMatch(gameId)) continue;
            string? appId = null;
            if (pins.TryGetValue(gameId, out var p) && ReadPins(p.Body) is { } pinMap && pinMap.TryGetValue(IdKinds.Steam, out var pinned)) appId = pinned;
            else if (cache.TryGetValue(gameId, out var c) && ReadEntry(c.Body) is { SteamUsed: { } used }) appId = used;
            if (IdKinds.IsValid(IdKinds.Steam, appId)) result.TryAdd(appId!, gameId);
        }
        return result;
    }

    // ---------- The game page ----------

    /// <summary>The resolved identity of a library game, looking it up first when allowed and stale (or <paramref name="refresh"/>).</summary>
    public async Task<ResolvedIdentityDto> GetAsync(string gameId, bool allowNetwork, bool refresh, CancellationToken ct)
    {
        var game = _repo.GetIdentityGame(gameId) ?? throw new DataSourceException(DataSourceOutcome.Malformed, "That game no longer exists.");
        var entry = CachedEntry(game);
        var block = BlockReason();
        var needsLookup = game.SteamAppId is null && (entry is null || refresh || IsStale(gameId));
        if (needsLookup && allowNetwork && block is null)
        {
            await _gate.WaitAsync(ct);
            try
            {
                // Another request may have finished the same lookup while this one waited.
                entry = CachedEntry(game);
                if (entry is null || refresh || IsStale(gameId))
                {
                    var found = await CollectAsync(game, ct);
                    // Nothing could be asked (every source is off): keep no answer, so turning a source on looks it up at once.
                    if (found.Asked.Count > 0)
                    {
                        Save(game, found);
                        entry = found;
                    }
                }
            }
            finally
            {
                _gate.Release();
            }
        }
        return ToDto(game, entry, block);
    }

    /// <summary>Background: resolves up to <paramref name="max"/> games without a Steam app that were never checked or are due.</summary>
    public async Task<int> RefreshLibraryAsync(int max, Func<bool> shouldStop, CancellationToken ct)
    {
        if (BlockReason() is not null) return 0;
        var cached = _repo.GetProviderCacheAll(CacheProvider);
        var due = _repo.GamesWithoutSteamApp(5000).Where(id => !cached.TryGetValue(id, out var c) || !c.Fresh).Take(max).ToList();
        var done = 0;
        foreach (var gameId in due)
        {
            if (shouldStop() || BlockReason() is not null) break;
            try
            {
                await GetAsync(gameId, allowNetwork: true, refresh: false, ct);
                done++;
            }
            catch (DataSourceException ex) when (ex.Outcome is DataSourceOutcome.RateLimited or DataSourceOutcome.Unavailable)
            {
                Log.Warn("identity", "Background matching paused for this round", new { outcome = ex.Outcome.ToString() });
                break;
            }
        }
        return done;
    }

    /// <summary>The user's choice for one ID kind: a value (validated), or null for "this game isn't on that service".</summary>
    public ResolvedIdentityDto Pin(string gameId, string kind, string? value)
    {
        var game = _repo.GetIdentityGame(gameId) ?? throw new DataSourceException(DataSourceOutcome.Malformed, "That game no longer exists.");
        if (!IdKinds.All.Contains(kind)) throw new DataSourceException(DataSourceOutcome.Malformed, "Unknown ID kind.");
        if (value is not null && !IdKinds.IsValid(kind, value)) throw new DataSourceException(DataSourceOutcome.Malformed, "That ID doesn’t look right.");
        if (kind == IdKinds.Steam && game.SteamAppId is not null)
            throw new DataSourceException(DataSourceOutcome.Malformed, "This game is a Steam game; its Steam app comes from Steam itself.");
        var pins = Pins(gameId) ?? new Dictionary<string, string?>(StringComparer.Ordinal);
        pins[kind] = value;
        _repo.SetProviderCache(PinProvider, gameId, JsonSerializer.Serialize(pins), PinTtl);
        _repo.Audit("identity.pin", $"{gameId} {kind}:{value ?? "none"}");
        Invalidate(gameId);
        return ToDto(game, CachedEntry(game), BlockReason());
    }

    public ResolvedIdentityDto Unpin(string gameId, string kind)
    {
        var game = _repo.GetIdentityGame(gameId) ?? throw new DataSourceException(DataSourceOutcome.Malformed, "That game no longer exists.");
        var pins = Pins(gameId);
        if (pins is not null && pins.Remove(kind))
        {
            if (pins.Count == 0) _repo.DeleteProviderCache(PinProvider, gameId);
            else _repo.SetProviderCache(PinProvider, gameId, JsonSerializer.Serialize(pins), PinTtl);
            _repo.Audit("identity.unpin", $"{gameId} {kind}");
        }
        Invalidate(gameId);
        return ToDto(game, CachedEntry(game), BlockReason());
    }

    /// <summary>Steam store search for "Fix match": the store's own answer, apps only, names cleaned.</summary>
    public async Task<IReadOnlyList<SteamSearchHitDto>> SearchSteamAsync(string query, CancellationToken ct)
    {
        if (LocalOnly) throw new DataSourceException(DataSourceOutcome.Offline, "Offline mode is on, so VYSTRAL doesn’t search Steam.");
        var q = query.Trim();
        if (q.Length is < 2 or > 100) return [];
        var json = await SteamGetAsync($"https://store.steampowered.com/api/storesearch/?term={Uri.EscapeDataString(q)}&l=english&cc={_sources.Country}", ct);
        return DiscoverParsers.ParseSteamSearch(json).Take(10).Select(h => new SteamSearchHitDto(h.SourceId, h.Title)).ToList();
    }

    /// <summary>Forgets every remembered answer (a matching setting changed).</summary>
    public void InvalidateAll() => _memory.Clear();

    public void Invalidate(string gameId)
    {
        _memory.TryRemove(gameId, out _);
        Changed?.Invoke(gameId);
    }

    // ---------- Evidence ----------

    /// <summary>Evidence that needs no network: the store's own IDs, Wikidata rows by store ID, earlier enrichment and metadata matches.</summary>
    internal IReadOnlyList<IdEvidence> LocalEvidence(IdentityGame game)
    {
        var list = new List<IdEvidence>();
        if (IdKinds.IsValid(IdKinds.Steam, game.SteamAppId)) list.Add(new(IdKinds.Steam, game.SteamAppId!, "store", "native", 1, game.Title));
        string? gogId = null;
        if (game.Platforms.Contains("gog"))
        {
            gogId = _repo.GetInstallations(game.GameId).Where(i => i.Platform == Core.Domain.PlatformId.Gog).Select(i => i.PlatformGameId)
                .FirstOrDefault(id => IdKinds.IsValid(IdKinds.Gog, id));
            if (gogId is not null) list.Add(new(IdKinds.Gog, gogId, "store", "native", 1, game.Title));
        }
        // Wikidata rows by the game's own store IDs (filled by the existing identity lookups).
        foreach (var (kind, key) in new[] { ("steam", game.SteamAppId), ("gog", gogId) })
        {
            if (key is null || _repo.GetExternalIds(kind, key) is not { WikidataId: { } qid } row) continue;
            list.AddRange(FromWikidataIds(qid, row.Ids, row.Label, null, "storeId", 0.95));
        }
        foreach (var e in _repo.GetEnrichment(game.GameId).Where(e => e.Matched && e.Confidence is > 0))
        {
            var method = e.MatchMethod switch { "steam-appid" or "wikidata" => "storeId", _ => "exactTitle" };
            var conf = Math.Clamp(e.Confidence!.Value, 0, 0.95);
            if (e.Source == "igdb" && IdKinds.IsValid(IdKinds.Igdb, e.SourceId)) list.Add(new(IdKinds.Igdb, e.SourceId!, "igdb", method, conf));
            if (e.Source == "rawg" && RawgSlugFromUrl(e.Url) is { } slug) list.Add(new(IdKinds.Rawg, slug, "rawg", method, conf));
        }
        // A non-Steam game the metadata lookup matched by exact title earlier (recorded in its source line).
        if (game.SteamAppId is null && game.MetadataSource is { } ms && MetadataMatch().Match(ms) is { Success: true } m && IdKinds.IsValid(IdKinds.Steam, m.Groups[1].Value))
            list.Add(new(IdKinds.Steam, m.Groups[1].Value, "steam", "earlierMatch", 0.7));
        return list;
    }

    /// <summary>Asks every enabled source about a game that has no Steam app of its own. Failures of one source never stop the others.</summary>
    private async Task<IdentityCacheEntry> CollectAsync(IdentityGame game, CancellationToken ct)
    {
        var entry = new IdentityCacheEntry { TitleKey = TitleKey(game.Title) };
        var year = IdentityMerge.YearOf(game.ReleaseDate);
        var title = game.Title;

        async Task Ask(string source, Func<Task<IEnumerable<IdEvidence>>> work)
        {
            if (IsGameActive() || LocalOnly) return;
            try
            {
                entry.Evidence.AddRange(await work());
                entry.Asked.Add(source);
            }
            catch (DataSourceException ex)
            {
                Log.Warn("identity", "A source couldn't help match a game", new { source, outcome = ex.Outcome.ToString() });
                if (ex.Outcome == DataSourceOutcome.Offline) throw;
            }
        }

        if (_settings.GetBool("dataSources.wikidata")) await Ask("wikidata", () => WikidataByTitleAsync(title, year, ct));
        if (_settings.GetBool("library.fetchMetadata")) await Ask("steam", () => SteamByTitleAsync(title, year, ct));
        if (_sources.ProviderReady("igdb")) await Ask("igdb", () => IgdbByTitleAsync(title, year, ct));
        if (_sources.ProviderReady("rawg"))
        {
            var steamGuess = IdentityMerge.Merge(entry.Evidence.Concat(LocalEvidence(game))).Candidates.FirstOrDefault(c => c.Kind == IdKinds.Steam)?.Value;
            await Ask("rawg", () => RawgByTitleAsync(title, year, steamGuess, ct));
        }
        if (_settings.GetBool("dataSources.gogCatalog") && !game.Platforms.Contains("gog")) await Ask("gog", () => GogByTitleAsync(title, year, ct));
        return entry;
    }

    private async Task<IEnumerable<IdEvidence>> WikidataByTitleAsync(string title, int? year, CancellationToken ct)
    {
        var hits = DiscoverParsers.ParseWikidataSearch(await _sources.Wikidata.DiscoverSearchAsync(title, ct));
        if (IdentityMerge.PickByTitle(title, year, hits, h => h.Title, h => h.Year) is not { } pick) return [];
        var h = hits[pick.Index];
        var ids = new Dictionary<string, string>(StringComparer.Ordinal);
        if (h.Ids.Steam is { } s) ids["steam"] = s;
        if (h.Ids.GogId is { } g) ids["gogId"] = g;
        if (h.Ids.Rawg is { } r) ids["rawg"] = r;
        return FromWikidataIds(h.SourceId, ids, h.Title, h.Year, pick.Method, pick.Confidence);
    }

    private async Task<IEnumerable<IdEvidence>> SteamByTitleAsync(string title, int? year, CancellationToken ct)
    {
        var search = await SteamGetAsync($"https://store.steampowered.com/api/storesearch/?term={Uri.EscapeDataString(title)}&l=english&cc={_sources.Country}", ct);
        var hits = DiscoverParsers.ParseSteamSearch(search).Where(h => h.Kind == "game").ToList();
        // Steam's search has no years: first a unique exact title, then the year on that app's own page.
        if (IdentityMerge.PickByTitle(title, null, hits, h => h.Title, _ => null) is not { } pick) return [];
        var appId = hits[pick.Index].SourceId;
        var details = DiscoverParsers.ParseSteamDetails(appId,
            await SteamGetAsync($"https://store.steampowered.com/api/appdetails?appids={appId}&cc={_sources.Country}&l=english", ct));
        if (details is null || details.Type != "game") return [];
        var conf = pick.Confidence;
        var method = pick.Method;
        if (year is { } y && details.Year is { } dy)
        {
            if (Math.Abs(y - dy) > 1) return []; // same name, different game (a remake, a namesake)
            conf += 0.15;
            method = pick.Method == "exactTitle" ? "exactTitleYear" : pick.Method;
        }
        return [new IdEvidence(IdKinds.Steam, appId, "steam", method, Math.Min(conf, 0.85), details.Name, details.Year)];
    }

    private async Task<IEnumerable<IdEvidence>> IgdbByTitleAsync(string title, int? year, CancellationToken ct)
    {
        var hits = DiscoverParsers.ParseIgdbSearch(await _sources.Igdb.DiscoverSearchAsync(title, 0, ct)).Where(h => h.Kind == "game").ToList();
        if (IdentityMerge.PickByTitle(title, year, hits, h => h.Title, h => h.Year) is not { } pick) return [];
        var h = hits[pick.Index];
        var list = new List<IdEvidence> { new(IdKinds.Igdb, h.SourceId, "igdb", pick.Method, pick.Confidence, h.Title, h.Year) };
        // IGDB links its games to store entries (external_games); the link is as strong as the title match that found the game.
        if (h.Ids.Steam is { } s) list.Add(new(IdKinds.Steam, s, "igdb", pick.Method, pick.Confidence, h.Title, h.Year));
        if (h.Ids.GogId is { } g) list.Add(new(IdKinds.Gog, g, "igdb", pick.Method, pick.Confidence, h.Title, h.Year));
        return list;
    }

    private async Task<IEnumerable<IdEvidence>> RawgByTitleAsync(string title, int? year, string? steamGuess, CancellationToken ct)
    {
        var hits = await _sources.Rawg.SearchAsync(title, ct);
        if (IdentityMerge.PickByTitle(title, year, hits, h => h.Name, h => h.ReleaseYear) is not { } pick) return [];
        var h = hits[pick.Index];
        var list = new List<IdEvidence> { new(IdKinds.Rawg, h.Slug, "rawg", pick.Method, pick.Confidence, h.Name, h.ReleaseYear) };
        // A cross-check rather than a new guess: does RAWG list this game on Steam under the app others found?
        if (steamGuess is not null && await _sources.Rawg.HasSteamAppAsync(h.Id, steamGuess, ct))
            list.Add(new(IdKinds.Steam, steamGuess, "rawg", "crossCheck", pick.Confidence, h.Name, h.ReleaseYear));
        return list;
    }

    private async Task<IEnumerable<IdEvidence>> GogByTitleAsync(string title, int? year, CancellationToken ct)
    {
        var hits = (await _gog.SearchAsync(title, ct)).Where(p => p.ProductType is "game" or "pack").ToList();
        if (IdentityMerge.PickByTitle(title, year, hits, h => h.Title, h => h.Year) is not { } pick) return [];
        var h = hits[pick.Index];
        return [new IdEvidence(IdKinds.Gog, h.Id, "gog", pick.Method, pick.Confidence, h.Title, h.Year)];
    }

    private static IEnumerable<IdEvidence> FromWikidataIds(string qid, IReadOnlyDictionary<string, string> ids, string? label, int? year, string method, double conf)
    {
        yield return new IdEvidence(IdKinds.Wikidata, qid, "wikidata", method, conf, label, year);
        if (ids.TryGetValue("steam", out var s)) yield return new IdEvidence(IdKinds.Steam, s, "wikidata", method, conf, label, year);
        if (ids.TryGetValue("gogId", out var g)) yield return new IdEvidence(IdKinds.Gog, g, "wikidata", method, conf, label, year);
        if (ids.TryGetValue("rawg", out var r)) yield return new IdEvidence(IdKinds.Rawg, r, "wikidata", method, conf, label, year);
    }

    private async Task<string> SteamGetAsync(string url, CancellationToken ct)
    {
        var r = await _sources.TransportFor("steamdeck").SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri(url)), ct);
        if (r.Status == HttpStatusCode.Forbidden) throw new DataSourceException(DataSourceOutcome.RateLimited, "Steam asked VYSTRAL to slow down. Try again in a few minutes.");
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Steam answered with an unexpected status ({(int)r.Status}).");
        return r.Body;
    }

    // ---------- Merge, cache and DTO ----------

    private (IReadOnlyList<ResolvedId> Ids, IReadOnlyList<IdCandidate> Candidates) Merge(IdentityGame game, IdentityCacheEntry? entry)
    {
        var evidence = new List<IdEvidence>(LocalEvidence(game));
        // Matching off: only what the stores themselves say, Wikidata by store ID, and your own choices.
        if (entry is not null && Enabled) evidence.AddRange(entry.Evidence);
        if (!Enabled) evidence.RemoveAll(e => e.Method is not ("native" or "storeId"));
        return IdentityMerge.Merge(evidence, Pins(game.GameId));
    }

    private static bool IsUsed(ResolvedId id) => id.Status is "native" or "pinned" || id.Status == "matched" && id.Confidence >= IdentityMerge.UseThreshold;

    internal ResolvedIdentityDto ToDto(IdentityGame game, IdentityCacheEntry? entry, string? block)
    {
        var (ids, candidates) = Merge(game, entry);
        var pins = Pins(game.GameId);
        var steam = ids.FirstOrDefault(i => i.Kind == IdKinds.Steam);
        var status = game.SteamAppId is not null ? "native"
            : pins is not null && pins.TryGetValue(IdKinds.Steam, out var p) ? p is null ? "notOnSteam" : "pinned"
            : steam?.Status switch
            {
                "matched" => "matched",
                "suggested" => "suggested",
                "conflict" => "conflict",
                _ => entry is null || entry.Asked.Count == 0 ? "notChecked" : "none",
            };
        var checkedAt = _repo.GetProviderCache(CacheProvider, game.GameId)?.Fetched.ToString("O");
        return new ResolvedIdentityDto(game.GameId, status, steam is null ? null : Dto(steam), ids.Select(Dto).ToList(),
            candidates.Where(c => c.Kind == IdKinds.Steam).Take(6).Select(c => new IdCandidateDto(c.Kind, c.Value, c.Name, c.Year, c.Confidence, c.Sources)).ToList(),
            entry?.Asked ?? [], checkedAt, game.SteamAppId is null && block is null, game.SteamAppId is null ? block : null);
    }

    private static ResolvedIdDto Dto(ResolvedId id) => new(id.Kind, IdKinds.Label(id.Kind), id.Value, id.Confidence, Level(id.Confidence), id.Status, IsUsed(id),
        id.Evidence.GroupBy(e => (e.Source, e.Method)).Select(g => new IdEvidenceDto(g.Key.Source, g.Key.Method, Math.Round(g.Max(e => e.Confidence), 2))).ToList(),
        id.Name, LinkFor(id.Kind, id.Value) is not null);

    public static string Level(double c) => c >= 0.99 ? "certain" : c >= 0.9 ? "high" : c >= IdentityMerge.UseThreshold ? "good" : c >= IdentityMerge.SuggestThreshold ? "medium" : "low";

    /// <summary>The public page for a resolved ID, built natively from the validated value.</summary>
    public static string? LinkFor(string kind, string value) => kind switch
    {
        IdKinds.Steam when IdKinds.IsValid(kind, value) => $"https://store.steampowered.com/app/{value}/",
        IdKinds.Rawg when IdKinds.IsValid(kind, value) && !value.All(char.IsAsciiDigit) => $"https://rawg.io/games/{value}",
        IdKinds.Wikidata when IdKinds.IsValid(kind, value) => $"https://www.wikidata.org/wiki/{value}",
        _ => null,
    };

    /// <summary>The link for one of a game's resolved IDs (the page names a kind, never a URL).</summary>
    public string? Link(string gameId, string kind)
    {
        if (_repo.GetIdentityGame(gameId) is not { } game) return null;
        var id = Merge(game, CachedEntry(game)).Ids.FirstOrDefault(i => i.Kind == kind);
        return id is null ? null : LinkFor(kind, id.Value);
    }

    private void Save(IdentityGame game, IdentityCacheEntry entry)
    {
        var steam = IdentityMerge.Merge(entry.Evidence.Concat(LocalEvidence(game))).Ids.FirstOrDefault(i => i.Kind == IdKinds.Steam);
        entry.SteamUsed = steam is not null && IsUsed(steam) ? steam.Value : null;
        entry.Evidence = entry.Evidence.Take(60).ToList();
        _repo.SetProviderCache(CacheProvider, game.GameId, JsonSerializer.Serialize(entry, JsonFileCache.Options), entry.Evidence.Count > 0 ? FoundTtl : MissTtl);
        Invalidate(game.GameId);
    }

    private bool IsStale(string gameId) => _repo.GetProviderCache(CacheProvider, gameId) is not { Fresh: true };

    private IdentityCacheEntry? CachedEntry(IdentityGame game)
    {
        if (_repo.GetProviderCache(CacheProvider, game.GameId) is not { } c) return null;
        var entry = ReadEntry(c.Body);
        return entry is not null && entry.TitleKey == TitleKey(game.Title) ? entry : null;
    }

    private static readonly HashSet<string> CachedSources = ["wikidata", "steam", "igdb", "rawg", "gog"];
    private static readonly HashSet<string> CachedMethods = ["storeId", "exactTitleYear", "exactTitle", "editionTitle", "crossCheck", "earlierMatch"];

    /// <summary>Reads a cached entry back (the database is user-writable): every field is validated; "native" and "chosen" can never come from the cache.</summary>
    internal static IdentityCacheEntry? ReadEntry(string body)
    {
        try
        {
            if (body.Length > 64 * 1024) return null;
            var e = JsonSerializer.Deserialize<IdentityCacheEntry>(body, JsonFileCache.Options);
            if (e is null || e.V != 1) return null;
            e.TitleKey = e.TitleKey is { Length: <= 300 } t ? t : "";
            e.Evidence = (e.Evidence ?? []).Where(x => x is not null && IdKinds.IsValid(x.Kind, x.Value) && CachedSources.Contains(x.Source) && CachedMethods.Contains(x.Method) &&
                                                    double.IsFinite(x.Confidence) && x.Confidence is > 0 and <= 0.95)
                .Select(x => x with { Name = x.Name is { Length: > 0 } n ? SteamCleanName(n) : null, Year = x.Year is > 1950 and < 2200 ? x.Year : null })
                .Take(60).ToList();
            e.Asked = (e.Asked ?? []).Where(CachedSources.Contains).Distinct().ToList();
            e.SteamUsed = IdKinds.IsValid(IdKinds.Steam, e.SteamUsed) ? e.SteamUsed : null;
            return e;
        }
        catch (JsonException) { return null; }
    }

    private Dictionary<string, string?>? Pins(string gameId) =>
        _repo.GetProviderCache(PinProvider, gameId) is { } c ? ReadPins(c.Body) : null;

    internal static Dictionary<string, string?>? ReadPins(string body)
    {
        try
        {
            if (body.Length > 4096) return null;
            var raw = JsonSerializer.Deserialize<Dictionary<string, string?>>(body);
            if (raw is null) return null;
            var clean = new Dictionary<string, string?>(StringComparer.Ordinal);
            foreach (var (k, v) in raw)
                if (IdKinds.All.Contains(k) && (v is null || IdKinds.IsValid(k, v))) clean[k] = v;
            return clean.Count == 0 ? null : clean;
        }
        catch (JsonException) { return null; }
    }

    internal static string TitleKey(string title) => TitleNormalizer.Normalize(title).Full;

    private static string SteamCleanName(string s) => MetadataService.Clean(s, 200);

    private static string? RawgSlugFromUrl(string? url) =>
        JsonRead.SafeUrl(url, "rawg.io") is { } safe && RawgUrl().Match(safe) is { Success: true } m && IdKinds.IsValid(IdKinds.Rawg, m.Groups[1].Value) ? m.Groups[1].Value : null;

    [GeneratedRegex(@"\Ahttps://rawg\.io/games/([a-z0-9][a-z0-9\-]{0,119})\z")]
    private static partial Regex RawgUrl();

    [GeneratedRegex(@"exact title match, app ([0-9]{1,10})\)")]
    private static partial Regex MetadataMatch();

    [GeneratedRegex(@"\A[0-9a-f]{32}\z")]
    private static partial Regex GameId();
}
