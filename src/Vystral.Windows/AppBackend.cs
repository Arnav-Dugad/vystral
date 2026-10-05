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
            Database.Migrate();
        }
        catch (MigrationException ex)
        {
            // Keep the broken file for recovery and start with a fresh database so games can still be launched.
            Log.Error("db", "Migration failed; starting with a fresh database", ex);
            var keep = Path.Combine(Paths.Backups, $"failed-migration-{DateTime.Now:yyyyMMddHHmmss}.db");
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            File.Move(Paths.Database, keep, overwrite: true);
            Database.Migrate();
            StartupProblem = $"Your library database couldn't be upgraded, so VYSTRAL started fresh. The old file was kept at {keep}.";
        }
        Repository = new LibraryRepository(Database);
        var recovered = Repository.RecoverOpenSessions();
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

        Func<bool> gameRunning = () => Sessions.Current?.Phase is "running" or "waiting" or "starting";
        Library.IsGameRunning = gameRunning;
        Updates.IsGameRunning = gameRunning;
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
        Log.Info("app", "Backend started", new { Version, SafeMode, PreviousRunCrashed });
    }

    public bool IsGameActive => Sessions.Current?.Phase is "running" or "waiting" or "starting";

    /// <summary>Called once the UI has rendered: kicks off the first scan and the update check.</summary>
    private void OnUiReady()
    {
        if (_initialScanStarted) return;
        _initialScanStarted = true;
        ConfirmStartWhenStable();
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
                            if (state.Phase == "available" && Settings.GetBool("updates.autoDownload")) state = await Updates.DownloadAsync();
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

    private void OnLaunchStateChanged(LaunchStateDto state)
    {
        if (state.Phase == "running") Library.StopEnrichment();
        if (state.Phase == "ended" && state.SessionId is not null)
        {
            _events.Emit("library.changed", new { reason = "session" });
            Library.StartEnrichment();
        }
    }

    public void Shutdown()
    {
        _life.Cancel();
        Sessions.StopTracking();
        Updates.ApplyOnExitIfReady();
        RecordCleanExit();
        try { File.Delete(Paths.CrashMarker); } catch (IOException) { }
        Log.Info("app", "Clean shutdown");
    }

    public void Dispose()
    {
        Sessions.Dispose();
        _http.Dispose();
        _life.Dispose();
    }
}
