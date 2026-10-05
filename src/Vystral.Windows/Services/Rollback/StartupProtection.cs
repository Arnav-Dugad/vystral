using System.Text.Json;
using Velopack;
using Velopack.Sources;

namespace Vystral.Windows.Services.Rollback;

/// <summary>
/// Silent rollback, wired to real files and Velopack. The decisions themselves live in
/// <see cref="StartupGuard"/>; this class loads and saves the ledger, preserves packages, and
/// applies a rollback through Velopack's documented downgrade path: an <see cref="UpdateManager"/>
/// over a local <see cref="SimpleFileSource"/> (the rollback folder) with
/// <see cref="UpdateOptions.AllowVersionDowngrade"/>, then <c>ApplyUpdatesAndRestart</c>.
/// </summary>
public sealed class StartupProtection
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private readonly Lock _lock = new();
    private readonly IRollbackFileSystem _fs;

    public string Directory { get; }
    public RollbackPackageStore Packages { get; }
    private string LedgerPath => Path.Combine(Directory, "startup.json");

    /// <summary>Velopack's process-wide locator (set by VelopackApp.Run): packages folder and channel.</summary>
    private static Velopack.Locators.IVelopackLocator? Locator =>
        Velopack.Locators.VelopackLocator.IsCurrentSet ? Velopack.Locators.VelopackLocator.Current : null;

    /// <summary>The version this process recorded at startup (null when not protected: dev build, safe mode).</summary>
    public static string? StartedVersion { get; private set; }

    public StartupProtection(string dataRoot, IRollbackFileSystem? files = null)
    {
        _fs = files ?? new PhysicalRollbackFileSystem();
        Directory = Path.Combine(dataRoot, "update");
        Packages = new RollbackPackageStore(Path.Combine(Directory, "rollback"), _fs);
    }

    public StartupLedger Load()
    {
        lock (_lock)
        {
            try
            {
                var text = _fs.ReadAllText(LedgerPath);
                return text is null ? new StartupLedger() : JsonSerializer.Deserialize<StartupLedger>(text) ?? new StartupLedger();
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                Log.Warn("rollback", "Startup ledger unreadable; starting a fresh one", ex: ex);
                return new StartupLedger();
            }
        }
    }

    public void Save(StartupLedger ledger)
    {
        lock (_lock)
        {
            try
            {
                _fs.CreateDirectory(Directory);
                _fs.WriteAllText(LedgerPath, JsonSerializer.Serialize(ledger, Json));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Log.Warn("rollback", "Couldn't save the startup ledger", ex: ex);
            }
        }
    }

    private void Update(Func<StartupLedger, StartupLedger> change)
    {
        lock (_lock) Save(change(Load()));
    }

    /// <summary>
    /// Runs in Program.Main right after Velopack's hooks and the single-instance check, before any
    /// WinUI or WebView code. Returns only when this process should go on starting; after applying a
    /// rollback, Velopack exits the process and restarts the previous version.
    /// </summary>
    public static void RunAtStartup(string dataRoot, bool safeMode)
    {
        try
        {
            var protection = new StartupProtection(dataRoot);
            var rollbackDir = new DirectoryInfo(protection.Packages.Directory);
            var mgr = new UpdateManager(new SimpleFileSource(rollbackDir), new UpdateOptions { AllowVersionDowngrade = true });
            var installed = mgr.IsInstalled && !mgr.IsPortable;
            var version = installed ? mgr.CurrentVersion?.ToString() : null;
            var preserved = installed ? protection.Packages.Get() : null;

            var ledger = protection.Load();
            var (next, decision) = StartupGuard.OnStart(ledger, new StartContext(version, installed, safeMode, preserved?.Version, DateTimeOffset.Now));
            Log.Info("rollback", "Start recorded", new
            {
                version, decision = decision.Action.ToString(), decision.Reason, failures = next.ConsecutiveFailures,
                next.EverSucceeded, next.LastGoodVersion, preserved = preserved?.Version,
            });
            if (!installed || safeMode) return; // nothing recorded
            protection.Save(next);
            StartedVersion = version;
            if (decision.Action != StartAction.RollBack || preserved is null) return;

            // Recorded first, so even a crash in here can never cause a second attempt.
            if (!protection.TryApplyRollback(mgr, preserved))
                protection.Save(StartupGuard.OnRollbackFailed(protection.Load(), version!));
        }
        catch (Exception ex)
        {
            // Startup protection must never be the reason VYSTRAL doesn't start.
            Log.Error("rollback", "Startup protection failed", ex);
        }
    }

    private bool TryApplyRollback(UpdateManager mgr, PreservedPackage pkg)
    {
        try
        {
            Log.Warn("rollback", "This version didn't start correctly twice; returning to the previous version", new { from = mgr.CurrentVersion?.ToString(), to = pkg.Version });
            if (!Packages.Verify(pkg))
            {
                Log.Error("rollback", "The preserved package failed its SHA-256 check; not rolling back", data: new { pkg.Version, pkg.Sha256 });
                return false;
            }
            Packages.WriteFeed(pkg, Locator?.Channel ?? "win");
            var info = mgr.CheckForUpdates();
            if (info is null || AppVersion.Compare(info.TargetFullRelease.Version.ToString(), pkg.Version) != 0)
            {
                Log.Error("rollback", "Velopack didn't offer the preserved package", data: new { offered = info?.TargetFullRelease.Version.ToString() });
                return false;
            }
            // Copies the package into Velopack's packages folder, checking it against the feed's hashes.
            mgr.DownloadUpdates(info);
            Log.Info("rollback", "Applying the previous version and restarting", new { pkg.Version });
            Log.Flush(TimeSpan.FromSeconds(2));
            mgr.ApplyUpdatesAndRestart(info.TargetFullRelease); // exits this process
            return true;
        }
        catch (Exception ex)
        {
            Log.Error("rollback", "Rollback couldn't be applied", ex);
            return false;
        }
    }

    /// <summary>Called <see cref="StartupGuard.SuccessDelay"/> after the interface reported ready.</summary>
    public void MarkSucceeded(string version)
    {
        Update(l => StartupGuard.OnStartSucceeded(l, version));
        Packages.DeleteIfOlderThan(version);
        Log.Info("rollback", "Start confirmed", new { version });
    }

    public void MarkCleanExit(string version, bool uiWasReady) => Update(l => StartupGuard.OnCleanExit(l, version, uiWasReady));

    public bool IsBlocked(string version) => StartupGuard.IsBlocked(Load(), version);

    public RollbackRecord? PendingNotice(string? version) => StartupGuard.PendingNotice(Load(), version);

    public void DismissNotice() => Update(StartupGuard.MarkNoticeShown);

    /// <summary>
    /// Keeps the running version's full package before an update downloads (Velopack deletes it
    /// afterwards). Best effort: without it, a rollback simply isn't possible for that update.
    /// </summary>
    public PreservedPackage? PreserveCurrent(UpdateManager mgr)
    {
        try
        {
            var current = mgr.CurrentVersion?.ToString();
            if (current is null || !mgr.IsInstalled || mgr.IsPortable) return null;
            if (Locator is not { } locator) return null;
            var asset = locator.GetLocalPackages()
                .Where(p => p.Type == VelopackAssetType.Full && p.Version.ToString() == current)
                .FirstOrDefault() ?? locator.GetLatestLocalFullPackage();
            if (asset is null || asset.Version.ToString() != current)
            {
                Log.Warn("rollback", "No local package for the running version; rollback won't be available for this update", new { current });
                return null;
            }
            var source = Path.Combine(locator.PackagesDir!, asset.FileName);
            return Packages.Preserve(asset.PackageId ?? mgr.AppId ?? "Vystral", current, source, DateTimeOffset.Now);
        }
        catch (Exception ex)
        {
            Log.Warn("rollback", "Couldn't preserve the current package", ex: ex);
            return null;
        }
    }
}
