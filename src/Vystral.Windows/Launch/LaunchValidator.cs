using System.Text.RegularExpressions;
using Vystral.Core.Domain;

namespace Vystral.Windows.Launch;

public sealed record ValidationResult(bool Ok, string? Problem)
{
    public static readonly ValidationResult Valid = new(true, null);
    public static ValidationResult Fail(string problem) => new(false, problem);
}

/// <summary>
/// Security gate for every launch. Launch targets come from platform manifests and user
/// input, both of which are untrusted; only well-formed targets of the allowed kinds pass.
/// </summary>
public static partial class LaunchValidator
{
    private static readonly Dictionary<PlatformId, string[]> AllowedSchemes = new()
    {
        [PlatformId.Steam] = ["steam"],
        [PlatformId.Epic] = ["com.epicgames.launcher"],
        [PlatformId.Ea] = ["origin2", "link2ea"],
        [PlatformId.Ubisoft] = ["uplay"],
        [PlatformId.Gog] = ["goggalaxy"],
        [PlatformId.BattleNet] = ["battlenet"],
        [PlatformId.Xbox] = [],
        [PlatformId.Manual] = [],
    };

    public const int MaxUserArgsLength = 1024;

    public static ValidationResult Validate(Installation inst, string? userArgs)
    {
        if (userArgs is not null)
        {
            if (userArgs.Length > MaxUserArgsLength) return ValidationResult.Fail("The custom launch options are too long.");
            if (userArgs.Any(char.IsControl)) return ValidationResult.Fail("The custom launch options contain invalid characters.");
        }

        var target = inst.Launch;
        switch (target.Kind)
        {
            case LaunchKind.Uri:
                if (target.Value.Length > 2048 || target.Value.Any(c => char.IsControl(c) || char.IsWhiteSpace(c)))
                    return ValidationResult.Fail("The store launch link is malformed.");
                if (!Uri.TryCreate(target.Value, UriKind.Absolute, out var uri))
                    return ValidationResult.Fail("The store launch link is malformed.");
                if (!AllowedSchemes.TryGetValue(inst.Platform, out var schemes) ||
                    !schemes.Contains(uri.Scheme, StringComparer.OrdinalIgnoreCase))
                    return ValidationResult.Fail($"VYSTRAL only opens {inst.Platform.DisplayName()} links for {inst.Platform.DisplayName()} games.");
                return ValidationResult.Valid;

            case LaunchKind.PackagedApp:
                return AumidPattern().IsMatch(target.Value)
                    ? ValidationResult.Valid
                    : ValidationResult.Fail("The Windows app identity for this game is malformed.");

            case LaunchKind.Executable:
                return ValidateExecutable(inst, target);

            default:
                return ValidationResult.Fail("Unknown launch type.");
        }
    }

    private static ValidationResult ValidateExecutable(Installation inst, LaunchTarget target)
    {
        string full;
        try
        {
            if (!Path.IsPathFullyQualified(target.Value)) return ValidationResult.Fail("The game's program path is not a full path.");
            full = Path.GetFullPath(target.Value);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return ValidationResult.Fail("The game's program path is invalid.");
        }

        if (full.StartsWith(@"\\", StringComparison.Ordinal))
            return ValidationResult.Fail("Games on network paths can't be launched from VYSTRAL.");
        if (!string.Equals(Path.GetExtension(full), ".exe", StringComparison.OrdinalIgnoreCase))
            return ValidationResult.Fail("Only .exe programs can be launched.");
        if (!File.Exists(full))
            return ValidationResult.Fail($"The game's program wasn't found at {full}. It may have been moved or uninstalled.");

        // Store games must launch from inside their own install folder (or the store's client
        // for Battle.net, which launches via its own executable).
        if (inst.Platform is not PlatformId.Manual and not PlatformId.BattleNet && inst.InstallPath is not null)
        {
            var root = Path.GetFullPath(inst.InstallPath).TrimEnd('\\') + "\\";
            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                return ValidationResult.Fail("The game's program is outside its install folder, so VYSTRAL won't start it.");
        }

        if (target.WorkingDirectory is not null &&
            (!Path.IsPathFullyQualified(target.WorkingDirectory) || !Directory.Exists(target.WorkingDirectory)))
            return ValidationResult.Fail("The game's working folder doesn't exist.");

        return ValidationResult.Valid;
    }

    /// <summary>Splits a user-entered argument string the way Windows does, so arguments can be
    /// passed via ArgumentList (no shell, no re-quoting surprises).</summary>
    public static IReadOnlyList<string> SplitArguments(string? args)
    {
        var result = new List<string>();
        if (string.IsNullOrWhiteSpace(args)) return result;
        var current = new System.Text.StringBuilder();
        var inQuotes = false;
        foreach (var c in args)
        {
            if (c == '"') { inQuotes = !inQuotes; continue; }
            if (char.IsWhiteSpace(c) && !inQuotes)
            {
                if (current.Length > 0) { result.Add(current.ToString()); current.Clear(); }
                continue;
            }
            current.Append(c);
        }
        if (current.Length > 0) result.Add(current.ToString());
        return result;
    }

    // PackageFamilyName (Name_PublisherId) + "!" + ApplicationId
    [GeneratedRegex(@"^[A-Za-z0-9.\-]{3,50}_[a-z0-9]{13}![A-Za-z][A-Za-z0-9.\-]{0,63}\z")]
    private static partial Regex AumidPattern();
}
