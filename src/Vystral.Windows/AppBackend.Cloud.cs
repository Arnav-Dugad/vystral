using Vystral.Core.Cloud;
using Vystral.Windows.Bridge;
using Vystral.Windows.Cloud;
using Vystral.Windows.DataSources;
using Vystral.Windows.Integrations;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track O parameter records.
public sealed record CloudLaunchParams(string GameId, string Service);
public sealed record CloudLinkParams(string Link);

/// <summary>
/// Track O: cloud play (Xbox Cloud Gaming, GeForce NOW). Opt-in, off by default. The page names a game and a service
/// only; every URL and command line is built natively from validated catalogue IDs, and links come from a fixed table.
/// </summary>
public sealed partial class AppBackend
{
    private CloudPlayService? _cloud;
    private HttpClient? _cloudHttp;
    public CloudPlayService Cloud => _cloud!;

    /// <summary>A cloud stream VYSTRAL started is running (background downloads and AI pause as they do for a local game).</summary>
    private bool CloudSessionActive => _cloud?.SessionActive == true;

    private static readonly Dictionary<string, string> CloudLinks = new(StringComparer.Ordinal)
    {
        ["gfnMemberships"] = "https://www.nvidia.com/en-us/geforce-now/memberships/",
        ["gfnFaq"] = "https://www.nvidia.com/en-us/geforce-now/faq/",
        ["gfnStatus"] = "https://status.geforcenow.com/",
        ["gfnSystem"] = "https://www.nvidia.com/en-us/geforce-now/system-reqs/",
        ["xboxCloud"] = "https://www.xbox.com/en-US/cloud-gaming",
        ["xboxStatus"] = "https://support.xbox.com/en-US/xbox-live-status",
    };

    private void RegisterCloudHandlers()
    {
        _cloudHttp = CloudPlayService.CreateHttpClient(Version);
        var registry = new WindowsRegistryReader();
        CloudEnvironment? env = null;
        var envAt = DateTime.MinValue;
        // Finding the vendor apps is a few file and registry reads; refreshed at most every 30 s.
        CloudEnvironment Env()
        {
            if (env is null || DateTime.UtcNow - envAt > TimeSpan.FromSeconds(30))
            {
                env = CloudLauncher.Detect(registry);
                envAt = DateTime.UtcNow;
            }
            return env;
        }
        var tracker = new HandleFreeForeground();
        _cloud = new CloudPlayService(Repository, Settings, _cloudHttp, _events, Path.Combine(Paths.Root, "cloud-edge"), Env,
            new CloudProcessStarter(), SafeMode ? null : new NtProcessSnapshotSource(), tracker.ForegroundPid)
        {
            DataSaverActive = () => DataSaverActive,
            GameActive = () => Sessions.IsBusy,
            Minimize = () =>
            {
                try { _shell.Minimize(); }
                catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { }
            },
        };

        Settings.Changed += key =>
        {
            if (!key.StartsWith("cloud.", StringComparison.Ordinal) && key is not ("privacy.localOnly" or "*")) return;
            _cloud.Invalidate();
            _events.Emit("cloud.changed", _cloud.Status());
            // Turning cloud play on (or changing market) fetches what's due, politely, in the background.
            if (key is "cloud.enabled" or "cloud.market" or "cloud.gfn" or "cloud.xbox" && _cloud.Enabled) StartCloudWork(TimeSpan.FromSeconds(2));
        };

        Dispatcher.Register("cloud.status", _ => Task.FromResult<object?>(_cloud.Status()));
        Dispatcher.Register("cloud.map", _ => Task.FromResult<object?>(_cloud.Map()));
        Dispatcher.Register<GameIdParams>("cloud.forGame", (p, _) => Task.FromResult<object?>(_cloud.ForGame(RequireId(p.GameId, "game"))));
        Dispatcher.Register("cloud.refresh", async ct => await Run(() => _cloud.RefreshAsync(manual: true, ct)));
        Dispatcher.Register<CloudLaunchParams>("cloud.launch", (p, _) =>
        {
            var gameId = RequireId(p.GameId, "game");
            var service = CloudServices.IsKnown(p.Service) ? p.Service : throw new BridgeException("invalid", "Unknown cloud service.");
            try { return Task.FromResult<object?>(_cloud.Launch(gameId, service)); }
            catch (ArgumentException) { throw new BridgeException("invalid", "That cloud entry couldn’t be opened safely."); }
        });
        Dispatcher.Register("cloud.endSession", _ => Task.FromResult<object?>(_cloud.EndActive(DateTimeOffset.Now)));
        Dispatcher.Register("cloud.session", _ => Task.FromResult<object?>(_cloud.ActiveDto()));
        Dispatcher.Register("cloud.meter", _ => Task.FromResult<object?>(_cloud.MeterDto()));
        Dispatcher.Register("cloud.serviceStatus", async ct => await _cloud.ServiceStatusAsync(ct));
        Dispatcher.Register<CloudLinkParams>("cloud.openLink", (p, _) =>
        {
            if (p.Link is null || !CloudLinks.TryGetValue(p.Link, out var url)) throw new BridgeException("invalid", "Unknown link.");
            _shell.OpenUri(new Uri(url));
            return Task.FromResult<object?>(true);
        });

        StartCloudWork(TimeSpan.FromMinutes(2));
    }

    private int _cloudWorkRunning;

    /// <summary>
    /// Background catalogue refresh: only with cloud play on, never in Offline mode, with Data saver on, while a game
    /// runs or in safe mode. Each service is asked at most once a day per market (longer after errors).
    /// </summary>
    private void StartCloudWork(TimeSpan delay)
    {
        if (SafeMode || _cloud is null || Interlocked.Exchange(ref _cloudWorkRunning, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(delay, _life.Token);
                while (!_life.IsCancellationRequested && _cloud.Enabled)
                {
                    if (!_cloud.LocalOnly && !IsGameActive && !DataSaverActive)
                    {
                        try { await _cloud.RefreshAsync(manual: false, _life.Token); }
                        catch (DataSourceException ex) { Log.Warn("cloud", "Background cloud refresh skipped", new { outcome = ex.Outcome.ToString() }); }
                    }
                    await Task.Delay(TimeSpan.FromHours(3), _life.Token);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Warn("cloud", "Background cloud work failed", ex: ex); }
            finally { Interlocked.Exchange(ref _cloudWorkRunning, 0); }
        });
    }

    private void ShutdownCloud()
    {
        try { _cloud?.Shutdown(); }
        catch (Exception ex) { Log.Warn("cloud", "Saving the cloud session on exit failed", ex: ex); }
    }

    /// <summary>The foreground window's process id (no process is opened).</summary>
    private sealed class HandleFreeForeground
    {
        public int? ForegroundPid()
        {
            var hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return null;
            return GetWindowThreadProcessId(hwnd, out var pid) == 0 || pid <= 4 ? null : (int)pid;
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    }
}
