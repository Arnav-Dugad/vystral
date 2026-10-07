using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;
using Vystral.Core.Cloud;
using Vystral.Core.Data;
using Vystral.Core.Media;
using Vystral.Windows.Bridge;
using Vystral.Windows.Cloud;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;

namespace Vystral.Windows.Discover;

/// <summary>
/// Track U: search any game across Steam's public store search, IGDB and RAWG (with the user's own keys) and Wikidata,
/// merged and de-duplicated, and a page for games that aren't in the library. Every source keeps its own switch and key,
/// nothing leaves the PC in Offline mode, Data saver stops image downloads, answers are cached in memory (LRU), each
/// provider keeps its polite request lane, and every answer is validated and capped. Nothing here launches or installs
/// anything: store pages open in the browser, through links built natively from validated IDs.
/// </summary>
public sealed partial class DiscoverService
{
    public const string SearchSetting = "discover.searchOnline";
    public const int MaxQueryLength = 100;
    public const int BarResults = 12;
    public const int MaxPages = 10;
    public static readonly TimeSpan SearchTtl = TimeSpan.FromMinutes(15);
    public static readonly TimeSpan DetailsTtl = TimeSpan.FromHours(1);

    private readonly LibraryRepository _repo;
    private readonly SettingsService _settings;
    private readonly ArtworkService _artwork;
    private readonly DataSourcesService _sources;
    private readonly Func<CloudPlayService?> _cloud;
    private readonly Func<TrailerService?> _trailers;
    private readonly IEventSink _events;
    private readonly DiscoverWatchStore _watch;
    private readonly Func<bool> _dataSaver;

    private readonly LruCache<string, (IReadOnlyList<DiscoverHit> Hits, bool HasMore)> _searchCache = new(200, SearchTtl);
    private readonly LruCache<string, DiscoverEntry> _entries = new(800);
    private readonly LruCache<string, (DiscoverDetailsDto Dto, Dictionary<string, string> Links)> _details = new(60, DetailsTtl);
    private readonly LruCache<string, string> _images = new(1500);
    private readonly LruCache<string, Dictionary<string, string>> _assetIndex = new(300, TimeSpan.FromHours(6));
    private readonly SemaphoreSlim _imageGate = new(4, 4);
    private readonly Dictionary<string, SearchRun> _runs = new(StringComparer.Ordinal);
    private readonly Lock _runsLock = new();
    private DiscoverLibraryIndex _library = DiscoverLibraryIndex.Empty;
    private DateTimeOffset _libraryAt = DateTimeOffset.MinValue;
    private int _searchSeq;

    /// <summary>Test hook: replaces the network for source searches (source, query, page) → hits and whether more pages exist.</summary>
    internal Func<string, string, int, CancellationToken, Task<(IReadOnlyList<DiscoverHit> Hits, bool HasMore)>>? FetchOverride { get; set; }

    public DiscoverService(LibraryRepository repo, SettingsService settings, ArtworkService artwork, DataSourcesService sources,
        Func<CloudPlayService?> cloud, Func<TrailerService?> trailers, IEventSink events, string dataRoot, Func<bool> dataSaver)
    {
        _repo = repo;
        _settings = settings;
        _artwork = artwork;
        _sources = sources;
        _cloud = cloud;
        _trailers = trailers;
        _events = events;
        _watch = new DiscoverWatchStore(dataRoot);
        _dataSaver = dataSaver;
    }

    public DiscoverWatchStore Watch => _watch;

    private bool LocalOnly => _settings.GetBool("privacy.localOnly");
    private bool SearchOnline => _settings.GetBool(SearchSetting);

    // ---------------- gates ----------------

    /// <summary>Whether a source may be asked now, and if not, why (off, noKey, offline).</summary>
    public (bool Ready, string? Reason) Gate(string source)
    {
        if (LocalOnly) return (false, "offline");
        if (!SearchOnline) return (false, "off");
        return source switch
        {
            DiscoverSources.Steam => _settings.GetBool("library.fetchMetadata") ? (true, null) : (false, "off"),
            DiscoverSources.Igdb => _sources.HasKey(KeyedProvider.Igdb) ? (true, null) : (false, "noKey"),
            DiscoverSources.Rawg => _sources.HasKey(KeyedProvider.Rawg) ? (true, null) : (false, "noKey"),
            DiscoverSources.Wikidata => _settings.GetBool("dataSources.wikidata") ? (true, null) : (false, "off"),
            _ => (false, "off"),
        };
    }

    /// <summary>Gates for the page's details lookups: the same switches, but they don't depend on "Search online".</summary>
    private bool DetailsReady(string source) =>
        !LocalOnly && source switch
        {
            DiscoverSources.Steam => _settings.GetBool("library.fetchMetadata"),
            DiscoverSources.Igdb => _sources.HasKey(KeyedProvider.Igdb),
            DiscoverSources.Rawg => _sources.HasKey(KeyedProvider.Rawg),
            DiscoverSources.Wikidata => _settings.GetBool("dataSources.wikidata"),
            _ => false,
        };

