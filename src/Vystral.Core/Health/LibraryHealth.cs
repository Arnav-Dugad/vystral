using System.Globalization;
using Vystral.Core.Contracts;

namespace Vystral.Core.Health;

// Track Q: the library health check. Pure logic over data already read from the database and a probe for
// the file system, so it is fast, offline and fully unit-testable. DTOs are mirrored in ui/src/bridge/types.health.ts.

/// <summary>One fix offered beside an issue. <paramref name="Safe"/> fixes are idempotent and may run in "Fix all safe issues".</summary>
public sealed record HealthFixDto(string Action, string Label, bool Safe);

public sealed record HealthIssueDto(
    string Id,
    string Kind,
    string Group,
    string Severity,
    string Title,
    string Detail,
    string? GameId,
    IReadOnlyList<string> GameIds,
    string? InstallationId,
    string? Platform,
    IReadOnlyList<string> Platforms,
    string? Path,
    string? Drive,
    string? SessionId,
    string? ArtKind,
    string? OtherGameId,
    IReadOnlyList<HealthFixDto> Fixes);

public sealed record HealthReportDto(
    string CheckedAt,
    int ElapsedMs,
    int Score,
    int GameCount,
    IReadOnlyList<HealthIssueDto> Issues,
    int DismissedCount,
    bool Offline,
    bool Scanning);

/// <summary>An installation's launch target (not part of the UI snapshot).</summary>
public sealed record HealthLaunchRow(string InstallationId, string LaunchKind, string LaunchValue);

public sealed record HealthArtRow(string GameId, string Kind, string File, string Source, bool IsUser);

public sealed record HealthSessionRow(string Id, string GameId, string Start, int DurationSeconds);

/// <summary>The same Steam app found in more than one Steam library folder.</summary>
public sealed record SteamLibraryDuplicate(string AppId, IReadOnlyList<string> Libraries);

public sealed record HealthInputs
{
    public required IReadOnlyList<GameDto> Games { get; init; }
    public IReadOnlyList<DuplicateSuggestionDto> Suggestions { get; init; } = [];
    public IReadOnlyList<HealthLaunchRow> Launches { get; init; } = [];
    public IReadOnlyList<HealthArtRow> Art { get; init; } = [];
    /// <summary>Game ids whose details lookup was attempted (metadata_fetched set).</summary>
    public IReadOnlySet<string> MetadataAttempted { get; init; } = new HashSet<string>();
    public IReadOnlyDictionary<string, string> SteamAppIds { get; init; } = new Dictionary<string, string>();
    public IReadOnlyList<HealthSessionRow> OpenSessions { get; init; } = [];
    public IReadOnlyList<HealthSessionRow> LongSessions { get; init; } = [];
    /// <summary>Sessions a tracker is recording right now (never reported as "never ended").</summary>
    public IReadOnlySet<string> ActiveSessionIds { get; init; } = new HashSet<string>();
    public IReadOnlyList<string> DisabledPlatforms { get; init; } = [];
    public IReadOnlyList<SteamLibraryDuplicate> SteamDuplicates { get; init; } = [];
    public IReadOnlySet<string> Dismissed { get; init; } = new HashSet<string>();
    public bool FetchMetadata { get; init; } = true;
    public required DateTimeOffset Now { get; init; }
}

public sealed record ArtFileInfo(long Length, int? Width, int? Height);

/// <summary>File-system questions the checker asks. The real one caches per drive and per art file.</summary>
public interface IHealthProbe
{
    bool DriveConnected(string path);
    bool FileExists(string path);
    bool DirectoryExists(string path);
    /// <summary>Null when the cached art file is gone.</summary>
    ArtFileInfo? ArtFile(string relativeFile);
}

public static class LibraryHealth
{
    public static readonly TimeSpan StaleMissingAfter = TimeSpan.FromDays(30);
    public const int LongSessionSeconds = 16 * 3600;
    public const int MinCoverWidth = 300, MinCoverHeight = 450, MinHeroWidth = 960;
    /// <summary>Steam's flat grey stand-in is about 4.5 KB; real covers and heroes are far larger (see ArtworkService.IsPlaceholder).</summary>
    public const long PlaceholderBytes = 6 * 1024;

