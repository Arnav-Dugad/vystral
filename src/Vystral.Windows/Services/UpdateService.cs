using System.Diagnostics;
using Velopack;
using Velopack.Sources;
using Vystral.Windows.Bridge;

namespace Vystral.Windows.Services;

public sealed record UpdateStateDto(
    string Phase,             // unavailable | idle | checking | upToDate | available | downloading | ready | applying | error
    string CurrentVersion,
    string? NewVersion = null,
    int Progress = 0,
    long? TotalBytes = null,
    double? BytesPerSecond = null,
    string? Notes = null,
    string? Message = null,
    string? CheckedAt = null,
    bool Delta = false);

/// <summary>
/// Updates from the project's GitHub Releases through Velopack. Packages are verified by
/// Velopack against the release feed's SHA hashes before being applied, and updates are
/// never applied while a game is running.
/// </summary>
public sealed class UpdateService
{
    public const string RepositoryUrl = "https://github.com/Arnav-Dugad/vystral";
    public static readonly TimeSpan CheckTimeout = TimeSpan.FromMinutes(2);

    private readonly IEventSink _events;
    private readonly UpdateManager? _manager;
    private readonly Lock _lock = new();
    private UpdateInfo? _pending;
    private UpdateStateDto _state;
    private CancellationTokenSource? _downloadCts;

    public Func<bool> IsGameRunning { get; set; } = () => false;

    public UpdateService(IEventSink events)
    {
        _events = events;
        var version = typeof(UpdateService).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
        try
        {
            var mgr = new UpdateManager(new GithubSource(RepositoryUrl, accessToken: null, prerelease: false, new FastDownloader(version)));
            if (mgr.IsInstalled)
            {
                _manager = mgr;
                version = mgr.CurrentVersion?.ToString() ?? version;
            }
        }
        catch (Exception ex)
        {
            Log.Warn("update", "Update manager unavailable", ex: ex);
        }
        _state = _manager is null
            ? new UpdateStateDto("unavailable", version, Message: "Automatic updates work in the installed app. This copy is a development or portable build.")
            : new UpdateStateDto("idle", version);
    }

    public UpdateStateDto State
    {
        get { lock (_lock) return _state; }
    }

    public async Task<UpdateStateDto> CheckAsync()
    {
        if (_manager is null) return State;
        if (State.Phase is "checking" or "downloading" or "applying") return State;
        Set(State with { Phase = "checking", Message = null });
        var sw = Stopwatch.StartNew();
        try
        {
            // Never let a stalled connection leave the check spinning forever.
            var info = await _manager.CheckForUpdatesAsync().WaitAsync(CheckTimeout);
            var now = DateTimeOffset.Now.ToString("O");
            if (info is null)
            {
                Log.Info("update", "Up to date", new { version = State.CurrentVersion, ms = sw.ElapsedMilliseconds });
                return Set(State with { Phase = "upToDate", NewVersion = null, Progress = 0, CheckedAt = now });
            }
            Log.Info("update", "Update available", new { from = State.CurrentVersion, to = info.TargetFullRelease.Version.ToString(), ms = sw.ElapsedMilliseconds });
            _pending = info;
            var target = info.TargetFullRelease;
            // Velopack downloads only the deltas when they chain from the installed version.
            var deltas = info.DeltasToTarget ?? [];
            var downloadSize = deltas.Length > 0 ? deltas.Sum(d => d.Size) : target.Size;
            return Set(State with
            {
                Phase = _manager.UpdatePendingRestart is not null ? "ready" : "available",
                NewVersion = target.Version.ToString(),
                TotalBytes = downloadSize,
                Delta = deltas.Length > 0,
                Notes = Truncate(target.NotesMarkdown, 6000),
                CheckedAt = now,
            });
        }
        catch (TimeoutException)
        {
            Log.Warn("update", "Update check timed out", new { ms = sw.ElapsedMilliseconds });
            return Set(State with
            {
                Phase = "error",
                Message = "GitHub took too long to answer. VYSTRAL will try again later.",
                CheckedAt = DateTimeOffset.Now.ToString("O"),
            });
        }
        catch (Exception ex)
        {
            Log.Warn("update", "Update check failed", ex: ex);
            return Set(State with
            {
                Phase = "error",
                Message = "Couldn't reach GitHub to check for updates. VYSTRAL will try again later.",
                CheckedAt = DateTimeOffset.Now.ToString("O"),
            });
        }
    }

