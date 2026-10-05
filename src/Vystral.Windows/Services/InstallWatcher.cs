using Vystral.Core.Parsing;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;

namespace Vystral.Windows.Services;

/// <summary>Progress fields Steam keeps in steamapps\appmanifest_&lt;appid&gt;.acf.</summary>
public sealed record ManifestState(string AppId, long StateFlags, long BytesDownloaded, long BytesToDownload, long BytesStaged, long BytesToStage);

/// <summary>Payload of the <c>install.progress</c> bridge event.</summary>
public sealed record InstallProgressDto(
    string GameId,
    string AppId,
    string Kind,      // install | update | uninstall
    string Phase,     // queued | downloading | staging | paused | installed | removed | unknown
    long BytesDone,
    long BytesTotal,
    double? Rate,     // bytes per second, null when unknown or stale
    bool Watching);

/// <summary>
/// Watches Steam's app manifests to report installs, updates and uninstalls that Steam is doing.
/// It only reads files: each tick stats manifest timestamps and parses a manifest only when it
/// changed. While VYSTRAL is watching something it ticks every second; otherwise it does a light
/// sweep every few seconds. It pauses entirely while a game is running.
/// </summary>
public sealed class InstallWatcher
{
    // EAppState bits (Steam). Many runtime bits are rarely persisted, so byte counters are used too.
    internal const long FlagUpdateRequired = 2, FlagFullyInstalled = 4, FlagUpdateRunning = 256, FlagUpdatePaused = 512,
        FlagUpdateStarted = 1024, FlagUninstalling = 2048, FlagPreallocating = 524288, FlagDownloading = 1048576,
        FlagStaging = 2097152, FlagCommitting = 4194304, FlagValidating = 131072, FlagAddingFiles = 262144;

    private static readonly TimeSpan GiveUpAfter = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan RateStaleAfter = TimeSpan.FromSeconds(45);

    private readonly Func<string?> _steamPath;
    private readonly Func<IReadOnlyDictionary<string, string>> _appToGame;
    private readonly IEventSink _events;
    private readonly Func<bool> _isGameActive;
    private readonly Lock _lock = new();
    private readonly Dictionary<string, Tracked> _tracked = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (string Path, DateTime Mtime, long Length, ManifestState? State)> _manifests = new(StringComparer.Ordinal);
    private IReadOnlyList<string> _steamapps = [];
    private DateTime _foldersReadAt = DateTime.MinValue;
    private IReadOnlyDictionary<string, string> _games = new Dictionary<string, string>();
    private DateTime _gamesReadAt = DateTime.MinValue;
    private bool _baselined;
    private int _tick;

    /// <summary>Raised (on the watcher thread) when an app finished installing or its manifest disappeared.</summary>
    public event Action<string, string>? Completed; // (appId, "installed" | "removed")

    public InstallWatcher(Func<string?> steamPath, Func<IReadOnlyDictionary<string, string>> appToGame, IEventSink events, Func<bool> isGameActive)
    {
        _steamPath = steamPath;
        _appToGame = appToGame;
        _events = events;
        _isGameActive = isGameActive;
    }

    private sealed class Tracked
    {
        public required string AppId { get; init; }
        public required string GameId { get; set; }
        public required string Kind { get; set; }
        public bool Requested { get; set; }
        public DateTime LastChange { get; set; } = DateTime.UtcNow;
        public ManifestState? Last { get; set; }
        public DateTime LastAt { get; set; } = DateTime.UtcNow;
        public string Phase { get; set; } = "queued";
        public double? Rate { get; set; }
        public DateTime RateAt { get; set; } = DateTime.MinValue;
        public InstallProgressDto? Emitted { get; set; }
    }

    /// <summary>Starts watching for an install VYSTRAL just asked Steam to begin.</summary>
    public void WatchInstall(string appId, string gameId) => Request(appId, gameId, "install");

    /// <summary>Starts watching for an uninstall VYSTRAL just asked Steam to begin.</summary>
    public void WatchUninstall(string appId, string gameId) => Request(appId, gameId, "uninstall");

    private void Request(string appId, string gameId, string kind)
    {
        lock (_lock)
        {
            if (!_tracked.TryGetValue(appId, out var t)) _tracked[appId] = t = new Tracked { AppId = appId, GameId = gameId, Kind = kind };
            t.Kind = kind;
            t.GameId = gameId;
            t.Requested = true;
            t.LastChange = DateTime.UtcNow;
            t.Phase = kind == "uninstall" ? "unknown" : t.Phase;
        }
        Emit(appId);
    }

