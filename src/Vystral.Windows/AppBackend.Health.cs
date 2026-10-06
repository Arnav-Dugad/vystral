using Vystral.Core.Controller;
using Vystral.Core.Domain;
using Vystral.Core.Health;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Launch;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track Q parameter records.
public sealed record HealthIssueParams(string IssueId);
public sealed record HealthFixParams(string IssueId, string Action);

/// <summary>Result of "Fix all safe issues".</summary>
public sealed record HealthFixAllDto(int Fixed, int Skipped, IReadOnlyList<string> Notes, HealthReportDto Report);

/// <summary>
/// Track Q: the library health check (one page listing what's wrong, each with a safe fix) and read-only per-game
/// Steam Input layouts. The check reads only local data. Fixes never delete user data: they rescan, download art
/// again (replacing it only when a download lands), look details up again, point a game you added at its program,
/// or close a session that never ended. Hiding and merging go through the existing game.* methods.
/// </summary>
public sealed partial class AppBackend
{
    private LibraryHealthService? _libraryHealth;
    private SteamInputLocator? _steamInput;
    private int _healthFixAllRunning;

    /// <summary>The fixes that run natively; the page runs the others (hide, merge, open a page, choose art).</summary>
    private static readonly string[] NativeFixes = ["rescan", "refetchArt", "lookupMetadata", "closeSession"];

    private LibraryHealthService LibHealth => _libraryHealth!;

    private void RegisterHealthHandlers()
    {
        _libraryHealth = new LibraryHealthService(Repository, Paths, Settings, _steam.FindSteamPath)
        {
            ActiveSessions = ActiveSessionIds,
            IsScanning = () => Library.IsScanning,
        };
        _steamInput = new SteamInputLocator(_steam.FindSteamPath);

        Dispatcher.Register("health.check", async _ => await Task.Run(LibHealth.Check));
        Dispatcher.Register<HealthIssueParams>("health.dismiss", async (p, _) =>
        {
            LibHealth.Dismissals.Dismiss(RequireIssueId(p.IssueId), DateTimeOffset.UtcNow);
            return await Task.Run(LibHealth.Check);
        });
        Dispatcher.Register<HealthIssueParams>("health.restore", async (p, _) =>
        {
            LibHealth.Dismissals.Restore(RequireIssueId(p.IssueId));
            return await Task.Run(LibHealth.Check);
        });
        Dispatcher.Register("health.restoreAll", async _ =>
        {
            LibHealth.Dismissals.RestoreAll();
            return await Task.Run(LibHealth.Check);
        });
        Dispatcher.Register<HealthFixParams>("health.fix", async (p, ct) =>
        {
            var id = RequireIssueId(p.IssueId);
            if (!NativeFixes.Contains(p.Action)) throw new BridgeException("invalid", "Unknown fix.");
            // The fix must be one the check offers for this issue right now; the page can't invent targets.
            var issue = (await Task.Run(LibHealth.Check, ct)).Issues.FirstOrDefault(i => i.Id == id)
                        ?? throw new BridgeException("notFound", "That issue is already gone.");
            if (!issue.Fixes.Any(f => f.Action == p.Action)) throw new BridgeException("invalid", "That fix doesn't apply here.");
            await RunHealthFixAsync(issue, p.Action, ct);
            return await Task.Run(LibHealth.Check, ct);
        });
        Dispatcher.Register("health.fixAll", async ct => await FixAllSafeAsync(ct));
        Dispatcher.Register<InstallationIdParams>("health.locateExecutable", async (p, _) =>
        {
            var installationId = RequireId(p.InstallationId, "installation");
            var inst = Repository.GetInstallation(installationId) ?? throw new BridgeException("notFound", "That game is no longer in your library.");
            if (inst.Platform != PlatformId.Manual) throw new BridgeException("invalid", "Only games you added yourself can be pointed at a program. Store games are found by rescanning.");
            var exe = await _shell.PickExecutableAsync();
            if (exe is null) return null; // cancelled: nothing changes
            ValidateExecutable(exe);
            if (!Repository.RelocateManualExecutable(installationId, Path.GetFullPath(exe))) throw new BridgeException("notFound", "That game is no longer in your library.");
            OnLibraryIdentityChanged(); // detection watches the new folder
            _events.Emit("library.changed", new { reason = "health" });
            return await Task.Run(LibHealth.Check);
        });

        Dispatcher.Register<GameIdParams>("controls.get", async (p, _) =>
        {
            var gameId = RequireId(p.GameId, "game");
            var game = Repository.GetGame(gameId) ?? throw new BridgeException("notFound", "That game is no longer in your library.");
            var appId = game.SteamAppId ?? Repository.GetSteamInstallation(gameId)?.AppId;
            return await Task.Run(() => _steamInput!.Get(appId));
        });
    }

