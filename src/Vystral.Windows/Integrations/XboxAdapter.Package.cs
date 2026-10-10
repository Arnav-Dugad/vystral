using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Vystral.Core.Domain;

namespace Vystral.Windows.Integrations;

/// <summary>
/// Track C1: reading Xbox / Microsoft Store packages thoroughly and read-only — localized names (ms-resource:),
/// the app a package really launches, better artwork, and an honest "last played" estimate from save data.
/// </summary>
public sealed partial class XboxAdapter
{
    /// <summary>What a scan may use beyond the packages themselves; tests pass fixtures, the app passes this PC.</summary>
    /// <param name="PackagesRoot">%LOCALAPPDATA%\Packages, where each package keeps its data (saves, caches).</param>
    /// <param name="ResolveResource">Loads an indirect string ("@{PackageFullName? ms-resource://...}"); null result when it can't.</param>
    internal sealed record ReadContext(string? PackagesRoot, Func<string, string?>? ResolveResource, Func<DateTimeOffset> Now)
    {
        public static ReadContext None { get; } = new(null, null, () => DateTimeOffset.UtcNow);

        public static ReadContext ForThisPc()
        {
            string? root = null;
            try
            {
                var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (!string.IsNullOrEmpty(local)) root = Path.Combine(local, "Packages");
            }
            catch (PlatformNotSupportedException) { }
            return new ReadContext(root, IndirectStrings.Load, () => DateTimeOffset.UtcNow);
        }
    }

    // ---------- Which app ----------

    /// <summary>
    /// A package can declare several apps (the game, a launcher, a settings tool). Picks the one the game config
    /// names first, else the first one shown in Start (AppListEntry isn't "none"), else the first.
    /// </summary>
    internal static XElement? PickApplication(XElement manifestRoot, XElement? config)
    {
        var apps = manifestRoot.Elements().Where(e => e.Name.LocalName == "Applications").Elements()
            .Where(e => e.Name.LocalName == "Application" && !string.IsNullOrWhiteSpace(e.Attribute("Id")?.Value))
            .ToList();
        if (apps.Count <= 1) return apps.FirstOrDefault();

        static bool Listed(XElement app) => !string.Equals(
            app.Elements().FirstOrDefault(e => e.Name.LocalName == "VisualElements")?.Attribute("AppListEntry")?.Value?.Trim(),
            "none", StringComparison.OrdinalIgnoreCase);

        if (config is not null)
        {
            foreach (var id in config.Descendants().Where(e => e.Name.LocalName == "Executable").Select(e => e.Attribute("Id")?.Value?.Trim()))
            {
                if (string.IsNullOrEmpty(id)) continue;
                var match = apps.FirstOrDefault(a => string.Equals(a.Attribute("Id")!.Value.Trim(), id, StringComparison.OrdinalIgnoreCase) && Listed(a));
                if (match is not null) return match;
            }
        }
        return apps.FirstOrDefault(Listed) ?? apps[0];
    }

    // ---------- Names ----------

    [GeneratedRegex(@"^[A-Za-z0-9._\-]{3,200}$", RegexOptions.CultureInvariant)]
    private static partial Regex PackageFullNameRegex();

    [GeneratedRegex(@"^[A-Za-z0-9.\-]{1,100}$", RegexOptions.CultureInvariant)]
    private static partial Regex PackageNameRegex();

    [GeneratedRegex(@"^\d{1,5}(\.\d{1,5}){1,3}$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionRegex();

    /// <summary>
    /// A display string as shown to people: plain text is trimmed; an <c>ms-resource:</c> reference is resolved through
    /// the package's own resources (read-only), trying the usual reference shapes. Null when nothing usable comes back.
    /// </summary>
    internal static string? ReadableText(string? value, int max, string? packageFullName, string packageName, Func<string, string?>? resolve)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var text = value.Trim();
        if (!text.StartsWith("ms-resource:", StringComparison.OrdinalIgnoreCase)) return Clean(text, max);
        if (resolve is null || packageFullName is null) return null;
        foreach (var source in IndirectStringCandidates(packageFullName, packageName, text))
        {
            string? resolved;
            try { resolved = resolve(source); }
            catch (Exception ex) when (ex is COMException or ArgumentException or InvalidOperationException) { resolved = null; }
            if (Clean(resolved, max) is { } ok) return ok;
        }
        return null;
    }

    /// <summary>
    /// Indirect strings for one <c>ms-resource:</c> reference, most likely first. "ms-resource:AppName" usually lives in
    /// the Resources map; "ms-resource:Strings/AppName" and "ms-resource:/Strings/AppName" name the map themselves;
    /// "ms-resource://Package/..." is already complete.
    /// </summary>
    internal static IReadOnlyList<string> IndirectStringCandidates(string packageFullName, string packageName, string reference)
    {
        if (!PackageFullNameRegex().IsMatch(packageFullName) || !PackageNameRegex().IsMatch(packageName)) return [];
        if (!reference.StartsWith("ms-resource:", StringComparison.OrdinalIgnoreCase)) return [];
        var key = reference["ms-resource:".Length..].Trim();
        if (key.Length is 0 or > 300 || key.Any(c => char.IsControl(c) || c is '{' or '}' or '?' or '@')) return [];
        var uris = new List<string>();
        if (key.StartsWith("//", StringComparison.Ordinal)) uris.Add("ms-resource:" + key);
        else if (key.StartsWith('/')) uris.Add($"ms-resource://{packageName}{key}");
        else if (key.Contains('/')) uris.Add($"ms-resource://{packageName}/{key}");
        else
        {
            uris.Add($"ms-resource://{packageName}/Resources/{key}");
            uris.Add($"ms-resource:///Resources/{key}");
        }
        return uris.Select(u => $"@{{{packageFullName}? {u}}}").ToList();
    }

    private static string? Clean(string? text, int max)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        text = text.Trim();
        if (text.Length > max || text.StartsWith("ms-resource:", StringComparison.OrdinalIgnoreCase) || text.StartsWith("@{", StringComparison.Ordinal) ||
            text.Any(char.IsControl))
            return null;
        return text;
    }

