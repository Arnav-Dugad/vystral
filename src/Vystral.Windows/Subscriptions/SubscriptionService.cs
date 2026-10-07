using System.Globalization;
using Vystral.Core.Cloud;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Matching;
using Vystral.Core.Subscriptions;
using Vystral.Windows.Bridge;
using Vystral.Windows.Cloud;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;

namespace Vystral.Windows.Subscriptions;

// ---------- Bridge DTOs (camelCase; mirrored in ui/src/bridge/types.subs.ts) ----------

/// <summary>A game is in one of your plans. <paramref name="Match"/>: "store" (the Xbox copy's package matches) or "title" (likely).</summary>
public sealed record SubsBadgeDto(string Plan, string PlanName, string Family, string Match, bool Leaving, string? LeavingEnd);

public sealed record SubsPlanCountDto(string Plan, string Name, bool HasList, int Count, int InLibrary);

public sealed record SubsStatusDto(IReadOnlyList<string> Plans, bool Asked, bool Catalog, bool LocalOnly, bool DataSaver, string Market,
    string State, string? RefreshedAt, string? NextRefreshAt, string? Error, IReadOnlyList<SubsPlanCountDto> Counts,
    int Leaving, int LeavingInLibrary, int Pending, bool Refreshing);

/// <summary>A game your plans include that isn't in your library. Opening it shows the official page; nothing is installed.</summary>
public sealed record SubsPickDto(string ProductId, string Title, string Plan, string PlanName, string Reason, string? Poster, string? LeavingEnd);

public sealed record SubsValuePlanDto(string Plan, string Name, long Seconds, int Games);
public sealed record SubsValueGameDto(string GameId, string Title, long Seconds);

public sealed record SubsValueDto(string MonthStart, IReadOnlyList<string> Plans, bool HasLists, long Seconds, int Games, int Sessions,
    IReadOnlyList<SubsValuePlanDto> Rows, IReadOnlyList<SubsValueGameDto> Top, double Price, string Currency, double? CostPerHour, string? CostNote);

/// <summary>
/// Track V: tailoring VYSTRAL to the subscriptions the user says they have (stored locally only; nothing is checked
/// against an account). With the opt-in "Use public Game Pass lists" switch, Microsoft's public Game Pass data (the
/// same grey, cached, rate-limited sources as Track O's cloud catalogue) tells which games each plan includes:
/// badges and a library filter for games you own, a Home row of included games you don't own yet (opening the
/// official page, never installing), "Leaving soon" badges with the Store listing's date, and a notification a few
/// days before. Off, or offline, it sends nothing.
/// </summary>
public sealed class SubscriptionService
{
    public const string OwnedSetting = "subs.owned";
    public const string AskedSetting = "subs.asked";
    public const string CatalogSetting = "subs.catalog";
    public const string ShowAllCloudSetting = "subs.cloudShowAll";
    public const string LeavingNotifySetting = "subs.leavingNotify";
    public const string PriceSetting = "subs.price";
    public const string CurrencySetting = "subs.currency";

    public static readonly TimeSpan RefreshEvery = TimeSpan.FromHours(24);
    public static readonly TimeSpan ProductTtl = TimeSpan.FromDays(60);
    public static readonly TimeSpan EndTtl = TimeSpan.FromHours(20);
    /// <summary>"A few days before": a leaving game you own is announced once, this close to its date.</summary>
    public static readonly TimeSpan LeavingNotice = TimeSpan.FromDays(4);
    public const int MaxBrowseBatchesPerRefresh = 40;
    public const int MaxFullBatchesPerRefresh = 3;
    public const int Picks = 12;

    private readonly LibraryRepository _repo;
    private readonly SettingsService _settings;
    private readonly IEventSink _events;
    private readonly string _cachePath;
    private readonly ProviderTransport _listTransport, _displayTransport;
    private readonly SubscriptionCatalogClient _client;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Lock _lock = new();
    private SubscriptionCache _cache;
    private (string Key, Dictionary<string, (string ProductId, CloudMatchKind Kind)> Map)? _matches;
    private volatile bool _refreshing;

