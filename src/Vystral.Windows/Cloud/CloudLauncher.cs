using System.ComponentModel;
using System.Diagnostics;
using Vystral.Core.Cloud;
using Vystral.Windows.Integrations;

namespace Vystral.Windows.Cloud;

/// <summary>Where a cloud game opens.</summary>
public static class CloudSurfaces
{
    public const string GfnApp = "gfnApp";
    public const string XboxApp = "xboxApp";
    public const string Edge = "edge";
    public const string Browser = "browser";

    public static string Label(string surface) => surface switch
    {
        GfnApp => "GeForce NOW app",
        XboxApp => "Xbox app",
        Edge => "a separate Microsoft Edge window",
        _ => "your browser",
    };
}

/// <summary>How a session is noticed after launch (read-only, see <see cref="CloudSessionDetector"/>).</summary>
public enum CloudDetect { GfnStreamer, XboxForeground, OwnProcess, Manual }

/// <summary>
/// What will be started. <see cref="FileName"/> is a validated local executable or an allow-listed URI
/// (https, msxbox); <see cref="Arguments"/> are passed as separate argv elements, never through a shell.
/// </summary>
public sealed record CloudLaunchPlan(string Surface, string FileName, IReadOnlyList<string> Arguments, bool ShellExecute, string? Url, CloudDetect Detect);

/// <summary>The official surfaces present on this PC (found read-only).</summary>
public sealed record CloudEnvironment(string? GfnAppPath, bool XboxApp, string? EdgePath);

/// <summary>Starts a process and returns its id when Windows reports one (tests substitute a recorder).</summary>
public interface ICloudProcessStarter
{
    int? Start(ProcessStartInfo info);
}

public sealed class CloudProcessStarter : ICloudProcessStarter
{
    public int? Start(ProcessStartInfo info)
    {
        using var p = Process.Start(info);
        try { return p?.Id; }
        catch (InvalidOperationException) { return null; }
    }
}

/// <summary>
/// Builds launches into the vendors' own apps and sites, exactly as the research recommends: the GeForce NOW desktop
/// app (its <c>--url-route</c> argument, the same one its own desktop shortcuts carry) or NVIDIA's documented web
/// deep link; the Xbox app's documented <c>msxbox://game/?productId=</c> or xbox.com/play. Browser fallback is a
/// chromeless Edge <c>--app</c> window with a VYSTRAL-owned profile folder VYSTRAL never reads, or the default browser.
/// The stream is never embedded in VYSTRAL. Every value is built from validated IDs only.
/// </summary>
public static class CloudLauncher
{
    public const string GfnUtmSource = "vystral";

    public static string GfnWebUrl(string gameId) =>
        CloudIds.IsGfnGameId(gameId) ? $"https://play.geforcenow.com/games?game-id={gameId}&utm_source={GfnUtmSource}" : throw new ArgumentException("Invalid GeForce NOW game ID.");

    public static string XboxWebUrl(string productId, string? title) =>
        CloudIds.IsProductId(productId) ? $"https://www.xbox.com/en-US/play/launch/{Slug(title)}/{productId}" : throw new ArgumentException("Invalid product ID.");

    public static string XboxAppUri(string productId) =>
        CloudIds.IsProductId(productId) ? $"msxbox://game/?productId={productId}" : throw new ArgumentException("Invalid product ID.");

    public static string GfnRoute(string cmsId) =>
        CloudIds.IsCmsId(cmsId) ? $"--url-route=#?cmsId={cmsId}&launchSource=External&shortName=game_gfn_pc&parentGameId=" : throw new ArgumentException("Invalid cmsId.");

    /// <summary>The cosmetic slug xbox.com expects before the product ID (it corrects a wrong one): ASCII letters and digits only.</summary>
    public static string Slug(string? title)
    {
        var chars = (title ?? "").ToLowerInvariant().Select(c => char.IsAsciiLetterOrDigit(c) ? c : '-').ToArray();
        var slug = string.Join('-', new string(chars).Split('-', StringSplitOptions.RemoveEmptyEntries));
        if (slug.Length > 60) slug = slug[..60].TrimEnd('-');
        return slug.Length == 0 ? "game" : slug;
    }

    /// <param name="useEdge">The browser setting: a separate Edge window (true) or the default browser.</param>
    public static CloudLaunchPlan Plan(CloudCatalogEntry entry, CloudEnvironment env, bool useEdge, string edgeProfileDir)
    {
        if (entry.Service == CloudServices.GeForceNow)
        {
            if (!CloudIds.IsGfnGameId(entry.EntryId) || !CloudIds.IsCmsId(entry.LaunchKey)) throw new ArgumentException("Invalid GeForce NOW entry.");
            if (env.GfnAppPath is { } app && IsSafeExe(app, "GeForceNOW.exe"))
                return new CloudLaunchPlan(CloudSurfaces.GfnApp, app, [GfnRoute(entry.LaunchKey!)], false, null, CloudDetect.GfnStreamer);
            return Browser(GfnWebUrl(entry.EntryId), env, useEdge, edgeProfileDir);
        }
        if (entry.Service == CloudServices.Xbox)
        {
            if (!CloudIds.IsProductId(entry.EntryId)) throw new ArgumentException("Invalid Xbox entry.");
            if (env.XboxApp) return new CloudLaunchPlan(CloudSurfaces.XboxApp, XboxAppUri(entry.EntryId), [], true, null, CloudDetect.XboxForeground);
            return Browser(XboxWebUrl(entry.EntryId, entry.Title), env, useEdge, edgeProfileDir);
        }
        throw new ArgumentException("Unknown cloud service.");
    }