    public DiscoverStatusDto Status()
    {
        var reason = LocalOnly ? "offline" : !SearchOnline ? "off" : null;
        return new DiscoverStatusDto(SearchOnline, LocalOnly, _dataSaver(), reason, DiscoverSources.All.Select(s =>
        {
            var (ready, why) = Gate(s);
            return new DiscoverSourceStatusDto(s, DiscoverSources.Name(s), ready ? "ready" : "unavailable", why);
        }).ToList());
    }

    // ---------------- library ----------------

    private DiscoverLibraryIndex Library()
    {
        if (DateTimeOffset.UtcNow - _libraryAt < TimeSpan.FromSeconds(30)) return _library;
        var rows = _repo.GetDiscoverLibrary();
        _library = DiscoverLibraryIndex.Build(rows.Select(r => new DiscoverLibraryGame(r.Id, r.Title,
            r.SteamAppId is { } s && DiscoverKeys.SteamAppId().IsMatch(s) ? s : null, DiscoverParsers.SteamDate(r.ReleaseDate).Year ?? DiscoverParsers.IsoDate(r.ReleaseDate).Year)));
        _libraryAt = DateTimeOffset.UtcNow;
        return _library;
    }

    /// <summary>Forget the library snapshot (called when the library changes).</summary>
    public void LibraryChanged() => _libraryAt = DateTimeOffset.MinValue;

    // ---------------- search ----------------

    private sealed class SearchRun(string id, string channel, string query)
    {
        public string Id { get; } = id;
        public string Channel { get; } = channel;
        public string Query { get; } = query;
        public int Page { get; set; }
        public CancellationTokenSource Cts { get; } = new();
        public List<DiscoverHit> Hits { get; } = [];
        public Dictionary<string, DiscoverSourceStateDto> States { get; } = new(StringComparer.Ordinal);
        public Lock Lock { get; } = new();
    }

    /// <summary>Normalizes and validates what was typed: trimmed, single-spaced, no control characters, 2–100 characters.</summary>
    public static string? CleanQuery(string? query)
    {
        if (query is null) return null;
        var q = Spaces().Replace(new string(query.Where(c => !char.IsControl(c)).ToArray()), " ").Trim();
        return q.Length is >= 2 and <= MaxQueryLength ? q : null;
    }

    /// <summary>
    /// Starts (or extends, for <paramref name="page"/> &gt; 0) a search. Returns at once with every source's state;
    /// each source's answer then arrives as a <c>discover.results</c> event carrying the whole merged list so far.
    /// A new search on the same channel cancels the previous one.
    /// </summary>
    public DiscoverSearchDto Search(string query, string channel, int page)
    {
        var q = CleanQuery(query) ?? throw new BridgeException("invalid", "Type at least two letters to search.");
        page = Math.Clamp(page, 0, MaxPages - 1);
        SearchRun run;
        lock (_runsLock)
        {
            if (page > 0 && _runs.TryGetValue(channel, out var existing) && existing.Query == q && !existing.Cts.IsCancellationRequested)
                run = existing;
            else
            {
                if (_runs.TryGetValue(channel, out var previous)) previous.Cts.Cancel();
                run = new SearchRun($"s{Interlocked.Increment(ref _searchSeq)}", channel, q);
                _runs[channel] = run;
                page = 0;
            }
            run.Page = page;
        }

        var toFetch = new List<string>();
        lock (run.Lock)
        {
            foreach (var source in DiscoverSources.All)
            {
                var (ready, reason) = Gate(source);
                if (!ready)
                {
                    run.States[source] = new DiscoverSourceStateDto(source, DiscoverSources.Name(source), "skipped", reason, 0, false);
                    continue;
                }
                var pages = source is DiscoverSources.Igdb or DiscoverSources.Rawg;
                if (page > 0 && (!pages || run.States.TryGetValue(source, out var st) && !st.HasMore)) continue;
                var count = run.States.TryGetValue(source, out var prev) ? prev.Count : 0;
                run.States[source] = new DiscoverSourceStateDto(source, DiscoverSources.Name(source), "pending", null, count, false);
                toFetch.Add(source);
            }
        }
        var snapshot = Snapshot(run, done: toFetch.Count == 0);
        foreach (var source in toFetch) _ = Task.Run(() => FetchSourceAsync(run, source, page));
        return snapshot;
    }

    /// <summary>Cancels a channel's running search (the command bar closed).</summary>
    public void Cancel(string channel)
    {
        lock (_runsLock)
        {
            if (_runs.Remove(channel, out var run)) run.Cts.Cancel();
        }
    }