    public Func<bool> DataSaverActive { get; set; } = () => false;
    public Func<bool> GameActive { get; set; } = () => false;
    public Func<DateTimeOffset> Clock { get; set; } = () => DateTimeOffset.Now;
    public TimeZoneInfo TimeZone { get; set; } = TimeZoneInfo.Local;
    /// <summary>The market both features use: Track O's (setting, then the Windows region).</summary>
    public Func<string> Market { get; set; } = () => "US";
    /// <summary>Copies a validated poster URL into the art cache; returns the cache-relative path.</summary>
    public Func<string, CancellationToken, Task<string?>>? CacheImage { get; set; }
    public Func<string, string> ArtUrl { get; set; } = rel => ArtworkService.Url("", rel);

    public SubscriptionService(LibraryRepository repo, SettingsService settings, HttpClient http, IEventSink events, string cachePath)
    {
        _repo = repo;
        _settings = settings;
        _events = events;
        _cachePath = cachePath;
        _cache = SubscriptionCache.Load(cachePath);
        _listTransport = new ProviderTransport(http, "subs.gamepass", "Game Pass", TimeSpan.FromSeconds(2), 1024 * 1024);
        _displayTransport = new ProviderTransport(http, "subs.msstore", "Microsoft Store", TimeSpan.FromSeconds(1.5), 4 * 1024 * 1024);
        _client = new SubscriptionCatalogClient(_listTransport, _displayTransport);
    }

    internal void NoDelaysForTests()
    {
        foreach (var t in new[] { _listTransport, _displayTransport }) t.Delay = (_, _) => Task.CompletedTask;
    }

    // ---------------- settings ----------------

    public IReadOnlyList<string> Plans => SubscriptionPlans.Parse(_settings.GetString(OwnedSetting));
    public bool CatalogOn => _settings.GetBool(CatalogSetting);
    public bool LocalOnly => _settings.GetBool("privacy.localOnly");
    private bool HasListPlans => Plans.Any(SubscriptionPlans.HasCatalog);

    private SubscriptionCache Cache
    {
        get { lock (_lock) return _cache; }
    }

    // ---------------- refresh ----------------

    /// <summary>After failures, wait 1, 2, 4, 8… hours (at most a day), like Track O.</summary>
    internal static TimeSpan Backoff(int failures) => TimeSpan.FromHours(Math.Min(24, Math.Pow(2, Math.Clamp(failures - 1, 0, 5))));

    /// <summary>When the lists may be asked for again in this market; null = now.</summary>
    public DateTimeOffset? NextAllowed(string market)
    {
        var c = Cache;
        if (c.Market != market) return FailNext(c);
        DateTimeOffset? next = SubscriptionCache.ParseDate(c.ListsAt) is { } ok ? ok + RefreshEvery : null;
        if (FailNext(c) is { } after && (next is null || after > next)) next = after;
        return next is { } x && x > Clock() ? x : null;
    }

    private DateTimeOffset? FailNext(SubscriptionCache c) =>
        c.Failures > 0 && SubscriptionCache.ParseDate(c.FailAt) is { } at && at + Backoff(c.Failures) > Clock() ? at + Backoff(c.Failures) : null;

