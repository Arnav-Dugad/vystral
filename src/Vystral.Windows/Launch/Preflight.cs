using System.Diagnostics;
using Vystral.Core.Domain;
using Vystral.Core.Parsing;
using Vystral.Windows.Bridge;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;

namespace Vystral.Windows.Launch;

/// <summary>One pre-flight row. Status is 'ok' | 'info' | 'warn'; it never blocks a launch.</summary>
public sealed record PreflightCheckDto(string Id, string Label, string Status, string Value, string? Detail = null);

/// <summary>Payload of the 'launch.preflight' event.</summary>
public sealed record PreflightEventDto(string Ticket, IReadOnlyList<PreflightCheckDto> Checks);

public interface IPreflightCheck
{
    string Id { get; }
    Task<PreflightCheckDto?> RunAsync(CancellationToken ct);
}

/// <summary>Wraps a synchronous probe so it runs on the thread pool and can be abandoned on timeout.</summary>
public sealed class PreflightCheck(string id, Func<CancellationToken, PreflightCheckDto?> run) : IPreflightCheck
{
    public string Id => id;
    // A dedicated thread per synchronous probe: a busy thread pool (startup, scans) would otherwise
    // queue them past the 300 ms budget. There are only a handful, once per launch.
    public Task<PreflightCheckDto?> RunAsync(CancellationToken ct) =>
        Task.Factory.StartNew(() => run(ct), ct, TaskCreationOptions.LongRunning, TaskScheduler.Default);
}

/// <summary>
/// Runs pre-flight checks in parallel within a fixed budget. Each check is isolated: one that
/// throws or is slow is simply left out, and the launch itself never waits for any of them.
/// </summary>
public static class PreflightRunner
{
    public static readonly TimeSpan DefaultBudget = TimeSpan.FromMilliseconds(300);

    public static async Task<IReadOnlyList<PreflightCheckDto>> RunAsync(IReadOnlyList<IPreflightCheck> checks, TimeSpan budget, CancellationToken ct = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(budget);
        var tasks = checks.Select(c => Isolate(c, cts.Token)).ToArray();
        await Task.WhenAny(Task.WhenAll(tasks), Task.Delay(budget, CancellationToken.None)).ConfigureAwait(false);
        var results = new List<PreflightCheckDto>(tasks.Length);
        foreach (var t in tasks)
            if (t.IsCompletedSuccessfully && t.Result is { } r) results.Add(r);
        return results;
    }

    private static async Task<PreflightCheckDto?> Isolate(IPreflightCheck check, CancellationToken ct)
    {
        try { return await check.RunAsync(ct).ConfigureAwait(false); }
        catch (OperationCanceledException) { return null; }
        catch (Exception ex)
        {
            Log.Warn("preflight", $"Check {check.Id} failed", ex: ex);
            return null;
        }
    }
}

/// <summary>Pure evaluation of each pre-flight check (unit-tested), plus the real probes.</summary>
public static class PreflightChecks
{
    public const long LowSpaceBytes = 10L * 1024 * 1024 * 1024;
    public const double LowSpaceFraction = 0.05;
    public const long LauncherMemoryWarnBytes = 1536L * 1024 * 1024;

    // ---------------- disk ----------------

    public static PreflightCheckDto Disk(string drive, long freeBytes, long totalBytes)
    {
        var low = freeBytes < LowSpaceBytes || (totalBytes > 0 && freeBytes < totalBytes * LowSpaceFraction);
        var label = $"Free space on {drive.TrimEnd('\\')}";
        return low
            ? new("disk", label, "warn", $"{FormatBytes(freeBytes)} free",
                "This drive is nearly full. Games can stutter, fail to save, or be unable to install updates when space runs out.")
            : new("disk", label, "ok", $"{FormatBytes(freeBytes)} free");
    }