    private async Task FetchSourceAsync(SearchRun run, string source, int page)
    {
        var ct = run.Cts.Token;
        DiscoverSourceStateDto state;
        try
        {
            var (hits, hasMore) = await FetchHitsAsync(source, run.Query, page, ct);
            if (ct.IsCancellationRequested) return;
            lock (run.Lock)
            {
                foreach (var h in hits)
                    if (!run.Hits.Any(x => x.Source == h.Source && x.SourceId == h.SourceId)) run.Hits.Add(h);
                var count = run.Hits.Count(h => h.Source == source);
                state = new DiscoverSourceStateDto(source, DiscoverSources.Name(source), "done", null, count, hasMore && page + 1 < MaxPages);
                run.States[source] = state;
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return;
        }
        catch (DataSourceException ex)
        {
            if (ct.IsCancellationRequested) return;
            var reason = ex.Outcome switch
            {
                DataSourceOutcome.RateLimited => "rateLimited",
                DataSourceOutcome.InvalidKey => "invalidKey",
                DataSourceOutcome.Offline => "offline",
                DataSourceOutcome.NotConfigured => "noKey",
                _ => "unavailable",
            };
            lock (run.Lock)
            {
                var count = run.Hits.Count(h => h.Source == source);
                run.States[source] = new DiscoverSourceStateDto(source, DiscoverSources.Name(source), "failed", reason, count, false);
            }
        }
        catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidOperationException or HttpRequestException)
        {
            if (ct.IsCancellationRequested) return;
            Log.Warn("discover", "A search source failed", new { source, error = ex.GetType().Name });
            lock (run.Lock)
                run.States[source] = new DiscoverSourceStateDto(source, DiscoverSources.Name(source), "failed", "unavailable", run.Hits.Count(h => h.Source == source), false);
        }
        bool done;
        lock (run.Lock) done = run.States.Values.All(s => s.State != "pending");
        if (ct.IsCancellationRequested) return;
        _events.Emit("discover.results", Snapshot(run, done));
    }

    private async Task<(IReadOnlyList<DiscoverHit> Hits, bool HasMore)> FetchHitsAsync(string source, string query, int page, CancellationToken ct)
    {
        var cacheKey = $"{source}|{page}|{_sources.Country}|{query.ToLowerInvariant()}";
        if (_searchCache.TryGet(cacheKey, out var cached)) return cached;
        (IReadOnlyList<DiscoverHit> Hits, bool HasMore) result;
        if (FetchOverride is { } fake) result = await fake(source, query, page, ct);
        else result = source switch
        {
            DiscoverSources.Steam => (DiscoverParsers.ParseSteamSearch(await SteamGetAsync(
                $"https://store.steampowered.com/api/storesearch/?term={Uri.EscapeDataString(query)}&l=english&cc={_sources.Country}", ct)), false),
            DiscoverSources.Igdb => Paged(DiscoverParsers.ParseIgdbSearch(await _sources.Igdb.DiscoverSearchAsync(query, page, ct), page * IgdbClient.DiscoverPageSize), IgdbClient.DiscoverPageSize),
            DiscoverSources.Rawg => Paged(DiscoverParsers.ParseRawgSearch(await _sources.Rawg.DiscoverSearchAsync(query, page, ct), page * RawgClient.DiscoverPageSize), RawgClient.DiscoverPageSize),
            _ => (DiscoverParsers.ParseWikidataSearch(await _sources.Wikidata.DiscoverSearchAsync(query, ct)), false),
        };
        _searchCache.Set(cacheKey, result);
        return result;

        static (IReadOnlyList<DiscoverHit>, bool) Paged(IReadOnlyList<DiscoverHit> hits, int size) => (hits, hits.Count >= size);
    }

    private async Task<string> SteamGetAsync(string url, CancellationToken ct)
    {
        var r = await _sources.TransportFor("steamdeck").SendAsync(() => new HttpRequestMessage(HttpMethod.Get, new Uri(url)), ct);
        if (r.Status == HttpStatusCode.Forbidden) throw new DataSourceException(DataSourceOutcome.RateLimited, "Steam asked VYSTRAL to slow down. Try again in a few minutes.");
        if (r.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Malformed, $"Steam answered with an unexpected status ({(int)r.Status}).");
        return r.Body;
    }

    private DiscoverSearchDto Snapshot(SearchRun run, bool done)
    {
        List<DiscoverHit> hits;
        List<DiscoverSourceStateDto> states;
        lock (run.Lock)
        {
            hits = [.. run.Hits];
            states = DiscoverSources.All.Where(run.States.ContainsKey).Select(s => run.States[s]).ToList();
        }
        var merged = DiscoverMerger.Merge(hits, run.Query, Library());
        foreach (var e in merged) RememberEntry(e);
        var take = run.Channel == "bar" ? BarResults : DiscoverMerger.MaxResults;
        var results = merged.Take(take).Select(ToDto).ToList();
        var reason = LocalOnly ? "offline" : !SearchOnline ? "off" : null;
        return new DiscoverSearchDto(run.Id, run.Channel, run.Query, run.Page, states, results, done, states.Any(s => s.HasMore), reason);
    }

