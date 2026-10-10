using System.Net.Http.Headers;
using Vystral.Core.Data;
using Vystral.Core.Integrations;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Launch;
using Vystral.Windows.Services;

namespace Vystral.Windows;

/// <summary>
/// Composition root for everything below the UI. The WinUI shell creates one instance,
/// forwards bridge messages to <see cref="Dispatcher"/>, and implements <see cref="IHostShell"/>.
/// </summary>
public sealed partial class AppBackend : IDisposable
{
    public AppPaths Paths { get; }
    public BridgeDispatcher Dispatcher { get; } = new();
    public SettingsService Settings { get; }
    public LibraryRepository Repository { get; }
    public LibraryService Library { get; }
    public SessionService Sessions { get; }
    public UpdateService Updates { get; }
    public OllamaService Ai { get; }
    public MediaService Media { get; }
    public ArtworkService Artwork { get; }
    public Database Database { get; }
    public bool SafeMode { get; }
    public bool PreviousRunCrashed { get; }
    public string? StartupProblem { get; }
    public string Version { get; }

    private readonly IHostShell _shell;
    private readonly IEventSink _events;
    private readonly IReadOnlyList<IPlatformAdapter> _adapters;
    private readonly SteamAdapter _steam;
    private readonly HttpClient _http;
    private readonly CancellationTokenSource _life = new();
    private bool _initialScanStarted;

