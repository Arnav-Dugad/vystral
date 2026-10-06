using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Windows.Services;

namespace Vystral.Windows.DataSources;

// ---------- Bridge DTOs (camelCase; mirrored in ui/src/bridge/types.artPacks.ts) ----------

public sealed record ArtPackPresetDto(string Id, string Label, string Description, IReadOnlyDictionary<string, string[]> Styles);

/// <param name="State">running, paused (by the user), waiting (see Reason), done, cancelled, failed.</param>
/// <param name="Reason">While waiting: offline, dataSaver, gameRunning, rateLimited, unavailable, safeMode. When failed: a message.</param>
public sealed record ArtPackJobDto(string Id, string PresetId, string PresetLabel, IReadOnlyList<string> Kinds, string Scope, bool ReplaceHandPicked,
    string State, string? Reason, int Total, int Done, int Applied, int Kept, int NoMatch, int NoArt, int Failed,
    string Started, string? Finished, int? EtaSeconds, string? Current, string? ResumeAt);

/// <param name="State">done, cancelled, failed, interrupted (VYSTRAL closed mid-run), or running.</param>
public sealed record ArtPackRunDto(string Id, string PresetId, string PresetLabel, string Scope, IReadOnlyList<string> Kinds, int Replaced,
    string Started, string? Finished, string State, string? RestoredAt, bool CanRestore);

public sealed record ArtPacksStatusDto(bool Configured, bool LocalOnly, bool DataSaver, bool GameActive, bool SafeMode,
    IReadOnlyList<ArtPackPresetDto> Presets, ArtPackJobDto? Job, IReadOnlyList<ArtPackRunDto> Runs);

public sealed record ArtPackSampleGameDto(string GameId, string Title);

public sealed record ArtPackPlanDto(int InScope, int Games, int Slots, int KeptHandPicked, int EstimatedSeconds, IReadOnlyList<ArtPackSampleGameDto> Sample);

/// <param name="Reason">noMatch (no confident SteamGridDB match), noArt (nothing in this style), noPreview, or null.</param>
public sealed record ArtPackSampleDto(string GameId, string Kind, string? Thumb, string? MatchedBy, string? Author, string? Reason);

public sealed record ArtPackRestoreDto(int Restored, int Skipped);

/// <summary>
/// Track N: art packs. Applies one SteamGridDB style to many games as a polite background job: one game
/// at a time, API calls spaced by the provider transport, image downloads paced on top, a 429 pauses the
/// job for as long as SteamGridDB asks. It waits (never fails) while Offline mode, Data saver or a game
/// is on, can be paused and cancelled, never replaces art the user chose by hand unless asked, and records
/// everything it replaces so the whole run can be undone (see <see cref="ArtPackManifestStore"/>).
/// </summary>
public sealed class ArtPackService
{
    public static readonly TimeSpan DownloadSpacing = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan MatchTtl = TimeSpan.FromDays(30);
    private static readonly TimeSpan MissTtl = TimeSpan.FromDays(7);

    private readonly LibraryRepository _repo;
    private readonly ArtworkService _artwork;
    private readonly SteamGridDbClient _sgdb;
    private readonly ProviderTransport _transport;
    private readonly ArtPackManifestStore _store;
    private readonly Func<string?> _block;
    private readonly Func<IReadOnlyList<ArtPackGame>> _games;
    private readonly CancellationToken _life;
    private readonly ArtPackPacer _downloads;
    private readonly SemaphoreSlim _wake = new(0, int.MaxValue);
    private readonly object _lock = new();
    private Job? _job;

    /// <summary>Progress, at most a few times a second plus every state change.</summary>
    public Action<ArtPackJobDto>? OnProgress { get; set; }

    /// <summary>Artwork changed (batched while a job runs).</summary>
    public Action? OnArtChanged { get; set; }

    /// <summary>Test hook: how long the job waits before re-checking a block.</summary>
    internal TimeSpan BlockedPoll { get; set; } = TimeSpan.FromSeconds(2);

