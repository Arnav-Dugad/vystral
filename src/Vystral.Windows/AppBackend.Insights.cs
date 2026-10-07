using System.Diagnostics;
using System.Text.Json;
using Vystral.Core.Domain;
using Vystral.Windows.Bridge;
using Vystral.Windows.Launch;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track B parameter records.
public sealed record LaunchFixParams(string Ticket, string ActionId);
public sealed record TicketParams(string Ticket);
public sealed record HotkeyParams(string Shortcut);

/// <summary>
/// Track B: launch pre-flight, launch timing, one-click fixes, opt-in frame-rate capture
/// (Intel PresentMon), the global summon hotkey and Windows notifications.
/// </summary>
public sealed partial class AppBackend : ILaunchFixRunner
{
    private static readonly HashSet<string> NotifiableEvents = ["launch.state", "update.state", "install.progress", "achievements.unlocked", "disk.forecast", "subs.leaving", "cloud.queue"];

    private IInsightHost? _insightHost;
    private NotificationPolicy _notifications = null!;
    private PresentMonInstaller _presentMon = null!;
    private readonly Lock _hotkeyLock = new();
    private string? _hotkeyActive;
    private string? _hotkeyError;
    private int _fpsInstalling;

    /// <summary>Native capabilities from the WinUI shell. Setting it applies the saved hotkey.</summary>
    public IInsightHost? InsightHost
    {
        get => _insightHost;
        set
        {
            _insightHost = value;
            ApplyHotkeyFromSettings(force: true);
        }
    }

    private void RegisterInsightHandlers()
    {
        _presentMon = new PresentMonInstaller(Path.Combine(Paths.Root, "tools"), _http);
        _notifications = new NotificationPolicy(Settings.GetBool, id => SafeGameTitle(id));
        Sessions.PreflightChecks = BuildPreflightChecks;
        Sessions.FpsCapture = PlanFpsCapture;
        Settings.Changed += key =>
        {
            if (key is "*" or "hotkey.enabled" or "hotkey.summon") ApplyHotkeyFromSettings(force: false);
        };

        // ---- launch ----
        Dispatcher.Register<TicketParams>("launch.preflightResult", (p, _) =>
        {
            var ticket = RequireId(p.Ticket, "ticket");
            var last = Sessions.LastPreflight;
            return Task.FromResult<object?>(last?.Ticket == ticket ? last : null);
        });
        Dispatcher.Register<LaunchFixParams>("launch.fix", async (p, _) =>
        {
            var ticket = RequireId(p.Ticket, "ticket");
            var action = RequireText(p.ActionId, 32, "Action");
            var message = await LaunchFixes.ExecuteAsync(Sessions.Fixes, ticket, action, this);
            Repository.Audit("launch.fix", $"{action} ({ticket})");
            return new { ok = true, message };
        });
        Dispatcher.Register<SessionIdParams>("sessions.insightSamples", (p, _) =>
            Task.FromResult<object?>(Repository.GetInsightSamples(RequireId(p.SessionId, "session"))));

        // ---- frame-rate capture ----
        Dispatcher.Register("fps.status", _ => Task.FromResult<object?>(FpsStatus()));
        Dispatcher.Register("fps.install", async ct =>
        {
            if (Settings.GetBool("privacy.localOnly"))
                throw new BridgeException("forbidden", "Local-only mode is on, so VYSTRAL won't download PresentMon. Turn it off in Settings › Privacy first.");
            if (Interlocked.Exchange(ref _fpsInstalling, 1) == 1) throw new BridgeException("busy", "PresentMon is already downloading.");
            try
            {
                _events.Emit("fps.install", new { phase = "downloading", progress = 0.0 });
                var last = -1;
                var progress = new Progress<double>(f =>
                {
                    var pct = (int)(f * 100);
                    if (pct == last) return;
                    last = pct;
                    _events.Emit("fps.install", new { phase = "downloading", progress = Math.Round(f, 2) });
                });
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct, _life.Token);
                timeout.CancelAfter(TimeSpan.FromMinutes(2));
                await _presentMon.InstallAsync(progress, timeout.Token);
                Repository.Audit("fps.install", $"PresentMon {_presentMon.Release.Version} sha256={_presentMon.Release.Sha256}");
                _events.Emit("fps.install", new { phase = "installed", progress = 1.0 });
            }
            catch (Exception ex) when (ex is HttpRequestException or InvalidDataException or IOException or UnauthorizedAccessException or TaskCanceledException)
            {
                Log.Warn("fps", "PresentMon download failed", ex: ex);
                var message = ex is InvalidDataException ? ex.Message : "PresentMon couldn't be downloaded. Check your connection and try again.";
                _events.Emit("fps.install", new { phase = "failed", progress = 0.0, error = message });
                throw new BridgeException("failed", message);
            }
            finally
            {
                Interlocked.Exchange(ref _fpsInstalling, 0);
            }
            return FpsStatus();
        });
        Dispatcher.Register("fps.remove", _ =>
        {
            if (IsGameActive) throw new BridgeException("busy", "Close your game before removing PresentMon.");
            try { _presentMon.Uninstall(); }
            catch (InvalidOperationException ex) { throw new BridgeException("busy", ex.Message); }
            Settings.Set("fps.captureEnabled", false);
            _events.Emit("settings.changed", Settings.GetAll());
            Repository.Audit("fps.remove", null);
            return Task.FromResult<object?>(FpsStatus());
        });
        Dispatcher.Register("fps.grantPermission", async _ => await GrantPerformanceLogUsersAsync());

