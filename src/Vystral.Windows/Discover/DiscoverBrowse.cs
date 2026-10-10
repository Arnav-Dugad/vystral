using System.Globalization;
using System.Text.Json;
using Vystral.Core.Data;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;

namespace Vystral.Windows.Discover;

/// <summary>A library game a "Because you played" shelf starts from, and why it was picked.</summary>
internal sealed record DiscoverSeed(DiscoverSeedRow Row, string Why);

/// <summary>
/// Track C3: Discover's browse shelves, before anything is typed.
/// <list type="bullet">
/// <item><b>Steam store shelves</b> (opt-in, <c>discover.storeShelves</c>): Steam's public featured lists
/// (<c>store.steampowered.com/api/featuredcategories</c>, undocumented, so opt-in), checked against the store's documented,
/// keyless item facts (<c>IStoreBrowseService/GetItems</c>) so only games are shown (no DLC, soundtracks or hardware) and
/// nothing Steam itself hides by default (adult-only content); "Free to play" and genre pages come from the store's
/// keyless query (<c>IStoreQueryService/Query</c>). At most one refresh every three hours per price country, a manual refresh
/// at most every five minutes, a back-off after errors, and the last good copy kept in the database cache.</item>
/// <item><b>Because you played</b>: up to four library games you played recently or most. IGDB's similar_games with the
/// user's key; without IGDB, Steam's tags (when the store shelves are on). Cached per game for a week; games you already
/// own (by Steam app ID, IGDB ID, or an exact title and year) are left out every time the shelves are built.</item>
/// </list>
/// Nothing here runs in Offline mode (saved shelves are still shown), and the user's keys never go to Steam.
/// </summary>
public sealed partial class DiscoverService
{
    public const string StoreShelvesSetting = "discover.storeShelves";
    public static readonly TimeSpan FeaturedTtl = TimeSpan.FromHours(3);
    public static readonly TimeSpan SimilarTtl = TimeSpan.FromDays(7);
    public static readonly TimeSpan SimilarMissTtl = TimeSpan.FromDays(1);
    public static readonly TimeSpan MinManualRefresh = TimeSpan.FromMinutes(5);
    public const int ShelfMax = 18;
    public const int ShelfMin = 3;
    public const int MaxSeeds = 4;
    public const int GenrePageSize = 24;

    internal const string FeaturedCacheProvider = "discover-featured";
    internal const string SimilarCacheProvider = "discover-similar";
    internal const string IgdbIdCacheProvider = "discover-igdbid";

    private static readonly JsonSerializerOptions CacheJson = new(JsonSerializerDefaults.Web);

    private bool StoreShelves => _settings.GetBool(StoreShelvesSetting);

    private readonly SemaphoreSlim _featuredGate = new(1, 1);
    private readonly SemaphoreSlim _similarGate = new(1, 1);
    private readonly Backoff _featuredBackoff = new();
    private readonly Backoff _similarBackoff = new();
    private readonly Backoff _genreBackoff = new();
    private readonly LruCache<string, (List<DiscoverResultDto> Results, bool HasMore)> _genrePages = new(80, TimeSpan.FromHours(6));
    private HashSet<long> _libraryIgdb = [];
    private DateTimeOffset _libraryIgdbAt = DateTimeOffset.MinValue;

    /// <summary>Test hook for the clock.</summary>
    internal Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

    /// <summary>Waits longer after each failure (15 min, 30 min … 6 h); a success clears it.</summary>
    private sealed class Backoff
    {
        private int _failures;
        private DateTimeOffset _until = DateTimeOffset.MinValue;
        public string? Reason { get; private set; }
        public bool Blocked(DateTimeOffset now) => now < _until;
        public void Fail(DateTimeOffset now, string reason)
        {
            _failures = Math.Min(_failures + 1, 6);
            _until = now + TimeSpan.FromMinutes(Math.Min(360, 15 * Math.Pow(2, _failures - 1)));
            Reason = reason;
        }
        public void Ok()
        {
            _failures = 0;
            _until = DateTimeOffset.MinValue;
            Reason = null;
        }
    }

    // ---------------- cache shapes (database cache, re-validated on read) ----------------