    /// <summary>Keeps what a search learned about a game, merged with anything known before (for its page and images).</summary>
    private void RememberEntry(DiscoverEntry e)
    {
        if (_entries.TryGet(e.Key, out var known) && !ReferenceEquals(known, e))
        {
            e.Ids = e.Ids.Merge(known.Ids);
            foreach (var i in known.Images) if (!e.Images.Contains(i) && e.Images.Count < 20) e.Images.Add(i);
        }
        _entries.Set(e.Key, e);
    }

    private DiscoverResultDto ToDto(DiscoverEntry e)
    {
        var hasCover = e.Ids.Steam is not null || e.Images.Any(i => i.Kind is "cover" or "background");
        return new DiscoverResultDto(e.Key, e.Title, e.Year, e.Stores, e.Platforms, e.Genres, e.Sources, e.Ids.Steam, e.LibraryGameId, e.Price,
            hasCover, _images.Get($"{e.Key}|cover") is { Length: > 0 } c ? c : null, e.Score, e.Kind);
    }

    // ---------------- images ----------------

    /// <summary>
    /// The art-host URL of one image for a result or page, downloading it through the safe pipeline the first time.
    /// Null with a reason when it can't be shown: offline, dataSaver, none.
    /// </summary>
    public async Task<(string? Url, string? Reason)> ImageAsync(string key, string kind, CancellationToken ct)
    {
        var memoKey = $"{key}|{kind}";
        if (_images.TryGet(memoKey, out var known)) return known.Length > 0 ? (known, null) : (null, "none");
        var candidates = ImageCandidates(key, kind);
        // Already on disk from an earlier visit: no network needed, even in Offline mode or with Data saver.
        foreach (var c in candidates)
            if (_artwork.CachedDiscoverImage(c.Url) is { } cachedUrl)
            {
                _images.Set(memoKey, cachedUrl);
                return (cachedUrl, null);
            }
        if (LocalOnly) return (null, "offline");
        if (_dataSaver()) return (null, "dataSaver");
        await _imageGate.WaitAsync(ct);
        try
        {
            foreach (var c in candidates)
            {
                if (await _artwork.CacheDiscoverImageAsync(c.Url, c.Kind, ct) is { } url)
                {
                    _images.Set(memoKey, url);
                    return (url, null);
                }
            }
            // Newer Steam apps only have hashed file names: ask the store's asset index once.
            if (IdsFor(key).Steam is { } appId && kind is "cover" or "hero" or "header")
            {
                foreach (var url in await HashedCandidatesAsync(appId, kind, ct))
                    if (await _artwork.CacheDiscoverImageAsync(url, kind, ct) is { } got)
                    {
                        _images.Set(memoKey, got);
                        return (got, null);
                    }
            }
            _images.Set(memoKey, "");
            return (null, "none");
        }
        finally
        {
            _imageGate.Release();
        }
    }

    private DiscoverIds IdsFor(string key) => _entries.TryGet(key, out var e) ? e.Ids : DiscoverKeys.IdsFromKey(key);

    internal IReadOnlyList<DiscoverImage> ImageCandidates(string key, string kind)
    {
        var images = _entries.TryGet(key, out var e) ? e.Images.ToList() : [];
        if (IdsFor(key).Steam is { } appId) foreach (var i in DiscoverParsers.SteamFlatImages(appId)) if (!images.Contains(i)) images.Add(i);
        var wanted = kind switch
        {
            "cover" => new[] { "cover", "background" },
            "hero" => ["hero", "background", "header"],
            "header" => ["header", "hero", "background"],
            _ => ["logo"],
        };
        return wanted.SelectMany(w => images.Where(i => i.Kind == w))
            .Where(i => DiscoverParsers.SafeImage(i.Url) is not null).Distinct().Take(8).ToList();
    }

    private async Task<IReadOnlyList<string>> HashedCandidatesAsync(string appId, string kind, CancellationToken ct)
    {
        if (!_assetIndex.TryGet(appId, out var assets))
        {
            var index = await _artwork.SteamAssetIndexAsync([appId], ct);
            assets = index.GetValueOrDefault(appId) ?? [];
            _assetIndex.Set(appId, assets);
        }
        string[] keys = kind switch
        {
            "cover" => ["library_capsule_2x", "library_capsule"],
            "hero" => ["library_hero_2x", "library_hero"],
            _ => ["header_2x", "header"],
        };
        return keys.Select(k => assets.GetValueOrDefault(k)).OfType<string>().Where(u => DiscoverParsers.SafeImage(u) is not null).ToList();
    }

    // ---------------- details ----------------