    /// <summary>
    /// Downloads what's due. <paramref name="manual"/> = the user asked (Data saver and a running game don't stop it,
    /// but the daily limit and back-off still apply).
    /// </summary>
    public async Task<SubsStatusDto> RefreshAsync(bool manual, CancellationToken ct)
    {
        if (!CatalogOn) throw new DataSourceException(DataSourceOutcome.Disabled, "Public Game Pass lists are off. Turn them on in Settings → Library & stores → Your subscriptions.");
        if (LocalOnly) throw new DataSourceException(DataSourceOutcome.Offline, "Offline mode is on, so VYSTRAL doesn’t download Game Pass lists. Turn it off in Settings → Privacy.");
        if (!HasListPlans || (!manual && (DataSaverActive() || GameActive()))) return Status();
        if (!await _gate.WaitAsync(0, ct)) return Status();
        _refreshing = true;
        _events.Emit("subs.changed", Status());
        try
        {
            var market = Market();
            var now = Clock();
            var cache = Cache;
            if (cache.Market != market || NextAllowed(market) is null)
            {
                try
                {
                    var lists = await _client.FetchListsAsync(market, ct);
                    if (lists.Values.Sum(l => l.Count) == 0 && cache.Lists.Values.Sum(l => l.Count) > 0 && cache.Market == market)
                        throw new DataSourceException(DataSourceOutcome.Malformed, "Game Pass sent empty lists.");
                    // Short lists are a bonus; one failing keeps its last copy.
                    var leaving = await TrySigl(SubscriptionCatalogClient.LeavingSoonSigl, market, cache.Market == market ? cache.Leaving : [], ct);
                    var recent = await TrySigl(SubscriptionCatalogClient.RecentlyAddedSigl, market, cache.Market == market ? cache.Recent : [], ct);
                    var popular = await TrySigl(SubscriptionCatalogClient.PopularSigl, market, cache.Market == market ? cache.Popular : [], ct);
                    Update(c =>
                    {
                        if (c.Market != market) c.Products.Clear();
                        c.Market = market;
                        c.Lists = lists.ToDictionary(kv => kv.Key, kv => kv.Value.ToList(), StringComparer.Ordinal);
                        c.Leaving = leaving.ToList();
                        c.Recent = recent.ToList();
                        c.Popular = popular.ToList();
                        c.ListsAt = now.ToString("O");
                        c.Failures = 0;
                        c.FailAt = null;
                        c.Error = null;
                    });
                }
                catch (DataSourceException ex)
                {
                    Update(c =>
                    {
                        c.Failures = Math.Min(100, c.Failures + 1);
                        c.FailAt = now.ToString("O");
                        c.Error = ex.Message.Length > 300 ? ex.Message[..300] : ex.Message;
                    });
                    Log.Warn("subs", "Game Pass lists refresh failed; the last good copy is kept", new { outcome = ex.Outcome.ToString(), failures = Cache.Failures });
                }
            }
            if (Cache.Market == market)
            {
                await ResolveTitlesAsync(market, ct);
                await ResolveDetailsAsync(market, ct);
                await CachePostersAsync(ct);
            }
            Save();
            lock (_lock) _matches = null;
        }
        finally
        {
            _refreshing = false;
            _gate.Release();
        }
        CheckLeaving();
        var status = Status();
        _events.Emit("subs.changed", status);
        return status;
    }

    private async Task<IReadOnlyList<string>> TrySigl(string sigl, string market, IReadOnlyList<string> previous, CancellationToken ct)
    {
        try { return await _client.FetchSiglAsync(sigl, market, ct); }
        catch (DataSourceException ex)
        {
            Log.Warn("subs", "A Game Pass list couldn't be updated; keeping the last copy", new { outcome = ex.Outcome.ToString() });
            return previous;
        }
    }

    /// <summary>Copy on write: readers keep the snapshot they took, so they never see a collection change under them.</summary>
    private void Update(Action<SubscriptionCache> change)
    {
        lock (_lock)
        {
            var next = _cache.Clone();
            change(next);
            _cache = next;
        }
    }

    private void Save()
    {
        lock (_lock) _cache.Save(_cachePath);
    }

