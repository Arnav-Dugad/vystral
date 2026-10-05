using System.Diagnostics;
using Velopack.Locators;
using Vystral.Core.Domain;
using Vystral.Windows.Bridge;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;
using Vystral.Windows.Tracking;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track H parameter records.
public sealed record TrackingIgnoreParams(string GameId, bool Ignored);

/// <summary>
/// Track H: games started outside VYSTRAL. While the app is open it notices them itself (same detector as
/// the background tracker); while it is closed the background tracker (<c>Vystral.exe --background-tracker</c>)
/// does. Exactly one process tracks at a time (see <see cref="TrackerSignals"/>). Off by default
/// (<c>tracking.background</c>).
/// </summary>
public sealed partial class AppBackend
{
    public const string BackgroundTrackingSetting = "tracking.background";

    private TrackerNames _trackerNames = null!;
    private TrackerFiles _trackerFiles = null!;
    private TrackerAutostart _autostart = null!;
    private ExternalTracker _externalTracker = null!;
    private MutexHolder? _appLock;
    private MutexHolder? _trackerLock;
    private CancellationTokenSource? _detectCts;
    private readonly Lock _trackingGate = new();
    private volatile bool _trackerOwned;
    private bool _portable;
    private DateTime _helperStartedAt = DateTime.MinValue;

    private void RegisterTrackingHandlers()
    {
        _trackerNames = TrackerNames.For(Paths.Root);
        _trackerFiles = new TrackerFiles(Paths.Root);
        _autostart = new TrackerAutostart(new WindowsRunKeyStore(), FindLauncher(out _portable));
        Sessions.ExternalSource = SessionSources.Detected;
        _externalTracker = new ExternalTracker(Repository, Sessions, () => BackgroundTrackerHost.ClientDirs(_adapters),
            HandleFreeProcessSource.CreateDefault, _trackerFiles, new WindowsPowerStatus());
        Settings.Changed += key =>
        {
            if (key is "*" or BackgroundTrackingSetting) _ = Task.Run(ApplyTracking);
        };

        Dispatcher.Register("tracking.status", _ => Task.FromResult<object?>(TrackingStatus()));
        Dispatcher.Register<TrackingIgnoreParams>("tracking.setIgnored", (p, _) =>
        {
            var gameId = RequireId(p.GameId, "game");
            if (Repository.GetGame(gameId) is null && p.Ignored) throw new BridgeException("notFound", "That game is no longer in your library.");
            _trackerFiles.SetIgnored(gameId, p.Ignored);
            _externalTracker.InvalidateTargets();
            Repository.Audit("tracking.ignore", $"{gameId} {(p.Ignored ? "ignored" : "watched")}");
            return Task.FromResult<object?>(TrackingStatus());
        });

        StartTrackingCoordination();
    }

    /// <summary>
    /// Takes the app's place in the protocol: hold <c>app</c>, ask the background tracker to yield, then own
    /// <c>tracker</c> until exit. Taking ownership continues a handed-over session, so nothing is counted twice.
    /// </summary>
    private void StartTrackingCoordination()
    {
        _appLock = MutexHolder.Acquire(_trackerNames.App);
        _ = Task.Run(async () =>
        {
            try
            {
                await _appLock.Acquired.WaitAsync(TimeSpan.FromSeconds(5));
                TrackerSignals.Set(_trackerNames.Yield);
                var tracker = _trackerLock = MutexHolder.Acquire(_trackerNames.Tracker);
                if (!await tracker.Acquired) return;
                _trackerOwned = true;
                Log.Info("tracker", "VYSTRAL owns game tracking");
                _externalTracker.TakeOver(DateTimeOffset.UtcNow);
                ApplyTracking();
            }
            catch (Exception ex)
            {
                Log.Warn("tracker", "Couldn't take over game tracking", ex: ex);
            }
        });
    }