    public async Task<DiscoverDetailsDto> DetailsAsync(string key, bool refresh, CancellationToken ct)
    {
        if (!DiscoverKeys.IsKey(key)) throw new BridgeException("invalid", "Unknown game.");
        if (!refresh && _details.TryGet(key, out var hit)) return Refreshed(hit.Dto);

        var entry = _entries.Get(key);
        var ids = entry?.Ids ?? DiscoverKeys.IdsFromKey(key);
        var notes = new List<string>();
        string? reason = LocalOnly ? "offline" : null;

        SteamAppDetails? steam = null;
        IgdbDiscoverGame? igdb = null;
        RawgDiscoverGame? rawg = null;
        WikidataDiscoverItem? wiki = null;
        TimeToBeat? ttb = null;
        SteamTrailer? trailer = null;
        var credits = new List<DiscoverCreditDto>();

        async Task Try(string source, Func<Task> work)
        {
            try { await work(); }
            catch (DataSourceException ex)
            {
                Log.Warn("discover", "A details source failed", new { source, outcome = ex.Outcome.ToString() });
                notes.Add($"{source}:{(ex.Outcome == DataSourceOutcome.RateLimited ? "rateLimited" : ex.Outcome == DataSourceOutcome.InvalidKey ? "invalidKey" : "unavailable")}");
            }
            catch (Exception ex) when (ex is System.Text.Json.JsonException or HttpRequestException or InvalidOperationException)
            {
                Log.Warn("discover", "A details source failed", new { source, error = ex.GetType().Name });
                notes.Add($"{source}:unavailable");
            }
        }

        if (reason is null)
        {
            // 1. Wikidata for an item-only key (it often knows the Steam app ID), or to learn other stores' IDs.
            if (ids.Wikidata is { } qid && ids.Steam is null && DetailsReady(DiscoverSources.Wikidata))
                await Try(DiscoverSources.Wikidata, async () =>
                {
                    if (await _sources.Wikidata.DiscoverItemAsync(qid, ct) is { } json && DiscoverParsers.ParseWikidataItem(json, qid) is { } w)
                    {
                        wiki = w;
                        ids = ids.Merge(w.Ids);
                    }
                });
            if (ids.Steam is { } appIdForIds && DetailsReady(DiscoverSources.Wikidata))
            {
                var row = _repo.GetExternalIds("steam", appIdForIds);
                if (row is null || DateTimeOffset.UtcNow - row.Fetched > DataSourcesService.IdentityTtl)
                    await Try(DiscoverSources.Wikidata, async () =>
                    {
                        foreach (var f in await _sources.Wikidata.LookupAsync("steam", [appIdForIds], ct)) _repo.UpsertExternalIds("steam", f.Key, f.ItemId, f.Label, f.Ids);
                        row = _repo.GetExternalIds("steam", appIdForIds);
                    });
                if (row is not null) ids = ids.Merge(FromIdentity(row));
            }

            // 2. Steam's store page data (and its trailer).
            if (ids.Steam is { } appId)
            {
                if (DetailsReady(DiscoverSources.Steam))
                    await Try(DiscoverSources.Steam, async () =>
                    {
                        var json = await SteamGetAsync($"https://store.steampowered.com/api/appdetails?appids={appId}&cc={_sources.Country}&l=english", ct);
                        steam = DiscoverParsers.ParseSteamDetails(appId, json);
                        if (steam is not null)
                        {
                            try { trailer = SteamTrailers.Select(appId, json); }
                            catch (System.Text.Json.JsonException) { trailer = null; }
                        }
                    });
                else notes.Add("steam:off");
            }

            // 3. IGDB: by its ID, else by Steam app ID, else by the slug Wikidata gave.
            if (DetailsReady(DiscoverSources.Igdb))
                await Try(DiscoverSources.Igdb, async () =>
                {
                    var igdbId = ids.Igdb ?? (ids.Steam is { } s ? await _sources.Igdb.FindBySteamAppIdAsync(s, ct) : null);
                    var json = igdbId is { } id ? await _sources.Igdb.DiscoverGameAsync(id, ct)
                        : ids.IgdbSlug is { } slug ? await _sources.Igdb.DiscoverGameBySlugAsync(slug, ct) : null;
                    if (json is not null && DiscoverParsers.ParseIgdbGame(json) is { } g && !g.Ids.ConflictsWith(ids with { Igdb = null, IgdbSlug = null }))
                    {
                        igdb = g;
                        ids = ids.Merge(g.Ids);
                        ttb = await _sources.Igdb.GetTimeToBeatAsync(g.Id, ct);
                    }
                });
            else notes.Add("igdb:noKey");

            // 4. RAWG, when it adds something (its description) or the page is RAWG's own.
            if (ids.Rawg is { } rawgSlug && DetailsReady(DiscoverSources.Rawg) && (key.StartsWith("rawg-", StringComparison.Ordinal) || (steam?.Description ?? igdb?.Summary) is null))
                await Try(DiscoverSources.Rawg, async () =>
                {
                    if (await _sources.Rawg.DiscoverGameAsync(rawgSlug, ct) is { } json) rawg = DiscoverParsers.ParseRawgGame(json);
                });

            // 5. Wikidata facts as a last resort (labels only), for games no other source describes.
            if (wiki is null && steam is null && igdb is null && rawg is null && ids.Wikidata is { } q2 && DetailsReady(DiscoverSources.Wikidata))
                await Try(DiscoverSources.Wikidata, async () =>
                {
                    if (await _sources.Wikidata.DiscoverItemAsync(q2, ct) is { } json) wiki = DiscoverParsers.ParseWikidataItem(json, q2);
                });
        }
        else if (_details.TryGet(key, out var stale)) return Refreshed(stale.Dto with { Reason = "offline" });

        var title = steam?.Name ?? igdb?.Name ?? wiki?.Label ?? rawg?.Name ?? entry?.Title;
        if (title is null)
        {
            if (reason is not null) throw new BridgeException("offline", "Offline mode is on, so VYSTRAL can’t look this game up. Turn it off in Settings → Privacy.");
            throw new BridgeException("notFound", "None of the connected sources know this game any more.");
        }

        if (steam is not null) credits.Add(new DiscoverCreditDto("steam", "Steam", "Store details, price and trailer from the Steam store"));
        if (igdb is not null) credits.Add(new DiscoverCreditDto("igdb", "IGDB", "Details and time to beat from IGDB.com"));
        if (rawg is not null || entry?.Sources.Contains(DiscoverSources.Rawg) == true) credits.Add(new DiscoverCreditDto("rawg", "RAWG", "Data from RAWG.io"));
        if (wiki is not null || ids.Wikidata is not null) credits.Add(new DiscoverCreditDto("wikidata", "Wikidata", "Store IDs from Wikidata (CC0)"));

        var (description, descriptionSource) =
            steam?.Description is { } d1 ? (d1, "steam") : igdb?.Summary is { } d2 ? (d2, "igdb") : rawg?.Description is { } d3 ? (d3, "rawg")
            : wiki?.Description is { } d4 ? (d4, "wikidata") : ((string?)null, (string?)null);
        static IReadOnlyList<string> First(params IReadOnlyList<string>?[] lists) => lists.FirstOrDefault(l => l is { Count: > 0 }) ?? [];
        var releaseDate = steam?.ReleaseDate ?? igdb?.ReleaseDate ?? rawg?.ReleaseDate ?? wiki?.ReleaseDate ?? entry?.ReleaseDate;
        var year = steam?.Year ?? igdb?.Year ?? rawg?.Year ?? wiki?.Year ?? entry?.Year;
        var platforms = new List<string>();
        foreach (var list in new[] { steam?.Platforms, igdb?.Platforms, rawg?.Platforms, wiki?.Platforms, entry?.Platforms })
            foreach (var p in list ?? []) if (!platforms.Contains(p) && platforms.Count < 10) platforms.Add(p);
        var stores = new List<string>(DiscoverParsers.StoresOf(ids));
        foreach (var s in igdb?.Stores ?? []) if (!stores.Contains(s)) stores.Add(s);
        foreach (var s in entry?.Stores ?? []) if (!stores.Contains(s)) stores.Add(s);

        // Remember everything learned, so images and links work for this key.
        var remembered = entry ?? new DiscoverEntry { Key = key, Title = title };
        remembered.Ids = remembered.Ids.Merge(ids);
        var images = new List<DiscoverImage>();
        if (steam?.HeaderImage is { } header) images.Add(new DiscoverImage("header", header));
        images.AddRange(igdb?.Images ?? []);
        images.AddRange(rawg?.Images ?? []);
        foreach (var i in images) if (!remembered.Images.Contains(i) && remembered.Images.Count < 20) remembered.Images.Add(i);
        _entries.Set(key, remembered);

        string? trailerId = null;
        if (trailer is not null && ids.Steam is { } tApp && _trailers() is { } trailers)
        {
            trailerId = DiscoverKeys.TrailerId(tApp);
            trailers.RegisterExternal(trailerId, trailer);
        }

        DeckDto? deck = null;
        AntiCheatDto? antiCheat = null;
        if (ids.Steam is { } compatApp)
        {
            try
            {
                var compat = await _sources.GetCompatForSteamAppAsync(compatApp, ct);
                deck = compat.Deck is { Category: not "unknown" } dk ? dk : null;
                antiCheat = compat.AntiCheat;
            }
            catch (DataSourceException) { }
        }

        var (cloud, cloudReason) = CloudFor(title, ids.Steam);
        var links = LinksFor(ids);
        var price = steam?.Price is { } sp ? sp with { Country = _sources.Country } : null;
        var library = Library();
        var libraryId = ids.Steam is { } la && library.BySteam(la) is { } owned ? owned.GameId : MatchByTitle(library, title, year, ids.Steam);

        var dto = new DiscoverDetailsDto(
            key, title, year, releaseDate, description, descriptionSource,
            First(steam?.Genres, igdb?.Genres, rawg?.Genres, wiki?.Genres, entry?.Genres),
            First(steam?.Developers, igdb?.Developers, rawg?.Developers, wiki?.Developers),
            First(steam?.Publishers, igdb?.Publishers, rawg?.Publishers, wiki?.Publishers),
            platforms, stores, ids.Steam, libraryId, price,
            ttb is null ? null : new DiscoverTtbDto(ttb.HastilySeconds, ttb.NormallySeconds, ttb.CompletelySeconds, ttb.Count),
            steam?.Metacritic, igdb?.Rating, igdb?.RatingCount ?? 0, deck, antiCheat,
            links.Select(l => l.Dto).ToList(), cloud, cloudReason, trailerId, _watch.Contains(key), credits, notes.Distinct().ToList(),
            DateTimeOffset.UtcNow.ToString("O"), reason,
            ImageCandidates(key, "hero").Count > 0, ImageCandidates(key, "logo").Count > 0, ImageCandidates(key, "cover").Count > 0 || ids.Steam is not null);
        if (reason is null) _details.Set(key, (dto, links.ToDictionary(l => l.Dto.Id, l => l.Url)));
        return dto;
    }

