using System.Security.Cryptography;
using System.Text;

namespace Vystral.Windows.Tracking;

/// <summary>How the process was asked to run.</summary>
public sealed record TrackerCommand(bool BackgroundTracker, string? DataDir);

/// <summary>
/// Command-line switches of the background tracker. The autostart entry passes exactly
/// <c>--background-tracker</c>; <c>--data-dir &lt;folder&gt;</c> exists for development and measurements
/// (it points the tracker at a scratch data folder and separate coordination objects).
/// </summary>
public static class TrackerCommandLine
{
    public const string Switch = "--background-tracker";
    public const string DataDirSwitch = "--data-dir";

    /// <summary>
    /// Parses the arguments. The tracker switch must come first; anything unexpected after it makes the
    /// whole command line invalid (returns a non-tracker command), so a crafted shortcut can't smuggle options.
    /// </summary>
    public static TrackerCommand Parse(IReadOnlyList<string> args)
    {
        var none = new TrackerCommand(false, null);
        if (args.Count == 0 || !string.Equals(args[0], Switch, StringComparison.OrdinalIgnoreCase)) return none;
        if (args.Count == 1) return new TrackerCommand(true, null);
        if (args.Count == 3 && string.Equals(args[1], DataDirSwitch, StringComparison.OrdinalIgnoreCase) && IsUsableDir(args[2]))
            return new TrackerCommand(true, Path.GetFullPath(args[2]));
        return none;
    }

    public static bool IsBackgroundTracker(IReadOnlyList<string> args) => Parse(args).BackgroundTracker;

    private static bool IsUsableDir(string dir) =>
        dir.Length is > 3 and < 240 && Path.IsPathFullyQualified(dir) && !dir.StartsWith(@"\\", StringComparison.Ordinal) &&
        dir.IndexOfAny(['"', '\r', '\n', '*', '?', '<', '>', '|']) < 0;
}

/// <summary>
/// Names of the kernel objects the app and the background tracker coordinate with. They live in the
/// session-local namespace and include a hash of the data folder, so a test or development copy using
/// another data folder never interferes with the installed app.
/// </summary>
public sealed class TrackerNames
{
    private readonly string _prefix;

    public TrackerNames(string prefix) => _prefix = prefix;

    public static TrackerNames For(string dataRoot)
    {
        var normalized = Path.GetFullPath(dataRoot).TrimEnd('\\').ToUpperInvariant();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)))[..12];
        return new TrackerNames($@"Local\VYSTRAL-{hash}");
    }

    /// <summary>Held by the app's window process for its whole lifetime.</summary>
    public string App => _prefix + "-app";
    /// <summary>Held by whichever process is currently tracking games (exactly one).</summary>
    public string Tracker => _prefix + "-tracker";
    /// <summary>Held by the background tracker for its lifetime (single instance).</summary>
    public string Helper => _prefix + "-helper";
    /// <summary>Auto-reset event: the app asks the background tracker to hand tracking over.</summary>
    public string Yield => _prefix + "-yield";
    /// <summary>Auto-reset event: asks the background tracker to exit.</summary>
    public string Stop => _prefix + "-stop";
    /// <summary>Serialises database migrations between the two processes.</summary>
    public string Migrate => _prefix + "-migrate";
}
