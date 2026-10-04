using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Vystral.Windows.Launch;

public sealed record RunningProcess(int Id, string ImagePath);

/// <summary>
/// Lists running processes and their image paths using the least-privileged query right
/// (PROCESS_QUERY_LIMITED_INFORMATION). This is the same read-only information Task Manager
/// shows; VYSTRAL never opens game processes for reading memory or injecting anything.
/// </summary>
public static partial class ProcessScanner
{
    private const uint ProcessQueryLimitedInformation = 0x1000;

    public static IReadOnlyList<RunningProcess> Snapshot()
    {
        var list = new List<RunningProcess>(256);
        var buffer = new StringBuilder(1024);
        foreach (var p in Process.GetProcesses())
        {
            using (p)
            {
                if (p.Id <= 4) continue;
                var path = TryGetImagePath(p.Id, buffer);
                if (path is not null) list.Add(new RunningProcess(p.Id, path));
            }
        }
        return list;
    }

    public static bool IsAlive(int pid)
    {
        var h = OpenProcess(ProcessQueryLimitedInformation, false, (uint)pid);
        if (h == IntPtr.Zero) return false;
        try
        {
            return GetExitCodeProcess(h, out var code) && code == 259; // STILL_ACTIVE
        }
        finally
        {
            CloseHandle(h);
        }
    }

    public static string? TryGetImagePath(int pid, StringBuilder? buffer = null)
    {
        var h = OpenProcess(ProcessQueryLimitedInformation, false, (uint)pid);
        if (h == IntPtr.Zero) return null;
        try
        {
            buffer ??= new StringBuilder(1024);
            buffer.Clear();
            buffer.EnsureCapacity(1024);
            var size = (uint)buffer.Capacity;
            return QueryFullProcessImageNameW(h, 0, buffer, ref size) ? buffer.ToString(0, (int)size) : null;
        }
        finally
        {
            CloseHandle(h);
        }
    }

    /// <summary>Processes whose executable lives under <paramref name="directory"/>, or matches a hinted file name.</summary>
    public static IReadOnlyList<RunningProcess> FindUnder(IReadOnlyList<RunningProcess> snapshot, string? directory,
        IReadOnlyCollection<string> exeHints, IReadOnlyCollection<string> excludedDirectories)
    {
        var root = string.IsNullOrEmpty(directory) ? null : Path.GetFullPath(directory).TrimEnd('\\') + "\\";
        var excluded = excludedDirectories.Select(d => Path.GetFullPath(d).TrimEnd('\\') + "\\").ToList();
        return snapshot.Where(p =>
        {
            if (excluded.Any(e => p.ImagePath.StartsWith(e, StringComparison.OrdinalIgnoreCase))) return false;
            if (root is not null && p.ImagePath.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return true;
            return root is null && exeHints.Contains(Path.GetFileName(p.ImagePath), StringComparer.OrdinalIgnoreCase);
        }).ToList();
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
