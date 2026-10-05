using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Vystral.Windows.Services;

/// <summary>
/// Per-user registry writes under <c>HKCU\Software\Classes</c> — the only registry VYSTRAL ever
/// writes. Behind an interface so the registration logic is tested without touching the registry.
/// Paths are relative to <c>HKCU\Software\Classes</c>; a null value name is the key's default value.
/// </summary>
public interface IUserClassesRegistry
{
    string? GetString(string subKey, string? name);
    void SetString(string subKey, string? name, string value);
    /// <summary>Deletes a key and everything under it; does nothing if it doesn't exist.</summary>
    void DeleteTree(string subKey);
}

public sealed class WindowsUserClassesRegistry : IUserClassesRegistry
{
    private const string Root = @"Software\Classes\";

    public string? GetString(string subKey, string? name)
    {
        using var key = Registry.CurrentUser.OpenSubKey(Root + subKey, writable: false);
        return key?.GetValue(name ?? "") as string;
    }

    public void SetString(string subKey, string? name, string value)
    {
        using var key = Registry.CurrentUser.CreateSubKey(Root + subKey, writable: true);
        key.SetValue(name ?? "", value, RegistryValueKind.String);
    }

    public void DeleteTree(string subKey) => Registry.CurrentUser.DeleteSubKeyTree(Root + subKey, throwOnMissingSubKey: false);
}

/// <summary>
/// Registers what clickable Windows notifications need for a self-contained, unpackaged app:
/// <list type="bullet">
/// <item>the <c>vystral:</c> URI scheme, so a toast with <c>activationType="protocol"</c> starts (or is
/// redirected to) VYSTRAL with <c>--uri &lt;uri&gt;</c>;</item>
/// <item>the AppUserModelID's display name and icon, so toasts are attributed to VYSTRAL even
/// without a Start menu shortcut (development and portable builds).</item>
/// </list>
/// Everything is per-user (no admin). Values are rewritten only when they differ, so this is cheap
/// to call on every start and repairs itself when the install folder moves.
/// </summary>
public sealed partial class ShellRegistration(IUserClassesRegistry registry, string exePath, string aumid, string displayName, string? iconPath)
{
    public const string ProtocolKey = ActivationUri.Scheme;
    public const string CommandKey = ProtocolKey + @"\shell\open\command";
    public const string IconKey = ProtocolKey + @"\DefaultIcon";
    public static string AumidKey(string aumid) => @"AppUserModelId\" + aumid;

    public string Command => $"\"{exePath}\" {ActivationUri.Switch} \"%1\"";

    /// <summary>The registry writes this would make, as (sub key, value name, value). Exposed for tests and documentation.</summary>
    public IReadOnlyList<(string Key, string? Name, string Value)> Entries()
    {
        Validate();
        var list = new List<(string, string?, string)>
        {
            (ProtocolKey, null, $"URL:{displayName}"),
            (ProtocolKey, "URL Protocol", ""),
            (IconKey, null, $"\"{exePath}\",0"),
            (CommandKey, null, Command),
            (AumidKey(aumid), "DisplayName", displayName),
        };
        if (iconPath is not null) list.Add((AumidKey(aumid), "IconUri", iconPath));
        return list;
    }

    /// <summary>Writes any value that is missing or different. Returns the number of values written.</summary>
    public int EnsureRegistered()
    {
        var written = 0;
        foreach (var (key, name, value) in Entries())
        {
            if (registry.GetString(key, name) == value) continue;
            registry.SetString(key, name, value);
            written++;
        }
        return written;
    }

    /// <summary>
    /// Removes the registration on uninstall. The URI scheme is removed only while it still points
    /// at this executable, so uninstalling one copy never breaks another copy that took it over.
    /// </summary>
    public void Unregister()
    {
        Validate();
        if (string.Equals(registry.GetString(CommandKey, null), Command, StringComparison.OrdinalIgnoreCase))
            registry.DeleteTree(ProtocolKey);
        registry.DeleteTree(AumidKey(aumid));
    }

    private void Validate()
    {
        if (!Path.IsPathFullyQualified(exePath) || exePath.StartsWith(@"\\", StringComparison.Ordinal) || exePath.IndexOfAny(['"', '%', '\r', '\n']) >= 0)
            throw new ArgumentException("The executable path can't be registered.", nameof(exePath));
        if (!AumidPattern().IsMatch(aumid)) throw new ArgumentException("Invalid AppUserModelID.", nameof(aumid));
        if (string.IsNullOrWhiteSpace(displayName) || displayName.Length > 64 || displayName.Any(char.IsControl))
            throw new ArgumentException("Invalid display name.", nameof(displayName));
        if (iconPath is not null && (!Path.IsPathFullyQualified(iconPath) || iconPath.IndexOfAny(['"', '\r', '\n']) >= 0))
            throw new ArgumentException("Invalid icon path.", nameof(iconPath));
    }

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z")]
    private static partial Regex AumidPattern();
}