    /// <summary>Stops watching (the user dismissed it). Steam is not affected.</summary>
    public void Forget(string appId)
    {
        InstallProgressDto? last;
        lock (_lock)
        {
            if (!_tracked.Remove(appId, out var t)) return;
            last = Dto(t) with { Watching = false };
        }
        _events.Emit("install.progress", last);
    }

    /// <summary>Everything currently in progress (for UI hydration).</summary>
    public IReadOnlyList<InstallProgressDto> Current()
    {
        lock (_lock) return _tracked.Values.Select(Dto).ToList();
    }

    public void InvalidateGames() => _gamesReadAt = DateTime.MinValue;

    public Task RunAsync(CancellationToken ct) => Task.Run(async () =>
    {
        while (!ct.IsCancellationRequested)
        {
            var busy = false;
            try
            {
                if (_isGameActive())
                {
                    // Performance Mode: no file activity; give-up timers don't advance meanwhile.
                    lock (_lock) foreach (var t in _tracked.Values) t.LastChange = DateTime.UtcNow;
                    await Task.Delay(TimeSpan.FromSeconds(5), ct);
                    continue;
                }
                busy = Tick();
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                Log.Warn("install", "Install watcher tick failed", ex: ex);
            }
            try { await Task.Delay(busy ? TimeSpan.FromSeconds(1) : TimeSpan.FromSeconds(4), ct); }
            catch (OperationCanceledException) { break; }
        }
    }, ct);

    /// <summary>One polling step. Returns true while something is being tracked (fast cadence).</summary>
    internal bool Tick()
    {
        var steam = _steamPath();
        if (steam is null) return false;
        var now = DateTime.UtcNow;
        if (now - _foldersReadAt > TimeSpan.FromSeconds(60))
        {
            _steamapps = SteamAdapter.GetLibraryFolders(steam).Select(f => Path.Combine(f, "steamapps")).Where(Directory.Exists).ToList();
            _foldersReadAt = now;
        }
        if (now - _gamesReadAt > TimeSpan.FromSeconds(30))
        {
            try { _games = _appToGame(); } catch (Exception ex) { Log.Warn("install", "Couldn't map Steam apps to games", ex: ex); }
            _gamesReadAt = now;
        }

        bool tracking;
        lock (_lock) tracking = _tracked.Count > 0;
        var fullSweep = !_baselined || !tracking || _tick++ % 4 == 0;

        var changed = fullSweep ? SweepAll() : SweepTracked();
        var completed = new List<(string AppId, string What)>();
        var toEmit = new List<string>();

        lock (_lock)
        {
            if (fullSweep && _baselined)
            {
                foreach (var (appId, kind) in changed)
                {
                    if (kind == "removed")
                    {
                        completed.Add((appId, "removed"));
                        if (_tracked.TryGetValue(appId, out var t)) { t.Phase = "removed"; t.LastChange = now; toEmit.Add(appId); }
                        continue;
                    }
                    var state = _manifests.GetValueOrDefault(appId).State;
                    if (state is null) continue;
                    var installing = (state.StateFlags & FlagFullyInstalled) == 0;
                    var updating = !installing && IsUpdateActive(state);
                    if ((installing || updating) && !_tracked.ContainsKey(appId) && _games.TryGetValue(appId, out var gid))
                        _tracked[appId] = new Tracked { AppId = appId, GameId = gid, Kind = installing ? "install" : "update" };
                }
            }
            if (!_baselined)
            {
                // First sweep: start tracking updates/installs already in progress, without announcing completions.
                foreach (var (appId, entry) in _manifests)
                {
                    if (entry.State is not { } s || !_games.TryGetValue(appId, out var gid)) continue;
                    if ((s.StateFlags & FlagFullyInstalled) == 0 || IsUpdateActive(s))
                        _tracked[appId] = new Tracked { AppId = appId, GameId = gid, Kind = (s.StateFlags & FlagFullyInstalled) == 0 ? "install" : "update", Last = s };
                }
                _baselined = true;
            }

            foreach (var t in _tracked.Values.ToList())
            {
                var state = _manifests.TryGetValue(t.AppId, out var m) ? m.State : null;
                var previousPhase = t.Phase;
                if (t.Phase == "removed" || (state is null && t.Last is not null))
                {
                    // The manifest vanished: uninstalled, or an install was cancelled in Steam.
                    t.Phase = "removed";
                }
                else if (t.Kind == "uninstall")
                {
                    t.Phase = state is null ? "removed" : (state.StateFlags & FlagUninstalling) != 0 ? "staging" : "unknown";
                }
                else if (!ReferenceEquals(state, t.Last) || state is null)
                {
                    var phase = Classify(t.Last, state, t.Phase);
                    if (state is not null && t.Last is not null)
                    {
                        var (done0, _) = Bytes(t.Last, t.Phase);
                        var (done1, _) = Bytes(state, phase);
                        var dt = (now - t.LastAt).TotalSeconds;
                        if (phase == t.Phase && done1 > done0 && dt > 0.2)
                        {
                            var instant = (done1 - done0) / dt;
                            t.Rate = t.Rate is null || now - t.RateAt > RateStaleAfter ? instant : t.Rate * 0.55 + instant * 0.45;
                            t.RateAt = now;
                        }
                    }
                    if (state is not null && !ReferenceEquals(state, t.Last)) { t.LastChange = now; t.LastAt = now; }
                    t.Last = state;
                    t.Phase = phase;
                }
                if (t.Rate is not null && now - t.RateAt > RateStaleAfter) t.Rate = null;
                if (t.Phase != previousPhase) t.LastChange = now;

                if (t.Phase is "installed" or "removed")
                {
                    toEmit.Add(t.AppId);
                    if (t.Phase == "installed" && t.Kind == "install") completed.Add((t.AppId, "installed"));
                    if (t.Phase == "removed" && !completed.Contains((t.AppId, "removed"))) completed.Add((t.AppId, "removed"));
                    continue;
                }
                if (t.Kind == "update" && state is not null && !IsUpdateActive(state) && (state.StateFlags & FlagFullyInstalled) != 0)
                {
                    t.Phase = "installed";
                    toEmit.Add(t.AppId);
                    continue;
                }
                if (now - t.LastChange > GiveUpAfter)
                {
                    t.Phase = t.Phase is "downloading" or "staging" ? "unknown" : t.Phase;
                    toEmit.Add(t.AppId);
                    continue;
                }
                toEmit.Add(t.AppId);
            }
        }

        foreach (var appId in toEmit.Distinct()) Emit(appId);
        foreach (var (appId, what) in completed.Distinct())
        {
            try { Completed?.Invoke(appId, what); }
            catch (Exception ex) { Log.Warn("install", "Completion handler failed", ex: ex); }
        }
        lock (_lock) return _tracked.Count > 0;
    }

