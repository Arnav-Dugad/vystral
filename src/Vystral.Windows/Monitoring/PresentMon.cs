using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Cryptography;
using System.Security.Principal;
using Vystral.Windows.Services;

namespace Vystral.Windows.Monitoring;

/// <summary>A pinned PresentMon console release. Only a file matching <see cref="Sha256"/> is ever run.</summary>
public sealed record PresentMonRelease(string Version, string FileName, Uri Url, long SizeBytes, string Sha256)
{
    /// <summary>
    /// Intel PresentMon 2.6.0 console application (MIT licence), published 2026-09-21 at
    /// github.com/GameTechDev/PresentMon/releases/tag/v2.6.0. The hash was computed from the
    /// downloaded asset and matches the digest GitHub publishes for it.
    /// </summary>
    public static readonly PresentMonRelease Pinned = new(
        "2.6.0",
        "PresentMon-2.6.0-x64.exe",
        new Uri("https://github.com/GameTechDev/PresentMon/releases/download/v2.6.0/PresentMon-2.6.0-x64.exe"),
        980_320,
        "b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af");

    public const string LicenseUrl = "https://github.com/GameTechDev/PresentMon/blob/main/LICENSE.txt";
    public const string ReleasePage = "https://github.com/GameTechDev/PresentMon/releases/tag/v2.6.0";
}

public enum FpsPermission
{
    /// <summary>The current sign-in can start ETW trace sessions (Performance Log Users, or elevated).</summary>
    Granted,
    /// <summary>The account was added to Performance Log Users but hasn't signed out and back in yet.</summary>
    SignOutRequired,
    /// <summary>The account is not in Performance Log Users.</summary>
    Missing,
}

/// <summary>
/// Downloads and verifies the pinned PresentMon console exe into VYSTRAL's data folder, and
/// answers whether frame-rate capture is permitted. Never bundled: the user opts in.
/// </summary>
public sealed class PresentMonInstaller(string toolsDir, HttpClient http, PresentMonRelease? release = null)
{
    private const long MaxDownloadBytes = 16 * 1024 * 1024;

    public PresentMonRelease Release { get; } = release ?? PresentMonRelease.Pinned;
    public string ExePath => Path.Combine(toolsDir, Release.FileName);

    /// <summary>True when the exe exists and its SHA-256 matches the pinned hash.</summary>
    public bool IsInstalled() => VerifyFile(ExePath, Release.Sha256);