    internal sealed record CachedItem(string AppId, string Title, int? Year, string? ReleaseDate, bool ComingSoon, bool Free, StorePrice? Price,
        string? PriceText, int DiscountPercent, List<string> Platforms, List<string> Genres, List<DiscoverImage> Images);

    internal sealed record CachedShelf(string Id, List<CachedItem> Items);

    internal sealed record FeaturedBody(List<CachedShelf> Shelves);

    internal sealed record SimilarBody(string Source, List<string> Basis, List<DiscoverHit> Hits);

    private static string? Reason(DataSourceException ex) => ex.Outcome switch
    {
        DataSourceOutcome.RateLimited => "rateLimited",
        DataSourceOutcome.InvalidKey => "invalidKey",
        DataSourceOutcome.Offline => "offline",
        _ => "unavailable",
    };

    // ================= Steam store shelves =================

    public async Task<DiscoverFeaturedDto> FeaturedAsync(bool refresh, CancellationToken ct)
    {
        if (!StoreShelves) return new DiscoverFeaturedDto("off", null, null, false, []);
        var country = _sources.Country;
        var cached = ReadFeatured(country);
        var now = Now();
        if (LocalOnly)
            return cached is { } off ? FeaturedDto("offline", "offline", off, stale: true) : new DiscoverFeaturedDto("offline", "offline", null, false, []);
        var wantNew = cached is null || !cached.Value.Fresh || refresh && now - cached.Value.Fetched > MinManualRefresh;
        if (!wantNew) return FeaturedDto("ready", null, cached!.Value, stale: false);
        if (_featuredBackoff.Blocked(now))
            return cached is { } c0 ? FeaturedDto("ready", _featuredBackoff.Reason, c0, stale: true) : new DiscoverFeaturedDto("failed", _featuredBackoff.Reason, null, false, []);

        await _featuredGate.WaitAsync(ct);
        try
        {
            // Another caller may have refreshed while this one waited.
            var again = ReadFeatured(country);
            if (again is { } a && Now() - a.Fetched < MinManualRefresh) return FeaturedDto("ready", null, a, stale: false);
            try
            {
                var body = await FetchFeaturedAsync(country, ct);
                _repo.SetProviderCache(FeaturedCacheProvider, country, JsonSerializer.Serialize(body, CacheJson), FeaturedTtl);
                _featuredBackoff.Ok();
                return FeaturedDto("ready", null, (body, Now(), true), stale: false);
            }
            catch (Exception ex) when (ex is DataSourceException or JsonException or HttpRequestException or InvalidOperationException)
            {
                var reason = ex is DataSourceException dse ? Reason(dse) : "unavailable";
                Log.Warn("discover", "Steam store shelves failed", new { error = ex.GetType().Name, reason });
                _featuredBackoff.Fail(Now(), reason ?? "unavailable");
                return cached is { } c1 ? FeaturedDto("ready", reason, c1, stale: true) : new DiscoverFeaturedDto("failed", reason, null, false, []);
            }
        }
        finally
        {
            _featuredGate.Release();
        }
    }