    public AppBackend(IHostShell shell, IEventSink events, bool safeMode, AppPaths? paths = null)
    {
        _shell = shell;
        _events = events;
        Paths = paths ?? new AppPaths();
        Log.Initialize(Paths.Logs);
        Version = typeof(AppBackend).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

        PreviousRunCrashed = File.Exists(Paths.CrashMarker);
        SafeMode = safeMode;
        try { File.WriteAllText(Paths.CrashMarker, DateTimeOffset.Now.ToString("O")); } catch (IOException) { }

        Database = new Database(Paths.Database);
        try
        {
            // Track H: the background tracker may migrate too (after an update); never both at once.
            Tracking.TrackerSignals.WithLock(Tracking.TrackerNames.For(Paths.Root).Migrate, TimeSpan.FromSeconds(30), Database.Migrate);
        }
        catch (MigrationException ex)
        {
            // Keep the broken file for recovery and start with a fresh database so games can still be launched.
            Log.Error("db", "Migration failed; starting with a fresh database", ex);
            StartupProblem = RecoverFromFailedMigration(out var fresh);
            Database = fresh;
        }
        Repository = new LibraryRepository(Database);
        // Track H: a session the background tracker owns or handed over stays open; whoever tracks next continues or closes it.
        var recovered = new Tracking.TrackerFiles(Paths.Root).ReadSession() is { } note
            ? Repository.RecoverOpenSessions([note.SessionId])
            : Repository.RecoverOpenSessions();
        if (recovered > 0) Log.Info("session", $"Closed {recovered} session(s) left open by a previous crash");

        Settings = new SettingsService(Repository);

        _http = new HttpClient(FastConnect.CreateHandler()) { Timeout = TimeSpan.FromSeconds(20) };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("VYSTRAL", Version));
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("(+https://github.com/Arnav-Dugad/vystral)"));

        var registry = new WindowsRegistryReader();
        _steam = new SteamAdapter(registry);
        _adapters = AdapterCatalog.Create(registry, AdapterEnvironment.Current, _steam);

        Artwork = new ArtworkService(Paths, Repository, _http);
        var metadata = new MetadataService(Repository, Artwork, _http);
        Library = new LibraryService(_adapters, Repository, Settings, Artwork, metadata, events);
        Sessions = new SessionService(Repository, _adapters, Settings, events);
        Updates = new UpdateService(events);
        Ai = new OllamaService(Settings, events);
        Media = new MediaService(Repository, Settings, _steam);

        Func<bool> gameRunning = () => IsGameActive;
        Library.IsGameRunning = gameRunning;
        Updates.IsGameRunning = gameRunning;
        Updates.BeforeRestart = Shutdown; // "Restart to update" exits the process: run the clean-exit path first
        Ai.IsGameRunning = gameRunning;
        Sessions.StateChanged += OnLaunchStateChanged;

        RegisterAppHandlers();
        RegisterLibraryHandlers();
        RegisterSystemHandlers();
        RegisterSteamAccountHandlers();   // AppBackend.SteamAccount.cs: Steam Web API, owned games, achievements, installs, storage
        RegisterInsightHandlers();        // AppBackend.Insights.cs: pre-flight, FPS capture, hotkey, notifications
        RegisterStatusHandlers();         // AppBackend.Status.cs: game status tracking, trailers
        RegisterShellHandlers();          // AppBackend.Shell.cs: Windows accent colour, Mica backdrop
        RegisterDataInsightHandlers();    // AppBackend.DataInsights.cs: achievement feed, driver comparison, background apps
        RegisterUpdateExtrasHandlers();   // AppBackend.Updates.cs: what's new, "New" badges, silent rollback, network health
        RegisterLiveTileHandlers();       // AppBackend.LiveTiles.cs: Home live tiles (Steam micro-trailers, cached proxy)
        RegisterDataSourceHandlers();     // AppBackend.DataSources.cs: art picker, enrichment, prices, identity, compatibility, value
        RegisterArtPackHandlers();        // AppBackend.ArtPacks.cs: one SteamGridDB style across the library, undoable
        RegisterTrackingHandlers();       // AppBackend.Tracking.cs: games started outside VYSTRAL, background tracker
        RegisterRecapHandlers();          // AppBackend.Recap.cs: away card, time to beat, anti-cheat notes, value forecast, session replay
        RegisterImmersiveHandlers();      // AppBackend.Immersive.cs: Immersive system bar (battery, network, controller batteries)
        RegisterTrackPHandlers();         // AppBackend.TrackP.cs: friends playing now (opt-in), update-space forecast
        RegisterHealthHandlers();         // AppBackend.Health.cs: library health check, per-game Steam Input layouts (Track Q)
        RegisterCloudHandlers();          // AppBackend.Cloud.cs: Xbox Cloud Gaming and GeForce NOW (opt-in), hours meter
        RegisterPlayDataHandlers();       // AppBackend.PlayData.cs: hardware history, energy estimate, controller battery history (Track Y)
        RegisterTrackXHandlers();         // AppBackend.TrackX.cs: new health issues on Home, layout compare, uninstall advisor, mods, save files
        RegisterSubscriptionHandlers();   // AppBackend.Subscriptions.cs: your subscriptions, what they include, leaving soon, queue alerts (Track V)
        RegisterDiscoverHandlers();       // AppBackend.Discover.cs: universal game search, pages for games you don't own, Watching (Track U)
        RegisterTrackWHandlers();         // AppBackend.TrackW.cs: wishlist, friends' recent games, achievement guide, news (Track W)
        RegisterMaintenanceHandlers();    // AppBackend.Maintenance.cs: first-paint snapshot, startup timings, after-update self-check, compaction (Track AA)
        RegisterLibraryCorrectnessHandlers(); // AppBackend.LibraryCorrectness.cs: Xbox package sizes in the background (Track C1)
        Log.Info("app", "Backend started", new { Version, SafeMode, PreviousRunCrashed });
    }

    /// <summary>
    /// The database couldn't be migrated: move it aside, with its -wal/-shm journal (they belong to it, and a stale
    /// journal next to a fresh file must never be replayed into it), and start fresh. When a file is in use (the
    /// background tracker may hold it open), everything moved is put back and this run uses a fresh database in
    /// the backups folder instead, so startup never fails.
    /// </summary>
    private string RecoverFromFailedMigration(out Database fresh)
    {
        var stamp = DateTime.Now.ToString("yyyyMMddHHmmss");
        var keep = Path.Combine(Paths.Backups, $"failed-migration-{stamp}.db");
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        var moved = new List<(string From, string To)>();
        try
        {
            Directory.CreateDirectory(Paths.Backups);
            // Journal first: if the database itself then can't move, nothing is left half-moved after the roll-back.
            foreach (var (from, to) in new[] { (Paths.Database + "-wal", keep + "-wal"), (Paths.Database + "-shm", keep + "-shm"), (Paths.Database, keep) })
            {
                if (!File.Exists(from)) continue;
                File.Move(from, to, overwrite: true);
                moved.Add((from, to));
            }
            fresh = new Database(Paths.Database);
            fresh.Migrate();
            return $"Your library database couldn't be upgraded, so VYSTRAL started fresh. The old file was kept at {keep}.";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Error("db", "Couldn't move the database aside; using a temporary one for this run", ex);
            for (var i = moved.Count - 1; i >= 0; i--)
            {
                try { File.Move(moved[i].To, moved[i].From, overwrite: false); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { Log.Warn("db", "Couldn't put a database file back", ex: e); }
            }
            var temporary = Path.Combine(Paths.Backups, $"temporary-{stamp}.db");
            Directory.CreateDirectory(Paths.Backups);
            fresh = new Database(temporary);
            fresh.Migrate();
            return "Your library database couldn't be upgraded, and another VYSTRAL process is using it, so this session started with an empty library. Your games and history are safe: close VYSTRAL (and turn off background tracking if it's on), then open it again.";
        }
    }

    /// <summary>A game is starting or running (one rule everywhere: <see cref="SessionService.IsActivePhase"/>), or a cloud stream started from VYSTRAL is running.</summary>
    public bool IsGameActive => Sessions.IsBusy || CloudSessionActive; // Track O: a cloud stream counts too

    /// <summary>Data saver is on (manually, or because the connection is metered): no optional downloads in the background.</summary>
    private bool DataSaverActive => _trailers?.DataSaverActive == true;

    /// <summary>Called once the UI has rendered: kicks off the first scan and the update check.</summary>
    private void OnUiReady()
    {
        if (_initialScanStarted) return;
        _initialScanStarted = true;
        ConfirmStartWhenStable();
        OnUiReadyMaintenance(); // Track AA: startup timings and the after-update self-check
        _ = Task.Run(async () =>
        {
            try { await Library.ScanAsync(_life.Token); }
            catch (Exception ex) { Log.Error("library", "Initial scan failed", ex); }
        });
        if (Settings.GetBool("updates.autoCheck") && !Settings.GetBool("privacy.localOnly") && !SafeMode)
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    // First check shortly after start, then every 6 hours for people who leave VYSTRAL open.
                    await Task.Delay(TimeSpan.FromSeconds(20), _life.Token);
                    while (!_life.IsCancellationRequested)
                    {
                        if (Settings.GetBool("updates.autoCheck") && !Settings.GetBool("privacy.localOnly"))
                        {
                            var state = await Updates.CheckAsync();
                            // Data saver (manual or metered connection): check only; the download waits for the user or a later round.
                            if (state.Phase == "available" && Settings.GetBool("updates.autoDownload") && !DataSaverActive) state = await Updates.DownloadAsync();
                            if (state.Phase == "ready") break; // installs on the next start
                        }
                        await Task.Delay(TimeSpan.FromHours(6), _life.Token);
                    }
                }
                catch (OperationCanceledException) { }
                catch (Exception ex) { Log.Warn("update", "Background update check failed", ex: ex); }
            });
        }
    }

    private int _enrichmentPausedForGame;

    private void OnLaunchStateChanged(LaunchStateDto state)
    {
        // Background enrichment stops as soon as a launch starts (not only once the game runs) and resumes after.
        if (SessionService.IsActivePhase(state.Phase))
        {
            if (Interlocked.Exchange(ref _enrichmentPausedForGame, 1) == 0) Library.StopEnrichment();
            return;
        }
        if (state.Phase == "ended" && state.SessionId is not null) _events.Emit("library.changed", new { reason = "session" });
        if (!IsGameActive && Interlocked.Exchange(ref _enrichmentPausedForGame, 0) == 1) Library.StartEnrichment();
    }

    private int _shutdown;

    public void Shutdown()
    {
        if (Interlocked.Exchange(ref _shutdown, 1) == 1) return; // also run by "Restart to update", before the window closes
        _life.Cancel();
        ShutdownTracking(); // Track H: hand a running session to the background tracker first
        ShutdownCloud();    // Track O: save a running cloud session up to now
        Sessions.StopTracking();
        Updates.ApplyOnExitIfReady();
        RecordCleanExit();
        try { File.Delete(Paths.CrashMarker); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        Log.Info("app", "Clean shutdown");
        Log.Flush(TimeSpan.FromSeconds(1));
    }

    public void Dispose()
    {
        DisposeMaintenance(); // Track AA
        Sessions.Dispose();
        _liveTiles?.Dispose();
        _cloud?.Dispose();
        DisposeSubscriptions(); // Track V
        _cloudHttp?.Dispose();
        _http.Dispose();
        _life.Dispose();
    }
}