    /// <param name="block">Why the job can't run right now: notConfigured, offline, dataSaver, safeMode, gameRunning — or null.</param>
    public ArtPackService(LibraryRepository repo, ArtworkService artwork, SteamGridDbClient sgdb, ProviderTransport transport,
        ArtPackManifestStore store, Func<string?> block, Func<IReadOnlyList<ArtPackGame>> games, CancellationToken life, ArtPackPacer? downloads = null)
    {
        _repo = repo;
        _artwork = artwork;
        _sgdb = sgdb;
        _transport = transport;
        _store = store;
        _block = block;
        _games = games;
        _life = life;
        _downloads = downloads ?? new ArtPackPacer(DownloadSpacing);
    }

    // ---------- Status ----------

    public ArtPacksStatusDto Status()
    {
        var block = _block();
        return new ArtPacksStatusDto(block != "notConfigured", block == "offline", block == "dataSaver", block == "gameRunning", block == "safeMode",
            ArtPackPresets.All.Select(ToDto).ToList(), CurrentJob(), Runs());
    }

    public ArtPackJobDto? CurrentJob()
    {
        lock (_lock) return _job?.ToDto();
    }

    public IReadOnlyList<ArtPackRunDto> Runs()
    {
        string? running;
        lock (_lock) running = _job is { Finished: null } j ? j.Id : null;
        return _store.List().Select(m =>
        {
            var state = m.Id == running ? "running" : m.State == "running" ? "interrupted" : m.State;
            var replaced = _store.Entries(m.Id).Count;
            return new ArtPackRunDto(m.Id, m.PresetId, m.PresetLabel, m.Scope, m.Kinds, replaced, m.Started, m.Finished, state, m.RestoredAt,
                CanRestore: running is null && m.RestoredAt is null && replaced > 0);
        }).ToList();
    }

    private static ArtPackPresetDto ToDto(ArtPackPreset p) =>
        new(p.Id, p.Label, p.Description, p.Styles.ToDictionary(kv => kv.Key.ToString().ToLowerInvariant(), kv => kv.Value));

    // ---------- Planning and preview ----------

    public ArtPackPlan BuildPlan(ArtPackRequest request) => ArtPackPlanner.Plan(_games(), _repo.AllArtwork(), request);

    public ArtPackPlanDto Plan(ArtPackRequest request)
    {
        var plan = BuildPlan(request);
        var titles = _games().ToDictionary(g => g.GameId, g => g.Title);
        return new ArtPackPlanDto(plan.InScope, plan.Games, plan.Slots.Count, plan.KeptHandPicked,
            ArtPackPlanner.EstimateSeconds(plan.Games, plan.Slots.Count, _transport.MinSpacing, DownloadSpacing),
            plan.Sample.Select(id => new ArtPackSampleGameDto(id, titles.GetValueOrDefault(id) ?? "")).ToList());
    }

    /// <summary>The image a pack would use for one game and slot, as a cached preview (art-host URL).</summary>
    public async Task<ArtPackSampleDto> SampleAsync(string gameId, ArtPackPreset preset, ArtworkKind kind, CancellationToken ct)
    {
        RequireReady(allowGameRunning: true);
        var k = kind.ToString().ToLowerInvariant();
        if (!preset.Supports(kind)) return new ArtPackSampleDto(gameId, k, null, null, null, "noArt");
        var game = _repo.GetGame(gameId) ?? throw new DataSourceException(DataSourceOutcome.Malformed, "That game no longer exists.");
        var (sgdb, by) = await MatchAsync(game, ct);
        if (sgdb is null) return new ArtPackSampleDto(gameId, k, null, null, null, "noMatch");
        var pick = ArtPackPlanner.PickImage(await _sgdb.GetImagesAsync(kind, sgdb.Id, new SgdbFilter(preset.Styles[kind], false, 0), ct), kind);
        if (pick is null || JsonRead.SafeUrl(pick.Thumb, "steamgriddb.com") is not { } thumb) return new ArtPackSampleDto(gameId, k, null, by, null, "noArt");
        var rel = await _artwork.CacheThumbAsync(thumb, "sgdb", ct);
        return new ArtPackSampleDto(gameId, k, rel is null ? null : ArtworkService.Url("", rel), by, pick.Author, rel is null ? "noPreview" : null);
    }

