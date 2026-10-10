using System.ComponentModel;
using System.Globalization;
using Vystral.Core.Cloud;
using Vystral.Core.Data;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;

namespace Vystral.Windows.Cloud;

// ---------- Bridge DTOs (camelCase; mirrored in ui/src/bridge/types.cloud.ts) ----------

/// <summary>A small per-game marker for library cards and the filter.</summary>
public sealed record CloudBadgeDto(string Service, string? PlayType, bool Premium, string Match);

/// <summary>One way to play a game in the cloud, with honest requirement wording.</summary>
public sealed record CloudOptionDto(string Service, string ServiceName, string EntryTitle, string? PlayType, bool Premium, string Match, string MatchStore,
    string Surface, string SurfaceLabel, string Headline, string Requirement, string? Note);

public sealed record CloudSessionDto(string GameId, string Title, string Service, string Surface, string State, string? Start, int Seconds, bool Manual,
    long? SessionLimitSeconds, long? SessionLeftSeconds, string SessionLevel);

public sealed record CloudGameDto(string GameId, bool Enabled, string? Reason, IReadOnlyList<CloudOptionDto> Options, CloudSessionDto? Active, CloudMeterDto? Meter);

public sealed record CloudServiceStateDto(string Service, string Name, bool Enabled, int Count, int Matched, string? RefreshedAt, string? NextRefreshAt, string State, string? Error);

public sealed record CloudAppsDto(bool GfnApp, bool XboxApp, bool Edge);

public sealed record CloudMeterDto(string Plan, string PlanLabel, string CycleStart, string NextReset, long UsedSeconds, long? LimitSeconds, long? LeftSeconds,
    double? Fraction, string Level, int RolloverHours, long? SessionLimitSeconds, long? SessionLeftSeconds, string SessionLevel, int Sessions,
    long XboxSeconds, int XboxSessions, int ResetDay, string PlanNote, string AsOf);

public sealed record CloudStatusDto(bool Enabled, bool LocalOnly, bool DataSaver, string Market, string MarketSource, string Browser,
    IReadOnlyList<CloudServiceStateDto> Services, CloudAppsDto Apps, CloudSessionDto? Active, CloudMeterDto Meter, bool Refreshing);

public sealed record CloudLaunchResultDto(string Service, string Surface, string SurfaceLabel, string Message);

/// <summary>
/// Track O: cloud play (Xbox Cloud Gaming, GeForce NOW). Opt-in and off by default. Catalogues come from the vendors'
/// own public pages' data (grey: cached, refreshed at most daily per market, backed off on errors, no cookies, a plain
/// VYSTRAL User-Agent, size-capped, every field validated) and are matched to the library by store ID, falling back to a
/// careful title match that is labelled as likely. Launching only ever opens the official app or site. Sessions are
/// noticed read-only and saved with a cloud source; the hours meter is an estimate from those sessions.
/// </summary>
public sealed class CloudPlayService : IDisposable
{
    public const string EnabledSetting = "cloud.enabled";
    public const string MarketSetting = "cloud.market";
    public const string PlanSetting = "cloud.gfnPlan";
    public const string ResetDaySetting = "cloud.resetDay";
    public const string BrowserSetting = "cloud.browser";
    public static string ServiceSetting(string service) => $"cloud.{service}";

    public static readonly TimeSpan RefreshEvery = TimeSpan.FromHours(24);
    public static readonly TimeSpan ProductTtl = TimeSpan.FromDays(60);
    public static readonly TimeSpan StatusTtl = TimeSpan.FromMinutes(5);
    public const int MinSessionSeconds = 60;
    public const int MaxProductBatchesPerRefresh = 40;

    private readonly LibraryRepository _repo;
    private readonly SettingsService _settings;
    private readonly IEventSink _events;
    private readonly ICloudProcessStarter _starter;
    private readonly IProcessSnapshotSource? _processes;
    private readonly Func<int?> _foreground;
    private readonly Func<CloudEnvironment> _environment;
    private readonly string _edgeProfileDir;
    private readonly ProviderTransport _gfnTransport, _siglTransport, _displayTransport, _statusTransport;
    private readonly GfnCatalogClient _gfn;
    private readonly XboxCloudCatalogClient _xbox;
    private readonly GfnStatusClient _status;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private readonly Lock _lock = new();

    private (string Key, Dictionary<string, List<CloudMatch>> Map)? _matches;
    private (CloudServiceStatusDto Dto, DateTimeOffset At)? _statusCache;
    private ActiveSession? _active;
    private int? _edgeBrowserPid;
    private volatile bool _refreshing;

