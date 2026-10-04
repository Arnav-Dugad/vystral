using Vystral.Core.Contracts;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Windows.Bridge;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;

namespace Vystral.Windows.Launch;

public sealed record LaunchStateDto(
    string Ticket,
    string GameId,
    string InstallationId,
    string Platform,
    string Phase,          // validating | starting | waiting | running | notDetected | ended | failed
    string? Message,
    string? SessionId = null,
    int? DurationSeconds = null,
    string? PerfSummary = null,
    string? StartedAt = null);

/// <summary>
/// Owns the launch → detect → track → end lifecycle. A launch is only reported as running once
/// a game process is actually observed. Nothing is ever relaunched automatically.
/// </summary>
public sealed class SessionService : IDisposable
{
    private static readonly TimeSpan DetectionWindow = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan SlowWatchWindow = TimeSpan.FromMinutes(10);

    private readonly LibraryRepository _repo;
    private readonly IReadOnlyDictionary<PlatformId, IPlatformAdapter> _adapters;
    private readonly SettingsService _settings;
    private readonly IEventSink _events;
    private readonly Lock _lock = new();
    private CancellationTokenSource? _watchCts;
    private LaunchStateDto? _current;

    public SessionService(LibraryRepository repo, IEnumerable<IPlatformAdapter> adapters, SettingsService settings, IEventSink events)
    {
        _repo = repo;
        _adapters = adapters.ToDictionary(a => a.Platform);
        _settings = settings;
        _events = events;
    }

    public LaunchStateDto? Current
    {
        get { lock (_lock) return _current; }
    }

    /// <summary>Raised when a session moves to running or ends; the host uses it to enter/leave Performance Mode.</summary>
    public event Action<LaunchStateDto>? StateChanged;

    /// <summary>Raised for each performance sample of the running session (used by the Pulse window).</summary>
    public event Action<PerfSampleDto>? Sampled;

    public LaunchStateDto Launch(string gameId, string? installationId)
    {
        var ticket = LibraryRepository.NewId();
        lock (_lock)
        {
            if (_current is { Phase: "starting" or "waiting" or "running" } busy)
                return Fail(ticket, gameId, installationId ?? "", "", busy.Phase == "running"
                    ? "A game started from VYSTRAL is still running. Close it first, or stop tracking it."
                    : "Another game is still starting.");
        }

        var game = _repo.GetGame(gameId);
        if (game is null) return Fail(ticket, gameId, installationId ?? "", "", "This game is no longer in your library.");

        var installs = _repo.GetInstallations(gameId);
        var inst = installationId is not null
            ? installs.FirstOrDefault(i => i.Id == installationId)
            : installs.FirstOrDefault(i => i.Id == game.PreferredInstallationId && i.State == InstallState.Installed)
              ?? installs.Where(i => i.State == InstallState.Installed).OrderByDescending(i => i.ImportedLastPlayed).FirstOrDefault();

        if (inst is null)
        {
            var missing = installs.FirstOrDefault(i => i.State == InstallState.Missing);
            return Fail(ticket, gameId, "", "", missing is not null
                ? $"{game.Title} wasn't found during the last scan of {missing.Platform.DisplayName()}. Reinstall it there, or rescan your library."
                : $"{game.Title} isn't installed on this PC.");
        }
        if (inst.State != InstallState.Installed)
            return Fail(ticket, gameId, inst.Id, inst.Platform.Key(),
                $"{game.Title} wasn't found during the last scan of {inst.Platform.DisplayName()}. Reinstall it there, or rescan your library.");

        Emit(new(ticket, gameId, inst.Id, inst.Platform.Key(), "validating", null));

        var userArgs = _repo.GetUserLaunchArgs(inst.Id);
        var valid = LaunchValidator.Validate(inst, userArgs);
        if (!valid.Ok) return Fail(ticket, gameId, inst.Id, inst.Platform.Key(), valid.Problem!);

        AdapterStatus? clientStatus = null;
        if (_adapters.TryGetValue(inst.Platform, out var adapter))
        {
            clientStatus = SafeStatus(adapter);
            if (inst.ClientRequired && clientStatus?.Status == ClientStatus.NotInstalled)
                return Fail(ticket, gameId, inst.Id, inst.Platform.Key(),
                    $"{game.Title} needs {inst.Platform.DisplayName()}, which isn't installed. Install {inst.Platform.DisplayName()} and try again.");
        }

        if (inst.InstallPath is not null && !Directory.Exists(inst.InstallPath))
            return Fail(ticket, gameId, inst.Id, inst.Platform.Key(),
                $"The install folder {inst.InstallPath} is missing. If it's on an external drive, connect it and try again.");

        Emit(new(ticket, gameId, inst.Id, inst.Platform.Key(), "starting",
            inst.ClientRequired ? $"Starting via {inst.Platform.DisplayName()}…" : "Starting…"));

        var steamExe = inst.Platform == PlatformId.Steam ? clientStatus?.ClientPath : null;
        var start = ProcessLauncher.Start(inst, userArgs, steamExe);
        _repo.Audit("game.launch", $"{inst.Platform.Key()}:{inst.PlatformGameId} ({(start.Started ? "accepted" : start.Error)})");
        if (!start.Started) return Fail(ticket, gameId, inst.Id, inst.Platform.Key(), start.Error ?? "The game didn't start.");

        var waiting = new LaunchStateDto(ticket, gameId, inst.Id, inst.Platform.Key(), "waiting",
            inst.ClientRequired ? $"Waiting for {inst.Platform.DisplayName()} to start the game…" : "Waiting for the game window…");
        Emit(waiting);

        var excluded = _adapters.Values.Select(SafeStatus)
            .Where(s => s?.ClientPath is not null)
            .Select(s => Path.GetDirectoryName(s!.ClientPath!)!)
            .Where(d => inst.InstallPath is null || !Path.GetFullPath(inst.InstallPath).StartsWith(Path.GetFullPath(d), StringComparison.OrdinalIgnoreCase))
            .ToList();

        var cts = new CancellationTokenSource();
        lock (_lock)
        {
            _watchCts?.Cancel();
            _watchCts = cts;
        }
        _ = Task.Run(() => WatchAsync(waiting, inst, start.ProcessId, excluded, cts.Token));
        return waiting;
    }