    /// <summary>Steam app ID first, then an exact, unambiguous title match; cached (misses too) so re-runs are cheap.</summary>
    internal async Task<(SgdbGame? Game, string? By)> MatchAsync(Game game, CancellationToken ct)
    {
        var titleKey = ArtPackPlanner.TitleKey(game.Title);
        if (_repo.GetProviderCache("sgdb-match", game.Id) is { Fresh: true } cached)
        {
            try
            {
                using var doc = JsonDocument.Parse(cached.Body);
                var root = doc.RootElement;
                if (JsonRead.Str(root, "title", 300) == titleKey && JsonRead.Str(root, "steam", 12) == game.SteamAppId)
                {
                    var id = JsonRead.Long(root, "id");
                    return id is > 0 ? (new SgdbGame(id.Value, JsonRead.Str(root, "name", 200) ?? game.Title, null), JsonRead.Str(root, "by", 10)) : (null, null);
                }
            }
            catch (JsonException) { }
        }
        SgdbGame? bySteam = game.SteamAppId is { } appId ? await _sgdb.GetGameBySteamAppIdAsync(appId, ct) : null;
        var search = bySteam is null ? await _sgdb.SearchAsync(game.Title, ct) : null;
        var (match, by) = ArtPackPlanner.Match(bySteam, game.Title, search);
        _repo.SetProviderCache("sgdb-match", game.Id,
            JsonSerializer.Serialize(new { id = match?.Id, name = match?.Name, by, title = titleKey, steam = game.SteamAppId }), match is null ? MissTtl : MatchTtl);
        return (match, by);
    }

    // ---------- The job ----------

    public ArtPackJobDto Start(ArtPackRequest request)
    {
        RequireReady(allowGameRunning: true);
        var plan = BuildPlan(request);
        if (plan.Slots.Count == 0)
            throw new DataSourceException(DataSourceOutcome.Malformed, plan.KeptHandPicked > 0
                ? "Every slot in this selection holds art you chose yourself. Tick “Replace my picks” to change them too."
                : "There’s nothing to change in this selection.");
        Job job;
        lock (_lock)
        {
            if (_job is { Finished: null }) throw new DataSourceException(DataSourceOutcome.Malformed, "An art pack is already being applied. Wait for it to finish, or cancel it.");
            job = _job = new Job(ArtPackManifestStore.NewId(), request, plan.Slots.Count, DateTimeOffset.UtcNow.ToString("O"));
        }
        _store.Save(job.Manifest());
        _store.Prune();
        _repo.Audit("artPacks.start", $"{job.Id} {request.Preset.Id} {request.Scope} {string.Join(',', request.Kinds)} replaceMine={request.ReplaceHandPicked}");
        Running = Task.Run(() => RunAsync(job, plan.Slots));
        Emit(job, force: true);
        return job.ToDto();
    }

    public ArtPackJobDto? Pause() => Signal(j => j.PauseRequested = true);

    public ArtPackJobDto? Resume() => Signal(j => j.PauseRequested = false);

    public ArtPackJobDto? Cancel() => Signal(j => j.CancelRequested = true);

    private ArtPackJobDto? Signal(Action<Job> change)
    {
        Job? job;
        lock (_lock)
        {
            job = _job is { Finished: null } j ? j : null;
            if (job is not null) change(job);
        }
        _wake.Release();
        return job?.ToDto();
    }

    /// <summary>Test hook: the running job's task.</summary>
    internal Task? Running { get; private set; }

