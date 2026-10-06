using System.Runtime;
using System.Runtime.InteropServices;
using System.Text.Json;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Launch;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;

namespace Vystral.Windows.Tracking;

/// <summary>
/// The background tracker process (<c>Vystral.exe --background-tracker</c>): no window, no XAML, no
/// WebView2 — only the database, the game detector and the session recorder. It tracks games only
/// while the app is closed; whenever the app runs, it hands its session over and waits.
/// </summary>
public sealed class BackgroundTrackerHost : IDisposable
{
    private static readonly TimeSpan OwnerCheck = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan NoDatabaseRetry = TimeSpan.FromMinutes(5);

    private readonly AppPaths _paths;
    private readonly TrackerNames _names;
    private readonly Func<NotificationRequest, bool>? _showToast;
    private EventWaitHandle? _stop;
    private EventWaitHandle? _yield;
    private Composition? _app;

    private sealed record Composition(Database Db, LibraryRepository Repo, SettingsService Settings, SessionService Sessions,
        ExternalTracker Tracker, NotificationPolicy Policy);

    public BackgroundTrackerHost(AppPaths paths, Func<NotificationRequest, bool>? showToast)
    {
        _paths = paths;
        _names = TrackerNames.For(paths.Root);
        _showToast = showToast;
    }

    /// <summary>Process entry for <c>--background-tracker</c>. Returns the exit code.</summary>
    public static int Main(TrackerCommand command, Func<NotificationRequest, bool>? showToast)
    {
        var paths = new AppPaths(command.DataDir);
        Log.Initialize(paths.Logs, "vystral-tracker");
        // Never keep the install folder open as the working directory: the updater renames current\.
        try { Environment.CurrentDirectory = paths.Root; } catch (IOException) { }
        using var host = new BackgroundTrackerHost(paths, showToast);
        var code = 0;
        // Mutexes belong to the thread that takes them: run the whole lifetime on one MTA thread.
        var thread = new Thread(() => code = host.Run()) { Name = "vystral-tracker", IsBackground = false };
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
        thread.Join();
        return code;
    }

    /// <summary>Runs until asked to stop (or tracking is turned off). Blocking.</summary>
    public int Run()
    {
        using var single = new Mutex(false, _names.Helper);
        try
        {
            if (!single.WaitOne(TimeSpan.FromSeconds(2))) return 0; // already running
        }
        catch (AbandonedMutexException) { /* a previous tracker crashed; we own it now */ }

        try
        {
            _stop = TrackerSignals.OpenEvent(_names.Stop);
            _yield = TrackerSignals.OpenEvent(_names.Yield);
            _stop.Reset(); // a stop meant for an earlier instance isn't for us
            Log.Info("tracker", "Background tracker started", new { pid = Environment.ProcessId, version = Version() });
            while (true)
            {
                if (WaitWhileAppRuns()) break;
                using var tracker = new Mutex(false, _names.Tracker);
                bool owned;
                try { owned = WaitHandle.WaitAny([tracker, _stop], TimeSpan.FromSeconds(30)) == 0; }
                catch (AbandonedMutexException e) when (e.MutexIndex == 0) { owned = true; }
                if (!owned)
                {
                    if (_stop.WaitOne(0)) break;
                    continue;
                }
                bool exit;
                try { exit = OwnerPhase(); }
                finally { tracker.ReleaseMutex(); }
                if (exit) break;
            }
            Log.Info("tracker", "Background tracker stopped");
            return 0;
        }
        catch (Exception ex)
        {
            Log.Error("tracker", "Background tracker failed", ex);
            return 1;
        }
        finally
        {
            // Stop the session loop first: it reads the tracker's process snapshots.
            try { _app?.Sessions.Dispose(); } catch (Exception) { }
            try { _app?.Tracker.Dispose(); } catch (Exception) { }
            single.ReleaseMutex();
        }
    }