    private static readonly Dictionary<string, string> PlatformNames = new()
    {
        ["steam"] = "Steam", ["xbox"] = "Xbox", ["epic"] = "Epic Games", ["gog"] = "GOG", ["ea"] = "EA app",
        ["ubisoft"] = "Ubisoft Connect", ["battlenet"] = "Battle.net", ["manual"] = "Added by you",
    };

    public static string PlatformName(string? key) => key is not null && PlatformNames.TryGetValue(key, out var n) ? n : key ?? "";

    public static (IReadOnlyList<HealthIssueDto> Issues, int Dismissed) Check(HealthInputs input, IHealthProbe probe)
    {
        var issues = new List<HealthIssueDto>();
        var visible = input.Games.Where(g => !g.Hidden).ToList();
        var byId = input.Games.ToDictionary(g => g.Id);
        var launches = input.Launches.ToDictionary(l => l.InstallationId);
        var driveCache = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        bool Connected(string path)
        {
            var root = DriveKey(path);
            if (!driveCache.TryGetValue(root, out var ok)) driveCache[root] = ok = probe.DriveConnected(path);
            return ok;
        }

        var offline = new Dictionary<string, (List<string> Games, HashSet<string> Platforms)>(StringComparer.OrdinalIgnoreCase);

        foreach (var g in visible)
        {
            if (g.Installations.Count == 0)
            {
                issues.Add(Issue("emptyEntry", g.Id, "launch", "info", $"{g.Title} has no versions",
                    "No store or program is linked to this entry any more, so there's nothing to start.", g,
                    fixes: [new("hide", "Hide it", false), new("openGame", "Open game page", false)]));
                continue;
            }
            foreach (var inst in g.Installations)
            {
                launches.TryGetValue(inst.Id, out var launch);
                var where = inst.InstallPath ?? (launch?.LaunchKind == "Executable" ? launch.LaunchValue : null);
                if (where is not null && IsLocalRooted(where) && !Connected(where))
                {
                    if (inst.State != "notinstalled")
                    {
                        var key = DriveKey(where);
                        if (!offline.TryGetValue(key, out var bucket)) offline[key] = bucket = ([], []);
                        if (!bucket.Games.Contains(g.Id)) bucket.Games.Add(g.Id);
                        bucket.Platforms.Add(inst.Platform);
                    }
                    continue;
                }

                if (inst.Platform == "manual")
                {
                    var exe = launch?.LaunchValue;
                    if (exe is not null && IsLocalRooted(exe) && !probe.FileExists(exe))
                        issues.Add(Issue("brokenShortcut", inst.Id, "launch", "problem", $"{g.Title} can't start",
                            "The program you added isn't where it used to be. It may have been moved, renamed or uninstalled. Point VYSTRAL at it again and everything else (playtime, notes, art) stays.",
                            g, inst.Id, inst.Platform, path: exe,
                            fixes: [new("locate", "Locate the program…", false), new("hide", "Hide it", false)]));
                    continue;
                }

                if (inst.State == "installed")
                {
                    if (inst.InstallPath is { } dir && IsLocalRooted(dir) && !probe.DirectoryExists(dir))
                    {
                        issues.Add(Issue("launchTargetMissing", inst.Id, "launch", "problem", $"{g.Title}'s folder is gone",
                            $"{PlatformName(inst.Platform)} listed it at this folder, but the folder isn't there now. A rescan updates what's installed; if you moved the game, let {PlatformName(inst.Platform)} find it first.",
                            g, inst.Id, inst.Platform, path: dir,
                            fixes: [new("rescan", "Rescan", true), new("openVersions", "See versions", false)]));
                    }
                    else if (launch is { LaunchKind: "Executable" } && IsLocalRooted(launch.LaunchValue) && !probe.FileExists(launch.LaunchValue))
                    {
                        issues.Add(Issue("launchTargetMissing", inst.Id, "launch", "problem", $"{g.Title} can't find its program",
                            $"The file {PlatformName(inst.Platform)} said starts the game is missing. A rescan picks up the current one; repairing the game in {PlatformName(inst.Platform)} also helps.",
                            g, inst.Id, inst.Platform, path: launch.LaunchValue,
                            fixes: [new("rescan", "Rescan", true), new("openVersions", "See versions", false)]));
                    }
                }
                else if (inst.State == "missing" && DateTimeOffset.TryParse(inst.LastSeen, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var seen)
                         && input.Now - seen > StaleMissingAfter)
                {
                    var days = (int)(input.Now - seen).TotalDays;
                    var allGone = g.Installations.All(i => i.State != "installed");
                    issues.Add(Issue("staleMissing", inst.Id, "installs", "info", $"{g.Title} hasn't been seen in {days} days",
                        $"{PlatformName(inst.Platform)} stopped listing it {days} days ago. It's kept (with your playtime and notes) in case it comes back. Rescan to check, or hide it if it's gone for good.",
                        g, inst.Id, inst.Platform,
                        fixes: allGone
                            ? [new("rescan", "Rescan", true), new("hide", "Hide it", false)]
                            : [new("rescan", "Rescan", true), new("openVersions", "See versions", false)]));
                }
            }

            var installed = g.Installations.Where(i => i.State == "installed").ToList();
            if (installed.Select(i => i.Platform).Distinct().Count() > 1)
            {
                var platforms = installed.Select(i => i.Platform).Distinct().ToList();
                var size = installed.Where(i => i.SizeBytes is > 0).Sum(i => i.SizeBytes ?? 0);
                issues.Add(Issue("duplicateInstall", g.Id, "duplicates", "info", $"{g.Title} is installed {installed.Count} times",
                    $"It's installed from {JoinNames(platforms.Select(PlatformName))}{(size > 0 ? $", using {FormatBytes(size)} in total" : "")}. Pick the one you play; the other can be uninstalled from its store to free space.",
                    g, platforms: platforms, fixes: [new("openVersions", "Choose a version", false)]));
            }
        }

        foreach (var (drive, bucket) in offline.OrderBy(o => o.Key, StringComparer.OrdinalIgnoreCase))
        {
            var n = bucket.Games.Count;
            var first = byId[bucket.Games[0]];
            issues.Add(new HealthIssueDto($"missingDrive:{Sanitize(drive)}", "missingDrive", "drives", "warning",
                $"Drive {drive} isn't connected",
                $"{Count(n, "game")} {(n == 1 ? "is" : "are")} installed there{(n == 1 ? $" ({first.Title})" : "")}. Nothing was removed — they'll be back as soon as you reconnect the drive. Rescan afterwards.",
                n == 1 ? first.Id : null, bucket.Games, null, bucket.Platforms.Count == 1 ? bucket.Platforms.First() : null, bucket.Platforms.Order().ToList(),
                null, drive, null, null, null, [new("rescan", "Rescan", true)]));
        }

        // Steam itself keeps one copy per library folder; the same app in two folders wastes space and confuses updates.
        var steamGames = new Dictionary<string, GameDto>(StringComparer.Ordinal);
        foreach (var g in input.Games)
            foreach (var i in g.Installations.Where(i => i.Platform == "steam"))
                steamGames.TryAdd(i.PlatformGameId, g);
        foreach (var dup in input.SteamDuplicates)
        {
            steamGames.TryGetValue(dup.AppId, out var g);
            if (g is { Hidden: true }) continue;
            var name = g?.Title ?? $"Steam app {dup.AppId}";
            issues.Add(new HealthIssueDto($"steamLibraryDuplicate:{dup.AppId}", "steamLibraryDuplicate", "duplicates", "warning",
                $"{name} is in {dup.Libraries.Count} Steam libraries",
                $"Steam has a copy in each of these folders: {string.Join("; ", dup.Libraries)}. Steam uses only one, so the other is wasted space. Remove the extra copy in Steam's Storage settings.",
                g?.Id, g is null ? [] : [g.Id], null, "steam", ["steam"], null, null, null, null, null,
                g is null ? [] : [new("openGame", "Open game page", false)]));
        }

        foreach (var s in input.Suggestions)
        {
            if (!byId.TryGetValue(s.GameIdA, out var a) || !byId.TryGetValue(s.GameIdB, out var b) || a.Hidden || b.Hidden) continue;
            var platforms = a.Installations.Concat(b.Installations).Select(i => i.Platform).Distinct().ToList();
            issues.Add(new HealthIssueDto($"duplicateSuggestion:{a.Id}-{b.Id}", "duplicateSuggestion", "duplicates", "info",
                $"“{a.Title}” and “{b.Title}” might be the same game",
                $"{s.Explanation} Merging only changes how they appear in VYSTRAL, and you can separate them again later.",
                a.Id, [a.Id, b.Id], null, null, platforms, null, null, null, null, b.Id,
                [new("merge", "Merge", false), new("keepSeparate", "Keep separate", false)]));
        }

        // Artwork: missing, placeholders, low resolution, files gone from the cache.
        var art = input.Art.GroupBy(a => a.GameId).ToDictionary(x => x.Key, x => x.ToDictionary(a => a.Kind, StringComparer.OrdinalIgnoreCase));
        foreach (var g in visible.Where(g => g.Installations.Count > 0))
        {
            input.SteamAppIds.TryGetValue(g.Id, out var appId);
            var steam = appId is not null;
            art.TryGetValue(g.Id, out var rows);
            var isInstalled = g.Installations.Any(i => i.State == "installed");
            foreach (var kind in (string[])["cover", "hero", "logo", "header"])
            {
                HealthArtRow? row = null;
                rows?.TryGetValue(kind, out row);
                var label = KindLabel(kind);
                List<HealthFixDto> Fixes(bool refetch) =>
                    refetch && steam && kind != "header"
                        ? [new("refetchArt", "Get it again", true), new("pickArt", $"Choose {Article(label)}…", false)]
                        : kind is "cover" or "hero" or "logo" ? [new("pickArt", $"Choose {Article(label)}…", false)] : [];
                if (row is null)
                {
                    // Covers matter everywhere; backgrounds only on installed games' pages.
                    if (kind == "cover")
                        issues.Add(Issue("artMissing", $"{g.Id}-cover", "art", "warning", $"{g.Title} has no cover",
                            steam ? "It shows a generated cover for now. VYSTRAL can get Steam's own cover, or you can choose one." : "It shows a generated cover for now. Choose an image, or pick one from SteamGridDB if you've added a key.",
                            g, artKind: kind, fixes: Fixes(true)));
                    else if (kind == "hero" && isInstalled)
                        issues.Add(Issue("artMissing", $"{g.Id}-hero", "art", "info", $"{g.Title} has no background",
                            "Its page and Immersive Mode use a blurred cover instead.", g, artKind: kind, fixes: Fixes(true)));
                    continue;
                }
                var file = probe.ArtFile(row.File);
                if (file is null)
                {
                    issues.Add(Issue("artFileMissing", $"{g.Id}-{kind}", "art", "warning", $"{g.Title}'s {label} file is missing",
                        row.IsUser ? $"The {label} you chose was removed from VYSTRAL's art cache. Choose it again." : $"The {label} was removed from VYSTRAL's art cache (for example by clearing the cache).",
                        g, artKind: kind, fixes: Fixes(!row.IsUser)));
                    continue;
                }
                if (kind is "cover" or "hero" && file.Length < PlaceholderBytes && !row.IsUser)
                {
                    issues.Add(Issue("artPlaceholder", $"{g.Id}-{kind}", "art", "warning", $"{g.Title}'s {label} is a placeholder",
                        $"The image is a blank stand-in ({FormatBytes(file.Length)}), not real art.", g, artKind: kind, fixes: Fixes(true)));
                    continue;
                }
                if (file.Width is { } w && file.Height is { } h &&
                    ((kind == "cover" && (w < MinCoverWidth || h < MinCoverHeight)) || (kind == "hero" && w < MinHeroWidth)))
                {
                    issues.Add(Issue("artLowRes", $"{g.Id}-{kind}", "art", "info", $"{g.Title}'s {label} is low resolution",
                        $"It's {w}×{h}, so it looks soft on large cards and screens." + (row.IsUser ? " You chose this one, so VYSTRAL won't replace it on its own." : ""),
                        g, artKind: kind, fixes: Fixes(!row.IsUser)));
                }
            }

            // Missing details: only once a lookup was tried (newer games are still waiting for theirs).
            if (string.IsNullOrWhiteSpace(g.Description) && string.IsNullOrWhiteSpace(g.Developer) && g.Genres.Count == 0 && input.MetadataAttempted.Contains(g.Id))
            {
                issues.Add(Issue("metadataMissing", g.Id, "metadata", "info", $"{g.Title} has no details",
                    input.FetchMetadata
                        ? steam ? "No description, developer or genres were found last time. Looking again often helps after a store page changes." : "Without a Steam app, details are matched only on an exact, unique title. Looking again can help if the title changed."
                        : "Online game details are turned off in Settings › Library & stores.",
                    g, fixes: input.FetchMetadata ? [new("lookupMetadata", "Look again", true), new("openGame", "Open game page", false)] : [new("openSettings", "Open settings", false)]));
            }
        }

        foreach (var s in input.OpenSessions.Where(s => !input.ActiveSessionIds.Contains(s.Id)))
        {
            byId.TryGetValue(s.GameId, out var g);
            if (g is { Hidden: true }) continue;
            issues.Add(new HealthIssueDto($"openSession:{s.Id}", "openSession", "sessions", "warning",
                $"A {(g?.Title is { } t ? t + " " : "")}session never ended",
                $"It started {FormatDate(s.Start)} and has no end time, so it isn't counted in your playtime. Closing it uses the last moment VYSTRAL saw the game running.",
                g?.Id, g is null ? [] : [g.Id], null, null, [], null, null, s.Id, null, null,
                [new("closeSession", "Close it", false)]));
        }
        foreach (var s in input.LongSessions.Take(50))
        {
            byId.TryGetValue(s.GameId, out var g);
            if (g is null || g.Hidden) continue;
            issues.Add(new HealthIssueDto($"longSession:{s.Id}", "longSession", "sessions", "info",
                $"{g.Title}: a {FormatHours(s.DurationSeconds)} session",
                $"Recorded {FormatDate(s.Start)}. If the game was left open (or the PC slept), this one session inflates your playtime.",
                g.Id, [g.Id], null, null, [], null, null, s.Id, null, null, [new("openSession", "Review session", false)]));
        }

        foreach (var p in input.DisabledPlatforms)
        {
            var games = visible.Where(g => g.Installations.Any(i => i.Platform == p && i.State == "installed")).Select(g => g.Id).ToList();
            if (games.Count == 0) continue;
            issues.Add(new HealthIssueDto($"platformOff:{Sanitize(p)}", "platformOff", "installs", "info",
                $"{PlatformName(p)} scanning is off",
                $"{Count(games.Count, "game")} from {PlatformName(p)} won't notice installs, updates or uninstalls until it's back on.",
                null, games, null, p, [p], null, null, null, null, null, [new("enableStore", "Turn it on", false)]));
        }

        var dismissed = issues.Count(i => input.Dismissed.Contains(i.Id));
        var shown = issues.Where(i => !input.Dismissed.Contains(i.Id))
            .OrderBy(i => SeverityRank(i.Severity)).ThenBy(i => GroupRank(i.Group)).ThenBy(i => i.Title, StringComparer.CurrentCultureIgnoreCase)
            .ToList();
        return (shown, dismissed);
    }