    private void Emit(string appId)
    {
        InstallProgressDto? dto;
        lock (_lock)
        {
            if (!_tracked.TryGetValue(appId, out var t)) return;
            var finished = t.Phase is "installed" or "removed" || DateTime.UtcNow - t.LastChange > GiveUpAfter;
            dto = Dto(t) with { Watching = !finished };
            if (finished) _tracked.Remove(appId);
            if (!finished && dto == t.Emitted) return;
            t.Emitted = dto;
        }
        _events.Emit("install.progress", dto);
    }

    private static InstallProgressDto Dto(Tracked t)
    {
        var (done, total) = t.Last is null ? (0L, 0L) : Bytes(t.Last, t.Phase);
        // Round the rate so tiny jitter doesn't produce a new event every tick.
        var rate = t.Rate is { } r ? Math.Round(r / 1024) * 1024 : (double?)null;
        return new InstallProgressDto(t.GameId, t.AppId, t.Kind, t.Phase, done, total, rate, true);
    }

    /// <summary>Re-reads every manifest in every library. Returns (appId, "changed"|"added"|"removed").</summary>
    private List<(string AppId, string Kind)> SweepAll()
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var changes = new List<(string, string)>();
        foreach (var steamapps in _steamapps)
        {
            IEnumerable<string> files;
            try { files = Directory.EnumerateFiles(steamapps, "appmanifest_*.acf").ToList(); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { continue; }
            foreach (var file in files)
            {
                var appId = AppIdFromFile(file);
                if (appId is null || !seen.Add(appId)) continue;
                var kind = Refresh(appId, file);
                if (kind is not null) changes.Add((appId, kind));
            }
        }
        foreach (var gone in _manifests.Keys.Where(k => !seen.Contains(k)).ToList())
        {
            _manifests.Remove(gone);
            changes.Add((gone, "removed"));
        }
        return changes;
    }