    /// <summary>Data saver (manual or metered): no background catalogue downloads.</summary>
    public Func<bool> DataSaverActive { get; set; } = () => false;
    public Func<bool> GameActive { get; set; } = () => false;
    /// <summary>Called after a launch when "Minimize VYSTRAL when a game starts" is on.</summary>
    public Action? Minimize { get; set; }
    public Func<DateTimeOffset> Clock { get; set; } = () => DateTimeOffset.Now;
    public TimeZoneInfo TimeZone { get; set; } = TimeZoneInfo.Local;
    public Func<string?> WindowsRegion { get; set; } = ReadWindowsRegion;

    public CloudPlayService(LibraryRepository repo, SettingsService settings, HttpClient http, IEventSink events, string edgeProfileDir,
        Func<CloudEnvironment> environment, ICloudProcessStarter starter, IProcessSnapshotSource? processes, Func<int?> foreground)
    {
        _repo = repo;
        _settings = settings;
        _events = events;
        _edgeProfileDir = edgeProfileDir;
        _environment = environment;
        _starter = starter;
        _processes = processes;
        _foreground = foreground;
        _gfnTransport = new ProviderTransport(http, "cloud.gfn", "GeForce NOW", TimeSpan.FromSeconds(3), 2 * 1024 * 1024);
        _siglTransport = new ProviderTransport(http, "cloud.xbox", "Xbox", TimeSpan.FromSeconds(2), 1024 * 1024);
        _displayTransport = new ProviderTransport(http, "cloud.msstore", "Microsoft Store", TimeSpan.FromSeconds(1.5), 4 * 1024 * 1024);
        _statusTransport = new ProviderTransport(http, "cloud.gfnStatus", "GeForce NOW status", TimeSpan.FromSeconds(5), 1024 * 1024);
        _gfn = new GfnCatalogClient(_gfnTransport);
        _xbox = new XboxCloudCatalogClient(_siglTransport, _displayTransport);
        _status = new GfnStatusClient(_statusTransport);
    }