    /// <summary>The browser fallback for a vendor URL: Edge <c>--app</c> with VYSTRAL's own profile folder, or the default browser.</summary>
    public static CloudLaunchPlan Browser(string url, CloudEnvironment env, bool useEdge, string edgeProfileDir)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || u.Scheme != Uri.UriSchemeHttps || u.Host is not ("play.geforcenow.com" or "www.xbox.com"))
            throw new ArgumentException("Only the vendors' own pages can be opened.");
        if (useEdge && env.EdgePath is { } edge && IsSafeExe(edge, "msedge.exe") && Path.IsPathFullyQualified(edgeProfileDir) && !edgeProfileDir.Contains('"'))
            return new CloudLaunchPlan(CloudSurfaces.Edge, edge,
                [$"--app={u.AbsoluteUri}", $"--user-data-dir={edgeProfileDir}", "--no-first-run", "--no-default-browser-check"], false, u.AbsoluteUri, CloudDetect.OwnProcess);
        return DefaultBrowser(u.AbsoluteUri);
    }

    public static CloudLaunchPlan DefaultBrowser(string url) => new(CloudSurfaces.Browser, url, [], true, url, CloudDetect.Manual);

    public static ProcessStartInfo ToStartInfo(CloudLaunchPlan plan)
    {
        if (plan.ShellExecute)
        {
            // Only https vendor pages and the Xbox app's documented scheme reach ShellExecute.
            if (!Uri.TryCreate(plan.FileName, UriKind.Absolute, out var u) || u.Scheme is not ("https" or "msxbox") || plan.Arguments.Count > 0)
                throw new ArgumentException("That link type isn't allowed.");
            return new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true };
        }
        var psi = new ProcessStartInfo(plan.FileName) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(plan.FileName)! };
        foreach (var a in plan.Arguments) psi.ArgumentList.Add(a);
        return psi;
    }

    /// <summary>A local, absolute path to the expected executable name (no UNC, no relative parts).</summary>
    internal static bool IsSafeExe(string path, string fileName) =>
        Path.IsPathFullyQualified(path) && !path.StartsWith(@"\\", StringComparison.Ordinal) && !path.Contains("..", StringComparison.Ordinal) &&
        !path.Contains('"') && string.Equals(Path.GetFileName(path), fileName, StringComparison.OrdinalIgnoreCase);

    // ---------- Finding the official surfaces (read-only) ----------

    public static CloudEnvironment Detect(IRegistryReader registry, Func<string, bool>? fileExists = null)
    {
        fileExists ??= File.Exists;
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var gfn = Path.Combine(local, "NVIDIA Corporation", "GeForceNOW", "CEF", "GeForceNOW.exe");
        var xbox = registry.GetValueNames(Hive.CurrentUser, @"Software\Classes\msxbox").Contains("URL Protocol", StringComparer.OrdinalIgnoreCase);
        string? edge = null;
        foreach (var candidate in EdgeCandidates(registry))
        {
            if (candidate is not null && IsSafeExe(candidate, "msedge.exe") && fileExists(candidate)) { edge = candidate; break; }
        }
        return new CloudEnvironment(fileExists(gfn) ? gfn : null, xbox, edge);
    }

    private static IEnumerable<string?> EdgeCandidates(IRegistryReader registry)
    {
        const string appPaths = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe";
        yield return Unquote(registry.GetString(Hive.LocalMachine, appPaths, ""));
        yield return Unquote(registry.GetString(Hive.CurrentUser, appPaths, ""));
        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe");
        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe");
    }

    private static string? Unquote(string? s) => s?.Trim().Trim('"');

    /// <summary>Starts the plan; if Edge can't be started (missing, blocked by policy), falls back to the default browser.</summary>
    public static (CloudLaunchPlan Plan, int? Pid) Execute(CloudLaunchPlan plan, ICloudProcessStarter starter)
    {
        try
        {
            return (plan, starter.Start(ToStartInfo(plan)));
        }
        catch (Win32Exception) when (plan.Surface == CloudSurfaces.Edge && plan.Url is { } url)
        {
            var fallback = DefaultBrowser(url);
            return (fallback, starter.Start(ToStartInfo(fallback)));
        }
    }
}
