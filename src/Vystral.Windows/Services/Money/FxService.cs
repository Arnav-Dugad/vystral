using System.Globalization;
using System.Net;
using Vystral.Core.Money;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;

namespace Vystral.Windows.Services.Money;

public sealed record FxStatusDto(
    string State, // ok | stale | never | offline | error | refreshing
    string? Base, string? Date, string? FetchedAt, IReadOnlyDictionary<string, double>? Rates,
    string RegionCurrency, string Source, string? Error, string? NextAttemptAt);

/// <summary>
/// Track D6: daily exchange rates so every price can be shown in the currency chosen in Settings. One keyless request
/// a day to Frankfurter (<see cref="Url"/>; open source, rates from the European Central Bank and other central
/// banks), through the same polite lane as other data sources (HTTPS only, size-capped, Retry-After honoured, health
/// reported). The table is kept in <c>cache\fx\rates.json</c> and used as-is when offline; nothing is sent in Offline
/// mode. The request carries no information about the user beyond the IP address every request has.
/// </summary>
public sealed class FxService
{
    public const string Url = "https://api.frankfurter.dev/v2/rates?base=EUR";
    public const string HealthId = "fx";
    public static readonly TimeSpan MaxAge = TimeSpan.FromHours(20);
    public static readonly TimeSpan StaleAfter = TimeSpan.FromHours(72);
    public static readonly TimeSpan RetryAfterFailure = TimeSpan.FromHours(1);
    public static readonly TimeSpan ManualMinInterval = TimeSpan.FromMinutes(5);

    private readonly ProviderTransport _lane;
    private readonly string _file;
    private readonly Func<bool> _offline;
    private readonly IEventSink _events;
    private readonly Lock _lock = new();
    private FxSnapshot? _current;
    private bool _loaded;
    private int _refreshing;
    private DateTimeOffset _lastAttempt = DateTimeOffset.MinValue;
    private string? _lastError;

    public Func<DateTimeOffset> Clock { get; set; } = () => DateTimeOffset.Now;

    public FxService(HttpClient http, string dataRoot, Func<bool> offline, IEventSink events)
    {
        _lane = new ProviderTransport(http, HealthId, "Frankfurter", TimeSpan.FromSeconds(2), FxRates.MaxBytes);
        _file = Path.Combine(dataRoot, "cache", "fx", "rates.json");
        _offline = offline;
        _events = events;
    }

    /// <summary>The cache folder (for the cache viewer).</summary>
    public string CacheFile => _file;

    public FxSnapshot? Current
    {
        get
        {
            lock (_lock)
            {
                if (!_loaded)
                {
                    _loaded = true;
                    try { _current = File.Exists(_file) && new FileInfo(_file).Length <= FxRates.MaxBytes ? FxRates.Deserialize(File.ReadAllText(_file)) : null; }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { _current = null; }
                    if (_current is not null && _current.FetchedAt > Clock().AddMinutes(5)) _current = null; // a time in the future: not ours
                }
                return _current;
            }
        }
    }

    public static string RegionCurrency()
    {
        try
        {
            var code = RegionInfo.CurrentRegion.ISOCurrencySymbol;
            return FxRates.IsCode(code) ? code : "USD";
        }
        catch (ArgumentException) { return "USD"; }
    }

    public FxStatusDto Status()
    {
        var c = Current;
        var now = Clock();
        var state = Volatile.Read(ref _refreshing) == 1 ? "refreshing"
            : _offline() ? "offline"
            : c is null ? (_lastError is null ? "never" : "error")
            : now - c.FetchedAt > StaleAfter ? "stale"
            : "ok";
        var next = c is null || now - c.FetchedAt >= MaxAge ? _lastAttempt + RetryAfterFailure : c.FetchedAt + MaxAge;
        return new FxStatusDto(state, c?.Base, c?.Date, c?.FetchedAt.ToString("O", CultureInfo.InvariantCulture), c?.Rates,
            RegionCurrency(), "Frankfurter (European Central Bank and other central banks)", _lastError,
            _offline() ? null : next.ToString("O", CultureInfo.InvariantCulture));
    }

    /// <summary>True when a refresh is due (old or missing table, not offline, not right after a failure).</summary>
    public bool Due(bool manual)
    {
        if (_offline()) return false;
        var now = Clock();
        if (manual) return now - _lastAttempt >= ManualMinInterval;
        var c = Current;
        if (c is not null && now - c.FetchedAt < MaxAge) return false;
        return now - _lastAttempt >= RetryAfterFailure;
    }

    /// <summary>Starts a refresh in the background when one is due; the page hears <c>fx.changed</c> when it lands.</summary>
    public void RefreshInBackground()
    {
        if (!Due(manual: false)) return;
        _ = Task.Run(() => RefreshAsync(manual: false, CancellationToken.None));
    }

    public async Task<FxStatusDto> RefreshAsync(bool manual, CancellationToken ct)
    {
        if (_offline()) throw new BridgeException("offline", "Offline mode is on, so VYSTRAL keeps using the exchange rates it already has.");
        if (!Due(manual)) return Status();
        if (Interlocked.Exchange(ref _refreshing, 1) == 1) return Status();
        _lastAttempt = Clock();
        try
        {
            var response = await _lane.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, Url), ct);
            if (response.Status != HttpStatusCode.OK) throw new DataSourceException(DataSourceOutcome.Unavailable, $"The exchange-rate service answered with an unexpected status ({(int)response.Status}).");
            var parsed = FxRates.Parse(response.Body, Clock());
            if (parsed is null)
            {
                ProviderHealthHub.Failed(HealthId, "The exchange rates couldn’t be read");
                throw new DataSourceException(DataSourceOutcome.Malformed, "The exchange rates couldn’t be read. VYSTRAL keeps using the last ones it had.");
            }
            lock (_lock)
            {
                _current = parsed;
                _loaded = true;
            }
            _lastError = null;
            Save(parsed);
            Log.Info("fx", "Exchange rates updated", new { date = parsed.Date, count = parsed.Rates.Count });
        }
        catch (DataSourceException ex)
        {
            _lastError = ex.Message;
            Log.Warn("fx", "Exchange rates not updated", new { outcome = ex.Outcome.ToString() });
            if (manual) throw new BridgeException(ex.Outcome == DataSourceOutcome.RateLimited ? "rateLimited" : "unavailable", ex.Message);
        }
        finally
        {
            Volatile.Write(ref _refreshing, 0);
        }
        var status = Status();
        _events.Emit("fx.changed", status);
        return status;
    }

    private void Save(FxSnapshot s)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            var tmp = _file + ".tmp";
            File.WriteAllText(tmp, FxRates.Serialize(s));
            File.Move(tmp, _file, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn("fx", "Couldn't save the exchange rates", new { error = ex.GetType().Name });
        }
    }

    /// <summary>The cache viewer cleared <c>cache\fx</c>: forget the table in memory too (the next price view fetches again).</summary>
    public void Forget()
    {
        lock (_lock)
        {
            _current = null;
            _loaded = true;
        }
        _lastAttempt = DateTimeOffset.MinValue;
        _lastError = null;
    }
}