    /// <summary>User chose to stop waiting for / tracking the current launch. The game itself is not touched.</summary>
    public void StopTracking()
    {
        lock (_lock) _watchCts?.Cancel();
    }

    private async Task WatchAsync(LaunchStateDto state, Installation inst, int? knownPid, List<string> excluded, CancellationToken ct)
    {
        try
        {
            var hints = inst.ProcessHints.ToHashSet(StringComparer.OrdinalIgnoreCase);
            var started = DateTimeOffset.UtcNow;
            List<int> pids = [];
            var notified = false;

            // Phase 1: wait for a game process to appear.
            while (!ct.IsCancellationRequested)
            {
                var found = ProcessScanner.FindUnder(ProcessScanner.Snapshot(), inst.InstallPath, hints, excluded);
                pids = found.Select(p => p.Id).ToList();
                if (knownPid is int pid && ProcessScanner.IsAlive(pid) && inst.InstallPath is not null &&
                    ProcessScanner.TryGetImagePath(pid) is { } path && path.StartsWith(inst.InstallPath, StringComparison.OrdinalIgnoreCase) &&
                    !pids.Contains(pid))
                    pids.Add(pid);
                if (pids.Count > 0) break;

                var elapsed = DateTimeOffset.UtcNow - started;
                if (elapsed > DetectionWindow && !notified)
                {
                    notified = true;
                    Emit(state with
                    {
                        Phase = "notDetected",
                        Message = "VYSTRAL hasn't seen the game start yet. It may still be updating or waiting in the store app. You can keep waiting or stop tracking; VYSTRAL won't relaunch it.",
                    });
                }
                if (elapsed > SlowWatchWindow)
                {
                    Emit(state with { Phase = "ended", Message = "Stopped waiting for the game. No session was recorded." });
                    return;
                }
                await Task.Delay(elapsed > DetectionWindow ? 5000 : 1500, ct);
            }
            if (ct.IsCancellationRequested)
            {
                Emit(state with { Phase = "ended", Message = "Stopped tracking. The game was not affected." });
                return;
            }

            // Phase 2: running.
            var sessionStart = DateTimeOffset.UtcNow;
            var sessionId = _repo.StartSession(inst.GameId, inst.Id, sessionStart);
            Emit(state with { Phase = "running", Message = null, SessionId = sessionId, StartedAt = sessionStart.ToString("O") });

            var collect = _settings.GetBool("performance.collectMetrics");
            using var sampler = collect ? new PerfSampler() : null;
            var samples = new List<PerfSampleDto>();
            var pending = new List<PerfSampleDto>();
            var lastSeenAlive = DateTimeOffset.UtcNow;
            var lastFlush = DateTimeOffset.UtcNow;
            var lastRescan = DateTimeOffset.UtcNow;

            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(2000, ct).ContinueWith(_ => { }, TaskScheduler.Default);
                var now = DateTimeOffset.UtcNow;
                pids = pids.Where(ProcessScanner.IsAlive).ToList();
                if (pids.Count == 0 || now - lastRescan > TimeSpan.FromSeconds(10))
                {
                    // Games often hand off to a second process (launcher → game); rescan to follow it.
                    pids = ProcessScanner.FindUnder(ProcessScanner.Snapshot(), inst.InstallPath, hints, excluded).Select(p => p.Id).ToList();
                    lastRescan = now;
                }
                if (pids.Count > 0) lastSeenAlive = now;
                else if (now - lastSeenAlive > TimeSpan.FromSeconds(8)) break;

                if (sampler is not null)
                {
                    var sample = sampler.Sample((int)(now - sessionStart).TotalMilliseconds);
                    samples.Add(sample);
                    pending.Add(sample);
                    try { Sampled?.Invoke(sample); } catch (Exception ex) { Log.Warn("session", "Sample handler failed", ex: ex); }
                    if (now - lastFlush > TimeSpan.FromSeconds(30))
                    {
                        _repo.AddPerfSamples(sessionId, pending);
                        pending.Clear();
                        lastFlush = now;
                    }
                }
            }

            if (pending.Count > 0) _repo.AddPerfSamples(sessionId, pending);
            var end = lastSeenAlive;
            var duration = (int)Math.Max(0, (end - sessionStart).TotalSeconds);
            var summary = sampler is null ? null : PerfSampler.ToJson(PerfSampler.Summarize(samples));
            _repo.EndSession(sessionId, end, duration, summary);
            Emit(state with
            {
                Phase = "ended",
                Message = ct.IsCancellationRequested ? "Stopped tracking. The session so far was saved." : null,
                SessionId = sessionId,
                DurationSeconds = duration,
                PerfSummary = summary,
                StartedAt = sessionStart.ToString("O"),
            });
        }
        catch (OperationCanceledException)
        {
            Emit(state with { Phase = "ended", Message = "Stopped tracking. The game was not affected." });
        }
        catch (Exception ex)
        {
            Log.Error("session", "Session watcher failed", ex);
            Emit(state with { Phase = "ended", Message = "VYSTRAL lost track of this session. The game was not affected." });
        }
    }

    private static AdapterStatus? SafeStatus(IPlatformAdapter adapter)
    {
        try { return adapter.GetStatus(); }
        catch (Exception ex)
        {
            Log.Warn("session", $"Status check failed for {adapter.Platform}", ex: ex);
            return null;
        }
    }

    private LaunchStateDto Fail(string ticket, string gameId, string installationId, string platform, string message)
    {
        var state = new LaunchStateDto(ticket, gameId, installationId, platform, "failed", message);
        Log.Warn("launch", message, new { gameId, installationId });
        Emit(state);
        return state;
    }

    private void Emit(LaunchStateDto state)
    {
        lock (_lock)
        {
            if (state.Phase is "failed" && _current is { Phase: "starting" or "waiting" or "running" } && _current.Ticket != state.Ticket)
            {
                // A rejected second launch must not overwrite the active one.
            }
            else
            {
                _current = state;
            }
        }
        _events.Emit("launch.state", state);
        try { StateChanged?.Invoke(state); }
        catch (Exception ex) { Log.Error("session", "StateChanged handler failed", ex); }
    }

    public void Dispose() => _watchCts?.Cancel();
}