        // ---- hotkey ----
        Dispatcher.Register("hotkey.status", _ => Task.FromResult<object?>(HotkeyStatus()));
        Dispatcher.Register<HotkeyParams>("hotkey.set", (p, _) =>
        {
            if (!Hotkey.TryParse(RequireText(p.Shortcut, 40, "Shortcut"), out var hotkey, out var error))
                throw new BridgeException("invalid", error ?? "That shortcut isn't valid.");
            var host = _insightHost ?? throw new BridgeException("unavailable", "Shortcuts need the VYSTRAL window.");
            lock (_hotkeyLock)
            {
                var result = host.ApplyHotkey(hotkey);
                if (!result.Registered)
                {
                    // Put the previous shortcut back so nothing silently stops working.
                    _hotkeyActive = null;
                    ApplyHotkeyFromSettings(force: true);
                    throw new BridgeException("conflict", result.Error ?? "That shortcut is used by another app. Try a different one.");
                }
                _hotkeyActive = hotkey!.ToString();
                _hotkeyError = null;
            }
            Settings.Set("hotkey.summon", hotkey.ToString());
            if (!Settings.GetBool("hotkey.enabled")) Settings.Set("hotkey.enabled", true);
            _events.Emit("settings.changed", Settings.GetAll());
            return Task.FromResult<object?>(HotkeyStatus());
        });