    /// <summary>Waits while the app's window process runs. True when asked to stop meanwhile.</summary>
    private bool WaitWhileAppRuns()
    {
        if (!Mutex.TryOpenExisting(_names.App, out var app)) return _stop!.WaitOne(0);
        using (app)
        {
            Log.Info("tracker", "VYSTRAL is open; the background tracker is paused");
            Trim();
            try
            {
                if (WaitHandle.WaitAny([app, _stop!]) == 1) return true;
            }
            catch (AbandonedMutexException e) when (e.MutexIndex == 0) { /* the app crashed */ }
            app.ReleaseMutex(); // held for an instant only: it just tells us the app is gone
        }
        return false;
    }

    /// <summary>Tracks games while this process owns tracking. True when the process should exit.</summary>
    private bool OwnerPhase()
    {
        _yield!.Reset();
        if (TrackerSignals.Exists(_names.App)) return false;
        var app = _app ??= Compose();
        if (app is null) return WaitOrStop(NoDatabaseRetry);
        switch (EnsureSchema(app.Db))
        {
            case SchemaState.Missing: return WaitOrStop(NoDatabaseRetry);
            case SchemaState.Newer:
                Log.Warn("tracker", "The database was created by a newer VYSTRAL; this tracker exits until VYSTRAL starts it again");
                return true;
        }
        app.Settings.Reload();
        if (!app.Settings.GetBool("tracking.background"))
        {
            Log.Info("tracker", "Background tracking is turned off; exiting");
            return true;
        }

        Log.Info("tracker", "Tracking games while VYSTRAL is closed");
        app.Tracker.InvalidateTargets();
        app.Tracker.TakeOver(DateTimeOffset.UtcNow);
        using var cts = new CancellationTokenSource();
        var loop = Task.Run(() => app.Tracker.RunAsync(cts.Token));
        var exit = false;
        var trimDue = 1;
        void OnClosed(string _) => Interlocked.Exchange(ref trimDue, 1);
        app.Sessions.SessionClosed += OnClosed;
        while (true)
        {
            // Give back the memory a session used (performance counters, NVML) once it is over.
            if (Interlocked.Exchange(ref trimDue, 0) == 1 && !app.Sessions.IsBusy) Trim();
            var signal = WaitHandle.WaitAny([_stop!, _yield], OwnerCheck);
            if (signal == 0) { exit = true; break; }
            if (signal == 1 || TrackerSignals.Exists(_names.App)) break;
        }
        app.Sessions.SessionClosed -= OnClosed;
        cts.Cancel();
        try { loop.Wait(TimeSpan.FromSeconds(5)); } catch (AggregateException) { }
        var parked = app.Tracker.ParkAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
        Log.Info("tracker", exit ? "Stopping" : "VYSTRAL opened; handing tracking over", new { parked });
        return exit;
    }

    private bool WaitOrStop(TimeSpan wait) => WaitHandle.WaitAny([_stop!, _yield!], wait) == 0;

    private enum SchemaState { Ready, Missing, Newer }

    /// <summary>
    /// The tracker never creates a library: without a database (VYSTRAL never opened) it waits. An older
    /// schema is migrated under the cross-process migration lock, exactly as the app does it.
    /// </summary>
    private SchemaState EnsureSchema(Database db)
    {
        if (!File.Exists(db.FilePath)) return SchemaState.Missing;
        try
        {
            var version = db.SchemaVersion();
            if (version == 0) return SchemaState.Missing;
            if (version > Database.LatestVersion) return SchemaState.Newer;
            if (version == Database.LatestVersion) return SchemaState.Ready;
            TrackerSignals.WithLock(_names.Migrate, TimeSpan.FromSeconds(30), () => db.Migrate());
            return SchemaState.Ready;
        }
        catch (Exception ex)
        {
            // Never move or replace the file here: the app owns recovery from a failed migration.
            Log.Error("tracker", "The database isn't usable by the background tracker", ex);
            return SchemaState.Missing;
        }
    }

