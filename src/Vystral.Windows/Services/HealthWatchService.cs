using System.Text.Json;
using Vystral.Core.Health;
using Vystral.Windows.Bridge;

namespace Vystral.Windows.Services;

/// <summary>What Home shows: issues found since the last check that haven't been acknowledged (most serious first).</summary>
public sealed record HealthNewsDto(IReadOnlyList<HealthIssueDto> Issues, string? CheckedAt, string? Reason, int Score);

/// <summary>
/// Track X: re-runs the library health check in the background — when a drive appears or disappears, after a scan or a
/// Steam install change, and once a day — and announces issues that weren't there last time on Home, once each.
/// The check is the same offline one the Health page runs (database plus a few existence checks, ~tens of ms).
/// Drive changes are noticed by comparing the logical-drive list every few seconds (one cheap Win32 call); nothing
/// here opens a file, writes outside ui-state/health-watch.json, or runs while a game is starting or playing.
/// </summary>
public sealed class HealthWatchService : IDisposable
{
    public const string SettingKey = "home.healthNews";
    public static readonly TimeSpan Debounce = TimeSpan.FromSeconds(3);
    public static readonly TimeSpan DrivePoll = TimeSpan.FromSeconds(4);
    public static readonly TimeSpan Daily = TimeSpan.FromHours(24);

    private readonly Func<HealthReportDto> _check;
    private readonly string _file;
    private readonly IEventSink _events;
    private readonly Func<bool> _gameActive;
    private readonly Func<bool> _enabled;
    private readonly Lock _lock = new();
    private readonly SemaphoreSlim _signal = new(0, int.MaxValue);
    private HealthWatchState _state;
    private HealthReportDto? _last;
    private string? _reason;
    private string? _lastReason;
    private int _poked;
    private DateTimeOffset _lastRun = DateTimeOffset.MinValue;

    /// <summary>Test hook: the drive list (defaults to <see cref="Environment.GetLogicalDrives"/>).</summary>
    public Func<string[]> Drives { get; init; } = Environment.GetLogicalDrives;

    public HealthWatchService(Func<HealthReportDto> check, string dataRoot, IEventSink events, Func<bool> gameActive, Func<bool> enabled)
    {
        _check = check;
        _file = Path.Combine(dataRoot, "ui-state", "health-watch.json");
        _events = events;
        _gameActive = gameActive;
        _enabled = enabled;
        _state = Read();
    }

    /// <summary>Asks for a check soon (coalesced). <paramref name="reason"/>: drive | scan | install | daily | start.</summary>
    public void Poke(string reason)
    {
        lock (_lock) _reason ??= reason;
        if (Interlocked.Exchange(ref _poked, 1) == 0) _signal.Release();
    }

    public async Task RunAsync(CancellationToken ct)
    {
        var drives = SafeDrives();
        var nextPoll = DateTimeOffset.UtcNow + DrivePoll;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var wait = nextPoll - DateTimeOffset.UtcNow;
                var signalled = wait > TimeSpan.Zero && await _signal.WaitAsync(wait, ct);
                if (!signalled)
                {
                    // While a game starts or runs, look far less often (Performance Mode keeps VYSTRAL nearly idle).
                    nextPoll = DateTimeOffset.UtcNow + (_gameActive() ? TimeSpan.FromSeconds(30) : DrivePoll);
                    var now = SafeDrives();
                    if (!now.SequenceEqual(drives, StringComparer.OrdinalIgnoreCase)) { drives = now; Poke("drive"); }
                    DateTimeOffset last;
                    lock (_lock) last = _lastRun;
                    if (last != DateTimeOffset.MinValue && DateTimeOffset.UtcNow - last > Daily) Poke("daily");
                    continue;
                }
                await Task.Delay(Debounce, ct); // a scan and a drive change often arrive together
                Interlocked.Exchange(ref _poked, 0);
                while (_gameActive() && !ct.IsCancellationRequested) await Task.Delay(TimeSpan.FromSeconds(15), ct);
                RunOnce();
            }
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>One check and diff (also used by tests). Returns the ids announced for the first time.</summary>
    public IReadOnlyList<string> RunOnce()
    {
        HealthReportDto report;
        try { report = _check(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            Log.Warn("health", "Background health check failed", ex: ex);
            return [];
        }
        string? reason;
        IReadOnlyList<string> fresh;
        bool changed;
        lock (_lock)
        {
            reason = _reason ?? "check";
            _reason = null;
            _lastReason = reason;
            var before = _state.Pending;
            (_state, fresh) = HealthNews.Diff(report.Issues, _state, DateTimeOffset.UtcNow);
            _last = report;
            _lastRun = DateTimeOffset.UtcNow;
            changed = fresh.Count > 0 || !before.SequenceEqual(_state.Pending);
            Write(_state);
        }
        if (fresh.Count > 0) Log.Info("health", "New health issues noticed", new { count = fresh.Count, reason });
        if (changed && _enabled()) _events.Emit("health.news", Current());
        return fresh;
    }

    /// <summary>The card's content. Empty when turned off or before the first background check.</summary>
    public HealthNewsDto Current()
    {
        lock (_lock)
        {
            if (!_enabled() || _last is null) return new HealthNewsDto([], _last?.CheckedAt, null, _last?.Score ?? 100);
            return new HealthNewsDto(HealthNews.Order(_state.Pending, _last.Issues), _last.CheckedAt, _lastReason, _last.Score);
        }
    }

    /// <summary>The user dismissed the card, opened the Health page or fixed it: these ids stop showing (they're never announced again).</summary>
    public HealthNewsDto Acknowledge(IReadOnlyList<string> ids)
    {
        lock (_lock)
        {
            _state = HealthNews.Acknowledge(_state, ids);
            Write(_state);
        }
        return Current();
    }

    private string[] SafeDrives()
    {
        try { return [.. Drives().Order(StringComparer.OrdinalIgnoreCase)]; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return []; }
    }

    private sealed record Stored(List<string>? Known, Dictionary<string, string>? Announced, List<string>? Pending, bool Baselined);

    private HealthWatchState Read()
    {
        try
        {
            if (!File.Exists(_file) || new FileInfo(_file).Length > 1024 * 1024) return HealthWatchState.Empty;
            var s = JsonSerializer.Deserialize<Stored>(File.ReadAllText(_file));
            if (s is null) return HealthWatchState.Empty;
            bool Valid(string id) => HealthDismissals.IdPattern().IsMatch(id);
            return new HealthWatchState(
                (s.Known ?? []).Where(Valid).Take(HealthNews.MaxIds).ToList(),
                (s.Announced ?? []).Where(p => Valid(p.Key) && p.Value.Length <= 40).Take(HealthNews.MaxIds).ToDictionary(StringComparer.Ordinal),
                (s.Pending ?? []).Where(Valid).Take(HealthNews.MaxPending).ToList(),
                s.Baselined);
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            Log.Warn("health", "Health watch state unreadable; starting fresh", ex: ex);
            return HealthWatchState.Empty;
        }
    }

    private void Write(HealthWatchState state)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            var tmp = _file + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(new Stored([.. state.Known], new(state.Announced), [.. state.Pending], state.Baselined)));
            File.Move(tmp, _file, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn("health", "Couldn't save the health watch state", ex: ex);
        }
    }

    public void Dispose() => _signal.Dispose();
}
