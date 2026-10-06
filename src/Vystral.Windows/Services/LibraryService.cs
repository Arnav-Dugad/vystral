using System.Diagnostics;
using Vystral.Core.Contracts;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;

namespace Vystral.Windows.Services;

/// <summary>
/// Coordinates library scans. Each adapter runs in isolation with its own timeout, so one
/// broken integration can't stall or erase the others. Enrichment (artwork/metadata) runs
/// afterwards in the background and never blocks the library from appearing.
/// </summary>
public sealed class LibraryService
{
    private static readonly TimeSpan AdapterTimeout = TimeSpan.FromSeconds(30);

    private readonly IReadOnlyList<IPlatformAdapter> _adapters;
    private readonly LibraryRepository _repo;
    private readonly SettingsService _settings;
    private readonly ArtworkService _artwork;
    private readonly MetadataService _metadata;
    private readonly IEventSink _events;
    private readonly SemaphoreSlim _scanLock = new(1, 1);
    private readonly Dictionary<PlatformId, AdapterScanResult> _lastResults = new();
    private CancellationTokenSource? _enrichCts;

    public Func<bool> IsGameRunning { get; set; } = () => false;

    public LibraryService(IReadOnlyList<IPlatformAdapter> adapters, LibraryRepository repo, SettingsService settings,
        ArtworkService artwork, MetadataService metadata, IEventSink events)
    {
        _adapters = adapters;
        _repo = repo;
        _settings = settings;
        _artwork = artwork;
        _metadata = metadata;
        _events = events;
    }

    public bool IsScanning => _scanLock.CurrentCount == 0;

    public LibrarySnapshotDto Snapshot() => _repo.LoadSnapshot(ArtworkService.Url);

    public IReadOnlyList<AdapterInfoDto> GetAdapters() => _adapters.Select(a =>
    {
        AdapterStatus status;
        try { status = a.GetStatus(); }
        catch (Exception ex) { status = new AdapterStatus(ClientStatus.Error, null, ex.Message); }
        _lastResults.TryGetValue(a.Platform, out var last);
        return new AdapterInfoDto(
            a.Platform.Key(), a.Platform.DisplayName(), _settings.IsPlatformEnabled(a.Platform.Key()),
            status.Status.ToString(), status.ClientPath, status.Detail,
            Enum.GetValues<AdapterCapabilities>().Where(c => c != AdapterCapabilities.None && a.Capabilities.HasFlag(c)).Select(c => c.ToString()).ToList(),
            a.Limitations, last?.Installations.Count, last?.Error, last is null ? null : (int)last.Elapsed.TotalMilliseconds);
    }).ToList();

    public async Task<ScanApplyReport?> ScanAsync(CancellationToken ct)
    {
        if (!await _scanLock.WaitAsync(0, ct)) return null; // a scan is already running
        try
        {
            var enabled = _adapters.Where(a => _settings.IsPlatformEnabled(a.Platform.Key())).ToList();
            _events.Emit("library.scan", new { phase = "started", platforms = enabled.Select(a => a.Platform.Key()) });
            var tasks = enabled.Select(a => RunAdapterAsync(a, ct)).ToList();
            var results = await Task.WhenAll(tasks);
            foreach (var r in results) _lastResults[r.Platform] = r;

            var report = _repo.ApplyScan(results);
            ImportLocalArtwork(results);
            Log.Info("library", "Scan applied", report);
            _events.Emit("library.scan", new
            {
                phase = "completed",
                report.Added, report.Updated, report.MarkedMissing, report.Merged,
                failures = results.Where(r => !r.Succeeded).Select(r => new { platform = r.Platform.Key(), r.Error }),
            });
            _events.Emit("library.changed", null);
            StartEnrichment();
            return report;
        }
        finally
        {
            _scanLock.Release();
        }
    }

    private async Task<AdapterScanResult> RunAdapterAsync(IPlatformAdapter adapter, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(AdapterTimeout);
        try
        {
            var status = adapter.GetStatus();
            if (status.Status == ClientStatus.NotInstalled)
                return new AdapterScanResult(adapter.Platform, true, [], null, sw.Elapsed);
            // Run on the thread pool: some adapters do synchronous file/registry work.
            var found = await Task.Run(() => adapter.DiscoverAsync(timeout.Token), timeout.Token);
            _events.Emit("library.scan", new { phase = "platform", platform = adapter.Platform.Key(), count = found.Count });
            return new AdapterScanResult(adapter.Platform, true, found, null, sw.Elapsed);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            Log.Warn("library", $"{adapter.Platform} scan timed out");
            return new AdapterScanResult(adapter.Platform, false, [], $"{adapter.Platform.DisplayName()} took too long to read. Its games were kept as they were.", sw.Elapsed);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Log.Error("library", $"{adapter.Platform} scan failed", ex);
            return new AdapterScanResult(adapter.Platform, false, [], $"{adapter.Platform.DisplayName()} couldn't be read ({ex.GetType().Name}). Its games were kept as they were.", sw.Elapsed);
        }
    }