        // ---- notifications ----
        Dispatcher.Register("notifications.status", _ => Task.FromResult<object?>(new
        {
            available = _insightHost?.NotificationsAvailable ?? false,
            clickable = _insightHost?.NotificationsClickable ?? false,
        }));
        Dispatcher.Register("notifications.test", _ =>
        {
            var host = _insightHost;
            if (host is null || !host.NotificationsAvailable) throw new BridgeException("unavailable", "Windows notifications aren't available for VYSTRAL on this PC.");
            var shown = host.ShowNotification(new NotificationRequest("test", "Notifications are on",
                "This is how VYSTRAL will let you know about saved sessions, updates and installs.",
                NotificationPolicy.Route("settings", ("section", "windows")), "test"));
            return Task.FromResult<object?>(new { shown });
        });
    }

    // ---------------- notifications ----------------

    /// <summary>
    /// Called by the shell for every event it sends to the UI. Only launch.state, update.state and
    /// install.progress are inspected; everything else returns immediately.
    /// </summary>
    public void ObserveEvent(string eventName, string eventJson)
    {
        // Track H: watch newly added games. Artwork and metadata arrive every 1.5 s during enrichment and don't change
        // which games exist, are hidden or merged, so they don't make the detector reload its targets.
        if (eventName == "library.changed" && !IsCosmeticLibraryChange(eventJson)) OnLibraryIdentityChanged();
        if (!NotifiableEvents.Contains(eventName)) return;
        var host = _insightHost;
        if (host is null || !host.NotificationsAvailable || _notifications is null) return;
        try
        {
            using var doc = JsonDocument.Parse(eventJson);
            if (!doc.RootElement.TryGetProperty("payload", out var payload)) return;
            foreach (var n in _notifications.Evaluate(eventName, payload, host.IsForeground))
                host.ShowNotification(n);
        }
        catch (Exception ex)
        {
            Log.Warn("notify", "Notification failed", ex: ex);
        }
    }

    /// <summary>library.changed reasons that never change the detector's targets (installations, hidden, merged games).</summary>
    private static readonly HashSet<string> CosmeticLibraryReasons = ["artwork", "metadata", "enrichment", "session", "history"];

    internal static bool IsCosmeticLibraryChange(string eventJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(eventJson);
            return doc.RootElement.ValueKind == JsonValueKind.Object &&
                   doc.RootElement.TryGetProperty("payload", out var payload) && payload.ValueKind == JsonValueKind.Object &&
                   payload.TryGetProperty("reason", out var reason) && reason.ValueKind == JsonValueKind.String &&
                   CosmeticLibraryReasons.Contains(reason.GetString()!);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private string? SafeGameTitle(string gameId)
    {
        try { return Repository.GetGame(gameId)?.Title; }
        catch (Exception) { return null; }
    }

    // ---------------- hotkey ----------------

    private void ApplyHotkeyFromSettings(bool force)
    {
        var host = _insightHost;
        if (host is null) return;
        lock (_hotkeyLock)
        {
            Hotkey? desired = null;
            string? parseError = null;
            if (Settings.GetBool("hotkey.enabled") && !Hotkey.TryParse(Settings.GetString("hotkey.summon"), out desired, out parseError))
                desired = null;
            var key = desired?.ToString();
            if (!force && key == _hotkeyActive && _hotkeyError is null) return;
            var result = host.ApplyHotkey(desired);
            _hotkeyActive = result.Registered ? key : null;
            _hotkeyError = parseError ?? result.Error;
            if (_hotkeyError is not null) Log.Warn("hotkey", _hotkeyError);
        }
    }

    private object HotkeyStatus()
    {
        lock (_hotkeyLock)
        {
            return new
            {
                shortcut = Settings.GetString("hotkey.summon"),
                enabled = Settings.GetBool("hotkey.enabled"),
                registered = _hotkeyActive is not null,
                error = _hotkeyError,
                available = _insightHost is not null,
            };
        }
    }

    // ---------------- pre-flight ----------------

    private IReadOnlyList<IPreflightCheck> BuildPreflightChecks(Installation inst)
    {
        var host = _insightHost;
        var list = new List<IPreflightCheck>
        {
            new PreflightCheck("disk", _ => PreflightChecks.ProbeDisk(inst.InstallPath)),
            new PreflightCheck("steamUpdate", _ => PreflightChecks.ProbeSteamUpdate(inst)),
            new PreflightCheck("launchers", _ => PreflightChecks.Launchers(PreflightChecks.SnapshotLauncherProcesses(), inst.Platform)),
            new PreflightCheck("antiCheat", _ => AntiCheatPreflight(inst)), // Track M: informative kernel anti-cheat note
        };
        if (host is not null)
        {
            list.Add(new PreflightCheck("controller", _ => PreflightChecks.Controllers(host.GetControllers(), BatteryDrainFor)));
            list.Add(new PreflightCheck("display", _ => host.WindowHandle == 0 ? null : PreflightChecks.Display(DisplayProbe.ForWindow(host.WindowHandle))));
        }
        return list;
    }

    // ---------------- launch fixes (ILaunchFixRunner) ----------------

    async Task ILaunchFixRunner.RescanPlatformAsync(PlatformId platform) => await ScanPlatformAsync(platform, _life.Token);

    void ILaunchFixRunner.OpenUri(Uri uri) => _shell.OpenUri(uri);

    void ILaunchFixRunner.OpenFolder(string path) => _shell.OpenFolder(path);

    void ILaunchFixRunner.StartClient(string exePath)
    {
        // Only ever the store client exe the adapter reported when the launch failed.
        using var _ = Process.Start(new ProcessStartInfo(exePath)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(exePath)!,
        });
        Repository.Audit("launch.fix.startClient", exePath);
    }

    // ---------------- frame-rate capture ----------------

    private FpsCapturePlan PlanFpsCapture()
    {
        // Track H: shared with the background tracker (FpsCapturePlanner), so both capture under the same conditions.
        var enabled = Settings.GetBool("fps.captureEnabled");
        return FpsCapturePlanner.Plan(enabled, enabled && _presentMon.IsInstalled(), _presentMon.ExePath);
    }

    private object FpsStatus()
    {
        var installed = _presentMon.IsInstalled();
        var permission = PresentMonInstaller.CheckPermission();
        var enabled = Settings.GetBool("fps.captureEnabled");
        string? account = null;
        try { account = PresentMonInstaller.CurrentAccountName(); } catch (Exception) { }
        return new
        {
            enabled,
            installed,
            installing = Volatile.Read(ref _fpsInstalling) == 1,
            version = _presentMon.Release.Version,
            fileName = _presentMon.Release.FileName,
            sizeBytes = _presentMon.Release.SizeBytes,
            sha256 = _presentMon.Release.Sha256,
            sourceUrl = _presentMon.Release.Url.AbsoluteUri,
            releasePage = PresentMonRelease.ReleasePage,
            licenseUrl = PresentMonRelease.LicenseUrl,
            installPath = _presentMon.ExePath,
            permission = permission switch
            {
                FpsPermission.Granted => "granted",
                FpsPermission.SignOutRequired => "signOutRequired",
                _ => "missing",
            },
            groupName = PresentMonInstaller.GroupName(),
            account,
            ready = enabled && installed && permission == FpsPermission.Granted,
            localOnly = Settings.GetBool("privacy.localOnly"),
        };
    }

    /// <summary>
    /// The only elevated action in VYSTRAL, and only on an explicit click: runs Windows' own
    /// <c>net localgroup "Performance Log Users" "&lt;you&gt;" /add</c> through a UAC prompt.
    /// </summary>
    private async Task<object?> GrantPerformanceLogUsersAsync()
    {
        if (PresentMonInstaller.CheckPermission() != FpsPermission.Missing) return new { status = "alreadyMember", fps = FpsStatus() };
        var group = PresentMonInstaller.GroupName();
        var account = PresentMonInstaller.CurrentAccountName();
        IReadOnlyList<string> args;
        try { args = PresentMonInstaller.GroupAddArguments(group, account); }
        catch (ArgumentException) { throw new BridgeException("unsupported", "Your account name can't be added automatically. Add it to Performance Log Users in Computer Management instead."); }

        var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "net.exe"))
        {
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Hidden,
            // Names were validated to contain no quotes or control characters.
            Arguments = $"{args[0]} \"{args[1]}\" \"{args[2]}\" {args[3]}",
        };
        Repository.Audit("fps.grantPermission", $"requested for {account}");
        try
        {
            using var p = Process.Start(psi);
            if (p is null) throw new BridgeException("failed", "Windows didn't run the command.");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            await p.WaitForExitAsync(timeout.Token);
            // 0 = added; 2 is returned for "already a member" (system error 1378).
            var ok = p.ExitCode is 0 or 2;
            Repository.Audit("fps.grantPermission", ok ? "added (sign-out required)" : $"net.exe exit code {p.ExitCode}");
            if (!ok) throw new BridgeException("failed", $"Windows couldn't add your account (code {p.ExitCode}).");
            return new { status = "added", signOutRequired = true, fps = FpsStatus() };
        }
        catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            return new { status = "cancelled", fps = FpsStatus() };
        }
        catch (OperationCanceledException)
        {
            throw new BridgeException("timeout", "The permission step didn't finish. Check whether a Windows prompt is waiting.");
        }
    }
}
