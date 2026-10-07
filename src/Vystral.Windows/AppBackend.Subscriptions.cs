using Vystral.Core.Cloud;
using Vystral.Windows.Bridge;
using Vystral.Windows.Cloud;
using Vystral.Windows.DataSources;
using Vystral.Windows.Integrations;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;
using Vystral.Windows.Subscriptions;

namespace Vystral.Windows;

// Track V parameter records.
public sealed record SubsProductParams(string ProductId);

/// <summary>
/// Track V: your gaming subscriptions (stored locally only), what they include (opt-in public Game Pass lists),
/// "Leaving soon", and GeForce NOW queue alerts read from the official app's window title.
/// </summary>
public sealed partial class AppBackend
{
    private SubscriptionService? _subs;
    private readonly GfnQueueWatcher _queue = new();
    private NtProcessSnapshotSource? _queueProcesses;
    public SubscriptionService Subscriptions => _subs!;

    private void RegisterSubscriptionHandlers()
    {
        _subs = new SubscriptionService(Repository, Settings, _cloudHttp ?? CloudPlayService.CreateHttpClient(Version), _events,
            Path.Combine(Paths.Root, "subscriptions-cache.json"))
        {
            DataSaverActive = () => DataSaverActive,
            GameActive = () => IsGameActive,
            Market = () => _cloud?.Market.Market ?? "US",
            CacheImage = (url, ct) => Artwork.CacheStoreImageAsync(url, ct),
        };

        Settings.Changed += key =>
        {
            if (!key.StartsWith("subs.", StringComparison.Ordinal) && key is not ("cloud.market" or "cloud.gfnPlan" or "privacy.localOnly" or "*")) return;
            _subs.Invalidate();
            _events.Emit("subs.changed", _subs.Status());
            // Turning the lists on, or picking a plan that has one, fetches what's due, politely, in the background.
            if (key is "subs.catalog" or "subs.owned" or "cloud.market" && _subs.CatalogOn) StartSubscriptionWork(TimeSpan.FromSeconds(2));
        };

        Dispatcher.Register("subs.status", _ => Task.FromResult<object?>(_subs.Status()));
        Dispatcher.Register("subs.map", _ => Task.FromResult<object?>(_subs.Map()));
        Dispatcher.Register("subs.included", _ => Task.FromResult<object?>(_subs.Included()));
        Dispatcher.Register("subs.value", _ => Task.FromResult<object?>(_subs.Value()));
        Dispatcher.Register("subs.refresh", async ct => await Run(() => _subs.RefreshAsync(manual: true, ct)));
        Dispatcher.Register<SubsProductParams>("subs.openStore", (p, _) =>
        {
            // Only a product from a list VYSTRAL downloaded, opened on its official page. Nothing is installed.
            if (!CloudIds.IsProductId(p.ProductId) || !_subs.IsKnownProduct(p.ProductId)) throw new BridgeException("invalid", "Unknown game.");
            // The Xbox app's documented game page when it's installed (Track O's builder and starter), else the Store page.
            if (CloudLauncher.Detect(new WindowsRegistryReader()).XboxApp)
            {
                try
                {
                    new CloudProcessStarter().Start(new System.Diagnostics.ProcessStartInfo(CloudLauncher.XboxAppUri(p.ProductId)) { UseShellExecute = true });
                    return Task.FromResult<object?>(new { opened = "xboxApp" });
                }
                catch (System.ComponentModel.Win32Exception ex)
                {
                    Log.Warn("subs", "The Xbox app didn't open; using the Store page", new { error = ex.NativeErrorCode });
                }
            }
            _shell.OpenUri(new Uri($"ms-windows-store://pdp/?ProductId={p.ProductId}"));
            return Task.FromResult<object?>(new { opened = "store" });
        });
        Dispatcher.Register("cloud.queueState", _ => Task.FromResult<object?>(_queue.Current is { Phase: not "none" } q ? q : null));

        // Library changes can add or remove matches.
        StartSubscriptionWork(TimeSpan.FromMinutes(3));
        StartQueueWatch();
    }

    private int _subsWorkRunning;

    /// <summary>
    /// Background list refresh: only with the lists turned on, never in Offline mode, with Data saver on, while a game
    /// runs or in safe mode. Lists are asked for at most once a day per market (longer after errors); the "leaving soon"
    /// check runs every few hours from the cached copy.
    /// </summary>
    private void StartSubscriptionWork(TimeSpan delay)
    {
        if (SafeMode || _subs is null || Interlocked.Exchange(ref _subsWorkRunning, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(delay, _life.Token);
                while (!_life.IsCancellationRequested && _subs.CatalogOn)
                {
                    if (!_subs.LocalOnly && !IsGameActive && !DataSaverActive)
                    {
                        try { await _subs.RefreshAsync(manual: false, _life.Token); }
                        catch (DataSourceException ex) { Log.Warn("subs", "Background subscription refresh skipped", new { outcome = ex.Outcome.ToString() }); }
                    }
                    else _subs.CheckLeaving();
                    await Task.Delay(TimeSpan.FromHours(3), _life.Token);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Warn("subs", "Background subscription work failed", ex: ex); }
            finally { Interlocked.Exchange(ref _subsWorkRunning, 0); }
        });
    }

    /// <summary>
    /// Cloud queue alerts: while a GeForce NOW session VYSTRAL started waits for its stream, look at the GeForce NOW
    /// app's window titles every few seconds (read-only). Idle, it only checks whether such a session exists.
    /// </summary>
    private void StartQueueWatch()
    {
        if (SafeMode) return;
        var titles = new Win32WindowTitles();
        _ = Task.Run(async () =>
        {
            try
            {
                while (!_life.IsCancellationRequested)
                {
                    var waiting = false;
                    try
                    {
                        var active = _cloud is { Enabled: true } c && Settings.GetBool("cloud.queueAlerts") ? c.ActiveDto() : null;
                        waiting = active is { Service: CloudServices.GeForceNow, State: "waiting" };
                        var procs = waiting ? (_queueProcesses ??= new NtProcessSnapshotSource()).Take() : [];
                        var signal = _queue.Step(DateTimeOffset.Now, active, procs, titles, (int)Math.Clamp(Settings.GetNumber("cloud.queueAlertAt"), 1, 50));
                        if (signal is not null) _events.Emit("cloud.queue", signal);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        Log.Warn("cloud", "Queue check failed", ex: ex);
                    }
                    await Task.Delay(waiting ? TimeSpan.FromSeconds(4) : TimeSpan.FromSeconds(10), _life.Token);
                }
            }
            catch (OperationCanceledException) { }
        });
    }

    private void DisposeSubscriptions() => _queueProcesses?.Dispose();
}
