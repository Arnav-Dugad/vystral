using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track W parameter records.
public sealed record WishlistAppParams(string AppId);
public sealed record AchievementNameParams(string GameId, string ApiName);
public sealed record AchievementGoalParams(string GameId, string? ApiName);
public sealed record NewsPostParams(string GameId, string Gid, bool? Force);

/// <summary>
/// Track W: Steam data extras. The wishlist (opt-in), friends' recent games on game pages (opt-in), the
/// achievement guide with a pinned goal, and official news/patch notes. Every call goes through the shared,
/// rate-limited Steam Web API client; the page never sends a URL (store and post links are built natively).
/// </summary>
public sealed partial class AppBackend
{
    private WishlistService _wishlist = null!;
    private FriendsHistoryService _friendsHistory = null!;
    private AchievementGuideService _achievementGuide = null!;
    private SteamNewsService _news = null!;

    private void RegisterTrackWHandlers()
    {
        var cache = Path.Combine(Paths.Root, "cache");
        _wishlist = new WishlistService(_steamKeys, _steamApi, Settings, Artwork, _dataSources, () => _steamAccount.SelectedSteamId(), Repository.SteamAppToGame,
            _events, Path.Combine(cache, "wishlist.json")) { IsGameActive = () => IsGameActive };
        _friendsHistory = new FriendsHistoryService(_steamKeys, _steamApi, Settings, Artwork, () => _steamAccount.SelectedSteamId(), _events,
            Path.Combine(cache, "friends-recent.json")) { IsGameActive = () => IsGameActive };
        _achievementGuide = new AchievementGuideService(Repository, Artwork, Path.Combine(Paths.Root, "ui-state", "achievement-goals.json"));
        _news = new SteamNewsService(_steamApi, Settings, Artwork, Path.Combine(cache, "news")) { IsGameActive = () => IsGameActive };

        Settings.Changed += key =>
        {
            if (key is "*" or WishlistService.SettingKey)
            {
                if (!Settings.GetBool(WishlistService.SettingKey)) _wishlist.Forget();
                else if (key != "*" && !SafeMode) _wishlist.StartRefresh(manual: true, _life.Token);
            }
            if ((key is "*" or FriendsHistoryService.SettingKey) && !Settings.GetBool(FriendsHistoryService.SettingKey)) _friendsHistory.Forget();
        };

        // ---------- Wishlist ----------
        Dispatcher.Register("wishlist.get", _ =>
        {
            if (!_steamKeys.IsConfigured) _wishlist.Forget(); // the key was removed: its wishlist goes too
            return Task.FromResult<object?>(_wishlist.Get());
        });
        Dispatcher.Register("wishlist.refresh", _ =>
        {
            if (SafeMode) throw new BridgeException("unavailable", "VYSTRAL is in safe mode, so it doesn’t contact Steam.");
            var (started, reason) = _wishlist.StartRefresh(manual: true, _life.Token);
            return Task.FromResult<object?>(new { started, reason, wishlist = _wishlist.Get() });
        });
        Dispatcher.Register<WishlistAppParams>("wishlist.openStore", (p, _) =>
        {
            var url = _wishlist.StoreUrl(RequireText(p.AppId, 10, "App")) ?? throw new BridgeException("notFound", "That game isn’t on your wishlist anymore.");
            _shell.OpenUri(url);
            return Task.FromResult<object?>(true);
        });

        // ---------- Friends' recent games ----------
        Dispatcher.Register<GameIdParams>("friends.gameHistory", (p, _) =>
        {
            var gameId = RequireId(p.GameId);
            if (SafeMode) return Task.FromResult<object?>(new FriendsHistoryDto("unavailable", "VYSTRAL is in safe mode, so it doesn’t contact Steam.", null, false, [], 0, 0, 0, 0));
            if (!_steamKeys.IsConfigured) _friendsHistory.Forget();
            return Task.FromResult<object?>(_friendsHistory.ForApp(SteamAppIdOf(gameId), _life.Token));
        });

        // ---------- Achievement guide ----------
        Dispatcher.Register<GameIdParams>("achievements.guide", async (p, ct) =>
        {
            var gameId = RequireId(p.GameId);
            var data = await _steamAccount.GetAchievementsAsync(gameId, ct);
            return _achievementGuide.Build(gameId, data);
        });
        Dispatcher.Register<GameIdParams>("achievements.goal", (p, _) => Task.FromResult<object?>(_achievementGuide.Goal(RequireId(p.GameId))));
        Dispatcher.Register<AchievementNameParams>("achievements.reveal", (p, _) =>
            Task.FromResult<object?>(new { description = _achievementGuide.Reveal(RequireId(p.GameId), RequireApiName(p.ApiName)) }));
        Dispatcher.Register<AchievementGoalParams>("achievements.setGoal", (p, _) =>
        {
            var gameId = RequireId(p.GameId);
            var apiName = p.ApiName is null ? null : RequireApiName(p.ApiName);
            if (!_achievementGuide.SetGoal(gameId, apiName, DateTimeOffset.UtcNow))
                throw new BridgeException("notFound", "That achievement isn’t in this game’s list anymore. Reopen the tab and try again.");
            var goal = _achievementGuide.Goal(gameId);
            _events.Emit("achievements.goalChanged", new { gameId, goal });
            return Task.FromResult<object?>(goal);
        });

        // ---------- News and patch notes ----------
        Dispatcher.Register<GameRefreshParams>("news.get", async (p, ct) =>
        {
            var gameId = RequireId(p.GameId);
            if (SafeMode) return new NewsDto("unavailable", "VYSTRAL is in safe mode, so it doesn’t contact Steam.", null, false, []);
            return await _news.GetAsync(SteamAppIdOf(gameId), p.Refresh ?? false, ct); // Track D4: own or matched Steam app
        });
        Dispatcher.Register<NewsPostParams>("news.images", async (p, ct) =>
        {
            var appId = SteamAppIdOf(RequireId(p.GameId)) ?? throw new BridgeException("notFound", "This game isn’t from Steam.");
            return await _news.LoadImagesAsync(appId, RequireGid(p.Gid), p.Force ?? false, ct);
        });
        Dispatcher.Register<NewsPostParams>("news.open", (p, _) =>
        {
            var appId = SteamAppIdOf(RequireId(p.GameId));
            var url = appId is null ? null : _news.PostUrl(appId, RequireGid(p.Gid));
            _shell.OpenUri(url ?? throw new BridgeException("notFound", "That post is no longer listed. Refresh the news."));
            return Task.FromResult<object?>(true);
        });

        // Automatic wishlist refresh: a few minutes after start, then the service's own 12-hour rule (checked every 30 minutes).
        if (!SafeMode)
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(TimeSpan.FromMinutes(3), _life.Token);
                    while (!_life.IsCancellationRequested)
                    {
                        _wishlist.StartRefresh(manual: false, _life.Token);
                        await Task.Delay(TimeSpan.FromMinutes(30), _life.Token);
                    }
                }
                catch (OperationCanceledException) { }
                catch (Exception ex) { Log.Warn("wishlist", "Automatic wishlist refresh stopped", ex: ex); }
            });
        }
    }

    private static string RequireApiName(string? apiName) =>
        apiName is not null && AchievementGuideService.ApiNamePattern().IsMatch(apiName) ? apiName : throw new BridgeException("invalid", "Invalid achievement.");

    private static string RequireGid(string? gid) =>
        gid is { Length: > 0 and <= 20 } && gid.All(char.IsAsciiDigit) ? gid : throw new BridgeException("invalid", "Invalid post.");
}