    private (FeaturedBody Body, DateTimeOffset Fetched, bool Fresh)? ReadFeatured(string country)
    {
        if (_repo.GetProviderCache(FeaturedCacheProvider, country) is not { } row) return null;
        try
        {
            return JsonSerializer.Deserialize<FeaturedBody>(row.Body, CacheJson) is { Shelves: not null } body ? (body, row.Fetched, row.Fresh && Now() - row.Fetched < FeaturedTtl) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private DiscoverFeaturedDto FeaturedDto(string state, string? reason, (FeaturedBody Body, DateTimeOffset Fetched, bool Fresh) data, bool stale)
    {
        var library = Library();
        var shelves = new List<DiscoverShelfDto>();
        foreach (var shelf in data.Body.Shelves)
        {
            if (shelf?.Id is null || !FeaturedTitles.TryGetValue(shelf.Id, out var title)) continue;
            var items = (shelf.Items ?? []).Select(i => BrowseDto(i, library)).OfType<DiscoverResultDto>().Take(ShelfMax).ToList();
            if (items.Count >= ShelfMin) shelves.Add(new DiscoverShelfDto(shelf.Id, "store", title.Title, title.Reason, "steam", null, items));
        }
        return new DiscoverFeaturedDto(shelves.Count == 0 && state == "ready" ? "failed" : state, shelves.Count == 0 && state == "ready" ? reason ?? "empty" : reason,
            data.Fetched.ToString("O", CultureInfo.InvariantCulture), stale, shelves);
    }

    private static readonly Dictionary<string, (string Title, string Reason)> FeaturedTitles = new(StringComparer.Ordinal)
    {
        ["trending"] = ("Trending on Steam", "Steam’s top sellers right now"),
        ["specials"] = ("Deals on Steam", "Steam’s featured discounts"),
        ["newReleases"] = ("New releases", "Just out on Steam"),
        ["comingSoon"] = ("Coming soon", "Soon on Steam"),
        ["free"] = ("Free to play", "Popular free games on Steam"),
    };

    internal async Task<FeaturedBody> FetchFeaturedAsync(string country, CancellationToken ct)
    {
        var featured = DiscoverBrowseParsers.ParseFeaturedCategories(await SteamGetAsync(
            $"https://store.steampowered.com/api/featuredcategories/?cc={country}&l=english", ct));
        var ids = featured.Sections.Values.SelectMany(x => x).Select(i => i.AppId).Distinct().Take(150).ToList();
        var facts = new Dictionary<string, SteamStoreFacts>(StringComparer.Ordinal);
        foreach (var chunk in ids.Chunk(50))
            foreach (var f in DiscoverBrowseParsers.ParseStoreItems(await SteamGetAsync(StoreItemsUrl(chunk, country, tags: 8), ct)))
                facts[f.AppId] = f;

        // Free to play: the store's own query (games only, released, free), in its popularity order.
        var free = DiscoverBrowseParsers.ParseStoreQuery(await SteamGetAsync(StoreQueryUrl(country, 0, 40,
            new { released_only = true, type_filters = new { include_games = true }, price_filters = new { only_free_items = true } }), ct));

        List<CachedItem> Shelf(string section, Func<SteamFeaturedItem, SteamStoreFacts, bool> keep)
        {
            var list = new List<CachedItem>();
            foreach (var fi in featured.Sections.GetValueOrDefault(section) ?? [])
            {
                // Only what the store confirms is a game anyone can see (no DLC, soundtracks, hardware or adult-only content).
                if (!facts.TryGetValue(fi.AppId, out var f) || !f.Showable || !keep(fi, f)) continue;
                list.Add(ToCached(f, fi.Price, fi.Price is null ? f.PriceText : null, fi.Price is null ? f.DiscountPercent : fi.DiscountPercent, fi.Platforms, fi.Images));
            }
            return list;
        }

        var specials = Shelf("daily_deal", (fi, _) => fi.DiscountPercent > 0).Concat(Shelf("specials", (fi, _) => fi.DiscountPercent > 0))
            .DistinctBy(i => i.AppId).ToList();
        return new FeaturedBody(
        [
            new("trending", Shelf("top_sellers", (_, _) => true)),
            new("specials", specials),
            new("newReleases", Shelf("new_releases", (fi, f) => !f.ComingSoon && (f.Free || fi.Price is { FinalCents: > 0 }))),
            new("comingSoon", Shelf("coming_soon", (_, f) => f.ComingSoon)),
            new("free", free.Items.Where(f => f.Showable && f.Free && !f.ComingSoon).Take(ShelfMax + 6)
                .Select(f => ToCached(f, null, null, 0, [], [])).ToList()),
        ]);
    }

    private static CachedItem ToCached(SteamStoreFacts f, StorePrice? price, string? priceText, int cut, IReadOnlyList<string> platforms, IReadOnlyList<DiscoverImage> extraImages)
    {
        var images = f.Images.Concat(extraImages).Distinct().Take(8).ToList();
        var genres = f.TagIds.Select(DiscoverBrowseParsers.TagName).OfType<string>().Distinct().Take(3).ToList();
        return new CachedItem(f.AppId, f.Name, f.Year, f.ReleaseDate, f.ComingSoon, f.Free, f.Free ? null : price, f.Free ? null : priceText, f.Free ? 0 : cut,
            [.. platforms], genres, images);
    }

    /// <summary>A shelf item as a result card, re-validated (the cache lives in the database) and marked when it's in the library.</summary>
    private DiscoverResultDto? BrowseDto(CachedItem i, DiscoverLibraryIndex library)
    {
        if (i is null || !DiscoverKeys.SteamAppId().IsMatch(i.AppId ?? "") || string.IsNullOrWhiteSpace(i.Title)) return null;
        var key = $"steam-{i.AppId}";
        var title = MetadataService.Clean(i.Title, 200);
        var images = (i.Images ?? []).Where(x => x is not null && x.Kind is "cover" or "hero" or "header" && DiscoverParsers.SafeImage(x.Url) is not null).Take(8).ToList();
        RememberBrowse(key, title, i.Year, i.ReleaseDate, new DiscoverIds(Steam: i.AppId), images);
        var price = i.Price is { } p && p.FinalCents >= 0 && p.InitialCents >= p.FinalCents && p.Currency is { Length: 3 } c && c.All(char.IsAsciiLetterUpper) ? p : null;
        return new DiscoverResultDto(key, title, i.Year is > 1950 and < 2200 ? i.Year : null, ["steam"], Cap(i.Platforms, 4), Cap(i.Genres, 3), [DiscoverSources.Steam], i.AppId,
            library.BySteam(i.AppId!)?.GameId, price, true, _images.Get($"{key}|cover") is { Length: > 0 } cover ? cover : null, 0, "game",
            i.ReleaseDate is { Length: 7 or 10 } d && d.All(ch => char.IsAsciiDigit(ch) || ch == '-') ? d : null, i.ComingSoon, i.Free,
            price is null && i.PriceText is { } t ? MetadataService.Clean(t, 24) : null, price is null ? Math.Clamp(i.DiscountPercent, 0, 100) : 0);

        static IReadOnlyList<string> Cap(List<string>? list, int n) => (list ?? []).Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => MetadataService.Clean(s, 40)).Take(n).ToList();
    }

    /// <summary>Lets images and the game's page work for a shelf item, without dropping what a search already learned about it.</summary>
    private void RememberBrowse(string key, string title, int? year, string? releaseDate, DiscoverIds ids, IReadOnlyList<DiscoverImage> images)
    {
        if (_entries.TryGet(key, out var known))
        {
            foreach (var img in images) if (!known.Images.Contains(img) && known.Images.Count < 20) known.Images.Add(img);
            return;
        }
        var e = new DiscoverEntry { Key = key, Title = title, Year = year, ReleaseDate = releaseDate, Ids = ids };
        e.Stores.Add("steam");
        e.Sources.Add(DiscoverSources.Steam);
        e.Images.AddRange(images);
        _entries.Set(key, e);
    }

    private static string StoreItemsUrl(IEnumerable<string> appIds, string country, int tags) =>
        "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=" + Uri.EscapeDataString(JsonSerializer.Serialize(new
        {
            ids = appIds.Select(id => new { appid = long.Parse(id, CultureInfo.InvariantCulture) }).ToArray(),
            context = new { language = "english", country_code = country },
            data_request = new { include_assets = true, include_release = true, include_tag_count = tags },
        }));

    private static string StoreQueryUrl(string country, int start, int count, object filters) =>
        "https://api.steampowered.com/IStoreQueryService/Query/v1/?input_json=" + Uri.EscapeDataString(JsonSerializer.Serialize(new
        {
            query = new { start, count, sort = 10, filters },
            context = new { language = "english", country_code = country },
            data_request = new { include_assets = true, include_release = true, include_all_purchase_options = true, include_tag_count = 8 },
        }));

    // ================= Because you played =================

    /// <summary>
    /// Up to <paramref name="max"/> seeds: the two games played most recently (in the last 45 days), then the most played
    /// (an hour at least; VYSTRAL's sessions or the store's playtime, whichever is larger).
    /// </summary>
    internal static IReadOnlyList<DiscoverSeed> PickSeeds(IEnumerable<DiscoverSeedRow> rows, DateTimeOffset now, int max = MaxSeeds)
    {
        var list = rows.ToList();
        var picked = new List<DiscoverSeed>();
        foreach (var r in list.Where(r => r.LastPlayed is { } l && l <= now.AddDays(1) && now - l < TimeSpan.FromDays(45))
                     .OrderByDescending(r => r.LastPlayed).ThenBy(r => r.Title, StringComparer.OrdinalIgnoreCase).Take(Math.Min(2, max)))
            picked.Add(new DiscoverSeed(r, "recent"));
        foreach (var r in list.Where(r => picked.All(p => p.Row.Id != r.Id))
                     .Select(r => (Row: r, Seconds: Math.Max(r.TrackedSeconds, r.ImportedMinutes * 60)))
                     .Where(x => x.Seconds >= 3600)
                     .OrderByDescending(x => x.Seconds).ThenBy(x => x.Row.Title, StringComparer.OrdinalIgnoreCase)
                     .Select(x => x.Row).Take(max - picked.Count))
            picked.Add(new DiscoverSeed(r, "mostPlayed"));
        return picked;
    }

    private HashSet<long> LibraryIgdb()
    {
        if (Now() - _libraryIgdbAt < TimeSpan.FromSeconds(30)) return _libraryIgdb;
        _libraryIgdb = [.. _repo.GetDiscoverLibraryIgdbIds()];
        _libraryIgdbAt = Now();
        return _libraryIgdb;
    }

    public async Task<DiscoverSimilarDto> SimilarAsync(bool refresh, CancellationToken ct)
    {
        var seeds = PickSeeds(_repo.GetDiscoverSeeds(), Now());
        if (seeds.Count == 0) return new DiscoverSimilarDto("noSeeds", null, null, null, false, []);
        var source = _sources.HasKey(KeyedProvider.Igdb) ? "igdb" : StoreShelves ? "steam" : null;
        if (source is null) return new DiscoverSimilarDto("noSource", null, null, null, false, []);

        var cached = seeds.ToDictionary(s => s.Row.Id, s => ReadSimilar(source, s.Row.Id));
        if (LocalOnly) return SimilarDto(seeds, cached, source, "offline", "offline", stale: true);
        if (!SearchOnline) return new DiscoverSimilarDto("off", source, "off", null, false, []);

        var now = Now();
        var missing = seeds.Where(s => cached[s.Row.Id] is not { } c || !c.Fresh || refresh && now - c.Fetched > MinManualRefresh).ToList();
        string? reason = null;
        var stale = false;
        if (missing.Count > 0)
        {
            if (_similarBackoff.Blocked(now))
            {
                reason = _similarBackoff.Reason;
                stale = true;
            }
            else
            {
                await _similarGate.WaitAsync(ct);
                try
                {
                    if (source == "igdb") await FetchSimilarIgdbAsync(missing, ct);
                    else await FetchSimilarSteamAsync(missing, ct);
                    _similarBackoff.Ok();
                }
                catch (Exception ex) when (ex is DataSourceException or JsonException or HttpRequestException or InvalidOperationException)
                {
                    reason = ex is DataSourceException dse ? Reason(dse) : "unavailable";
                    Log.Warn("discover", "Because-you-played suggestions failed", new { source, error = ex.GetType().Name, reason });
                    _similarBackoff.Fail(Now(), reason ?? "unavailable");
                    stale = true;
                }
                finally
                {
                    _similarGate.Release();
                }
                foreach (var s in missing) cached[s.Row.Id] = ReadSimilar(source, s.Row.Id) ?? cached[s.Row.Id];
            }
        }
        var dto = SimilarDto(seeds, cached, source, "ready", reason, stale);
        return dto.Shelves.Count == 0 && reason is not null ? dto with { State = "failed" } : dto;
    }

    private (SimilarBody Body, DateTimeOffset Fetched, bool Fresh)? ReadSimilar(string source, string gameId)
    {
        if (_repo.GetProviderCache(SimilarCacheProvider, $"{source}:{gameId}") is not { } row) return null;
        try
        {
            return JsonSerializer.Deserialize<SimilarBody>(row.Body, CacheJson) is { Hits: not null } body && body.Source == source ? (body, row.Fetched, row.Fresh && Now() - row.Fetched < (body.Hits.Count == 0 ? SimilarMissTtl : SimilarTtl)) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private void WriteSimilar(string source, string gameId, List<string> basis, List<DiscoverHit> hits) =>
        _repo.SetProviderCache(SimilarCacheProvider, $"{source}:{gameId}", JsonSerializer.Serialize(new SimilarBody(source, basis, hits), CacheJson),
            hits.Count == 0 ? SimilarMissTtl : SimilarTtl);

    private DiscoverSimilarDto SimilarDto(IReadOnlyList<DiscoverSeed> seeds, Dictionary<string, (SimilarBody Body, DateTimeOffset Fetched, bool Fresh)?> cached,
        string source, string state, string? reason, bool stale)
    {
        var library = Library();
        var ownedIgdb = LibraryIgdb();
        var shown = new HashSet<string>(StringComparer.Ordinal);
        var shelves = new List<DiscoverShelfDto>();
        DateTimeOffset? oldest = null;
        foreach (var seed in seeds)
        {
            if (cached.GetValueOrDefault(seed.Row.Id) is not { } c) continue;
            oldest = oldest is null || c.Fetched < oldest ? c.Fetched : oldest;
            var items = new List<DiscoverResultDto>();
            foreach (var hit in (c.Body.Hits ?? []).Where(Valid).OrderBy(h => h.Rank))
            {
                if (hit.Kind != "game" || IsSeed(hit, seed.Row)) continue;
                if (hit.Ids.Igdb is { } ig && ownedIgdb.Contains(ig)) continue;
                var e = DiscoverMerger.Merge([hit], "", library)[0];
                if (e.LibraryGameId is not null || !shown.Add(e.Key)) continue;
                RememberEntry(e);
                items.Add(ToDto(e));
                if (items.Count >= ShelfMax) break;
            }
            if (items.Count < ShelfMin) continue;
            var basis = (c.Body.Basis ?? []).Where(b => !string.IsNullOrWhiteSpace(b)).Take(3).Select(b => MetadataService.Clean(b, 40)).ToList();
            var why = source == "igdb" ? "Similar games, according to IGDB"
                : basis.Count > 0 ? $"Shares Steam tags: {string.Join(", ", basis)}" : "Shares its Steam tags";
            shelves.Add(new DiscoverShelfDto($"because:{seed.Row.Id}", "because", $"Because you played {seed.Row.Title}", why, source,
                new DiscoverShelfSeedDto(seed.Row.Id, seed.Row.Title, seed.Why), items));
        }
        return new DiscoverSimilarDto(state, source, reason, oldest?.ToString("O", CultureInfo.InvariantCulture), stale, shelves);
    }

    /// <summary>A cached hit is used only if its identifiers still have the strict shapes (the cache lives in the database).</summary>
    private static bool Valid(DiscoverHit h) =>
        h is { Title.Length: > 0 and <= 200, Ids: not null } && (h.Ids.Steam is null || DiscoverKeys.SteamAppId().IsMatch(h.Ids.Steam)) &&
        (h.Ids.Rawg is null || DiscoverKeys.Slug().IsMatch(h.Ids.Rawg)) && (h.Ids.IgdbSlug is null || DiscoverKeys.Slug().IsMatch(h.Ids.IgdbSlug)) &&
        (h.Ids.Wikidata is null || DiscoverKeys.Qid().IsMatch(h.Ids.Wikidata)) && (h.Ids.Epic is null || DiscoverKeys.Slug().IsMatch(h.Ids.Epic)) &&
        (h.Ids.GogPath is null || DiscoverKeys.GogPath().IsMatch(h.Ids.GogPath)) && (h.Ids.Microsoft is null || DiscoverKeys.MsBigId().IsMatch(h.Ids.Microsoft)) &&
        h.Ids.Igdb is null or (> 0 and < 1_000_000_000_000) && h.Images is not null && h.Images.All(i => DiscoverParsers.SafeImage(i.Url) is not null) &&
        h.Stores is not null && h.Platforms is not null && h.Genres is not null;

    private static bool IsSeed(DiscoverHit h, DiscoverSeedRow seed) =>
        h.Ids.Steam is { } s && s == seed.SteamAppId ||
        h.Ids.Igdb is { } i && seed.IgdbId == i.ToString(CultureInfo.InvariantCulture) ||
        DiscoverMerger.Norm(h.Title) == DiscoverMerger.Norm(seed.Title);

    private async Task FetchSimilarIgdbAsync(IReadOnlyList<DiscoverSeed> seeds, CancellationToken ct)
    {
        // 1. Each seed's IGDB ID: from enrichment, else by its Steam app ID (remembered for 30 days).
        var igdbOf = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var s in seeds)
        {
            if (long.TryParse(s.Row.IgdbId, NumberStyles.None, CultureInfo.InvariantCulture, out var known) && known > 0)
            {
                igdbOf[s.Row.Id] = known;
                continue;
            }
            if (s.Row.SteamAppId is not { } app) continue;
            if (_repo.GetProviderCache(IgdbIdCacheProvider, app) is { Fresh: true } idRow)
            {
                if (long.TryParse(idRow.Body, NumberStyles.None, CultureInfo.InvariantCulture, out var cachedId) && cachedId > 0) igdbOf[s.Row.Id] = cachedId;
                continue;
            }
            var found = await _sources.Igdb.FindBySteamAppIdAsync(app, ct);
            _repo.SetProviderCache(IgdbIdCacheProvider, app, (found ?? 0).ToString(CultureInfo.InvariantCulture), TimeSpan.FromDays(found is null ? 3 : 30));
            if (found is { } f) igdbOf[s.Row.Id] = f;
        }

        // 2. Their similar_games lists, then those games in batches of 40.
        var similar = igdbOf.Count == 0 ? new Dictionary<long, IReadOnlyList<long>>()
            : DiscoverBrowseParsers.ParseIgdbSimilar(await _sources.Igdb.DiscoverSimilarIdsAsync(igdbOf.Values.Distinct().ToList(), ct));
        var wanted = similar.Values.SelectMany(x => x).Distinct().Take(120).ToList();
        var byId = new Dictionary<long, DiscoverHit>();
        foreach (var chunk in wanted.Chunk(DiscoverParsers.MaxHitsPerSource))
            foreach (var h in DiscoverParsers.ParseIgdbSearch(await _sources.Igdb.DiscoverGamesByIdsAsync(chunk, ct)))
                if (h.Ids.Igdb is { } id) byId.TryAdd(id, h);

        foreach (var s in seeds)
        {
            var list = igdbOf.TryGetValue(s.Row.Id, out var seedId) && similar.TryGetValue(seedId, out var ids)
                ? ids.Select((id, rank) => byId.TryGetValue(id, out var h) ? h with { Rank = rank } : null).OfType<DiscoverHit>().ToList()
                : [];
            WriteSimilar("igdb", s.Row.Id, [], list);
        }
    }

    private async Task FetchSimilarSteamAsync(IReadOnlyList<DiscoverSeed> seeds, CancellationToken ct)
    {
        var country = _sources.Country;
        var withApp = seeds.Where(s => s.Row.SteamAppId is not null).ToList();
        var facts = withApp.Count == 0 ? []
            : DiscoverBrowseParsers.ParseStoreItems(await SteamGetAsync(StoreItemsUrl(withApp.Select(s => s.Row.SteamAppId!), country, tags: 10), ct))
                .ToDictionary(f => f.AppId, StringComparer.Ordinal);
        foreach (var s in seeds)
        {
            if (s.Row.SteamAppId is not { } app || !facts.TryGetValue(app, out var f) || f.TagIds.Count == 0)
            {
                WriteSimilar("steam", s.Row.Id, [], []);
                continue;
            }
            // The two most telling tags (broad ones like "Singleplayer" only when nothing else is known).
            var tags = f.TagIds.Where(t => !DiscoverGenres.BroadTags.Contains(t)).Take(2).ToList();
            if (tags.Count == 0) tags = f.TagIds.Take(2).ToList();
            var page = await TagQueryAsync(tags, country, ct);
            if (page.Count < 8 && tags.Count > 1) page = await TagQueryAsync(tags.Take(1).ToList(), country, ct);
            var basis = tags.Select(DiscoverBrowseParsers.TagName).OfType<string>().ToList();
            var hits = page.Select((x, rank) => new DiscoverHit(DiscoverSources.Steam, x.AppId, x.Name, x.Year, x.ReleaseDate, rank, new DiscoverIds(Steam: x.AppId),
                ["steam"], [], x.TagIds.Select(DiscoverBrowseParsers.TagName).OfType<string>().Distinct().Take(3).ToList(), x.Images)).ToList();
            WriteSimilar("steam", s.Row.Id, basis, hits);
        }
    }

    private async Task<List<SteamStoreFacts>> TagQueryAsync(IReadOnlyList<int> tags, string country, CancellationToken ct) =>
        DiscoverBrowseParsers.ParseStoreQuery(await SteamGetAsync(StoreQueryUrl(country, 0, 40, new
        {
            released_only = true,
            type_filters = new { include_games = true },
            tagids_must_match = tags.Select(t => new { tagids = new[] { t } }).ToArray(),
        }), ct)).Items.Where(x => x.Showable).ToList();

    // ================= Genres and tags =================

    public async Task<DiscoverGenreDto> GenreAsync(string genreId, int page, CancellationToken ct)
    {
        var g = DiscoverGenres.ById.GetValueOrDefault(genreId) ?? throw new Vystral.Windows.Bridge.BridgeException("invalid", "Unknown genre.");
        page = Math.Clamp(page, 0, MaxPages - 1);
        var source = StoreShelves ? "steam" : _sources.HasKey(KeyedProvider.Igdb) ? "igdb" : null;
        DiscoverGenreDto Dto(string state, string? reason, List<DiscoverResultDto> results, bool hasMore) =>
            new(g.Id, g.Label, state, source, reason, page, hasMore, results.Select(Owned).ToList());
        if (source is null) return Dto("noSource", null, [], false);
        var key = $"{g.Id}|{page}|{source}|{_sources.Country}";
        var hit = _genrePages.TryGet(key, out var c) ? c : ((List<DiscoverResultDto>, bool)?)null;
        if (LocalOnly) return hit is { } h0 ? Dto("ready", "offline", h0.Item1, false) : Dto("offline", "offline", [], false);
        if (source == "igdb" && !SearchOnline) return Dto("off", "off", [], false);
        if (hit is { } h1) return Dto("ready", null, h1.Item1, h1.Item2);
        if (_genreBackoff.Blocked(Now())) return Dto("failed", _genreBackoff.Reason, [], false);
        try
        {
            List<DiscoverResultDto> results;
            bool hasMore;
            if (source == "steam")
            {
                var country = _sources.Country;
                var q = DiscoverBrowseParsers.ParseStoreQuery(await SteamGetAsync(StoreQueryUrl(country, page * GenrePageSize, GenrePageSize, new
                {
                    released_only = true,
                    type_filters = new { include_games = true },
                    tagids_must_match = new[] { new { tagids = new[] { g.SteamTag } } },
                }), ct));
                var library = Library();
                results = q.Items.Where(x => x.Showable)
                    .Select(x => BrowseDto(ToCached(x, null, x.PriceText, x.DiscountPercent, [], []), library)).OfType<DiscoverResultDto>().ToList();
                hasMore = q.Total > (page + 1) * GenrePageSize && page + 1 < MaxPages;
            }
            else
            {
                var hits = DiscoverParsers.ParseIgdbSearch(await _sources.Igdb.DiscoverGenreAsync(g.IgdbField, g.IgdbId, page, ct), page * IgdbClient.DiscoverPageSize);
                var library = Library();
                results = [];
                foreach (var h in hits.Where(h => h.Kind == "game"))
                {
                    var e = DiscoverMerger.Merge([h], "", library)[0];
                    RememberEntry(e);
                    results.Add(ToDto(e));
                }
                hasMore = hits.Count >= IgdbClient.DiscoverPageSize && page + 1 < MaxPages;
            }
            _genrePages.Set(key, (results, hasMore));
            _genreBackoff.Ok();
            return Dto("ready", null, results, hasMore);
        }
        catch (Exception ex) when (ex is DataSourceException or JsonException or HttpRequestException or InvalidOperationException)
        {
            var reason = ex is DataSourceException dse ? Reason(dse) : "unavailable";
            Log.Warn("discover", "A genre page failed", new { source, error = ex.GetType().Name, reason });
            _genreBackoff.Fail(Now(), reason ?? "unavailable");
            return Dto("failed", reason, [], false);
        }
    }

    /// <summary>Marks a cached result with the library game it is today (the library may have changed since).</summary>
    private DiscoverResultDto Owned(DiscoverResultDto r)
    {
        var library = Library();
        var id = r.SteamAppId is { } a && library.BySteam(a) is { } bySteam ? bySteam.GameId : MatchByTitle(library, r.Title, r.Year, r.SteamAppId);
        return id == r.LibraryGameId ? r : r with { LibraryGameId = id };
    }
}
