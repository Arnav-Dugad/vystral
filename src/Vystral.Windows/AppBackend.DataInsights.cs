using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using Vystral.Core.Contracts;
using Vystral.Core.Data;
using Vystral.Core.Insights;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Launch;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track F parameter records.
public sealed record AchievementFeedParams(int? Offset, int? Limit);
public sealed record OptionalGameIdParams(string? GameId);
public sealed record BackgroundAppHideParams(string Name, bool Hidden);

/// <summary>
/// Track F (data &amp; insight): the merged achievement feed and near-completion shelf, achievement
/// unlocks after a session, GPU driver before/after comparisons, and the background-app report.
/// Everything is read from the local database; only the post-session achievement check talks to Steam.
/// </summary>
public sealed partial class AppBackend
{
    private const int FeedPageMax = 100;
    private SessionAchievementWatcher _achievementWatcher = null!;
    private readonly ConcurrentDictionary<string, byte> _feedIconsWarmed = new(StringComparer.Ordinal);

    private void RegisterDataInsightHandlers()
    {
        var registry = new WindowsRegistryReader();
        Sessions.GpuIdentity = sampler => GpuDriverProbe.Read(sampler, registry);
        Sessions.BackgroundApps = () => Settings.GetBool("performance.backgroundApps")
            ? new BackgroundAppTracker(new NtProcessSnapshotSource(), BackgroundAppTracker.ReadMemoryLoad, Environment.ProcessId, Environment.ProcessorCount)
            : null;

        _achievementWatcher = new SessionAchievementWatcher(Repository, _steamAccount.CanRefreshAchievements, _steamAccount.RefreshAppNowAsync,
            _steamAccount.WarmUnlockedIconsAsync, IconUrl, _events);
        Sessions.StateChanged += OnSessionEndedCheckAchievements;

        // ---- achievements ----
        Dispatcher.Register<AchievementFeedParams>("achievements.feed", (p, _) =>
        {
            var offset = p.Offset ?? 0;
            var limit = p.Limit ?? 40;
            if (offset is < 0 or > 1_000_000) throw new BridgeException("invalid", "Invalid offset.");
            if (limit is < 1 or > FeedPageMax) throw new BridgeException("invalid", $"Limit must be between 1 and {FeedPageMax}.");
            return Task.FromResult<object?>(AchievementFeed(offset, limit));
        });
        Dispatcher.Register("achievements.overview", _ => Task.FromResult<object?>(AchievementOverview()));

        // ---- GPU driver comparison ----
        Dispatcher.Register<OptionalGameIdParams>("insights.driverComparison", (p, _) =>
        {
            var gameId = p.GameId is null ? null : RequireId(p.GameId, "game");
            return Task.FromResult<object?>(DriverComparison.Build(Repository.GetDriverSessions(gameId)));
        });

        // ---- background apps ----
        Dispatcher.Register("insights.backgroundApps", _ => Task.FromResult<object?>(BackgroundReport()));
        Dispatcher.Register<BackgroundAppHideParams>("insights.hideBackgroundApp", (p, _) =>
        {
            var name = RequireText(p.Name, 128, "App name").Trim();
            if (!ExeName().IsMatch(name)) throw new BridgeException("invalid", "That isn't an app name.");
            Repository.SetBackgroundAppHidden(name, p.Hidden);
            return Task.FromResult<object?>(BackgroundReport());
        });
    }

    private BackgroundImpactDto BackgroundReport()
    {
        var (sessions, apps) = Repository.GetImpactData();
        return BackgroundImpact.Analyze(sessions, apps, Repository.GetHiddenBackgroundApps(),
            Settings.GetBool("performance.collectMetrics") && Settings.GetBool("performance.backgroundApps"));
    }

    private string? IconUrl(string? relativeFile) =>
        relativeFile is not null && Artwork.CachedFileExists(relativeFile) ? ArtworkService.Url("", relativeFile) : null;

    private string AchievementStatus(int unlockedOrRows)
    {
        if (unlockedOrRows > 0) return "ok";
        var status = _steamAccount.Status();
        if (status.LocalOnly) return "localOnly";
        return status.Configured ? "empty" : "notConnected";
    }

    private AchievementFeedDto AchievementFeed(int offset, int limit)
    {
        var total = Repository.CountUnlockedAchievements();
        IReadOnlyList<AchievementFeedRow> rows = total == 0 ? [] : Repository.GetAchievementFeed(offset, limit);
        var items = rows.Select(r => new AchievementFeedItemDto(r.AppId, r.GameId, r.GameTitle, r.ApiName, r.DisplayName, r.Description,
            r.UnlockTime, r.GlobalPercent, IconUrl(r.IconFile ?? r.IconGrayFile))).ToList();
        WarmFeedIcons(rows.Where(r => r.GameId is not null && IconUrl(r.IconFile ?? r.IconGrayFile) is null).Select(r => (r.AppId, r.GameId!)));
        return new AchievementFeedDto(AchievementStatus(total), items, offset, total, offset + items.Count < total);
    }

    private AchievementOverviewDto AchievementOverview()
    {
        var totals = Repository.GetAchievementTotals();
        var status = AchievementStatus(totals.Games);
        string? message = status == "ok" && Settings.GetBool("privacy.localOnly")
            ? "Offline mode is on, so these are the achievements saved on this PC."
            : null;
        IReadOnlyList<NearCompletionDto> near = totals.Games == 0 ? [] : AchievementInsights.NearCompletion(Repository.GetAchievementProgress());
        return new AchievementOverviewDto(status, message, totals.Unlocked, totals.Games, totals.Rare, totals.UltraRare, totals.LastFetched, near);
    }

    /// <summary>
    /// The feed only shows icons that are already cached. For a page with missing icons, cache them for up
    /// to four games in the background (once per game per run), then tell the UI to refresh.
    /// </summary>
    private void WarmFeedIcons(IEnumerable<(string AppId, string GameId)> missing)
    {
        if (Settings.GetBool("privacy.localOnly") || IsGameActive) return;
        var todo = missing.DistinctBy(m => m.AppId).Where(m => _feedIconsWarmed.TryAdd(m.AppId, 0)).Take(4).ToList();
        if (todo.Count == 0) return;
        _ = Task.Run(async () =>
        {
            try
            {
                foreach (var (appId, gameId) in todo)
                    await _steamAccount.WarmUnlockedIconsAsync(gameId, appId, null, _life.Token);
                _events.Emit("achievements.iconsReady", new { appIds = todo.Select(t => t.AppId).ToList() });
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Warn("achievements", "Feed icon caching failed", ex: ex); }
        });
    }

    private void OnSessionEndedCheckAchievements(LaunchStateDto s)
    {
        if (s.Phase != "ended" || s.SessionId is not { } sessionId || s.StartedAt is null || !DateTimeOffset.TryParse(s.StartedAt, out var start)) return;
        _ = Task.Run(async () =>
        {
            try { await _achievementWatcher.CheckAsync(sessionId, s.GameId, start, _life.Token); }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Warn("achievements", "Post-session achievement check failed", ex: ex); }
        });
    }

    [GeneratedRegex("""^[^\\/:*?"<>|]{1,128}\z""")]
    private static partial Regex ExeName();
}