    private Composition? Compose()
    {
        if (!File.Exists(_paths.Database)) return null;
        var db = new Database(_paths.Database, pooling: false);
        var repo = new LibraryRepository(db);
        SettingsService settings;
        try { settings = new SettingsService(repo); }
        catch (Exception ex)
        {
            Log.Warn("tracker", "Settings unreadable", ex: ex);
            return null;
        }
        var registry = new WindowsRegistryReader();
        var adapters = AdapterCatalog.Create(registry, AdapterEnvironment.Current, new SteamAdapter(registry));
        var policy = new NotificationPolicy(settings.GetBool, id => SafeTitle(repo, id));
        var sink = new ToastSink(this, settings, policy);
        var sessions = new SessionService(repo, adapters, settings, sink) { ExternalSource = SessionSources.Background };
        sessions.GpuIdentity = sampler => GpuDriverProbe.Read(sampler, registry);
        sessions.BackgroundApps = () => settings.GetBool("performance.backgroundApps")
            ? new BackgroundAppTracker(new NtProcessSnapshotSource(), BackgroundAppTracker.ReadMemoryLoad, Environment.ProcessId, Environment.ProcessorCount)
            : null;
        var tools = Path.Combine(_paths.Root, "tools");
        sessions.FpsCapture = () => FpsCapturePlanner.Plan(settings.GetBool("fps.captureEnabled"), tools);
        var tracker = new ExternalTracker(repo, sessions, () => ClientDirs(adapters), HandleFreeProcessSource.CreateDefault,
            new TrackerFiles(_paths.Root), new WindowsPowerStatus());
        return new Composition(db, repo, settings, sessions, tracker, policy);
    }

    /// <summary>Folders of the installed store clients (their processes are never a game).</summary>
    public static IReadOnlyList<string> ClientDirs(IEnumerable<IPlatformAdapter> adapters)
    {
        var dirs = new List<string>();
        foreach (var a in adapters)
        {
            try
            {
                if (a.GetStatus().ClientPath is { } exe && Path.GetDirectoryName(exe) is { Length: > 0 } dir) dirs.Add(dir);
            }
            catch (Exception ex) { Log.Warn("tracker", $"Status check failed for {a.Platform}", ex: ex); }
        }
        return dirs;
    }

    private static string? SafeTitle(LibraryRepository repo, string gameId)
    {
        try { return repo.GetGame(gameId)?.Title; }
        catch (Exception) { return null; }
    }

    /// <summary>
    /// "Session saved" for background sessions: the same <see cref="NotificationPolicy"/> (and settings) as
    /// the app, shown as a protocol-activated toast, so selecting it opens the journal in VYSTRAL.
    /// </summary>
    private sealed class ToastSink(BackgroundTrackerHost host, SettingsService settings, NotificationPolicy policy) : IEventSink
    {
        public void Emit(string eventName, object? payload)
        {
            if (eventName != "launch.state" || host._showToast is null) return;
            if (payload is not LaunchStateDto { Phase: "ended", SessionId: not null }) return;
            try
            {
                settings.Reload();
                using var doc = JsonDocument.Parse(BridgeDispatcher.EventJson(eventName, payload));
                foreach (var n in policy.Evaluate(eventName, doc.RootElement.GetProperty("payload"), foreground: false))
                    host._showToast(n);
            }
            catch (Exception ex) { Log.Warn("tracker", "Couldn't show the session notification", ex: ex); }
        }
    }

    /// <summary>Gives memory back to Windows while idle (the tracker's working set should stay small).</summary>
    private static void Trim()
    {
        try
        {
            GCSettings.LargeObjectHeapCompactionMode = GCLargeObjectHeapCompactionMode.CompactOnce;
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            SetProcessWorkingSetSize(new IntPtr(-1), -1, -1); // -1: this process
        }
        catch (Exception) { }
    }

    private static string Version() => typeof(BackgroundTrackerHost).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    public void Dispose()
    {
        _stop?.Dispose();
        _yield?.Dispose();
    }

    [DllImport("kernel32.dll")]
    private static extern bool SetProcessWorkingSetSize(IntPtr process, nint min, nint max);
}
