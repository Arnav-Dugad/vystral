using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using Vystral.Windows.Services.NetworkHealth;
using Vystral.Windows.Services.Rollback;

namespace Vystral.Windows;

public sealed record VersionParams(string Version);
public sealed record BadgeKeysParams(IReadOnlyList<string> Keys);
public sealed record HealthCheckParams(string? Id);

// Track J: "What's new" after an update, "New" badges, silent rollback, Network health.
public sealed partial class AppBackend
{
    private StartupProtection? _startup;
    private WhatsNewStore? _whatsNew;
    private NetworkHealthService? _health;
    private SystemNetworkProbeIo? _healthIo;
    private bool _uiReady;

    /// <summary>Network health's probe registry. Other features add their services with <see cref="NetworkHealthService.Register"/>.</summary>
    public NetworkHealthService Health => _health!;

    private void RegisterUpdateExtrasHandlers()
    {
        _startup = new StartupProtection(Paths.Root);
        Updates.Protection = _startup;
        _whatsNew = new WhatsNewStore(Paths.Root);
        _healthIo = new SystemNetworkProbeIo(Version);
        _health = new NetworkHealthService(_healthIo, () => new HealthContext(
            Settings.GetBool,
            SafeIsSteamKeyConfigured()));

        Dispatcher.Register("whatsNew.state", _ =>
        {
            var current = Updates.State.CurrentVersion;
            var state = _whatsNew.Get(current, Settings.GetBool("onboarding.completed"));
            var notice = _startup.PendingNotice(current);
            return Task.FromResult<object?>(new
            {
                currentVersion = current,
                lastSeenVersion = state.LastSeenVersion,
                firstVersion = state.FirstVersion,
                seenBadges = state.SeenBadges.Keys.ToList(),
                rollbackNotice = notice is null ? null : new { from = notice.From, to = notice.To, at = notice.At },
            });
        });
        Dispatcher.Register<VersionParams>("whatsNew.markSeen", (p, _) =>
        {
            if (!AppVersion.IsValid(p.Version)) throw new BridgeException("invalid", "Invalid version.");
            _whatsNew.MarkVersionSeen(p.Version);
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register<BadgeKeysParams>("whatsNew.badgesSeen", (p, _) =>
        {
            try { _whatsNew.MarkBadgesSeen(p.Keys, DateTimeOffset.Now); }
            catch (ArgumentException) { throw new BridgeException("invalid", "Invalid badge keys."); }
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register("update.dismissRollbackNotice", _ =>
        {
            _startup.DismissNotice();
            return Task.FromResult<object?>(true);
        });

        Dispatcher.Register("network.health.list", _ => Task.FromResult<object?>(_health.List()));
        Dispatcher.Register<HealthCheckParams>("network.health.check", async (p, ct) =>
        {
            if (p.Id is { Length: > 40 }) throw new BridgeException("invalid", "Unknown service.");
            try { return await _health.CheckAsync(p.Id, ct); }
            catch (ArgumentException) { throw new BridgeException("invalid", "Unknown service."); }
        });
    }

    private static bool SafeIsSteamKeyConfigured()
    {
        try { return new SteamApiKeyStore(new WindowsCredentialStore()).IsConfigured; }
        catch (Exception) { return false; }
    }

    /// <summary>The interface reported ready: confirm this start after <see cref="StartupGuard.SuccessDelay"/>.</summary>
    private void ConfirmStartWhenStable()
    {
        _uiReady = true;
        StartHistoryOnReady(); // Track D6: the crash-free streak's own record (also in development builds)
        if (StartupProtection.StartedVersion is not { } version || _startup is null) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(StartupGuard.SuccessDelay, _life.Token);
                // Track AA: a real after-update self-check failure leaves this start unconfirmed, so it counts as a
                // failed start (like one that never got ready). Slowness never does: an unfinished check doesn't block this.
                if (_selfCheckHardFailure)
                {
                    Log.Warn("rollback", "Not confirming this start: the after-update self-check failed", new { version });
                    return;
                }
                _startup.MarkSucceeded(version);
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Warn("rollback", "Couldn't confirm this start", ex: ex); }
        });
    }

    private void RecordCleanExit()
    {
        // Track AA: after a failed self-check a clean exit doesn't clear the attempt either.
        if (StartupProtection.StartedVersion is { } version) _startup?.MarkCleanExit(version, _uiReady && !_selfCheckHardFailure);
        StartHistoryOnCleanExit(); // Track D6
        _healthIo?.Dispose();
    }
}