    private async Task RunAsync(Job job, IReadOnlyList<ArtPackSlot> slots)
    {
        var clock = job.Clock;
        clock.Start();
        var lastChanged = Stopwatch.StartNew();
        var changedSince = 0;
        string end = "done";
        string? failure = null;
        try
        {
            foreach (var group in slots.GroupBy(s => s.GameId))
            {
                var pending = group.Select(s => s.Kind).ToList();
                var transient = 0;
                while (pending.Count > 0)
                {
                    if (!await WaitUntilRunnableAsync(job, clock)) break;
                    var game = _repo.GetGame(group.Key);
                    if (game is null) { job.Count(pending.Count, ref job.Failed); pending.Clear(); break; }
                    lock (_lock) job.Current = game.Title;
                    try
                    {
                        var (sgdb, _) = await MatchAsync(game, _life);
                        if (sgdb is null)
                        {
                            job.Count(pending.Count, ref job.NoMatch);
                            pending.Clear();
                            break;
                        }
                        while (pending.Count > 0)
                        {
                            if (job.CancelRequested) break;
                            var kind = pending[0];
                            var applied = await ApplySlotAsync(job, game, sgdb, kind);
                            pending.RemoveAt(0);
                            if (applied) changedSince++;
                            Emit(job);
                        }
                        transient = 0;
                    }
                    catch (DataSourceException ex) when (ex.Outcome is DataSourceOutcome.RateLimited)
                    {
                        _downloads.Defer(_transport.BlockedUntil is { } until ? until - DateTimeOffset.UtcNow : TimeSpan.FromMinutes(1));
                        // Loops back to WaitUntilRunnableAsync, which waits out the pause and retries this game.
                    }
                    catch (DataSourceException ex) when (ex.Outcome is DataSourceOutcome.Unavailable or DataSourceOutcome.Malformed)
                    {
                        if (++transient >= 3)
                        {
                            job.Count(pending.Count, ref job.Failed);
                            pending.Clear();
                            Log.Warn("artpacks", "Skipped a game after repeated errors", new { gameId = group.Key, outcome = ex.Outcome.ToString() });
                        }
                        else
                        {
                            lock (_lock) { job.State = "waiting"; job.Reason = "unavailable"; }
                            Emit(job, force: true);
                            await Task.Delay(TimeSpan.FromSeconds(5 * transient), _life);
                        }
                    }
                }
                if (changedSince > 0 && (changedSince >= 12 || lastChanged.Elapsed > TimeSpan.FromSeconds(4)))
                {
                    changedSince = 0;
                    lastChanged.Restart();
                    OnArtChanged?.Invoke();
                }
                if (job.CancelRequested) break;
            }
            if (job.CancelRequested) end = "cancelled";
        }
        catch (OperationCanceledException) { end = "cancelled"; }
        catch (DataSourceException ex)
        {
            end = "failed";
            failure = ex.Outcome is DataSourceOutcome.InvalidKey
                ? "SteamGridDB stopped accepting your API key, so the art pack stopped. What changed so far can still be restored."
                : ex.Message;
        }
        catch (Exception ex)
        {
            end = "failed";
            failure = "Something went wrong while applying the art pack. What changed so far can still be restored.";
            Log.Warn("artpacks", "Art pack failed", ex: ex);
        }
        lock (_lock)
        {
            job.State = end;
            job.Reason = failure;
            job.Current = null;
            job.Finished = DateTimeOffset.UtcNow.ToString("O");
        }
        clock.Stop();
        try { _store.Save(job.Manifest()); } catch (IOException ex) { Log.Warn("artpacks", "Couldn’t save the art-pack record", ex: ex); }
        _repo.Audit("artPacks.finish", $"{job.Id} {end} applied={job.Applied} kept={job.Kept} noMatch={job.NoMatch} noArt={job.NoArt} failed={job.Failed}");
        if (changedSince > 0 || job.Applied > 0) OnArtChanged?.Invoke();
        Emit(job, force: true);
    }