    public static PreflightCheckDto? ProbeDisk(string? installPath)
    {
        if (string.IsNullOrEmpty(installPath) || installPath.StartsWith(@"\\", StringComparison.Ordinal)) return null;
        var root = Path.GetPathRoot(installPath);
        if (string.IsNullOrEmpty(root)) return null;
        var d = new DriveInfo(root);
        return d.IsReady ? Disk(d.Name, d.AvailableFreeSpace, d.TotalSize) : null;
    }

    // ---------------- Steam update ----------------

    // appmanifest StateFlags bits that mean an update is queued or in progress.
    private const long SteamUpdatePendingMask = 2 /*UpdateRequired*/ | 256 /*UpdateRunning*/ | 512 /*UpdatePaused*/ | 1024 /*UpdateStarted*/
                                                | 1048576 /*Downloading*/ | 2097152 /*Staging*/ | 4194304 /*Committing*/;

    public static PreflightCheckDto SteamUpdate(VdfNode appState)
    {
        var flags = appState.GetLong("StateFlags") ?? 0;
        var toDownload = appState.GetLong("BytesToDownload") ?? 0;
        var downloaded = appState.GetLong("BytesDownloaded") ?? 0;
        var toStage = appState.GetLong("BytesToStage") ?? 0;
        var staged = appState.GetLong("BytesStaged") ?? 0;
        var result = appState.GetLong("UpdateResult") ?? 0;
        const string label = "Steam updates";

        var remaining = Math.Max(0, toDownload - downloaded);
        if ((flags & SteamUpdatePendingMask) != 0 || remaining > 0 || toStage > staged)
        {
            var size = remaining > 0 ? $" About {FormatBytes(remaining)} still needs to download." : "";
            return new("steamUpdate", label, "warn", "Update pending", $"Steam may update before the game starts.{size}");
        }
        if (result != 0)
            return new("steamUpdate", label, "info", "Last update didn't finish",
                $"Steam reported a problem with this game's last update (code {result}). It may retry before the game starts.");
        return new("steamUpdate", label, "ok", "Up to date");
    }