    /// <summary>Re-checks only the manifests of apps being tracked.</summary>
    private List<(string AppId, string Kind)> SweepTracked()
    {
        List<string> ids;
        lock (_lock) ids = _tracked.Keys.ToList();
        var changes = new List<(string, string)>();
        foreach (var appId in ids)
        {
            var path = _manifests.TryGetValue(appId, out var m) ? m.Path : _steamapps.Select(s => Path.Combine(s, $"appmanifest_{appId}.acf")).FirstOrDefault(File.Exists);
            if (path is null || !File.Exists(path))
            {
                if (_manifests.Remove(appId)) changes.Add((appId, "removed"));
                continue;
            }
            var kind = Refresh(appId, path);
            if (kind is not null) changes.Add((appId, kind));
        }
        return changes;
    }

    private string? Refresh(string appId, string path)
    {
        FileInfo info;
        try
        {
            info = new FileInfo(path);
            if (!info.Exists) return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }

        var known = _manifests.TryGetValue(appId, out var prev);
        if (known && prev.Mtime == info.LastWriteTimeUtc && prev.Length == info.Length) return null;
        ManifestState? state = null;
        try
        {
            if (info.Length < 256 * 1024) state = ParseManifest(File.ReadAllText(path));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Steam is mid-write; try again next tick.
            return null;
        }
        _manifests[appId] = (path, info.LastWriteTimeUtc, info.Length, state ?? prev.State);
        return known ? "changed" : "added";
    }

    private static string? AppIdFromFile(string file)
    {
        var name = Path.GetFileNameWithoutExtension(file);
        var id = name.StartsWith("appmanifest_", StringComparison.OrdinalIgnoreCase) ? name[12..] : "";
        return id.Length is > 0 and <= 10 && id.All(char.IsAsciiDigit) ? id : null;
    }

    // ---------- Pure helpers (unit-tested) ----------

    internal static ManifestState? ParseManifest(string text)
    {
        try
        {
            var s = Vdf.Parse(text)["AppState"];
            var appId = s?.GetString("appid");
            if (s is null || appId is null || appId.Length is 0 or > 10 || !appId.All(char.IsAsciiDigit)) return null;
            return new ManifestState(appId,
                s.GetLong("StateFlags") ?? 0,
                Math.Max(0, s.GetLong("BytesDownloaded") ?? 0), Math.Max(0, s.GetLong("BytesToDownload") ?? 0),
                Math.Max(0, s.GetLong("BytesStaged") ?? 0), Math.Max(0, s.GetLong("BytesToStage") ?? 0));
        }
        catch (FormatException)
        {
            return null;
        }
    }

    internal static bool IsUpdateActive(ManifestState s) =>
        (s.StateFlags & (FlagUpdateStarted | FlagUpdateRunning | FlagDownloading | FlagStaging | FlagCommitting | FlagPreallocating | FlagUpdatePaused)) != 0;

    /// <summary>
    /// Derives a user-facing phase. Explicit runtime bits win; otherwise movement of the byte
    /// counters between two observations tells downloading from staging. With no evidence the
    /// previous phase is kept rather than guessed.
    /// </summary>
    internal static string Classify(ManifestState? previous, ManifestState? current, string previousPhase = "queued")
    {
        if (current is null) return "queued";
        var f = current.StateFlags;
        if ((f & FlagUpdatePaused) != 0) return "paused";
        if ((f & (FlagStaging | FlagCommitting)) != 0) return "staging";
        if ((f & (FlagDownloading | FlagPreallocating | FlagAddingFiles | FlagValidating | FlagUpdateRunning)) != 0) return "downloading";
        var pending = (f & (FlagUpdateRequired | FlagUpdateStarted)) != 0;
        if ((f & FlagFullyInstalled) != 0 && !pending) return "installed";
        if (previous is not null)
        {
            if (current.BytesStaged > previous.BytesStaged) return "staging";
            if (current.BytesDownloaded > previous.BytesDownloaded) return "downloading";
        }
        if (!pending) return "unknown";
        if (current.BytesToDownload > 0 && current.BytesDownloaded >= current.BytesToDownload && current.BytesToStage > 0 && current.BytesStaged < current.BytesToStage)
            return "staging";
        if (previousPhase is "downloading" or "staging" or "paused") return previousPhase;
        return current.BytesDownloaded > 0 ? "downloading" : "queued";
    }

    /// <summary>Bytes done/total for the phase: staging counts staged bytes, everything else downloaded bytes.</summary>
    internal static (long Done, long Total) Bytes(ManifestState s, string phase) =>
        phase == "staging" && s.BytesToStage > 0
            ? (Math.Min(s.BytesStaged, s.BytesToStage), s.BytesToStage)
            : (Math.Min(s.BytesDownloaded, Math.Max(s.BytesToDownload, s.BytesDownloaded)), s.BytesToDownload);
}