    private void ImportLocalArtwork(IEnumerable<AdapterScanResult> results)
    {
        foreach (var result in results.Where(r => r.Succeeded))
        foreach (var found in result.Installations.Where(f => f.LocalArtwork.Count > 0))
        {
            var inst = _repo.GetInstallationsByPlatformId(found.Platform, found.PlatformGameId);
            if (inst is null) continue;
            _artwork.ImportScanned(inst.GameId, found.LocalArtwork, $"{found.Platform.Key()}-local");
        }
    }

    /// <summary>Background enrichment. Pauses while a game runs; cancelled by the next scan.</summary>
    public void StartEnrichment()
    {
        if (!_settings.GetBool("library.fetchMetadata") || _settings.GetBool("privacy.localOnly")) return;
        _enrichCts?.Cancel();
        var cts = _enrichCts = new CancellationTokenSource();
        var fetchArt = _settings.GetBool("library.fetchArtwork");
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(3), cts.Token);
                if (fetchArt && !IsGameRunning()) await PrefetchCoversAsync(cts.Token);
                var total = 0;
                while (!cts.IsCancellationRequested)
                {
                    var n = await _metadata.EnrichAsync(25, fetchArt, IsGameRunning, cts.Token);
                    total += n;
                    if (n == 0) break;
                    _events.Emit("library.changed", new { reason = "metadata" });
                }
                if (total > 0) Log.Info("metadata", $"Enriched {total} games");
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Error("metadata", "Enrichment stopped", ex); }
        }, cts.Token);
    }

    public void StopEnrichment() => _enrichCts?.Cancel();

    /// <summary>
    /// Covers first: Steam's CDN isn't behind the store API's rate limit, so a library of hundreds
    /// of owned games gets its covers in seconds. The UI is told to refresh at most every 1.5 s.
    /// </summary>
    private async Task PrefetchCoversAsync(CancellationToken ct)
    {
        var forgotten = _artwork.ForgetPlaceholders();
        if (forgotten > 0) Log.Info("art", $"Forgot {forgotten} placeholder images to fetch again");
        var games = _repo.SteamGamesMissingCover(2000);
        if (games.Count == 0) return;
        // Steam's own on-disk cache usually has art for owned games too, even ones never installed:
        // importing it is instant, offline and costs no download.
        if (_adapters.OfType<SteamAdapter>().FirstOrDefault()?.FindSteamPath() is { } steamPath)
        {
            var imported = 0;
            foreach (var (gameId, appId) in games)
            {
                ct.ThrowIfCancellationRequested();
                var existing = _repo.GetArtwork(gameId);
                foreach (var (kind, path) in SteamAdapter.FindLocalArtwork(steamPath, appId))
                {
                    if (existing.ContainsKey(kind.ToString().ToLowerInvariant()) || ArtworkService.IsPlaceholder(kind, SafeLength(path))) continue;
                    if (_artwork.ImportLocal(gameId, kind, path, "steam-local") && kind == ArtworkKind.Cover) imported++;
                }
            }
            if (imported > 0)
            {
                Log.Info("art", $"Imported {imported} covers from Steam's local cache");
                _events.Emit("library.changed", new { reason = "artwork" });
                games = _repo.SteamGamesMissingCover(2000);
            }
        }
        var lastEmit = Environment.TickCount64;
        var pending = 0;
        var landed = await _artwork.PrefetchSteamCoversAsync(games, () =>
        {
            Interlocked.Exchange(ref pending, 1);
            var now = Environment.TickCount64;
            var last = Interlocked.Read(ref lastEmit);
            if (now - last >= 1500 && Interlocked.CompareExchange(ref lastEmit, now, last) == last)
            {
                Interlocked.Exchange(ref pending, 0);
                _events.Emit("library.changed", new { reason = "artwork" });
            }
        }, ct);
        if (Interlocked.Exchange(ref pending, 0) == 1) _events.Emit("library.changed", new { reason = "artwork" });
        if (landed > 0) Log.Info("art", $"Fetched {landed} of {games.Count} missing Steam covers");
    }

    private static long SafeLength(string path)
    {
        try { return new FileInfo(path).Length; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { return 0; }
    }
}