    private static string? MatchByTitle(DiscoverLibraryIndex library, string title, int? year, string? steamAppId)
    {
        var c = library.ByTitle(DiscoverMerger.Norm(title)).Where(l => l.SteamAppId is null || steamAppId is null).ToList();
        if (c.Count != 1) return null;
        return c[0].Year is { } ly && year is { } y && Math.Abs(ly - y) > 1 ? null : c[0].GameId;
    }

    /// <summary>The cached details with what may have changed since (Watching, library membership).</summary>
    private DiscoverDetailsDto Refreshed(DiscoverDetailsDto d)
    {
        var library = Library();
        var libraryId = d.SteamAppId is { } a && library.BySteam(a) is { } owned ? owned.GameId : MatchByTitle(library, d.Title, d.Year, d.SteamAppId);
        return d with { Watching = _watch.Contains(d.Key), LibraryGameId = libraryId };
    }

    private static DiscoverIds FromIdentity(ExternalIdRow row)
    {
        string? Get(string name) => row.Ids.TryGetValue(name, out var v) ? v : null;
        return new DiscoverIds(
            Steam: Get("steam"), IgdbSlug: Get("igdb") is { } i && DiscoverKeys.Slug().IsMatch(i) ? i : null,
            Rawg: Get("rawg") is { } r && DiscoverKeys.Slug().IsMatch(r) ? r : null, Wikidata: row.WikidataId,
            GogId: Get("gogId"), GogPath: Get("gog") is { } g && DiscoverKeys.GogPath().IsMatch(g) ? g : null,
            Epic: Get("epic") is { } e && DiscoverKeys.Slug().IsMatch(e) ? e : null,
            Microsoft: Get("microsoft") is { } m && DiscoverKeys.MsBigId().IsMatch(m) ? m.ToLowerInvariant() : null);
    }