    public static bool VerifyFile(string path, string sha256)
    {
        try
        {
            if (!File.Exists(path)) return false;
            using var fs = File.OpenRead(path);
            if (fs.Length > MaxDownloadBytes) return false;
            return string.Equals(Convert.ToHexStringLower(SHA256.HashData(fs)), sha256, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>
    /// Downloads over HTTPS, streams into a temp file while hashing, and only moves it into place
    /// when the hash matches. A mismatch deletes the temp file and throws <see cref="InvalidDataException"/>.
    /// </summary>
    public async Task InstallAsync(IProgress<double>? progress, CancellationToken ct)
    {
        if (Release.Url.Scheme != Uri.UriSchemeHttps) throw new InvalidOperationException("Downloads must use HTTPS.");
        Directory.CreateDirectory(toolsDir);
        var tmp = ExePath + ".download";
        try
        {
            using (var response = await http.GetAsync(Release.Url, HttpCompletionOption.ResponseHeadersRead, ct))
            {
                response.EnsureSuccessStatusCode();
                if (response.RequestMessage?.RequestUri is { } final && final.Scheme != Uri.UriSchemeHttps)
                    throw new InvalidDataException("The download was redirected to an insecure address.");
                var declared = response.Content.Headers.ContentLength;
                if (declared > MaxDownloadBytes) throw new InvalidDataException("The download is larger than expected.");

                await using var source = await response.Content.ReadAsStreamAsync(ct);
                await using var target = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None);
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var buffer = new byte[81920];
                long total = 0;
                int read;
                while ((read = await source.ReadAsync(buffer, ct)) > 0)
                {
                    total += read;
                    if (total > MaxDownloadBytes) throw new InvalidDataException("The download is larger than expected.");
                    hash.AppendData(buffer, 0, read);
                    await target.WriteAsync(buffer.AsMemory(0, read), ct);
                    progress?.Report(Math.Min(1, total / (double)(declared ?? Release.SizeBytes)));
                }
                var actual = Convert.ToHexStringLower(hash.GetHashAndReset());
                if (!string.Equals(actual, Release.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("The downloaded file didn't match the expected fingerprint (SHA-256), so it was deleted and not used.");
            }
            File.Move(tmp, ExePath, overwrite: true);
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch (IOException) { }
        }
    }

    public void Uninstall()
    {
        try { if (File.Exists(ExePath)) File.Delete(ExePath); }
        catch (IOException ex) { throw new InvalidOperationException("PresentMon is in use. Try again after your game closes.", ex); }
    }

    // ---------------- Permission ----------------

    private static readonly SecurityIdentifier PerformanceLogUsers = new("S-1-5-32-559");

    /// <summary>Whether the current sign-in can capture, and if not, why.</summary>
    public static FpsPermission CheckPermission()
    {
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            var principal = new WindowsPrincipal(identity);
            if (principal.IsInRole(PerformanceLogUsers) || principal.IsInRole(WindowsBuiltInRole.Administrator)) return FpsPermission.Granted;
            return IsAccountInGroup(identity.Name) ? FpsPermission.SignOutRequired : FpsPermission.Missing;
        }
        catch (Exception ex) when (ex is SecurityException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            return FpsPermission.Missing;
        }
    }

    /// <summary>The group's localized name (it is translated on non-English Windows).</summary>
    public static string GroupName()
    {
        try
        {
            var account = (NTAccount)PerformanceLogUsers.Translate(typeof(NTAccount));
            var name = account.Value;
            var slash = name.IndexOf('\\');
            return slash >= 0 ? name[(slash + 1)..] : name;
        }
        catch (Exception ex) when (ex is IdentityNotMappedException or SystemException)
        {
            return "Performance Log Users";
        }
    }

    public static string CurrentAccountName()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.Name;
    }

    /// <summary>
    /// Builds the arguments for <c>net localgroup "&lt;group&gt;" "&lt;DOMAIN\user&gt;" /add</c>.
    /// Rejects names containing quotes or control characters so nothing can be injected.
    /// </summary>
    public static IReadOnlyList<string> GroupAddArguments(string groupName, string account)
    {
        static bool Safe(string s) => s.Length is > 0 and < 260 && !s.Any(c => c == '"' || char.IsControl(c));
        if (!Safe(groupName) || !Safe(account)) throw new ArgumentException("Unexpected account or group name.");
        return ["localgroup", groupName, account, "/add"];
    }

    /// <summary>Local group membership from the account database (reflects changes before sign-out).</summary>
    private static bool IsAccountInGroup(string account)
    {
        var group = GroupName();
        var status = NetUserGetLocalGroups(null, account, 0, 1 /* LG_INCLUDE_INDIRECT */, out var buffer, -1, out var read, out _);
        try
        {
            if (status != 0 || buffer == IntPtr.Zero) return false;
            for (var i = 0; i < read; i++)
            {
                var namePtr = Marshal.ReadIntPtr(buffer, i * IntPtr.Size);
                if (string.Equals(Marshal.PtrToStringUni(namePtr), group, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }
        finally
        {
            if (buffer != IntPtr.Zero) NetApiBufferFree(buffer);
        }
    }

    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetUserGetLocalGroups(string? server, string user, int level, int flags, out IntPtr buffer, int prefMaxLen, out int entriesRead, out int totalEntries);

    [DllImport("netapi32.dll")]
    private static extern int NetApiBufferFree(IntPtr buffer);
}

/// <summary>
/// Runs PresentMon as a child process for one game process and streams its CSV from stdout
/// into <see cref="FrameStats"/>. Memory is bounded; the process is stopped (its ETW session
/// closed cleanly) when the session ends. Read-only: PresentMon observes present events, it
/// doesn't inject anything into the game.
/// </summary>
public sealed class FrameCapture : IDisposable
{
    public const string SessionName = "VYSTRAL_FrameCapture";

    private readonly string _exe;
    private readonly Process _process;
    private readonly PresentMonCsvParser _parser;
    private readonly Task _stdout;
    private readonly Task _stderr;
    private readonly System.Text.StringBuilder _errors = new();

    public FrameStats Stats { get; }
    public int TargetPid { get; }

    private FrameCapture(string exe, Process process, int pid, FrameStats stats)
    {
        _exe = exe;
        Stats = stats;
        _process = process;
        TargetPid = pid;
        _parser = new PresentMonCsvParser(pid);
        _stdout = Task.Run(() => PumpAsync(process.StandardOutput.BaseStream, line =>
        {
            if (_parser.ParseLine(line) is double ft) Stats.Add(ft);
        }));
        _stderr = Task.Run(() => PumpAsync(process.StandardError.BaseStream, line =>
        {
            lock (_errors) if (_errors.Length < 4000) _errors.AppendLine(line);
        }));
    }

    public static IReadOnlyList<string> Arguments(int pid) =>
    [
        "--process_id", pid.ToString(System.Globalization.CultureInfo.InvariantCulture),
        "--output_stdout",
        "--no_console_stats",
        "--no_track_input",
        "--session_name", SessionName,
        "--stop_existing_session",
        "--terminate_on_proc_exit",
    ];

    /// <summary>Starts capture. The exe must already be verified against the pinned hash.</summary>
    public static FrameCapture Start(string exe, int pid, FrameStats stats)
    {
        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false,
            WorkingDirectory = Path.GetDirectoryName(exe)!,
        };
        foreach (var a in Arguments(pid)) psi.ArgumentList.Add(a);
        var p = Process.Start(psi) ?? throw new InvalidOperationException("PresentMon didn't start.");
        try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { }
        return new FrameCapture(exe, p, pid, stats);
    }

    public bool HasExited
    {
        get { try { return _process.HasExited; } catch (InvalidOperationException) { return true; } }
    }

    /// <summary>Plain-language reason when PresentMon stopped by itself without producing frames.</summary>
    public string? Failure()
    {
        if (!HasExited || Stats.Frames > 0) return null;
        string err;
        lock (_errors) err = _errors.ToString();
        int code;
        try { code = _process.ExitCode; } catch (InvalidOperationException) { code = -1; }
        return Explain(code, err);
    }

    public static string? Explain(int exitCode, string stderr)
    {
        if (stderr.Contains("access denied", StringComparison.OrdinalIgnoreCase))
            return "Windows didn't allow PresentMon to read frame events. Your account needs to be in the Performance Log Users group (and you need to sign out and back in once).";
        if (exitCode == 0) return null;
        return $"PresentMon stopped unexpectedly (code {exitCode}).";
    }

    public FrameWindow? DrainWindow() => Stats.DrainWindow();

    /// <summary>
    /// Stops capture: asks PresentMon to end its named ETW session (a second, short-lived
    /// PresentMon with --terminate_existing_session), waits briefly, and only then kills it.
    /// </summary>
    public async Task StopAsync()
    {
        try
        {
            if (!HasExited && !PresentMonInstaller.VerifyFile(_exe, PresentMonRelease.Pinned.Sha256))
            {
                // The threat model promises the hash is checked before every run, the "stop" run included:
                // a file that changed since it started is never run; the capture is ended directly instead.
                Log.Warn("fps", "PresentMon's file changed while it ran; ending the capture without running it again");
                TryKill(_process);
            }
            else if (!HasExited)
            {
                try
                {
                    var psi = new ProcessStartInfo(_exe) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                    foreach (var a in new[] { "--session_name", SessionName, "--terminate_existing_session" }) psi.ArgumentList.Add(a);
                    using var stopper = Process.Start(psi);
                    if (stopper is not null)
                    {
                        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                        try { await stopper.WaitForExitAsync(cts.Token); } catch (OperationCanceledException) { TryKill(stopper); }
                    }
                }
                catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    Log.Warn("fps", "Couldn't ask PresentMon to stop its session", ex: ex);
                }
                using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                try { await _process.WaitForExitAsync(wait.Token); } catch (OperationCanceledException) { TryKill(_process); }
            }
            await Task.WhenAny(Task.WhenAll(_stdout, _stderr), Task.Delay(2000));
        }
        catch (Exception ex)
        {
            Log.Warn("fps", "Stopping PresentMon failed", ex: ex);
            TryKill(_process);
        }
    }

    private static void TryKill(Process p)
    {
        try { if (!p.HasExited) p.Kill(entireProcessTree: true); }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { }
    }

    private static async Task PumpAsync(Stream stream, Action<string> onLine)
    {
        var reader = new OutputLineReader();
        var buffer = new byte[16384];
        try
        {
            int read;
            while ((read = await stream.ReadAsync(buffer)) > 0)
                foreach (var line in reader.Feed(buffer.AsSpan(0, read))) onLine(line);
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException) { }
    }

    public void Dispose()
    {
        TryKill(_process);
        _process.Dispose();
    }
}
