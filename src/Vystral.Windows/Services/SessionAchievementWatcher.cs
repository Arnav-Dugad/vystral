using System.Collections.Concurrent;
using Vystral.Core.Contracts;
using Vystral.Core.Data;
using Vystral.Core.Insights;
using Vystral.Windows.Bridge;

namespace Vystral.Windows.Services;

/// <summary>
/// After a Steam game's session ends, asks Steam (once, then once more ~60 s later because Steam can lag)
/// which achievements are unlocked, and reports only those unlocked during the session as
/// 'achievements.unlocked'. Nothing happens offline, with data saver on, without a Web API key, or once
/// another game is running.
/// </summary>
public sealed class SessionAchievementWatcher(
    LibraryRepository repo,
    Func<bool> canRefresh,
    Func<string, CancellationToken, Task<bool>> refreshApp,
    Func<string, string, IReadOnlySet<string>, CancellationToken, Task> warmIcons,
    Func<string?, string?> iconUrl,
    IEventSink events)
{
    public const string EventName = "achievements.unlocked";
    public static readonly TimeSpan FirstDelay = TimeSpan.FromSeconds(5);
    public static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(60);

    private readonly ConcurrentDictionary<string, byte> _seen = new(StringComparer.Ordinal);

    /// <summary>Waits between attempts; replaced in tests.</summary>
    public Func<TimeSpan, CancellationToken, Task> Delay { get; init; } = Task.Delay;

    /// <summary>Checks one finished session. Returns the event that was emitted, or null.</summary>
    public async Task<AchievementUnlockEventDto?> CheckAsync(string sessionId, string gameId, DateTimeOffset sessionStart, CancellationToken ct)
    {
        if (!_seen.TryAdd(sessionId, 0)) return null;
        if (_seen.Count > 200) _seen.Clear();
        var inst = repo.GetSteamInstallation(gameId);
        if (inst is null || !canRefresh()) return null;

        var before = repo.GetAchievements(inst.AppId).Where(a => a.Achieved).Select(a => a.ApiName).ToHashSet(StringComparer.Ordinal);
        for (var attempt = 0; attempt < 2; attempt++)
        {
            await Delay(attempt == 0 ? FirstDelay : RetryDelay, ct);
            if (!canRefresh()) return null;
            if (!await refreshApp(inst.AppId, ct)) continue;
            var fresh = AchievementInsights.NewlyUnlocked(before, repo.GetAchievements(inst.AppId), sessionStart);
            if (fresh.Count == 0) continue;

            var names = fresh.Select(f => f.ApiName).ToHashSet(StringComparer.Ordinal);
            try { await warmIcons(gameId, inst.AppId, names, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { Log.Warn("achievements", "Icon caching failed", ex: ex); }

            // Re-read so freshly cached icon files are included.
            var rows = repo.GetAchievements(inst.AppId).Where(r => names.Contains(r.ApiName))
                .OrderBy(r => r.GlobalPercent ?? double.MaxValue).ThenBy(r => r.SortOrder).ToList();
            var title = repo.GetGame(gameId)?.Title ?? "your game";
            var items = rows.Select(r => new AchievementFeedItemDto(inst.AppId, gameId, title, r.ApiName, r.DisplayName, r.Description,
                r.UnlockTime?.ToString("O") ?? DateTimeOffset.UtcNow.ToString("O"), r.GlobalPercent, iconUrl(r.IconFile ?? r.IconGrayFile))).ToList();
            var (threshold, count) = AchievementInsights.RareSummary(rows.Select(r => r.GlobalPercent));
            var payload = new AchievementUnlockEventDto(sessionId, gameId, title, inst.AppId, items, threshold, count);
            Log.Info("achievements", "Unlocked during session", new { count = items.Count, attempt });
            events.Emit(EventName, payload);
            return payload;
        }
        return null;
    }
}
