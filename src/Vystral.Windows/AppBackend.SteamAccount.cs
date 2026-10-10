using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Launch;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track A parameter records.
public sealed record SteamConnectParams(string Key, string? SteamId);
public sealed record SteamAccountParams(string SteamId);
public sealed record PlatformParams(string Platform);

/// <summary>
/// Steam Web API (opt-in), achievements, store-driven install/uninstall with live progress,
/// and single-platform rescans. VYSTRAL never installs, moves or deletes game files itself:
/// it asks Steam through steam://install|uninstall and watches Steam's manifests.
/// </summary>
public sealed partial class AppBackend
{
    private SteamAccountService _steamAccount = null!;
    private InstallWatcher _installs = null!;
    private int _steamScanQueued;
    private SteamApiKeyStore _steamKeys = null!;
    private SteamWebApiClient _steamApi = null!;

    public SteamAccountService SteamAccount => _steamAccount;

    private void RegisterSteamAccountHandlers()
    {
        var keys = _steamKeys = new SteamApiKeyStore(new WindowsCredentialStore());
        var api = _steamApi = new SteamWebApiClient(_http, keys.Get); // shared with Track P's friends card (one rate-limited lane)
        _steamAccount = new SteamAccountService(keys, api, Repository, Settings, Artwork, _steam.FindSteamPath, _events)
        {
            IsGameActive = () => IsGameActive,
        };
        _installs = new InstallWatcher(_steam.FindSteamPath, Repository.SteamAppToGame, _events, () => IsGameActive);
        _installs.Completed += (appId, what) =>
        {
            Log.Info("install", $"Steam app {what}", new { appId });
            QueueSteamScan();
        };
        _ = _installs.RunAsync(_life.Token);

        // Owned games refresh on its own at most twice a day, a minute after start.
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(60), _life.Token);
                // The startup scan marks uninstalled games "missing"; owned ones are really "not installed".
                if (Repository.RestoreOwnedSteamMissing(Vystral.Core.Data.LibraryRepository.DriveConnected) > 0) _events.Emit("library.changed", new { reason = "steamOwned" });
                var last = Repository.GetInternalValue("steam.webApi.lastSync");
                var due = last is null || !DateTimeOffset.TryParse(last, out var at) || DateTimeOffset.UtcNow - at > TimeSpan.FromHours(12);
                if (due && keys.IsConfigured && !Settings.GetBool("privacy.localOnly") && !SafeMode && !IsGameActive)
                    await _steamAccount.SyncAsync(_life.Token);
            }
            catch (OperationCanceledException) { }
            catch (BridgeException) { }
            catch (Exception ex) { Log.Warn("steamapi", "Automatic owned-games sync failed", ex: ex); }
        });

        // A full rescan marks uninstalled Steam games "missing"; owned ones go back to "not installed".
        Dispatcher.Register("library.scan", async ct =>
        {
            var report = await Library.ScanAsync(ct);
            if (report is null) return new { alreadyRunning = true };
            if (Repository.RestoreOwnedSteamMissing(Vystral.Core.Data.LibraryRepository.DriveConnected) > 0) _events.Emit("library.changed", new { reason = "steamOwned" });
            _installs.InvalidateGames();
            return report;
        });

        Dispatcher.Register("steam.status",_ => Task.FromResult<object?>(_steamAccount.Status()));
        Dispatcher.Register<SteamConnectParams>("steam.connect", async (p, ct) =>
        {
            var key = RequireText(p.Key, 80, "Key");
            var steamId = p.SteamId is null ? null : RequireText(p.SteamId, 17, "Steam account");
            var result = await _steamAccount.ConnectAsync(key, steamId, ct);
            return new { result, status = _steamAccount.Status() };
        });
        Dispatcher.Register("steam.test", async ct =>
        {
            var result = await _steamAccount.TestAsync(ct);
            return new { result, status = _steamAccount.Status() };
        });
        Dispatcher.Register("steam.sync", async ct =>
        {
            var result = await _steamAccount.SyncAsync(ct);
            return new { result, status = _steamAccount.Status() };
        });
        Dispatcher.Register("steam.disconnect", _ =>
        {
            _steamAccount.Disconnect();
            _events.Emit("library.changed", new { reason = "steamOwned" });
            return Task.FromResult<object?>(_steamAccount.Status());
        });
        Dispatcher.Register<SteamAccountParams>("steam.selectAccount", (p, _) =>
        {
            _steamAccount.SelectAccount(RequireText(p.SteamId, 17, "Steam account"));
            return Task.FromResult<object?>(_steamAccount.Status());
        });
        // Track C1: the "no longer in your Steam library" notice, handed out once.
        Dispatcher.Register("steam.ownershipNotice", _ => Task.FromResult<object?>(_steamAccount.TakeOwnershipNotice()));
        Dispatcher.Register<GameIdParams>("steam.achievements", async (p, ct) =>
            await _steamAccount.GetAchievementsAsync(RequireId(p.GameId), ct));

        Dispatcher.Register<GameIdParams>("steam.install", (p, _) =>
        {
            var gameId = RequireId(p.GameId);
            var inst = Repository.GetSteamInstallation(gameId) ?? throw new BridgeException("unsupported", "This game isn’t from Steam.");
            if (inst.State == InstallState.Installed) throw new BridgeException("invalid", "This game is already installed.");
            RequireSteamClient();
            var uri = StoreActions.Steam(StoreAction.Install, inst.AppId) ?? throw new BridgeException("invalid", "This Steam game can’t be installed from VYSTRAL.");
            _shell.OpenUri(uri);
            _installs.WatchInstall(inst.AppId, gameId);
            Repository.Audit("steam.install", inst.AppId);
            return Task.FromResult<object?>(new { appId = inst.AppId });
        });
        Dispatcher.Register<GameIdParams>("steam.uninstall", (p, _) =>
        {
            var gameId = RequireId(p.GameId);
            var inst = Repository.GetSteamInstallation(gameId) ?? throw new BridgeException("unsupported", "This game isn’t from Steam.");
            if (inst.State != InstallState.Installed) throw new BridgeException("invalid", "This game isn’t installed.");
            if (IsGameActive) throw new BridgeException("busy", "Close your game before uninstalling anything.");
            RequireSteamClient();
            var uri = StoreActions.Steam(StoreAction.Uninstall, inst.AppId) ?? throw new BridgeException("invalid", "This Steam game can’t be uninstalled from VYSTRAL.");
            _shell.OpenUri(uri);
            _installs.WatchUninstall(inst.AppId, gameId);
            Repository.Audit("steam.uninstall", inst.AppId);
            return Task.FromResult<object?>(new { appId = inst.AppId });
        });
        Dispatcher.Register("steam.installs", _ => Task.FromResult<object?>(_installs.Current()));
        Dispatcher.Register<GameIdParams>("steam.forgetInstall", (p, _) =>
        {
            if (Repository.GetSteamInstallation(RequireId(p.GameId)) is { } inst) _installs.Forget(inst.AppId);
            return Task.FromResult<object?>(true);
        });

        Dispatcher.Register<PlatformParams>("library.scanPlatform", async (p, ct) =>
        {
            if (!PlatformInfo.TryParse(p.Platform, out var platform) || platform == PlatformId.Manual)
                throw new BridgeException("invalid", "Unknown platform.");
            return await ScanPlatformAsync(platform, ct);
        });
    }

    private void RequireSteamClient()
    {
        if (_steam.GetStatus().Status != ClientStatus.Available)
            throw new BridgeException("unavailable", "Steam isn’t installed on this PC, so it can’t install or uninstall games.");
    }

    /// <summary>Coalesces manifest changes into one Steam-only rescan a moment later.</summary>
    private void QueueSteamScan()
    {
        if (Interlocked.Exchange(ref _steamScanQueued, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(2), _life.Token);
                Interlocked.Exchange(ref _steamScanQueued, 0);
                await ScanPlatformAsync(PlatformId.Steam, _life.Token);
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Warn("library", "Steam rescan after install change failed", ex: ex); }
            finally { Interlocked.Exchange(ref _steamScanQueued, 0); }
        });
    }

    /// <summary>
    /// Rescans one store only. Same reconciliation as a full scan (missing is marked only for that
    /// store); owned Steam games the scan no longer sees go back to "not installed".
    /// </summary>
    private async Task<object?> ScanPlatformAsync(PlatformId platform, CancellationToken ct)
    {
        // A full scan is running: wait for it (briefly) rather than dropping this rescan, e.g. after a Steam install.
        for (var waited = 0; Library.IsScanning && waited < 120; waited++) await Task.Delay(1000, ct);
        if (Library.IsScanning) return new { alreadyRunning = true };
        if (!Settings.IsPlatformEnabled(platform.Key())) return new { disabled = true };
        var adapter = _adapters.FirstOrDefault(a => a.Platform == platform) ?? throw new BridgeException("invalid", "Unknown platform.");
        var sw = System.Diagnostics.Stopwatch.StartNew();
        AdapterScanResult result;
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            try
            {
                if (adapter.GetStatus().Status == ClientStatus.NotInstalled) return new { notInstalled = true };
                var found = await Task.Run(() => adapter.DiscoverAsync(timeout.Token), timeout.Token);
                result = new AdapterScanResult(platform, true, found, null, sw.Elapsed);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw new BridgeException("timeout", $"{platform.DisplayName()} took too long to read. Its games were kept as they were.");
            }
        }

        var report = Repository.ApplyScan([result]);
        foreach (var found in result.Installations.Where(f => f.LocalArtwork.Count > 0))
        {
            var inst = Repository.GetInstallationsByPlatformId(found.Platform, found.PlatformGameId);
            if (inst is null) continue;
            Artwork.ImportScanned(inst.GameId, found.LocalArtwork, $"{platform.Key()}-local");
        }
        var restored = platform == PlatformId.Steam ? Repository.RestoreOwnedSteamMissing(Vystral.Core.Data.LibraryRepository.DriveConnected) : 0;
        if (platform == PlatformId.Xbox) PokePackageSizes(); // Track C1
        _installs.InvalidateGames();
        Log.Info("library", "Platform rescan applied", new { platform = platform.Key(), report, restored });
        _events.Emit("library.changed", new { reason = "platformScan" });
        Library.StartEnrichment();
        return new { report.Added, report.Updated, report.MarkedMissing, report.Merged, restored };
    }
}