    /// <summary>Downloads and stores one slot. Returns true when the art changed.</summary>
    private async Task<bool> ApplySlotAsync(Job job, Game game, SgdbGame sgdb, ArtworkKind kind)
    {
        var images = await _sgdb.GetImagesAsync(kind, sgdb.Id, new SgdbFilter(job.Request.Preset.Styles[kind], false, 0), _life);
        var pick = ArtPackPlanner.PickImage(images, kind);
        if (pick is null || JsonRead.SafeUrl(pick.Url, "steamgriddb.com") is not { } url)
        {
            job.Count(1, ref job.NoArt);
            return false;
        }
        await _downloads.WaitAsync(_life);
        var file = await _artwork.DownloadPackArtAsync(game.Id, kind, url, _life);
        if (file is null)
        {
            job.Count(1, ref job.Failed);
            return false;
        }
        var (written, previous) = _repo.ApplyPackArtwork(game.Id, kind, file, job.Request.ReplaceHandPicked);
        if (!written)
        {
            job.Count(1, ref job.Kept); // the user picked something while the pack ran
            return false;
        }
        var unchanged = previous is { Source: LibraryRepository.ArtPackSource } && previous.File == file;
        if (!unchanged) _store.Append(job.Id, new ArtPackEntry(game.Id, kind.ToString().ToLowerInvariant(), file, previous));
        _repo.SetProviderCache("art-credit", $"{game.Id}:{kind.ToString().ToLowerInvariant()}",
            JsonSerializer.Serialize(new { author = pick.Author, id = pick.Id, pack = job.Request.Preset.Label }), TimeSpan.FromDays(3650));
        job.Count(1, ref job.Applied);
        return !unchanged;
    }

    /// <summary>Waits while paused or blocked. False when the job was cancelled.</summary>
    private async Task<bool> WaitUntilRunnableAsync(Job job, Stopwatch clock)
    {
        while (true)
        {
            if (job.CancelRequested) return false;
            var block = _block();
            if (block == "notConfigured")
                throw new DataSourceException(DataSourceOutcome.NotConfigured, "The SteamGridDB key was removed, so the art pack stopped. What changed so far can still be restored.");
            var paused = _transport.BlockedUntil;
            var reason = job.PauseRequested ? "paused" : block ?? (paused is not null ? "rateLimited" : null);
            if (reason is null)
            {
                bool changed;
                lock (_lock)
                {
                    changed = job.State != "running";
                    job.State = "running";
                    job.Reason = null;
                    job.ResumeAt = null;
                }
                if (!clock.IsRunning) clock.Start();
                if (changed) Emit(job, force: true);
                return true;
            }
            bool stateChanged;
            lock (_lock)
            {
                var state = reason == "paused" ? "paused" : "waiting";
                stateChanged = job.State != state || job.Reason != (reason == "paused" ? null : reason);
                job.State = state;
                job.Reason = reason == "paused" ? null : reason;
                job.ResumeAt = reason == "rateLimited" ? paused?.ToString("O") : null;
            }
            clock.Stop();
            if (stateChanged)
            {
                Emit(job, force: true);
                try { _store.Save(job.Manifest()); } catch (IOException) { }
            }
            var wait = reason == "rateLimited" && paused is { } p ? Clamp(p - DateTimeOffset.UtcNow) : BlockedPoll;
            await Task.WhenAny(_wake.WaitAsync(_life), Task.Delay(wait, _life));
            _life.ThrowIfCancellationRequested();
        }
    }

    private TimeSpan Clamp(TimeSpan t) => t < TimeSpan.FromMilliseconds(200) ? TimeSpan.FromMilliseconds(200) : t > BlockedPoll * 30 ? BlockedPoll * 30 : t;

    private long _lastEmit;

    private void Emit(Job job, bool force = false)
    {
        var now = Environment.TickCount64;
        if (!force && now - Interlocked.Read(ref _lastEmit) < 250) return;
        Interlocked.Exchange(ref _lastEmit, now);
        ArtPackJobDto dto;
        lock (_lock) dto = job.ToDto();
        OnProgress?.Invoke(dto);
    }

    private void RequireReady(bool allowGameRunning)
    {
        switch (_block())
        {
            case "notConfigured":
                throw new DataSourceException(DataSourceOutcome.NotConfigured, "Art packs use SteamGridDB, which needs your own free API key. Add it in Settings → Library & stores → Data sources.");
            case "offline":
                throw new DataSourceException(DataSourceOutcome.Offline, "Offline mode is on, so VYSTRAL doesn’t contact SteamGridDB. Turn it off in Settings → Privacy.");
            case "dataSaver":
                throw new DataSourceException(DataSourceOutcome.Disabled, "Data saver is on, so art packs don’t download artwork. Turn it off in Settings → Privacy to apply one.");
            case "safeMode":
                throw new DataSourceException(DataSourceOutcome.Disabled, "Background downloads are off in safe mode.");
            case "gameRunning" when !allowGameRunning:
                throw new DataSourceException(DataSourceOutcome.Disabled, "A game is running. Art packs wait until it closes.");
        }
    }