    /// <summary>Official store pages and reference pages, built only from validated IDs.</summary>
    internal static IReadOnlyList<(DiscoverLinkDto Dto, string Url)> LinksFor(DiscoverIds ids)
    {
        var list = new List<(DiscoverLinkDto, string)>();
        if (ids.Steam is { } s && DiscoverKeys.SteamAppId().IsMatch(s)) list.Add((new("steam", "Steam", "steam", "store"), $"https://store.steampowered.com/app/{s}/"));
        if (ids.GogPath is { } g && DiscoverKeys.GogPath().IsMatch(g)) list.Add((new("gog", "GOG", "gog", "store"), $"https://www.gog.com/en/{g}"));
        if (ids.Epic is { } e && DiscoverKeys.Slug().IsMatch(e)) list.Add((new("epic", "Epic Games Store", "epic", "store"), $"https://store.epicgames.com/p/{e}"));
        if (ids.Microsoft is { } m && DiscoverKeys.MsBigId().IsMatch(m))
            list.Add((new("microsoft", "Microsoft Store", "xbox", "store"), $"https://apps.microsoft.com/detail/{m.ToUpperInvariant()}"));
        if (ids.IgdbSlug is { } i && DiscoverKeys.Slug().IsMatch(i)) list.Add((new("igdb", "IGDB", null, "info"), $"https://www.igdb.com/games/{i}"));
        if (ids.Rawg is { } r && DiscoverKeys.Slug().IsMatch(r)) list.Add((new("rawg", "RAWG", null, "info"), $"https://rawg.io/games/{r}"));
        if (ids.Wikidata is { } q && DiscoverKeys.Qid().IsMatch(q)) list.Add((new("wikidata", "Wikidata", null, "info"), $"https://www.wikidata.org/wiki/{q}"));
        return list;
    }