    /// <summary>
    /// 100 with nothing to fix; each issue costs by severity (problem 6, warning 2.5, info 0.75; multi-game issues a
    /// little more), scaled by library size so ten notes in a 2,000-game library weigh less than in a 20-game one.
    /// </summary>
    public static int Score(IReadOnlyList<HealthIssueDto> issues, int gameCount)
    {
        if (issues.Count == 0) return 100;
        var weight = issues.Sum(i => SeverityWeight(i.Severity) * (1 + 0.25 * Math.Min(Math.Max(i.GameIds.Count - 1, 0), 8)));
        var scale = Math.Max(12, gameCount * 0.4);
        return (int)Math.Clamp(Math.Round(100 * scale / (scale + weight)), 1, 99);
    }

    public static double SeverityWeight(string severity) => severity switch { "problem" => 6, "warning" => 2.5, _ => 0.75 };

    private static int SeverityRank(string s) => s switch { "problem" => 0, "warning" => 1, _ => 2 };

    private static readonly string[] Groups = ["launch", "drives", "sessions", "duplicates", "installs", "art", "metadata"];
    private static int GroupRank(string g) => Array.IndexOf(Groups, g) is var i and >= 0 ? i : Groups.Length;

    private static HealthIssueDto Issue(string kind, string subject, string group, string severity, string title, string detail, GameDto game,
        string? installationId = null, string? platform = null, string? path = null, string? artKind = null,
        IReadOnlyList<string>? platforms = null, IReadOnlyList<HealthFixDto>? fixes = null) =>
        new($"{kind}:{subject}", kind, group, severity, title, detail, game.Id, [game.Id], installationId, platform,
            platforms ?? (platform is not null ? [platform] : game.Installations.Select(i => i.Platform).Distinct().ToList()),
            path, null, null, artKind, null, fixes ?? []);