    // ---------- Undo ----------

    /// <summary>
    /// Puts back everything one run replaced, newest change first. Slots changed since (by hand or by a newer
    /// pack) are left alone and counted as skipped. Previous files that no longer exist are not pointed to;
    /// those slots return to the store's art on the next scan.
    /// </summary>
    public ArtPackRestoreDto Restore(string id)
    {
        lock (_lock)
            if (_job is { Finished: null }) throw new DataSourceException(DataSourceOutcome.Malformed, "Wait for the current art pack to finish (or cancel it) before restoring.");
        var m = _store.Load(id) ?? throw new DataSourceException(DataSourceOutcome.Malformed, "That art pack record no longer exists.");
        if (m.RestoredAt is not null) return new ArtPackRestoreDto(0, 0);
        int restored = 0, skipped = 0;
        foreach (var e in _store.Entries(id).Reverse())
        {
            if (!Enum.TryParse<ArtworkKind>(e.Kind, true, out var kind)) { skipped++; continue; }
            var previous = e.Previous is { } p && _artwork.CachedFileExists(p.File) ? p : null;
            if (_repo.RestorePackArtwork(e.GameId, kind, e.File, previous)) restored++;
            else skipped++;
        }
        _store.Save(m with { RestoredAt = DateTimeOffset.UtcNow.ToString("O") });
        _repo.Audit("artPacks.restore", $"{id} restored={restored} skipped={skipped}");
        if (restored > 0) OnArtChanged?.Invoke();
        return new ArtPackRestoreDto(restored, skipped);
    }

    /// <summary>Cache files an undo may need (kept when the art cache is cleared).</summary>
    public IEnumerable<string> ReferencedFiles() => _store.ReferencedFiles();

    // ---------- Job state ----------

    private sealed class Job(string id, ArtPackRequest request, int total, string started)
    {
        public string Id { get; } = id;
        public ArtPackRequest Request { get; } = request;
        public int Total { get; } = total;
        public string Started { get; } = started;
        public string State { get; set; } = "running";
        public string? Reason { get; set; }
        public string? Current { get; set; }
        public string? Finished { get; set; }
        public string? ResumeAt { get; set; }
        /// <summary>Runs only while the job is actually working (not paused or waiting), for the ETA.</summary>
        public Stopwatch Clock { get; } = new();
        public volatile bool PauseRequested;
        public volatile bool CancelRequested;
        public int Applied, Kept, NoMatch, NoArt, Failed;

        public int Done => Applied + Kept + NoMatch + NoArt + Failed;

        public void Count(int n, ref int field) => Interlocked.Add(ref field, n);

        public ArtPackJobDto ToDto()
        {
            int? eta = null;
            if (Finished is null && Done >= 3 && State == "running")
            {
                var perSlot = Clock.Elapsed.TotalSeconds / Math.Max(1, Done);
                eta = (int)Math.Ceiling(perSlot * (Total - Done));
            }
            return new ArtPackJobDto(Id, Request.Preset.Id, Request.Preset.Label, Request.Kinds.Select(k => k.ToString().ToLowerInvariant()).ToList(),
                Request.Scope.ToString(), Request.ReplaceHandPicked, State, Reason, Total, Done, Applied, Kept, NoMatch, NoArt, Failed, Started, Finished, eta, Current, ResumeAt);
        }

        public ArtPackManifest Manifest() => new(Id, Request.Preset.Id, Request.Preset.Label, Request.Scope.ToString(),
            Request.Kinds.Select(k => k.ToString().ToLowerInvariant()).ToList(), Request.ReplaceHandPicked, Started, Finished,
            Finished is null ? "running" : State, null);
    }
}