    /// <summary>
    /// A cookie-less client for cloud catalogues: no cookie container (nothing is stored or sent back), no redirects,
    /// and the same plain "VYSTRAL/&lt;version&gt;" User-Agent as VYSTRAL's other requests.
    /// </summary>
    public static HttpClient CreateHttpClient(string version)
    {
        var handler = FastConnect.CreateHandler(allowRedirects: false);
        handler.UseCookies = false;
        var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };
        http.DefaultRequestHeaders.UserAgent.Add(new System.Net.Http.Headers.ProductInfoHeaderValue("VYSTRAL", version));
        return http;
    }

    // ---------------- settings ----------------

    public bool Enabled => _settings.GetBool(EnabledSetting);
    public bool LocalOnly => _settings.GetBool("privacy.localOnly");
    public bool ServiceOn(string service) => Enabled && _settings.GetBool(ServiceSetting(service));
    public bool UseEdge => _settings.GetString(BrowserSetting) != "default";
    public int ResetDay => (int)Math.Clamp(_settings.GetNumber(ResetDaySetting), 1, 31);

    public (string Market, string Source) Market
    {
        get
        {
            var set = _settings.GetString(MarketSetting);
            if (CloudIds.IsMarket(set)) return (set, "setting");
            var region = WindowsRegion();
            return CloudIds.IsMarket(region) ? (region!, "windows") : ("US", "default");
        }
    }

    /// <summary>The user's Windows home region (Settings → Time &amp; language → Region), else the format region.</summary>
    public static string? ReadWindowsRegion()
    {
        try
        {
            var home = global::Windows.System.UserProfile.GlobalizationPreferences.HomeGeographicRegion;
            if (CloudIds.IsMarket(home?.ToUpperInvariant())) return home!.ToUpperInvariant();
        }
        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException or InvalidOperationException or TypeInitializationException) { }
        try { return RegionInfo.CurrentRegion.TwoLetterISORegionName.ToUpperInvariant(); }
        catch (ArgumentException) { return null; }
    }

    // ---------------- refresh ----------------

    private string OkKey(string service) => $"cloud.{service}.lastOk";
    private string FailKey(string service) => $"cloud.{service}.lastFail";

    /// <summary>When the catalogue for this market last refreshed successfully.</summary>
    private DateTimeOffset? LastOk(string service, string market)
    {
        var raw = _repo.GetInternalValue(OkKey(service));
        var parts = raw?.Split('|');
        return parts is [var m, var at] && m == market && DateTimeOffset.TryParse(at, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t) ? t : null;
    }

    private (DateTimeOffset At, int Count, string Message)? LastFail(string service, string market)
    {
        var raw = _repo.GetInternalValue(FailKey(service));
        var parts = raw?.Split('|', 4);
        return parts is [var m, var at, var n, var msg] && m == market && DateTimeOffset.TryParse(at, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t) &&
               int.TryParse(n, out var count) ? (t, count, msg) : null;
    }

    /// <summary>After failures, wait 1, 2, 4, 8… hours (at most a day) before asking again.</summary>
    internal static TimeSpan Backoff(int failures) => TimeSpan.FromHours(Math.Min(24, Math.Pow(2, Math.Clamp(failures - 1, 0, 5))));

    /// <summary>The earliest time this service may be asked again for this market; null = now.</summary>
    public DateTimeOffset? NextAllowed(string service, string market)
    {
        DateTimeOffset? next = LastOk(service, market) is { } ok ? ok + RefreshEvery : null;
        if (LastFail(service, market) is { } fail && (LastOk(service, market) is not { } ok2 || fail.At > ok2))
        {
            var after = fail.At + Backoff(fail.Count);
            next = next is { } n && n > after ? n : after;
        }
        return next is { } x && x > DateTimeOffset.UtcNow ? x : null;
    }

    /// <summary>
    /// Refreshes the enabled services that are due. <paramref name="manual"/> = the user asked (Data saver doesn't stop it,
    /// but the daily limit and back-off still apply). Returns the status afterwards.
    /// </summary>
    public async Task<CloudStatusDto> RefreshAsync(bool manual, CancellationToken ct)
    {
        if (!Enabled) throw new DataSourceException(DataSourceOutcome.Disabled, "Cloud play is off. Turn it on in Settings → Cloud play.");
        if (LocalOnly) throw new DataSourceException(DataSourceOutcome.Offline, "Offline mode is on, so VYSTRAL doesn’t download cloud catalogues. Turn it off in Settings → Privacy.");
        if (!manual && (DataSaverActive() || GameActive())) return Status();
        if (!await _refreshGate.WaitAsync(0, ct)) return Status();
        _refreshing = true;
        _events.Emit("cloud.changed", Status());
        try
        {
            var (market, _) = Market;
            foreach (var service in CloudServices.All)
            {
                if (!ServiceOn(service) || NextAllowed(service, market) is not null) continue;
                try
                {
                    if (service == CloudServices.GeForceNow) await RefreshGfnAsync(market, ct);
                    else await RefreshXboxAsync(market, ct);
                    _repo.SetInternalValue(OkKey(service), $"{market}|{DateTimeOffset.UtcNow:O}");
                    _repo.SetInternalValue(FailKey(service), null);
                }
                catch (DataSourceException ex)
                {
                    var count = (LastFail(service, market)?.Count ?? 0) + 1;
                    _repo.SetInternalValue(FailKey(service), $"{market}|{DateTimeOffset.UtcNow:O}|{count}|{ex.Message.Replace('|', ' ')}");
                    Log.Warn("cloud", "Catalogue refresh failed; the last good copy is kept", new { service, outcome = ex.Outcome.ToString(), failures = count });
                }
            }
            // GeForce NOW lists some games by Store product ID; resolve those only when the library has Xbox copies.
            await ResolveProductsAsync(market, ct);
            lock (_lock) _matches = null;
        }
        finally
        {
            _refreshing = false;
            _refreshGate.Release();
        }
        var status = Status();
        _events.Emit("cloud.changed", status);
        return status;
    }

    private async Task RefreshGfnAsync(string market, CancellationToken ct)
    {
        var entries = await _gfn.FetchAllAsync(market, ct);
        // An empty answer for a supported market would wipe good data; keep the last copy unless the market changed.
        if (entries.Count == 0 && _repo.CloudCatalogCount(CloudServices.GeForceNow, market) > 0)
            throw new DataSourceException(DataSourceOutcome.Malformed, "GeForce NOW sent an empty list.");
        _repo.ReplaceCloudCatalog(CloudServices.GeForceNow, market, entries);
    }

    private async Task RefreshXboxAsync(string market, CancellationToken ct)
    {
        var ids = await _xbox.FetchCloudProductIdsAsync(market, ct);
        if (ids.Count == 0 && _repo.CloudCatalogCount(CloudServices.Xbox, market) > 0)
            throw new DataSourceException(DataSourceOutcome.Malformed, "Xbox sent an empty list.");
        var products = _repo.GetCloudProducts();
        _repo.ReplaceCloudCatalog(CloudServices.Xbox, market, ids.Select(id => new CloudCatalogEntry(CloudServices.Xbox, id, id,
            products.TryGetValue(id, out var p) ? p.Title ?? "" : "", CloudPlayTypes.Ready, false, [new CloudStoreLink(CloudStores.Xbox, id)])).ToList());
    }

    /// <summary>Product IDs needing a package family name: Xbox cloud entries, and GeForce NOW Xbox variants when the library has Xbox copies.</summary>
    private async Task ResolveProductsAsync(string market, CancellationToken ct)
    {
        var known = _repo.GetCloudProducts();
        var now = DateTimeOffset.UtcNow;
        var wanted = new List<string>();
        if (ServiceOn(CloudServices.Xbox)) wanted.AddRange(_repo.GetCloudCatalog(CloudServices.Xbox, market).Select(e => e.EntryId));
        if (ServiceOn(CloudServices.GeForceNow) && _repo.GetCloudLibrary().Any(g => g.Copies.Any(c => c.Platform == CloudStores.Xbox)))
            wanted.AddRange(_repo.GetCloudCatalog(CloudServices.GeForceNow, market).SelectMany(e => e.Links).Where(l => l.Store == CloudStores.Xbox).Select(l => l.StoreId));
        var due = wanted.Distinct(StringComparer.Ordinal)
            .Where(id => CloudIds.IsProductId(id) && (!known.TryGetValue(id, out var row) || now - row.Fetched > ProductTtl)).ToList();
        if (due.Count == 0) return;
        var batches = 0;
        foreach (var batch in due.Chunk(XboxCloudCatalogClient.BatchSize))
        {
            if (++batches > MaxProductBatchesPerRefresh) break; // the rest next time
            try
            {
                var rows = await _xbox.FetchProductsAsync(batch, market, ct);
                _repo.UpsertCloudProducts(rows.Select(r => new CloudProductRow(r.ProductId, r.Pfn, r.Title, now)).ToList());
            }
            catch (DataSourceException ex)
            {
                Log.Warn("cloud", "Store product lookup stopped for this round", new { outcome = ex.Outcome.ToString() });
                break;
            }
        }
        // Titles for Xbox entries come from the products just resolved.
        if (ServiceOn(CloudServices.Xbox))
        {
            var products = _repo.GetCloudProducts();
            var entries = _repo.GetCloudCatalog(CloudServices.Xbox, market);
            if (entries.Any(e => e.Title.Length == 0 && products.TryGetValue(e.EntryId, out var p) && p.Title is not null))
                _repo.ReplaceCloudCatalog(CloudServices.Xbox, market, entries.Select(e =>
                    e.Title.Length == 0 && products.TryGetValue(e.EntryId, out var p) && p.Title is not null ? e with { Title = p.Title } : e).ToList());
        }
    }

    // ---------------- matching ----------------

    private Dictionary<string, List<CloudMatch>> Matches()
    {
        var (market, _) = Market;
        var library = _repo.GetCloudLibrary();
        var key = $"{market}|{ServiceOn(CloudServices.GeForceNow)}|{ServiceOn(CloudServices.Xbox)}|{library.Count}|{library.Sum(g => g.Copies.Count)}|" +
                  $"{library.Aggregate(0, (h, g) => HashCode.Combine(h, g.GameId, g.Title))}|{_repo.CloudCatalogCount(CloudServices.GeForceNow, market)}|" +
                  $"{_repo.CloudCatalogCount(CloudServices.Xbox, market)}|{_repo.GetInternalValue(OkKey(CloudServices.GeForceNow))}|{_repo.GetInternalValue(OkKey(CloudServices.Xbox))}";
        lock (_lock)
        {
            if (_matches is { } m && m.Key == key) return m.Map;
        }
        var pfn = _repo.GetCloudProducts().Where(p => p.Value.Pfn is not null).ToDictionary(p => p.Key, p => p.Value.Pfn!, StringComparer.Ordinal);
        var map = new Dictionary<string, List<CloudMatch>>(StringComparer.Ordinal);
        foreach (var service in CloudServices.All)
        {
            if (!ServiceOn(service)) continue;
            foreach (var match in CloudMatcher.Match(service, _repo.GetCloudCatalog(service, market), library, pfn))
            {
                if (!map.TryGetValue(match.GameId, out var list)) map[match.GameId] = list = [];
                list.Add(match);
            }
        }
        lock (_lock) _matches = (key, map);
        return map;
    }

    /// <summary>gameId → cloud badges, for library cards and the "Playable in the cloud" filter.</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<CloudBadgeDto>> Map()
    {
        if (!Enabled) return new Dictionary<string, IReadOnlyList<CloudBadgeDto>>();
        return Matches().ToDictionary(kv => kv.Key, kv => (IReadOnlyList<CloudBadgeDto>)kv.Value
            .Select(m => new CloudBadgeDto(m.Service, m.Entry.PlayType, m.Entry.Premium, m.Kind == CloudMatchKind.StoreId ? "store" : "title")).ToList());
    }

    public CloudGameDto ForGame(string gameId)
    {
        if (!Enabled) return new CloudGameDto(gameId, false, "off", [], null, null);
        var env = _environment();
        var options = Matches().TryGetValue(gameId, out var list)
            ? list.Select(m => Option(m, env)).ToList()
            : [];
        var reason = options.Count > 0 ? null
            : CloudServices.All.Where(ServiceOn).All(s => _repo.CloudCatalogCount(s, Market.Market) == 0) ? "noData" : "none";
        var active = ActiveDto();
        return new CloudGameDto(gameId, true, reason, options, active?.GameId == gameId ? active : null, MeterDto());
    }

    private CloudOptionDto Option(CloudMatch m, CloudEnvironment env)
    {
        var plan = SafePlan(m.Entry, env);
        var surface = plan?.Surface ?? CloudSurfaces.Browser;
        var likely = m.Kind == CloudMatchKind.Title;
        var storeName = StoreName(m.Store);
        string headline, requirement;
        string? note = null;
        if (m.Service == CloudServices.GeForceNow)
        {
            var install = m.Entry.PlayType == CloudPlayTypes.InstallToPlay;
            headline = install ? "GeForce NOW · Install-to-Play (Performance/Ultimate)" : "GeForce NOW · Ready to play";
            requirement = install || m.Entry.Premium
                ? $"Needs a Performance or Ultimate membership and your {storeName} copy."
                : $"Works with a free or paid membership and your {storeName} copy.";
            if (install) note = "GeForce NOW installs it on its rig the first time, which can take a while.";
        }
        else
        {
            headline = "Cloud playable · may be included with Game Pass";
            requirement = m.Store == CloudStores.Xbox && !likely
                ? "Streams with Game Pass Essential, Premium or Ultimate, or if you own it and it’s on Xbox’s stream-your-own-game list."
                : "Streams with Game Pass Essential, Premium or Ultimate. Your copy from another store doesn’t count; xbox.com shows the final answer.";
        }
        if (likely) note = (note is null ? "" : note + " ") + "Likely match by title: the vendor’s page shows the final answer.";
        return new CloudOptionDto(m.Service, CloudServices.DisplayName(m.Service), m.Entry.Title, m.Entry.PlayType, m.Entry.Premium,
            likely ? "title" : "store", m.Store, surface, CloudSurfaces.Label(surface), headline, requirement, note);
    }

    private CloudLaunchPlan? SafePlan(CloudCatalogEntry entry, CloudEnvironment env)
    {
        try { return CloudLauncher.Plan(entry, env, UseEdge, _edgeProfileDir); }
        catch (ArgumentException) { return null; }
    }

    private static string StoreName(string store) => store switch
    {
        CloudStores.Steam => "Steam",
        CloudStores.Xbox => "Xbox",
        CloudStores.Epic => "Epic Games",
        CloudStores.Ubisoft => "Ubisoft",
        CloudStores.Gog => "GOG",
        CloudStores.Ea => "EA",
        CloudStores.BattleNet => "Battle.net",
        _ => "store",
    };

    // ---------------- launching and sessions ----------------

    private sealed class ActiveSession(string gameId, string title, string service, CloudLaunchPlan plan, CloudSessionDetector detector)
    {
        public string GameId { get; } = gameId;
        public string Title { get; } = title;
        public string Service { get; } = service;
        public CloudLaunchPlan Plan { get; } = plan;
        public CloudSessionDetector Detector { get; } = detector;
        public string? SessionId { get; set; }
        public DateTimeOffset LastTouch { get; set; }
        public CancellationTokenSource Stop { get; } = new();
    }

    /// <summary>The user pressed "Play in the cloud": that press is their consent to open the vendor's app or site.</summary>
    public CloudLaunchResultDto Launch(string gameId, string service)
    {
        if (!Enabled) throw new BridgeException("disabled", "Cloud play is off. Turn it on in Settings → Cloud play.");
        if (!CloudServices.IsKnown(service) || !ServiceOn(service)) throw new BridgeException("disabled", $"{CloudServices.DisplayName(service)} is turned off in Settings → Cloud play.");
        var match = Matches().TryGetValue(gameId, out var list) ? list.FirstOrDefault(m => m.Service == service) : null;
        if (match is null) throw new BridgeException("notFound", $"This game isn’t listed for {CloudServices.DisplayName(service)} in your region.");
        var title = _repo.GetGame(gameId)?.Title ?? match.Entry.Title;

        var env = _environment();
        var plan = CloudLauncher.Plan(match.Entry, env, UseEdge, _edgeProfileDir);
        if (plan.Surface == CloudSurfaces.Edge) Directory.CreateDirectory(_edgeProfileDir);
        (CloudLaunchPlan Plan, int? Pid) started;
        try
        {
            started = CloudLauncher.Execute(plan, _starter);
        }
        catch (Win32Exception ex) when (plan.Surface is CloudSurfaces.GfnApp or CloudSurfaces.XboxApp)
        {
            // The vendor app couldn't be started (moved, blocked): fall back to its official site.
            Log.Warn("cloud", "Vendor app didn't start; opening the website", new { service, error = ex.NativeErrorCode });
            var web = CloudLauncher.Plan(match.Entry, env with { GfnAppPath = null, XboxApp = false }, UseEdge, _edgeProfileDir);
            started = CloudLauncher.Execute(web, _starter);
        }
        catch (Win32Exception ex)
        {
            Log.Warn("cloud", "Couldn't open the cloud page", new { service, error = ex.NativeErrorCode });
            throw new BridgeException("unavailable", "Windows couldn’t open it. Check that a browser is installed and try again.");
        }

        var now = Clock();
        EndActive(now, "replaced");
        var cap = TimeSpan.FromHours(service == CloudServices.GeForceNow && GfnPlan.For(_settings.GetString(PlanSetting)).SessionHours is { } h ? h : 8);
        var detector = new CloudSessionDetector(started.Plan.Detect, started.Pid, now, cap, _edgeBrowserPid);
        var active = new ActiveSession(gameId, title, service, started.Plan, detector);
        lock (_lock) _active = active;
        Repository_Audit("cloud.launch", $"{service} {started.Plan.Surface}");
        Log.Info("cloud", "Opened a cloud game", new { service, surface = started.Plan.Surface });
        if (detector.State == CloudDetectorState.Running) BeginSession(active, now);
        _ = Task.Run(() => TrackAsync(active));
        if (_settings.GetBool("launch.minimizeOnStart")) Minimize?.Invoke();
        _events.Emit("cloud.session", ActiveDto());

        var where = CloudSurfaces.Label(started.Plan.Surface);
        var message = started.Plan.Surface switch
        {
            CloudSurfaces.XboxApp => $"Opening {title} in the Xbox app. Press Stream there to play.",
            CloudSurfaces.GfnApp => $"Starting {title} in the GeForce NOW app.",
            CloudSurfaces.Edge => $"Opening {title} in {where}. VYSTRAL never reads it.",
            _ => $"Opening {title} in your browser. VYSTRAL can’t see browser tabs, so press “I’m done” when you finish.",
        };
        return new CloudLaunchResultDto(service, started.Plan.Surface, where, message);
    }

    private void Repository_Audit(string action, string detail)
    {
        try { _repo.Audit(action, detail); }
        catch (Exception ex) when (ex is Microsoft.Data.Sqlite.SqliteException or InvalidOperationException) { }
    }

    private void BeginSession(ActiveSession a, DateTimeOffset now)
    {
        if (a.SessionId is not null || a.Detector.Start is not { } start) return;
        try
        {
            a.SessionId = _repo.StartCloudSession(a.GameId, a.Service, start);
            a.LastTouch = now;
        }
        catch (Exception ex) when (ex is Microsoft.Data.Sqlite.SqliteException or ArgumentException)
        {
            Log.Warn("cloud", "Couldn't record the cloud session", ex: ex);
        }
    }

    private async Task TrackAsync(ActiveSession a)
    {
        try
        {
            while (!a.Detector.Done && !a.Stop.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(3), a.Stop.Token);
                Step(a, Clock());
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { Log.Warn("cloud", "Cloud session tracking stopped", ex: ex); }
    }

    /// <summary>One detection step (also used by tests through <see cref="TickForTests"/>).</summary>
    private void Step(ActiveSession a, DateTimeOffset now)
    {
        var before = a.Detector.State;
        var procs = _processes?.Take() ?? [];
        a.Detector.Tick(now, procs, _foreground());
        if (a.Detector.BrowserPid is { } pid && now - a.Detector.Start.GetValueOrDefault(now) > CloudSessionDetector.HandOffWindow) _edgeBrowserPid = pid;
        if (a.Detector.State == CloudDetectorState.Running && before == CloudDetectorState.Waiting)
        {
            BeginSession(a, now);
            _events.Emit("cloud.session", ActiveDto());
        }
        if (a.SessionId is { } id && a.Detector.State == CloudDetectorState.Running && now - a.LastTouch >= TimeSpan.FromSeconds(30))
        {
            _repo.TouchOpenSession(id, a.Detector.Seconds);
            a.LastTouch = now;
        }
        if (a.Detector.Done) Complete(a, "detected");
    }

    /// <summary>Test hook: no spacing between requests.</summary>
    internal void NoDelaysForTests()
    {
        foreach (var t in new[] { _gfnTransport, _siglTransport, _displayTransport, _statusTransport }) t.Delay = (_, _) => Task.CompletedTask;
    }

    internal void TickForTests(DateTimeOffset now)
    {
        if (_active is { } a) Step(a, now);
    }

    /// <summary>"I'm done" (or a new launch): ends the running cloud session now.</summary>
    public bool EndActive(DateTimeOffset now, string why = "user")
    {
        ActiveSession? a;
        lock (_lock) a = _active;
        if (a is null) return false;
        a.Detector.EndNow(now);
        Complete(a, why);
        return true;
    }

    private void Complete(ActiveSession a, string why)
    {
        lock (_lock)
        {
            if (!ReferenceEquals(_active, a)) return;
            _active = null;
        }
        a.Stop.Cancel();
        var seconds = a.Detector.Seconds;
        var saved = false;
        if (a.SessionId is { } id)
        {
            try
            {
                if (a.Detector.State == CloudDetectorState.Ended && seconds >= MinSessionSeconds)
                {
                    _repo.EndSession(id, a.Detector.End ?? Clock(), seconds, null);
                    saved = true;
                }
                else _repo.DeleteSession(id); // shorter than a minute: not a play session
            }
            catch (Microsoft.Data.Sqlite.SqliteException ex) { Log.Warn("cloud", "Couldn't save the cloud session", ex: ex); }
        }
        Log.Info("cloud", "Cloud session finished", new { a.Service, surface = a.Plan.Surface, seconds, saved, why });
        _events.Emit("cloud.session", new { ended = true, gameId = a.GameId, service = a.Service, seconds, saved });
        if (saved) _events.Emit("library.changed", new { reason = "session" });
    }

    public bool SessionActive
    {
        get { lock (_lock) return _active is { Detector.State: CloudDetectorState.Running }; }
    }

    public CloudSessionDto? ActiveDto()
    {
        ActiveSession? a;
        lock (_lock) a = _active;
        if (a is null) return null;
        var now = Clock();
        var d = a.Detector;
        long? limit = null, left = null;
        var level = "none";
        if (a.Service == CloudServices.GeForceNow && GfnPlan.For(_settings.GetString(PlanSetting)).SessionHours is { } h)
        {
            limit = h * 3600L;
            if (d.Start is { } s)
            {
                left = Math.Max(0, limit.Value - (long)(now - s).TotalSeconds);
                level = left == 0 ? "reached" : left <= (long)CloudHours.SessionNear.TotalSeconds ? "near" : "ok";
            }
        }
        var seconds = d.Start is { } st ? (int)Math.Max(0, (now - st).TotalSeconds) : 0;
        return new CloudSessionDto(a.GameId, a.Title, a.Service, a.Plan.Surface, d.State == CloudDetectorState.Running ? "running" : "waiting",
            d.Start?.ToString("O"), seconds, d.Mode == CloudDetect.Manual, limit, left, level);
    }

    // ---------------- meter ----------------

    public CloudMeterDto MeterDto()
    {
        var now = Clock();
        var plan = _settings.GetString(PlanSetting);
        var resetDay = ResetDay;
        var cycle = CloudHours.CycleStart(now, resetDay, TimeZone);
        ActiveSession? a;
        lock (_lock) a = _active;
        DateTimeOffset? running = a is { Service: CloudServices.GeForceNow, Detector: { State: CloudDetectorState.Running, Start: { } s } } ? s : null;
        var m = CloudHours.Compute(plan, resetDay, now, TimeZone, _repo.CloudSpansSince(Core.Domain.SessionSources.CloudGfn, cycle), running);
        var xboxSpans = _repo.CloudSpansSince(Core.Domain.SessionSources.CloudXbox, cycle);
        var xboxRunning = a is { Service: CloudServices.Xbox, Detector: { State: CloudDetectorState.Running, Start: { } xs } } ? xs : (DateTimeOffset?)null;
        var xboxAll = xboxRunning is { } xr ? xboxSpans.Append(new CloudSpan(xr, now)).ToList() : xboxSpans;
        return new CloudMeterDto(m.Plan, m.PlanLabel, m.CycleStart.ToString("O"), m.NextReset.ToString("O"), m.UsedSeconds, m.LimitSeconds, m.LeftSeconds,
            m.Fraction, m.Level, m.RolloverHours, m.SessionLimitSeconds, m.SessionLeftSeconds, m.SessionLevel, m.Sessions,
            CloudHours.SecondsIn(xboxAll, cycle, now), xboxAll.Count(x => x.End > cycle), resetDay, GfnPlan.For(plan).Note, GfnPlan.AsOf);
    }

    // ---------------- status ----------------

    public CloudStatusDto Status()
    {
        var (market, source) = Market;
        var map = Enabled ? Matches() : [];
        var services = CloudServices.All.Select(s =>
        {
            var on = ServiceOn(s);
            var count = _repo.CloudCatalogCount(s, market);
            var matched = map.Values.Count(l => l.Any(m => m.Service == s));
            var ok = LastOk(s, market);
            var fail = LastFail(s, market);
            var next = NextAllowed(s, market);
            var failedLast = fail is { } f && (ok is null || f.At > ok);
            var state = !on ? "off"
                : _refreshing ? "refreshing"
                : LocalOnly ? "offline"
                : failedLast ? (count > 0 ? "stale" : "error")
                : ok is null ? "never"
                : "ok";
            return new CloudServiceStateDto(s, CloudServices.DisplayName(s), on, count, matched, ok?.ToString("O"), next?.ToString("O"), state,
                failedLast ? fail!.Value.Message : null);
        }).ToList();
        var env = _environment();
        return new CloudStatusDto(Enabled, LocalOnly, DataSaverActive(), market, source, UseEdge ? "edge" : "default", services,
            new CloudAppsDto(env.GfnAppPath is not null, env.XboxApp, env.EdgePath is not null), ActiveDto(), MeterDto(), _refreshing);
    }

    /// <summary>GeForce NOW's public status page (cached five minutes, only while cloud play is on and online).</summary>
    public async Task<CloudServiceStatusDto> ServiceStatusAsync(CancellationToken ct)
    {
        var at = DateTimeOffset.UtcNow;
        if (_statusCache is { } c && at - c.At < StatusTtl) return c.Dto;
        if (!ServiceOn(CloudServices.GeForceNow)) return new CloudServiceStatusDto(CloudServices.GeForceNow, "unknown", "Turned off", 0, 0, [], at.ToString("O"), "disabled");
        if (LocalOnly) return new CloudServiceStatusDto(CloudServices.GeForceNow, "unknown", "Offline mode is on", 0, 0, [], at.ToString("O"), "offline");
        try
        {
            var dto = await _status.FetchAsync(ct);
            _statusCache = (dto, at);
            return dto;
        }
        catch (DataSourceException ex)
        {
            return new CloudServiceStatusDto(CloudServices.GeForceNow, "unknown", "Status unavailable", 0, 0, [], at.ToString("O"), ex.Message);
        }
    }

    /// <summary>Track D6: forgets the downloaded catalogues so the next refresh fetches them again (the cache viewer).</summary>
    public void ClearDownloaded()
    {
        _repo.ClearCloudCatalogs();
        foreach (var svc in new[] { CloudServices.GeForceNow, CloudServices.Xbox })
        {
            _repo.SetInternalValue(OkKey(svc), null);
            _repo.SetInternalValue(FailKey(svc), null);
        }
        lock (_lock)
        {
            _matches = null;
            _statusCache = null;
        }
    }

    /// <summary>The settings changed: matches depend on the market and the services switched on.</summary>
    public void Invalidate()
    {
        lock (_lock) _matches = null;
    }

    public void Dispose()
    {
        ActiveSession? a;
        lock (_lock) a = _active;
        a?.Stop.Cancel();
        (_processes as IDisposable)?.Dispose();
    }

    /// <summary>On shutdown: a running cloud session is saved up to now (its stream may go on, but VYSTRAL stops seeing it).</summary>
    public void Shutdown() => EndActive(Clock(), "shutdown");
}