    public static PreflightCheckDto? ProbeSteamUpdate(Installation inst)
    {
        if (inst.Platform != PlatformId.Steam || inst.InstallPath is null || !inst.PlatformGameId.All(char.IsAsciiDigit)) return null;
        // <library>/steamapps/common/<installdir>  →  <library>/steamapps/appmanifest_<appid>.acf
        var steamapps = Directory.GetParent(Path.GetFullPath(inst.InstallPath))?.Parent?.FullName;
        if (steamapps is null) return null;
        var manifest = Path.Combine(steamapps, $"appmanifest_{inst.PlatformGameId}.acf");
        if (!File.Exists(manifest)) return null;
        try
        {
            var state = Vdf.ParseFile(manifest)["AppState"];
            return state is null ? null : SteamUpdate(state);
        }
        catch (Exception ex) when (ex is FormatException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    // ---------------- controller ----------------

    public static PreflightCheckDto Controllers(IReadOnlyList<ControllerInfo> pads)
    {
        const string label = "Controller";
        if (pads.Count == 0)
            return new("controller", label, "info", "None connected", "If this game needs a controller, connect or pair it now.");
        var low = pads.Where(p => p.BatteryPercent is <= 20 && p.Charging != true).OrderBy(p => p.BatteryPercent).FirstOrDefault();
        var name = pads.Count == 1 ? pads[0].Name : $"{pads.Count} connected";
        var battery = pads.Where(p => p.BatteryPercent is not null).Select(p => p.BatteryPercent!.Value).DefaultIfEmpty(-1).Min();
        var value = battery >= 0 ? $"{name} · {battery}% battery" : name;
        return low is not null
            ? new("controller", label, "warn", value, $"{low.Name} is low on battery. Charge it or swap the batteries before a long session.")
            : new("controller", label, "ok", value);
    }

    // ---------------- display ----------------

    public static PreflightCheckDto? Display(DisplayState? d)
    {
        if (d is null || (d.RefreshHz is null && d.HdrSupported is null)) return null;
        var parts = new List<string>(2);
        if (d.RefreshHz is int hz) parts.Add($"{hz} Hz");
        string? detail = null;
        if (d.HdrEnabled == true) parts.Add("HDR on");
        else if (d.HdrSupported == true)
        {
            parts.Add("HDR off");
            detail = "This display supports HDR. If the game uses it, turn on Use HDR in Windows Settings › System › Display.";
        }
        else if (d.HdrSupported == false) parts.Add("SDR");
        return new("display", "Display", detail is null ? "ok" : "info", string.Join(" · ", parts), detail);
    }

    // ---------------- other launchers ----------------

    /// <summary>Process names (without .exe) of each store app's background processes. Read-only lookups.</summary>
    public static readonly IReadOnlyDictionary<PlatformId, string[]> LauncherProcesses = new Dictionary<PlatformId, string[]>
    {
        [PlatformId.Steam] = ["steam", "steamwebhelper"],
        [PlatformId.Epic] = ["EpicGamesLauncher", "EpicWebHelper"],
        [PlatformId.Ea] = ["EADesktop", "EACefSubProcess"],
        [PlatformId.Ubisoft] = ["upc", "UplayWebCore", "UbisoftConnect"],
        [PlatformId.BattleNet] = ["Battle.net"],
        [PlatformId.Gog] = ["GalaxyClient", "GalaxyClient Helper", "GOG Galaxy Notifications Renderer"],
        [PlatformId.Xbox] = ["XboxPcApp"],
    };

    public sealed record LauncherProcess(string Name, long PrivateBytes);

    public static PreflightCheckDto Launchers(IEnumerable<LauncherProcess> processes, PlatformId needed)
    {
        var byName = new Dictionary<string, PlatformId>(StringComparer.OrdinalIgnoreCase);
        foreach (var (platform, names) in LauncherProcesses)
            if (platform != needed) foreach (var n in names) byName[n] = platform;

        var running = new Dictionary<PlatformId, long>();
        foreach (var p in processes)
            if (byName.TryGetValue(p.Name, out var platform))
                running[platform] = running.GetValueOrDefault(platform) + Math.Max(0, p.PrivateBytes);

        const string label = "Other store apps";
        if (running.Count == 0) return new("launchers", label, "ok", "None running");
        var total = running.Values.Sum();
        var names2 = string.Join(", ", running.Keys.OrderBy(k => k.DisplayName()).Select(k => k.DisplayName()));
        var detail = $"{names2} {(running.Count == 1 ? "is" : "are")} running in the background and using {FormatBytes(total)} of memory. VYSTRAL never closes them; close them yourself if the game needs the memory.";
        return new("launchers", label, total >= LauncherMemoryWarnBytes ? "warn" : "info", $"{running.Count} running · {FormatBytes(total)}", detail);
    }

    public static IReadOnlyList<LauncherProcess> SnapshotLauncherProcesses()
    {
        var wanted = LauncherProcesses.Values.SelectMany(n => n).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var list = new List<LauncherProcess>();
        foreach (var p in Process.GetProcesses())
        {
            using (p)
            {
                try
                {
                    if (!wanted.Contains(p.ProcessName)) continue;
                    list.Add(new LauncherProcess(p.ProcessName, p.PrivateMemorySize64));
                }
                catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
                {
                    // Exited, or a process we can't query (e.g. a service under another account): skip it.
                }
            }
        }
        return list;
    }

    // ---------------- helpers ----------------

    public static string FormatBytes(long bytes)
    {
        const double Gb = 1024.0 * 1024 * 1024, Mb = 1024.0 * 1024;
        if (bytes >= 100 * Gb) return $"{bytes / Gb:0} GB";
        if (bytes >= Gb) return $"{bytes / Gb:0.0} GB";
        return $"{Math.Max(0, bytes) / Mb:0} MB";
    }
}