    private static string RequireIssueId(string? id) =>
        id is not null && HealthDismissals.IdPattern().IsMatch(id) ? id : throw new BridgeException("invalid", "Invalid issue.");

    /// <summary>A program the user picked: an existing local .exe, not on a network share.</summary>
    internal static void ValidateExecutable(string exe)
    {
        if (exe.Length > 1024 || exe.StartsWith(@"\\", StringComparison.Ordinal) || !Path.IsPathFullyQualified(exe))
            throw new BridgeException("invalid", "Choose a program on this PC (network locations aren't supported).");
        if (!string.Equals(Path.GetExtension(exe), ".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(exe))
            throw new BridgeException("invalid", "Choose a program (.exe) file.");
    }

    private IReadOnlySet<string> ActiveSessionIds()
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        if (Sessions.Current is { SessionId: { } s } current && SessionService.IsActivePhase(current.Phase)) ids.Add(s);
        try
        {
            if (new Tracking.TrackerFiles(Paths.Root).ReadSession() is { } note) ids.Add(note.SessionId);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        return ids;
    }

    private async Task RunHealthFixAsync(HealthIssueDto issue, string action, CancellationToken ct)
    {
        switch (action)
        {
            case "rescan":
                if (await Library.ScanAsync(ct) is null) throw new BridgeException("busy", "A scan is already running. It'll finish in a moment.");
                break;
            case "refetchArt":
            {
                EnsureOnline("download art");
                if (DataSaverActive) throw new BridgeException("dataSaver", "Data saver is on, so art isn't downloaded. Turn it off in Settings › Privacy, or choose an image yourself.");
                if (IsGameActive) throw new BridgeException("busy", "Art downloads wait until you finish playing.");
                var landed = await RefetchArtAsync(issue, ct);
                if (landed == 0) throw new BridgeException("unavailable", "Steam didn't have better art for this one. You can choose an image instead.");
                _events.Emit("library.changed", new { reason = "artwork" });
                break;
            }
            case "lookupMetadata":
                if (!Settings.GetBool("library.fetchMetadata")) throw new BridgeException("off", "Online game details are turned off in Settings › Library & stores.");
                EnsureOnline("look up game details");
                Repository.ResetMetadataLookup(issue.GameIds);
                Library.StartEnrichment();
                break;
            case "closeSession":
                if (issue.SessionId is null || ActiveSessionIds().Contains(issue.SessionId)) throw new BridgeException("busy", "That session is being recorded right now.");
                if (!Repository.CloseOpenSession(issue.SessionId)) throw new BridgeException("notFound", "That session already ended.");
                _events.Emit("library.changed", new { reason = "session" });
                break;
        }
    }

    private async Task<int> RefetchArtAsync(HealthIssueDto issue, CancellationToken ct)
    {
        if (issue.GameId is null || issue.ArtKind is null || !Enum.TryParse<ArtworkKind>(issue.ArtKind, true, out var kind)) return 0;
        var game = Repository.GetGame(issue.GameId);
        var appId = game?.SteamAppId ?? Repository.GetSteamInstallation(issue.GameId)?.AppId;
        return appId is null ? 0 : await Artwork.RefetchSteamAsync(issue.GameId, appId, [kind], ct);
    }

    /// <summary>
    /// Runs every issue's safe (idempotent) fix: one rescan, art downloads, details lookups. Progress is reported
    /// with <c>health.progress</c> events. Network work is skipped in Offline mode, with Data saver, or while playing.
    /// </summary>
    private async Task<HealthFixAllDto> FixAllSafeAsync(CancellationToken ct)
    {
        if (Interlocked.Exchange(ref _healthFixAllRunning, 1) == 1) throw new BridgeException("busy", "Already fixing. Give it a moment.");
        try
        {
            var report = await Task.Run(LibHealth.Check, ct);
            var safe = report.Issues.Select(i => (Issue: i, Fix: i.Fixes.FirstOrDefault(f => f.Safe))).Where(x => x.Fix is not null).ToList();
            var notes = new List<string>();
            var networkBlocked = Settings.GetBool("privacy.localOnly") ? "Offline mode is on, so art and details weren't downloaded."
                : DataSaverActive ? "Data saver is on, so art and details weren't downloaded."
                : IsGameActive ? "A game is running, so downloads wait until you finish."
                : null;
            if (networkBlocked is not null) notes.Add(networkBlocked);

            var rescan = safe.Any(x => x.Fix!.Action == "rescan");
            var art = networkBlocked is null
                ? safe.Where(x => x.Fix!.Action == "refetchArt" && x.Issue.GameId is not null).GroupBy(x => x.Issue.GameId!).ToList()
                : [];
            var lookups = networkBlocked is null && Settings.GetBool("library.fetchMetadata")
                ? safe.Where(x => x.Fix!.Action == "lookupMetadata").SelectMany(x => x.Issue.GameIds).Distinct().ToList()
                : [];
            var lookupIssues = safe.Count(x => x.Fix!.Action == "lookupMetadata");
            var skipped = safe.Count(x => x.Fix!.Action == "refetchArt") - art.Sum(g => g.Count()) + (lookups.Count > 0 ? 0 : lookupIssues);
            var total = (rescan ? 1 : 0) + art.Count + (lookups.Count > 0 ? 1 : 0);
            var done = 0;
            var fixedCount = 0;
            void Progress(string label) => _events.Emit("health.progress", new { done, total, label });

            if (rescan)
            {
                Progress("Rescanning your stores…");
                if (await Library.ScanAsync(ct) is not null) fixedCount += safe.Count(x => x.Fix!.Action == "rescan");
                done++;
            }
            foreach (var group in art)
            {
                ct.ThrowIfCancellationRequested();
                Progress($"Getting art for {Repository.GetGame(group.Key)?.Title ?? "a game"}…");
                var game = Repository.GetGame(group.Key);
                var appId = game?.SteamAppId ?? Repository.GetSteamInstallation(group.Key)?.AppId;
                var kinds = group.Select(x => Enum.TryParse<ArtworkKind>(x.Issue.ArtKind, true, out var k) ? k : (ArtworkKind?)null).OfType<ArtworkKind>().ToList();
                if (appId is not null && await Artwork.RefetchSteamAsync(group.Key, appId, kinds, ct) > 0) fixedCount += group.Count();
                else skipped += group.Count();
                done++;
                if (done % 8 == 0) _events.Emit("library.changed", new { reason = "artwork" });
            }
            if (lookups.Count > 0)
            {
                Progress("Looking up game details…");
                Repository.ResetMetadataLookup(lookups);
                Library.StartEnrichment();
                fixedCount += lookupIssues;
                notes.Add("Details are being looked up in the background; they appear over the next few minutes.");
                done++;
            }
            if (art.Count > 0) _events.Emit("library.changed", new { reason = "artwork" });
            Progress("Done");
            var after = await Task.Run(LibHealth.Check, ct);
            Log.Info("health", "Fixed safe issues", new { fixedCount, skipped, before = report.Issues.Count, after = after.Issues.Count });
            return new HealthFixAllDto(fixedCount, Math.Max(0, skipped), notes, after);
        }
        finally
        {
            Interlocked.Exchange(ref _healthFixAllRunning, 0);
        }
    }
}