    /// <summary>The URL behind one of a page's links (the page only sends the key and the link's name).</summary>
    public string? LinkUrl(string key, string link)
    {
        if (_details.TryGet(key, out var d) && d.Links.TryGetValue(link, out var url)) return url;
        return LinksFor(IdsFor(key)).FirstOrDefault(l => l.Dto.Id == link).Url;
    }

    /// <summary>
    /// Whether a cloud catalogue VYSTRAL already downloaded lists this game. GeForce NOW is matched only by Steam app ID
    /// (a verified store ID: you'd stream your own Steam copy); Xbox Cloud Gaming by an unambiguous title (a likely match,
    /// labelled as such). Needs cloud play to be on, since the catalogues are only downloaded then. No request is made.
    /// </summary>
    internal (IReadOnlyList<DiscoverCloudDto> Options, string? Reason) CloudFor(string title, string? steamAppId)
    {
        var cloud = _cloud();
        if (cloud is null || !cloud.Enabled) return ([], "off");
        var (market, _) = cloud.Market;
        var copies = steamAppId is not null ? new List<CloudLibraryCopy> { new(CloudStores.Steam, steamAppId, title) } : [new("discover", "", title)];
        var game = new CloudLibraryGame("discover", title, steamAppId, copies);
        var options = new List<DiscoverCloudDto>();
        var anyData = false;
        foreach (var service in CloudServices.All)
        {
            if (!cloud.ServiceOn(service)) continue;
            var catalog = _repo.GetCloudCatalog(service, market);
            if (catalog.Count > 0) anyData = true;
            foreach (var m in CloudMatcher.Match(service, catalog, [game], new Dictionary<string, string>()))
            {
                var byStore = m.Kind == CloudMatchKind.StoreId;
                var note = service == CloudServices.GeForceNow
                    ? (m.Entry.PlayType == CloudPlayTypes.InstallToPlay ? "Listed for Steam as Install-to-Play (Performance or Ultimate). You’d stream a copy you own." : "Listed for Steam. You’d stream a copy you own.")
                    : byStore ? "Listed on Xbox Cloud Gaming." : "Likely match by title: Xbox Cloud Gaming may include it with Game Pass. xbox.com shows the final answer.";
                options.Add(new DiscoverCloudDto(service, CloudServices.DisplayName(service), m.Entry.PlayType, m.Entry.Premium, byStore ? "store" : "title", note));
            }
        }
        return (options, options.Count > 0 ? null : anyData ? "none" : "noData");
    }

    // ---------------- deals, watching ----------------

    public string? SteamAppIdFor(string key) => _details.TryGet(key, out var d) ? d.Dto.SteamAppId : IdsFor(key).Steam;

    public async Task<DealsDto> DealsAsync(string key, bool refresh, CancellationToken ct) =>
        await _sources.GetDealsForSteamAppAsync(SteamAppIdFor(key), refresh, ct);

    public string? OfferUrl(string key, string offerId) => _sources.OfferUrlForSteamApp(SteamAppIdFor(key), offerId);

    public IReadOnlyList<DiscoverWatchDto> Watching() =>
        _watch.List().Select(w => new DiscoverWatchDto(w.Key, w.Title, w.Year, w.SteamAppId, w.AddedAt, w.PriceWhenAdded,
            _images.Get($"{w.Key}|cover") is { Length: > 0 } c ? c
            : w.SteamAppId is { } s ? DiscoverParsers.SteamFlatImages(s).Where(i => i.Kind == "cover").Select(i => _artwork.CachedDiscoverImage(i.Url)).FirstOrDefault(u => u is not null)
            : null)).ToList();

    public IReadOnlyList<DiscoverWatchDto> SetWatching(string key, bool on)
    {
        if (on)
        {
            var d = _details.TryGet(key, out var hit) ? hit.Dto : null;
            var e = _entries.Get(key);
            var title = d?.Title ?? e?.Title ?? throw new BridgeException("notFound", "Open the game’s page first, then watch it.");
            _watch.Set(new DiscoverWatchItem(key, title, d?.Year ?? e?.Year, d?.SteamAppId ?? e?.Ids.Steam, DateTimeOffset.UtcNow.ToString("O"), d?.Price?.Formatted), true);
        }
        else _watch.Set(new DiscoverWatchItem(key, "-", null, null, DateTimeOffset.UtcNow.ToString("O"), null), false);
        if (_details.TryGet(key, out var cached)) _details.Set(key, (cached.Dto with { Watching = on }, cached.Links));
        return Watching();
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();
}
