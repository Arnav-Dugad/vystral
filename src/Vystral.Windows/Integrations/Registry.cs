using Microsoft.Win32;

namespace Vystral.Windows.Integrations;

public enum Hive { LocalMachine, CurrentUser }

/// <summary>
/// Read-only registry access. Adapters receive this instead of touching <see cref="Registry"/>
/// directly so they can be tested against fixtures, and so writes are structurally impossible.
/// Paths are always resolved in the 64-bit view; 32-bit data is addressed via WOW6432Node.
/// </summary>
public interface IRegistryReader
{
    object? GetValue(Hive hive, string path, string name);
    IReadOnlyList<string> GetSubKeyNames(Hive hive, string path);
    IReadOnlyList<string> GetValueNames(Hive hive, string path);
}

public static class RegistryReaderExtensions
{
    public static string? GetString(this IRegistryReader reg, Hive hive, string path, string name) =>
        reg.GetValue(hive, path, name) switch
        {
            string s when !string.IsNullOrWhiteSpace(s) => s,
            _ => null,
        };

    public static int? GetInt(this IRegistryReader reg, Hive hive, string path, string name) =>
        reg.GetValue(hive, path, name) switch
        {
            int i => i,
            long l => (int)l,
            string s when int.TryParse(s, out var i) => i,
            _ => null,
        };
}

public sealed class WindowsRegistryReader : IRegistryReader
{
    public object? GetValue(Hive hive, string path, string name)
    {
        try
        {
            using var key = Open(hive, path);
            return key?.GetValue(name);
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return null;
        }
    }

    public IReadOnlyList<string> GetSubKeyNames(Hive hive, string path)
    {
        try
        {
            using var key = Open(hive, path);
            return key?.GetSubKeyNames() ?? [];
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return [];
        }
    }

    public IReadOnlyList<string> GetValueNames(Hive hive, string path)
    {
        try
        {
            using var key = Open(hive, path);
            return key?.GetValueNames() ?? [];
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return [];
        }
    }

    private static RegistryKey? Open(Hive hive, string path)
    {
        using var root = RegistryKey.OpenBaseKey(
            hive == Hive.LocalMachine ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, RegistryView.Registry64);
        return root.OpenSubKey(path, writable: false);
    }
}

/// <summary>An "Apps &amp; features" entry, used by several adapters to locate games.</summary>
public sealed record UninstallEntry(
    Hive Hive,
    string KeyName,
    string? DisplayName,
    string? Publisher,
    string? InstallLocation,
    string? UninstallString,
    string? DisplayIcon);

public static class UninstallScanner
{
    private static readonly string[] Roots =
    [
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];

    public static IReadOnlyList<UninstallEntry> Read(IRegistryReader reg)
    {
        var list = new List<UninstallEntry>();
        foreach (var hive in new[] { Hive.LocalMachine, Hive.CurrentUser })
        foreach (var root in Roots)
        foreach (var name in reg.GetSubKeyNames(hive, root))
        {
            var path = $@"{root}\{name}";
            list.Add(new UninstallEntry(hive, name,
                reg.GetString(hive, path, "DisplayName"),
                reg.GetString(hive, path, "Publisher"),
                NormalizeDir(reg.GetString(hive, path, "InstallLocation")),
                reg.GetString(hive, path, "UninstallString"),
                reg.GetString(hive, path, "DisplayIcon")));
        }
        return list;
    }

    public static string? NormalizeDir(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        var p = path.Trim().Trim('"').Replace('/', '\\');
        return p.Length > 3 ? p.TrimEnd('\\') : p;
    }
}

/// <summary>Well-known folders, injectable for tests.</summary>
public sealed record AdapterEnvironment(string ProgramData, string LocalAppData, string ProgramFiles, string ProgramFilesX86)
{
    public static AdapterEnvironment Current { get; } = new(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86));
}