    public async Task<UpdateStateDto> DownloadAsync()
    {
        if (_manager is null || _pending is null) return State;
        if (IsGameRunning()) return Set(State with { Message = "Updates download after your game closes." });
        var cts = _downloadCts = new CancellationTokenSource();
        var sw = Stopwatch.StartNew();
        var total = State.TotalBytes ?? _pending.TargetFullRelease.Size;
        Set(State with { Phase = "downloading", Progress = 0, Message = null, BytesPerSecond = null });
        try
        {
            var lastEmit = TimeSpan.Zero;
            await _manager.DownloadUpdatesAsync(_pending, p =>
            {
                var elapsed = sw.Elapsed;
                if (elapsed - lastEmit < TimeSpan.FromMilliseconds(150) && p < 100) return;
                lastEmit = elapsed;
                double? speed = elapsed.TotalSeconds > 0.5 && total > 0 ? total * (p / 100.0) / elapsed.TotalSeconds : null;
                Set(State with { Phase = "downloading", Progress = p, BytesPerSecond = speed });
            }, cts.Token);
            return Set(State with { Phase = "ready", Progress = 100, BytesPerSecond = null, Message = null });
        }
        catch (OperationCanceledException)
        {
            return Set(State with { Phase = "available", Progress = 0, BytesPerSecond = null, Message = "Download cancelled." });
        }
        catch (Exception ex)
        {
            Log.Warn("update", "Update download failed", ex: ex);
            return Set(State with { Phase = "error", BytesPerSecond = null, Message = "The update couldn't be downloaded. Your current version is unaffected." });
        }
    }

    public void CancelDownload() => _downloadCts?.Cancel();

    /// <summary>Restarts into the new version. Refused while a game is being tracked.</summary>
    public UpdateStateDto ApplyAndRestart()
    {
        if (_manager is null || _pending is null || State.Phase != "ready") return State;
        if (IsGameRunning()) return Set(State with { Message = "Close your game first; VYSTRAL restarts to finish updating." });
        Set(State with { Phase = "applying" });
        _manager.ApplyUpdatesAndRestart(_pending.TargetFullRelease);
        return State;
    }

    /// <summary>If an update is downloaded but not applied, install it silently after VYSTRAL exits.</summary>
    public void ApplyOnExitIfReady()
    {
        if (_manager is null || _pending is null || State.Phase != "ready") return;
        try
        {
            _manager.WaitExitThenApplyUpdates(_pending.TargetFullRelease, silent: true, restart: false);
        }
        catch (Exception ex)
        {
            Log.Warn("update", "Deferred update apply failed", ex: ex);
        }
    }

    private UpdateStateDto Set(UpdateStateDto state)
    {
        lock (_lock) _state = state;
        _events.Emit("update.state", state);
        return state;
    }

    private static string? Truncate(string? s, int max) => s is null || s.Length <= max ? s : s[..max] + "…";
}

/// <summary>
/// Velopack's downloader with VYSTRAL's fast connector (see <see cref="FastConnect"/>): GitHub's
/// release files sit behind several CDN addresses, and one unreachable address used to cost 21 s
/// per file, per release, on every check.
/// </summary>
internal sealed class FastDownloader(string version) : HttpClientFileDownloader
{
    protected override HttpClient CreateHttpClient(IDictionary<string, string>? headers, double timeout)
    {
        var client = new HttpClient(FastConnect.CreateHandler(), disposeHandler: true) { Timeout = TimeSpan.FromMinutes(timeout) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd($"VYSTRAL/{version}");
        foreach (var (key, value) in headers ?? new Dictionary<string, string>())
            client.DefaultRequestHeaders.TryAddWithoutValidation(key, value);
        return client;
    }
}

