using Vystral.Windows.Bridge;
using Vystral.Windows.Cloud;
using Vystral.Windows.Discover;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track D5 parameter records.
public sealed record RecommendDismissParams(string Key, string Title, string[]? Features);
public sealed record RecommendKeyParams(string Key);
public sealed record CloudReadinessParams(bool? Run);
public sealed record DiscoverCloudMapParams(string[] Keys);

/// <summary>
/// Track D5: recommend.v2's "Not interested" memory (the engine itself is pure TypeScript in ui/src/lib/recommendV2.ts),
/// the opt-in cloud readiness check, and cloud availability for Discover cards. "Free this week" (freebies.get /
/// freebies.open) is Track D4's GamerPower client; the UI treats a build without it as "nothing to show".
/// </summary>
public sealed partial class AppBackend
{
    private RecommendStore? _recommend;
    private CloudReadinessService? _readiness;

    private void RegisterRecommendHandlers()
    {
        _recommend = new RecommendStore(Paths.Root);
        _readiness = new CloudReadinessService(_healthIo!);

        Dispatcher.Register("recommend.dismissed", _ => Task.FromResult<object?>(_recommend.List()));
        Dispatcher.Register<RecommendDismissParams>("recommend.dismiss", (p, _) =>
        {
            if (!RecommendStore.IsKey(p.Key)) throw new BridgeException("invalid", "Unknown item.");
            var title = RequireText(p.Title, RecommendStore.MaxTitle, "Title");
            if (p.Features is { Length: > 32 }) throw new BridgeException("invalid", "Too many features.");
            var list = SaveRecommend(() => _recommend.Dismiss(p.Key, title, p.Features?.Where(f => f is not null && f.Length <= 50), DateTimeOffset.UtcNow));
            _events.Emit("recommend.dismissed", list);
            return Task.FromResult<object?>(list);
        });
        Dispatcher.Register<RecommendKeyParams>("recommend.undismiss", (p, _) =>
        {
            if (!RecommendStore.IsKey(p.Key)) throw new BridgeException("invalid", "Unknown item.");
            var list = SaveRecommend(() => _recommend.Undismiss(p.Key));
            _events.Emit("recommend.dismissed", list);
            return Task.FromResult<object?>(list);
        });
        Dispatcher.Register("recommend.clearDismissed", _ =>
        {
            SaveRecommend(() => { _recommend.Clear(); return []; });
            _events.Emit("recommend.dismissed", Array.Empty<RecommendDismissal>());
            return Task.FromResult<object?>(true);
        });

        // The readiness check runs only when asked (run: true) and never in Offline mode; otherwise the last result.
        Dispatcher.Register<CloudReadinessParams>("cloud.readiness", async (p, ct) =>
        {
            if (p.Run != true) return _readiness.Last;
            if (Settings.GetBool("privacy.localOnly"))
                throw new BridgeException("offline", "Offline mode is on, so VYSTRAL doesn’t contact any service. Turn it off in Settings → Privacy to check.");
            var services = new List<string>();
            if (Settings.GetBool("cloud.gfn")) services.Add("gfn");
            if (Settings.GetBool("cloud.xbox")) services.Add("xbox");
            var metered = _network?.Current.Metered ?? false;
            return await _readiness.RunAsync(services, metered, ct);
        });

        Dispatcher.Register<DiscoverCloudMapParams>("discover.cloudMap", (p, _) =>
        {
            if (p.Keys is null || p.Keys.Length > 120) throw new BridgeException("invalid", "Ask for at most 120 games.");
            var keys = p.Keys.Where(DiscoverKeys.IsKey).ToList();
            var (enabled, map) = Discover.CloudForMany(keys);
            return Task.FromResult<object?>(new { enabled, map });
        });
    }

    private static IReadOnlyList<RecommendDismissal> SaveRecommend(Func<IReadOnlyList<RecommendDismissal>> change)
    {
        try { return change(); }
        catch (ArgumentException ex) { throw new BridgeException("invalid", ex.Message); }
        catch (IOException) { throw new BridgeException("unavailable", "VYSTRAL couldn’t save your “Not interested” list. Check that the data folder isn’t read-only."); }
    }
}