    internal static string? UsableVersion(string? version) =>
        version is not null && VersionRegex().IsMatch(version.Trim()) ? version.Trim() : null;

    // ---------- Artwork ----------

    /// <summary>
    /// The best local images a package ships, each the largest scale/target-size variant: an icon from the square
    /// logos (falling back to the store logo), a landscape header from the wide tile (else the splash screen), and a
    /// hero only from a GDK game's full-screen splash image (a UWP splash is a logo on a colour, so it isn't a hero).
    /// </summary>
    internal static Dictionary<ArtworkKind, string> PackageArtwork(string location, XElement? shellVisuals, XElement? visual, string? storeLogo)
    {
        var tile = visual?.Elements().FirstOrDefault(e => e.Name.LocalName == "DefaultTile");
        var splash = visual?.Elements().FirstOrDefault(e => e.Name.LocalName == "SplashScreen");
        var art = new Dictionary<ArtworkKind, string>();
        void Pick(ArtworkKind kind, params string?[] candidates)
        {
            foreach (var candidate in candidates)
            {
                if (ResolveLogo(location, candidate) is not { } file) continue;
                art[kind] = file;
                return;
            }
        }
        Pick(ArtworkKind.Icon,
            shellVisuals?.Attribute("Square480x480Logo")?.Value,
            tile?.Attribute("Square310x310Logo")?.Value,
            visual?.Attribute("Square150x150Logo")?.Value,
            shellVisuals?.Attribute("Square150x150Logo")?.Value,
            visual?.Attribute("Square44x44Logo")?.Value,
            shellVisuals?.Attribute("Square44x44Logo")?.Value,
            shellVisuals?.Attribute("StoreLogo")?.Value,
            storeLogo);
        Pick(ArtworkKind.Header,
            tile?.Attribute("Wide310x150Logo")?.Value,
            splash?.Attribute("Image")?.Value,
            shellVisuals?.Attribute("SplashScreenImage")?.Value);
        Pick(ArtworkKind.Hero, shellVisuals?.Attribute("SplashScreenImage")?.Value);
        return art;
    }

    // ---------- Last played (estimated) ----------

    /// <summary>The package data folders a game writes while it runs: cloud saves, local saves, temp data, its app container.</summary>
    internal static readonly string[] SaveDataFolders = [@"SystemAppData\wgs", "LocalState", "TempState", "AC"];

    /// <summary>
    /// The newest file write time under the package's own data folders — an honest estimate of when the game last ran
    /// (it writes saves and caches while playing). Only metadata is read; reparse points aren't followed; the walk is
    /// capped. Times in the future (clock skew) are ignored. Null when there's nothing to go on.
    /// </summary>
    internal static DateTimeOffset? EstimateLastPlayed(string? packagesRoot, string familyName, DateTimeOffset now, int maxEntries = 20_000)
    {
        if (string.IsNullOrEmpty(packagesRoot) || !PackageFullNameRegex().IsMatch(familyName)) return null;
        var packageDir = AdapterIo.CombineInside(packagesRoot, familyName);
        if (packageDir is null || !AdapterIo.DirectoryExists(packageDir)) return null;
        var limit = now.UtcDateTime.AddHours(1);
        var newest = DateTime.MinValue;
        var seen = 0;
        var options = new EnumerationOptions
        {
            IgnoreInaccessible = true,
            RecurseSubdirectories = false,
            AttributesToSkip = FileAttributes.ReparsePoint,
            ReturnSpecialDirectories = false,
        };
        foreach (var sub in SaveDataFolders)
        {
            var start = Path.Combine(packageDir, sub);
            if (!AdapterIo.DirectoryExists(start)) continue;
            var stack = new Stack<string>();
            stack.Push(start);
            while (stack.Count > 0 && seen < maxEntries)
            {
                var dir = stack.Pop();
                try
                {
                    foreach (var entry in new DirectoryInfo(dir).EnumerateFileSystemInfos("*", options))
                    {
                        if (++seen > maxEntries) break;
                        if (entry is DirectoryInfo) { stack.Push(entry.FullName); continue; }
                        var t = entry.LastWriteTimeUtc;
                        if (t > newest && t <= limit) newest = t;
                    }
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException) { }
            }
        }
        return newest == DateTime.MinValue || newest.Year < 2000 ? null : new DateTimeOffset(DateTime.SpecifyKind(newest, DateTimeKind.Utc));
    }
}

/// <summary>Read-only access to Windows' indirect strings (package resources), via SHLoadIndirectString.</summary>
internal static class IndirectStrings
{
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern unsafe int SHLoadIndirectString(string pszSource, char* pszOutBuf, uint cchOutBuf, IntPtr ppvReserved);

    public static unsafe string? Load(string source)
    {
        if (string.IsNullOrEmpty(source) || source.Length > 1024 || !source.StartsWith("@{", StringComparison.Ordinal)) return null;
        const int size = 1024;
        var buffer = stackalloc char[size];
        try
        {
            if (SHLoadIndirectString(source, buffer, size, IntPtr.Zero) != 0) return null;
            buffer[size - 1] = '\0';
            var text = new string(buffer);
            return text.Length == 0 ? null : text;
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or SEHException)
        {
            return null;
        }
    }
}
