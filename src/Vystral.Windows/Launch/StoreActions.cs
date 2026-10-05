using System.Text.RegularExpressions;
using Vystral.Core.Domain;

namespace Vystral.Windows.Launch;

/// <summary>
/// Builds the only store-action links VYSTRAL ever opens: <c>steam://install/&lt;appid&gt;</c> and
/// <c>steam://uninstall/&lt;appid&gt;</c>. Steam then shows its own confirmation and does the work;
/// VYSTRAL never downloads, moves or deletes game files itself.
/// </summary>
public enum StoreAction { Install, Uninstall }

public static partial class StoreActions
{
    /// <summary>Returns the action URI, or null when <paramref name="appId"/> isn't a plain Steam appid.</summary>
    public static Uri? Steam(StoreAction action, string? appId)
    {
        if (appId is null || !AppIdPattern().IsMatch(appId)) return null;
        var verb = action == StoreAction.Install ? "install" : "uninstall";
        var uri = new Uri($"steam://{verb}/{appId}");
        return LaunchValidator.ValidateStoreAction(PlatformId.Steam, uri).Ok ? uri : null;
    }

    [GeneratedRegex(@"^[0-9]{1,10}\z")]
    internal static partial Regex AppIdPattern();
}

public static partial class LaunchValidator
{
    /// <summary>
    /// Store install/uninstall links use the same per-platform scheme allow-list as launches, and
    /// additionally must be exactly <c>&lt;scheme&gt;://(install|uninstall)/&lt;digits&gt;</c>.
    /// </summary>
    public static ValidationResult ValidateStoreAction(PlatformId platform, Uri uri)
    {
        if (!AllowedSchemes.TryGetValue(platform, out var schemes) || !schemes.Contains(uri.Scheme, StringComparer.OrdinalIgnoreCase))
            return ValidationResult.Fail($"VYSTRAL only opens {platform.DisplayName()} links for {platform.DisplayName()} games.");
        var raw = uri.OriginalString;
        if (raw.Length > 64 || raw.Any(c => char.IsControl(c) || char.IsWhiteSpace(c)) || !StoreActionPattern().IsMatch(raw))
            return ValidationResult.Fail("That store link isn't one VYSTRAL opens.");
        return ValidationResult.Valid;
    }

    [GeneratedRegex(@"^steam://(install|uninstall)/[0-9]{1,10}\z")]
    private static partial Regex StoreActionPattern();
}