    /// <summary>Every product in the plans the user has (union of their lists).</summary>
    private HashSet<string> PlanProducts(SubscriptionCache c, IReadOnlyList<string>? plans = null)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var plan in plans ?? Plans)
            foreach (var key in SubscriptionPlans.CatalogKeysFor(plan))
                if (c.Lists.TryGetValue(key, out var ids)) set.UnionWith(ids);
        return set;
    }

    /// <summary>Names (and posters) with the light template, highest-value lists first, at most 40 requests per refresh.</summary>
    private async Task ResolveTitlesAsync(string market, CancellationToken ct)
    {
        var now = Clock();
        var c = Cache;
        var inPlans = PlanProducts(c);
        var order = c.Leaving.Concat(c.Recent).Concat(c.Popular).Where(inPlans.Contains).Concat(inPlans.Order(StringComparer.Ordinal));
        var due = order.Distinct(StringComparer.Ordinal).Where(id => Due(c, id, now)).ToList();
        var batches = 0;
        foreach (var batch in due.Chunk(XboxCloudCatalogClient.BatchSize))
        {
            if (++batches > MaxBrowseBatchesPerRefresh) break; // the rest next time
            try
            {
                var rows = await _client.FetchProductsAsync(batch, market, browse: true, now, ct);
                Update(cache =>
                {
                    foreach (var id in batch)
                    {
                        var row = rows.FirstOrDefault(r => r.ProductId == id);
                        var p = cache.Products.TryGetValue(id, out var existing) ? existing.Copy() : new CachedProduct();
                        p.Title = row?.Title ?? p.Title;
                        p.Poster = row?.PosterUrl ?? p.Poster;
                        p.At = now.ToString("O"); // not listed: unknown, not asked again for a while
                        cache.Products[id] = p;
                    }
                });
            }
            catch (DataSourceException ex)
            {
                Log.Warn("subs", "Store product lookup stopped for this round", new { outcome = ex.Outcome.ToString() });
                break;
            }
        }
    }

    private static bool Due(SubscriptionCache c, string id, DateTimeOffset now) =>
        !c.Products.TryGetValue(id, out var p) || SubscriptionCache.ParseDate(p.At) is not { } at || now - at > ProductTtl;

    /// <summary>
    /// Full details for a few products: "Leaving soon" games (their Game Pass end date, re-read daily) and products
    /// whose name matches an Xbox copy in the library (their package family name, so the badge is certain).
    /// </summary>
    private async Task ResolveDetailsAsync(string market, CancellationToken ct)
    {
        var now = Clock();
        var c = Cache;
        var inPlans = PlanProducts(c);
        var known = KnownPfns(c);
        var wanted = new List<string>();
        if (Plans.Any(SubscriptionPlans.IsGamePass))
            wanted.AddRange(c.Leaving.Where(id => !c.Products.TryGetValue(id, out var p) || SubscriptionCache.ParseDate(p.EndCheckedAt) is not { } at || now - at > EndTtl));
        var knownPfns = new HashSet<string>(known.Values, StringComparer.OrdinalIgnoreCase);
        var xboxTitles = _repo.GetCloudLibrary().SelectMany(g => g.Copies).Where(cp => cp.Platform == CloudStores.Xbox && !knownPfns.Contains(cp.PlatformGameId))
            .Select(cp => TitleNormalizer.Normalize(cp.Title).Base).Where(b => b.Length >= 3).ToHashSet(StringComparer.Ordinal);
        if (xboxTitles.Count > 0)
            wanted.AddRange(inPlans.Where(id => !known.ContainsKey(id) && c.Products.TryGetValue(id, out var p) && p.Title is { } t &&
                                                 p.EndCheckedAt is null && xboxTitles.Contains(TitleNormalizer.Normalize(t).Base)));
        var batches = 0;
        foreach (var batch in wanted.Distinct(StringComparer.Ordinal).Chunk(XboxCloudCatalogClient.BatchSize))
        {
            if (++batches > MaxFullBatchesPerRefresh) break;
            try
            {
                var rows = await _client.FetchProductsAsync(batch, market, browse: false, now, ct);
                Update(cache =>
                {
                    foreach (var id in batch)
                    {
                        var row = rows.FirstOrDefault(r => r.ProductId == id);
                        var p = cache.Products.TryGetValue(id, out var existing) ? existing.Copy() : new CachedProduct { At = now.ToString("O") };
                        if (row is not null)
                        {
                            p.Title = row.Title ?? p.Title;
                            p.Pfn = row.Pfn ?? p.Pfn;
                            p.Poster = row.PosterUrl ?? p.Poster;
                            p.End = row.GamePassEnd?.ToString("O");
                        }
                        p.EndCheckedAt = now.ToString("O");
                        cache.Products[id] = p;
                    }
                });
            }
            catch (DataSourceException ex)
            {
                Log.Warn("subs", "Store details lookup stopped for this round", new { outcome = ex.Outcome.ToString() });
                break;
            }
        }
    }

    /// <summary>Posters for the Home row only (at most a dozen downloads a refresh, each at most once).</summary>
    private async Task CachePostersAsync(CancellationToken ct)
    {
        if (CacheImage is null) return;
        foreach (var pick in PickCandidates().Take(Picks))
        {
            var c = Cache;
            if (!c.Products.TryGetValue(pick.ProductId, out var p) || p.Poster is null || p.Art is not null) continue;
            var rel = await CacheImage(p.Poster, ct);
            if (rel is null) continue;
            var id = pick.ProductId;
            Update(cache =>
            {
                if (!cache.Products.TryGetValue(id, out var current)) return;
                var copy = current.Copy();
                copy.Art = rel;
                cache.Products[id] = copy;
            });
        }
    }

    // ---------------- matching ----------------

    private Dictionary<string, string> KnownPfns(SubscriptionCache c)
    {
        var map = _repo.GetCloudProducts().Where(p => p.Value.Pfn is not null).ToDictionary(p => p.Key, p => p.Value.Pfn!, StringComparer.Ordinal);
        foreach (var (id, p) in c.Products)
            if (p.Pfn is not null) map[id] = p.Pfn;
        return map;
    }

    /// <summary>gameId → (product, how it matched), over every product in the user's plans.</summary>
    private Dictionary<string, (string ProductId, CloudMatchKind Kind)> Matches()
    {
        var c = Cache;
        var plans = Plans;
        var library = _repo.GetCloudLibrary();
        var key = $"{string.Join(',', plans)}|{c.Market}|{c.ListsAt}|{c.Products.Count}|{c.Products.Count(p => p.Value.Pfn is not null)}|{library.Count}|" +
                  $"{library.Sum(g => g.Copies.Count)}|{library.Aggregate(0, (h, g) => HashCode.Combine(h, g.GameId, g.Title))}";
        lock (_lock)
        {
            if (_matches is { } m && m.Key == key) return m.Map;
        }
        var ids = PlanProducts(c, plans);
        var entries = ids.Select(id => new CloudCatalogEntry(CloudServices.Xbox, id, id,
            c.Products.TryGetValue(id, out var p) ? p.Title ?? "" : "", CloudPlayTypes.Ready, false, [new CloudStoreLink(CloudStores.Xbox, id)])).ToList();
        // The matcher's Xbox rules fit subscriptions: a plan doesn't depend on where you bought a game, so any copy may
        // match by title (labelled likely), and an Xbox copy matches exactly by package family name.
        var map = CloudMatcher.Match(CloudServices.Xbox, entries, library, KnownPfns(c))
            .ToDictionary(x => x.GameId, x => (x.Entry.EntryId, x.Kind), StringComparer.Ordinal);
        lock (_lock) _matches = (key, map);
        return map;
    }

    /// <summary>gameId → badges, one per plan that includes it. Empty when the lists are off or unknown.</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<SubsBadgeDto>> Map()
    {
        if (!CatalogOn || !HasListPlans) return new Dictionary<string, IReadOnlyList<SubsBadgeDto>>();
        var c = Cache;
        if (c.Lists.Count == 0 || c.Market != Market()) return new Dictionary<string, IReadOnlyList<SubsBadgeDto>>();
        var plans = Plans.Where(SubscriptionPlans.HasCatalog).ToList();
        var leaving = new HashSet<string>(c.Leaving, StringComparer.Ordinal);
        var now = Clock();
        var result = new Dictionary<string, IReadOnlyList<SubsBadgeDto>>(StringComparer.Ordinal);
        foreach (var (gameId, (productId, kind)) in Matches())
        {
            var badges = new List<SubsBadgeDto>();
            foreach (var plan in plans)
            {
                if (!SubscriptionPlans.CatalogKeysFor(plan).Any(k => c.Lists.TryGetValue(k, out var l) && l.Contains(productId))) continue;
                var isLeaving = SubscriptionPlans.IsGamePass(plan) && leaving.Contains(productId);
                badges.Add(new SubsBadgeDto(plan, SubscriptionPlans.DisplayName(plan), SubscriptionPlans.Family(plan), kind == CloudMatchKind.StoreId ? "store" : "title",
                    isLeaving, isLeaving ? LeavingEnd(c, productId, now) : null));
            }
            if (badges.Count > 0) result[gameId] = badges;
        }
        return result;
    }

    private static string? LeavingEnd(SubscriptionCache c, string productId, DateTimeOffset now) =>
        c.Products.TryGetValue(productId, out var p) && SubscriptionCache.ParseDate(p.End) is { } end && end > now ? end.ToString("O") : null;

    private sealed record Candidate(string ProductId, string Plan, string Reason);

    /// <summary>Included games you don't own: leaving soon, then recently added, then popular, in your plans, named.</summary>
    private IEnumerable<Candidate> PickCandidates()
    {
        var c = Cache;
        var plans = Plans.Where(SubscriptionPlans.HasCatalog).ToList();
        if (plans.Count == 0 || c.Lists.Count == 0 || c.Market != Market()) yield break;
        var owned = new HashSet<string>(Matches().Values.Select(v => v.ProductId), StringComparer.Ordinal);
        var ownedTitles = _repo.GetCloudLibrary().Select(g => TitleNormalizer.Normalize(g.Title).Base).ToHashSet(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (ids, reason) in new[] { (c.Leaving, "leaving"), (c.Recent, "new"), (c.Popular, "popular") })
        {
            foreach (var id in ids)
            {
                if (!seen.Add(id) || owned.Contains(id) || !c.Products.TryGetValue(id, out var p) || p.Title is null) continue;
                if (ownedTitles.Contains(TitleNormalizer.Normalize(p.Title).Base)) continue;
                var plan = plans.FirstOrDefault(pl => SubscriptionPlans.CatalogKeysFor(pl).Any(k => c.Lists.TryGetValue(k, out var l) && l.Contains(id)));
                if (plan is null || (reason == "leaving" && !SubscriptionPlans.IsGamePass(plan))) continue;
                yield return new Candidate(id, plan, reason);
            }
        }
    }

    public IReadOnlyList<SubsPickDto> Included()
    {
        if (!CatalogOn || !HasListPlans) return [];
        var c = Cache;
        var now = Clock();
        return PickCandidates().Take(Picks).Select(x =>
        {
            var p = c.Products[x.ProductId];
            return new SubsPickDto(x.ProductId, p.Title!, x.Plan, SubscriptionPlans.DisplayName(x.Plan), x.Reason, p.Art is null ? null : ArtUrl(p.Art),
                x.Reason == "leaving" ? LeavingEnd(c, x.ProductId, now) : null);
        }).ToList();
    }

    /// <summary>A product the Home row may open (it must be in a list VYSTRAL downloaded).</summary>
    public bool IsKnownProduct(string productId)
    {
        if (!CloudIds.IsProductId(productId)) return false;
        var c = Cache;
        return c.Lists.Values.Any(l => l.Contains(productId)) || c.Leaving.Contains(productId);
    }

    // ---------------- leaving soon ----------------

    /// <summary>
    /// Owned games leaving Game Pass get one notification each: a few days before the Store listing's date, or as soon
    /// as the game shows up in "Leaving soon" when there's no date. Remembered in the cache file, so never twice.
    /// </summary>
    public void CheckLeaving()
    {
        if (!_settings.GetBool(LeavingNotifySetting) || !CatalogOn || !Plans.Any(SubscriptionPlans.IsGamePass)) return;
        var c = Cache;
        if (c.Leaving.Count == 0) return;
        var now = Clock();
        var map = Map();
        var items = new List<object>();
        var notified = new List<string>();
        foreach (var (gameId, badges) in map)
        {
            var b = badges.FirstOrDefault(x => x.Leaving);
            if (b is null || !Matches().TryGetValue(gameId, out var match)) continue;
            var productId = match.ProductId;
            if (c.LeavingNotified.ContainsKey(productId)) continue;
            var end = SubscriptionCache.ParseDate(b.LeavingEnd);
            if (end is { } e && e - now > LeavingNotice) continue; // not yet: a few days before
            var title = _repo.GetGame(gameId)?.Title ?? "A game";
            items.Add(new { gameId, title, end = end?.ToString("O") });
            notified.Add(productId);
        }
        if (items.Count == 0) return;
        Update(cache => { foreach (var id in notified) cache.LeavingNotified[id] = now.ToString("O"); });
        Save();
        _events.Emit("subs.leaving", new { key = string.Join(',', notified.Order(StringComparer.Ordinal)), items = items.Take(10).ToList(), count = items.Count });
    }

    // ---------------- value ----------------

    public SubsValueDto Value()
    {
        var now = Clock();
        var monthStart = SubscriptionValue.MonthStart(now, TimeZone);
        var plans = Plans;
        var gfnPlan = _settings.GetString(CloudPlayService.PlanSetting);
        var gfnMember = gfnPlan is "free" or "performance" or "ultimate" or "daypass";
        var map = Map().ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value.Select(b => b.Plan).ToList(), StringComparer.Ordinal);
        var sessions = _repo.ObservedSessionsEndedAfter(monthStart,
                [SessionSources.Tracked, SessionSources.Detected, SessionSources.Background, SessionSources.CloudGfn, SessionSources.CloudXbox], 4000)
            .Select(s => new ValueSession(s.GameId, s.Source, s.Start, s.DurationSeconds)).ToList();
        var price = Math.Clamp(_settings.GetNumber(PriceSetting), 0, 1000);
        var r = SubscriptionValue.Compute(sessions, map, plans, gfnMember, monthStart, now, price);
        var titles = r.Top.Select(t => new SubsValueGameDto(t.GameId, _repo.GetGame(t.GameId)?.Title ?? "", t.Seconds)).Where(t => t.Title.Length > 0).ToList();
        var rows = r.Plans.Select(p => new SubsValuePlanDto(p.Plan,
            p.Plan == SubscriptionValue.GeForceNowRow ? "GeForce NOW" : SubscriptionPlans.DisplayName(p.Plan), p.Seconds, p.Games)).ToList();
        return new SubsValueDto(monthStart.ToString("O"), plans, CatalogOn && Cache.Lists.Count > 0, r.Seconds, r.Games, r.Sessions, rows, titles,
            price, _settings.GetString(CurrencySetting), r.CostPerHour, r.CostNote);
    }

    // ---------------- status ----------------

    public SubsStatusDto Status()
    {
        var c = Cache;
        var market = Market();
        var plans = Plans;
        var map = CatalogOn ? Map() : new Dictionary<string, IReadOnlyList<SubsBadgeDto>>();
        var counts = plans.Select(p =>
        {
            var ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (var k in SubscriptionPlans.CatalogKeysFor(p))
                if (c.Lists.TryGetValue(k, out var l)) ids.UnionWith(l);
            return new SubsPlanCountDto(p, SubscriptionPlans.DisplayName(p), SubscriptionPlans.HasCatalog(p), ids.Count, map.Values.Count(b => b.Any(x => x.Plan == p)));
        }).ToList();
        var ok = c.Market == market ? SubscriptionCache.ParseDate(c.ListsAt) : null;
        var failedLast = c.Failures > 0 && SubscriptionCache.ParseDate(c.FailAt) is { } f && (ok is null || f > ok);
        var hasData = c.Market == market && c.Lists.Count > 0;
        var state = !CatalogOn ? "off"
            : !HasListPlans ? "noPlans"
            : _refreshing ? "refreshing"
            : LocalOnly ? "offline"
            : failedLast ? (hasData ? "stale" : "error")
            : ok is null ? "never"
            : "ok";
        var inPlans = hasData ? PlanProducts(c, plans) : [];
        var pending = inPlans.Count(id => !c.Products.ContainsKey(id));
        var leavingInPlans = plans.Any(SubscriptionPlans.IsGamePass) ? c.Leaving.Count(inPlans.Contains) : 0;
        return new SubsStatusDto(plans, _settings.GetBool(AskedSetting), CatalogOn, LocalOnly, DataSaverActive(), market, state,
            ok?.ToString("O"), NextAllowed(market)?.ToString("O"), failedLast ? c.Error : null, counts,
            leavingInPlans, map.Values.Count(b => b.Any(x => x.Leaving)), pending, _refreshing);
    }

    /// <summary>The settings or library changed: matches depend on plans and games.</summary>
    public void Invalidate()
    {
        lock (_lock) _matches = null;
    }

    internal static string Iso(DateTimeOffset d) => d.ToString("O", CultureInfo.InvariantCulture);
}
