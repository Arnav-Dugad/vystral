using Vystral.Windows.Bridge;
using Vystral.Windows.Discover;
using Vystral.Windows.GamePage;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

/// <summary>Track C4: a library game (<c>gameId</c>) or a Discover page (<c>key</c>, with the Steam app ID it showed, if any).</summary>
public sealed record GamePageParams(string? GameId, string? Key, string? AppId, bool? Refresh);
public sealed record FranchiseCoverParams(string IgdbId);

/// <summary>Achievement progress from what VYSTRAL already saved (no request is made for it).</summary>
public sealed record AchievementProgressDto(int Unlocked, int Total, string? FetchedAt, string? RarestName, double? RarestPercent);

/// <summary>
/// Track C4: visually helpful game pages. Steam's review snapshot (all time vs last 30 days), store facts with a local
/// price history, Steam community tags (game pages and Library filters), the franchise timeline from IGDB, and
/// achievement progress from the saved list. The page sends only ids and keys (validated); every URL is built natively.
/// </summary>
public sealed partial class AppBackend
{
    private StoreInsightsService _storeInsights = null!;
    private SteamTagsService _tags = null!;
    private FranchiseService _franchise = null!;

    private void RegisterGamePageHandlers()
    {
        var cache = Path.Combine(Paths.Root, "cache", "game-pages");
        _storeInsights = new StoreInsightsService(new SteamStoreInsightsClient(_dataSources.TransportFor("steamdeck")), Settings, () => _dataSources.Country, cache)
            { IsGameActive = () => IsGameActive };
        _tags = new SteamTagsService(_steamApi, Settings, Repository.SteamAppToGame, _events, cache) { IsGameActive = () => IsGameActive };
        _franchise = new FranchiseService(_dataSources, Repository, Artwork, Settings, cache) { IsGameActive = () => IsGameActive };

        Settings.Changed += key =>
        {
            if ((key is "*" or SteamTagsService.SettingKey) && !Settings.GetBool(SteamTagsService.SettingKey)) _tags.Forget();
            if (key is SteamTagsService.SettingKey or "library.fetchMetadata" or "privacy.localOnly") _events.Emit("tags.changed", new { done = 0 });
        };

        Dispatcher.Register<GamePageParams>("reviews.get", async (p, ct) =>
        {
            if (SafeMode) return new ReviewsDto("unavailable", "VYSTRAL is in safe mode, so it doesn’t contact Steam.", null, null, null, null, null, null, false);
            return await _storeInsights.GetReviewsAsync(PageAppId(p), p.Refresh ?? false, ct);
        });
        Dispatcher.Register<GamePageParams>("reviews.open", (p, _) =>
        {
            _shell.OpenUri(StoreInsightsService.ReviewsUrl(PageAppId(p)) ?? throw new BridgeException("notFound", "This game isn’t on Steam."));
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register<GamePageParams>("store.facts", async (p, ct) =>
        {
            if (SafeMode) return new StoreFactsDto("unavailable", "VYSTRAL is in safe mode, so it doesn’t contact Steam.", _dataSources.Country, null, false, null, null, 0, null, null, null, null, false, [], null, false);
            return await _storeInsights.GetFactsAsync(PageAppId(p), p.Refresh ?? false, ct);
        });
        Dispatcher.Register<GamePageParams>("tags.get", async (p, ct) =>
        {
            if (SafeMode) return new GameTagsDto("unavailable", "VYSTRAL is in safe mode, so it doesn’t contact Steam.", [], null, false);
            return await _tags.ForAppAsync(PageAppId(p), p.Refresh ?? false, ct);
        });
        Dispatcher.Register("tags.library", _ =>
        {
            if (!SafeMode) _tags.StartRefresh(_life.Token);
            return Task.FromResult<object?>(_tags.Library());
        });
        Dispatcher.Register<GamePageParams>("franchise.get", async (p, ct) =>
        {
            if (SafeMode) return new FranchiseDto("unavailable", "VYSTRAL is in safe mode, so it doesn’t contact IGDB.", null, null, [], 0, null, false);
            if (p.GameId is not null) return await _franchise.ForLibraryGameAsync(RequireId(p.GameId, "game"), p.Refresh ?? false, ct);
            var key = DiscoverKeys.IsKey(p.Key) ? p.Key! : throw new BridgeException("invalid", "Unknown game.");
            return await _franchise.ForDiscoverAsync(key, RequireOptionalAppId(p.AppId), p.Refresh ?? false, ct);
        });
        Dispatcher.Register<FranchiseCoverParams>("franchise.cover", async (p, ct) =>
        {
            var id = p.IgdbId is { Length: > 0 and <= 12 } s && s.All(char.IsAsciiDigit) ? s : throw new BridgeException("invalid", "Unknown game.");
            var (url, reason) = await _franchise.CoverAsync(id, ct);
            return new { url, reason };
        });
        Dispatcher.Register<GameIdParams>("gamePage.achievements", (p, _) =>
        {
            var game = Repository.GetGame(RequireId(p.GameId, "game"));
            if (game?.SteamAppId is not { } appId) return Task.FromResult<object?>(null);
            var rows = Repository.GetAchievements(appId);
            if (rows.Count == 0) return Task.FromResult<object?>(null);
            var rarest = rows.Where(r => r.Achieved && r.GlobalPercent is not null).OrderBy(r => r.GlobalPercent).FirstOrDefault();
            return Task.FromResult<object?>(new AchievementProgressDto(rows.Count(r => r.Achieved), rows.Count,
                Repository.GetAchievementFetch(appId)?.Fetched.ToString("O"), rarest?.DisplayName, rarest?.GlobalPercent));
        });
    }

    /// <summary>The Steam app ID a request is about: the library game's own, or the one a Discover page showed.</summary>
    private string? PageAppId(GamePageParams p)
    {
        if (p.GameId is not null) return Repository.GetGame(RequireId(p.GameId, "game"))?.SteamAppId;
        if (p.Key is not null && !DiscoverKeys.IsKey(p.Key)) throw new BridgeException("invalid", "Unknown game.");
        return RequireOptionalAppId(p.AppId) ?? (p.Key is not null ? DiscoverKeys.IdsFromKey(p.Key).Steam : null);
    }

    private static string? RequireOptionalAppId(string? appId) =>
        appId is null ? null : GamePageIds.IsAppId(appId) ? appId : throw new BridgeException("invalid", "Invalid app.");
}