    /// <summary>"E:" for drive-letter paths, the share for UNC paths, else the path root.</summary>
    public static string DriveKey(string path)
    {
        if (path.Length >= 2 && path[1] == ':' && char.IsAsciiLetter(path[0])) return char.ToUpperInvariant(path[0]) + ":";
        try { return System.IO.Path.GetPathRoot(path) is { Length: > 0 } r ? r.TrimEnd('\\', '/') : path; }
        catch (ArgumentException) { return path; }
    }

    private static bool IsLocalRooted(string path)
    {
        try { return path.Length >= 3 && System.IO.Path.IsPathFullyQualified(path); }
        catch (ArgumentException) { return false; }
    }

    private static string Sanitize(string s) => new(s.Where(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.').Take(60).ToArray());

    private static string KindLabel(string kind) => kind switch { "hero" => "background", _ => kind };
    private static string Article(string label) => label is "cover" or "background" or "logo" or "header" ? $"a {label}" : label;
    private static string Count(int n, string noun) => $"{n.ToString("N0", CultureInfo.CurrentCulture)} {noun}{(n == 1 ? "" : "s")}";

    private static string JoinNames(IEnumerable<string> names)
    {
        var list = names.ToList();
        return list.Count <= 1 ? string.Concat(list) : $"{string.Join(", ", list.Take(list.Count - 1))} and {list[^1]}";
    }

    public static string FormatBytes(long bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        double v = bytes;
        var u = 0;
        while (v >= 1024 && u < units.Length - 1) { v /= 1024; u++; }
        return $"{v.ToString(u == 0 || v >= 100 ? "0" : "0.#", CultureInfo.CurrentCulture)} {units[u]}";
    }

    private static string FormatHours(int seconds) => seconds >= 3600 * 48
        ? $"{seconds / 86400}-day"
        : $"{seconds / 3600}-hour";

    private static string FormatDate(string iso) =>
        DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d)
            ? d.ToLocalTime().ToString("d MMM yyyy, HH:mm", CultureInfo.CurrentCulture)
            : "at an unknown time";
}