    /// <summary>Applies <c>tracking.background</c>: autostart entry, detection while open, the background tracker process.</summary>
    private void ApplyTracking()
    {
        try
        {
            lock (_trackingGate)
            {
                var on = Settings.GetBool(BackgroundTrackingSetting);
                try
                {
                    if (on) _autostart.Enable();
                    else _autostart.Disable();
                }
                catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or System.Security.SecurityException)
                {
                    Log.Warn("tracker", "Couldn't update the sign-in entry", ex: ex);
                }

                var detect = on && _trackerOwned && !SafeMode;
                if (detect && _detectCts is null)
                {
                    var cts = _detectCts = new CancellationTokenSource();
                    _externalTracker.InvalidateTargets();
                    _ = Task.Run(() => _externalTracker.RunAsync(cts.Token));
                    Log.Info("tracker", "Noticing games started outside VYSTRAL");
                }
                else if (!detect && _detectCts is not null)
                {
                    _detectCts.Cancel();
                    _detectCts = null;
                }

                // Only the installed app runs the background tracker: a development build would lock its own
                // output folder and track into the real data folder. (Run "--background-tracker" by hand to test it.)
                if (on && !SafeMode && _autostart.Available) EnsureHelperRunning();
            }
            if (!Settings.GetBool(BackgroundTrackingSetting) && TrackerSignals.Exists(_trackerNames.Helper))
                TrackerSignals.StopHelper(_trackerNames, TimeSpan.FromSeconds(5));
        }
        catch (Exception ex)
        {
            Log.Warn("tracker", "Applying the background tracking setting failed", ex: ex);
        }
    }

    /// <summary>Starts the background tracker now (it waits while the app is open and takes over when it closes).</summary>
    private void EnsureHelperRunning()
    {
        if (TrackerSignals.Exists(_trackerNames.Helper)) return;
        if (DateTime.UtcNow - _helperStartedAt < TimeSpan.FromSeconds(30)) return;
        var exe = Environment.ProcessPath;
        if (exe is null || !exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || Path.GetFileNameWithoutExtension(exe).Equals("testhost", StringComparison.OrdinalIgnoreCase)) return;
        _helperStartedAt = DateTime.UtcNow;
        var psi = new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe)! };
        psi.ArgumentList.Add(TrackerCommandLine.Switch);
        if (!string.Equals(Path.GetFullPath(Paths.Root).TrimEnd('\\'), Path.GetFullPath(AppPaths.DefaultRoot).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
        {
            psi.ArgumentList.Add(TrackerCommandLine.DataDirSwitch);
            psi.ArgumentList.Add(Paths.Root);
        }
        try
        {
            using var p = Process.Start(psi);
            Log.Info("tracker", "Started the background tracker", new { pid = p?.Id });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Log.Warn("tracker", "Couldn't start the background tracker", ex: ex);
        }
    }

    /// <summary>
    /// On exit: if the background tracker will carry on, hand it the running session (left open, continued by
    /// it) instead of ending it; then release tracking. Must run before <see cref="SessionService.StopTracking"/>.
    /// </summary>
    private void ShutdownTracking()
    {
        try
        {
            _detectCts?.Cancel();
            if (_trackerOwned && !SafeMode && Settings.GetBool(BackgroundTrackingSetting) && TrackerSignals.Exists(_trackerNames.Helper))
            {
                // Off the UI thread: ParkAsync continues on the thread pool, and this may be called on the UI thread.
                var parked = Task.Run(() => _externalTracker.ParkAsync(TimeSpan.FromSeconds(3))).Wait(TimeSpan.FromSeconds(4));
                if (parked) Log.Info("tracker", "Handed tracking to the background tracker");
            }
        }
        catch (Exception ex)
        {
            Log.Warn("tracker", "Hand-over on exit failed", ex: ex);
        }
        finally
        {
            _trackerOwned = false;
            _trackerLock?.Dispose();
            _appLock?.Dispose();
            _externalTracker?.Dispose();
        }
    }

    private object TrackingStatus()
    {
        var enabled = Settings.GetBool(BackgroundTrackingSetting);
        Core.Data.ObservedSessionRow? last = null;
        try { last = Repository.LatestSession(SessionSources.Background, SessionSources.Detected); }
        catch (Exception ex) { Log.Warn("tracker", "Couldn't read the last noticed session", ex: ex); }
        AutostartState autostart;
        try { autostart = _autostart.State(); }
        catch (Exception) { autostart = AutostartState.Unavailable; }
        var ignored = _trackerFiles.ReadIgnored().Select(id => new { gameId = id, title = SafeGameTitle(id) }).Where(g => g.title is not null).ToList();
        return new
        {
            enabled,
            available = !SafeMode,
            safeMode = SafeMode,
            build = _autostart.Available ? "installed" : _portable ? "portable" : "development",
            autostart = autostart switch
            {
                AutostartState.On => "on",
                AutostartState.Off => "off",
                AutostartState.DisabledByWindows => "disabledByWindows",
                AutostartState.Stale => "stale",
                _ => "unavailable",
            },
            helperRunning = TrackerSignals.Exists(_trackerNames.Helper),
            detecting = _detectCts is not null,
            owner = _trackerOwned,
            watchedGames = _externalTracker.TargetCount,
            pollSeconds = (int)ExternalTracker.PollInterval.TotalSeconds,
            savingPollSeconds = (int)ExternalTracker.SavingPollInterval.TotalSeconds,
            minSessionSeconds = (int)Launch.SessionService.MinExternalSession.TotalSeconds,
            lastSeen = last is null ? null : new
            {
                gameId = last.GameId,
                title = last.GameTitle,
                source = last.Source,
                start = last.Start.ToString("O"),
                end = last.End?.ToString("O"),
                durationSeconds = last.DurationSeconds,
            },
            ignored,
        };
    }

    /// <summary>Velopack's root launcher (installed builds only); <paramref name="portable"/> for the portable zip.</summary>
    private static string? FindLauncher(out bool portable)
    {
        portable = false;
        try
        {
            if (!VelopackLocator.IsCurrentSet) return null;
            var locator = VelopackLocator.Current;
            portable = locator.IsPortable;
            return TrackerAutostart.FindLauncher(locator.RootAppDir, portable, Environment.ProcessPath);
        }
        catch (Exception)
        {
            return null; // not installed by Velopack (development build)
        }
    }
}
