using System.Globalization;
using Vystral.Core.Domain;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track I parameter records.
public sealed record DataSourceIdParams(string Provider);
public sealed record DataSourceConnectParams(string Provider, string Key, string? Secret);
public sealed record DataSourceLinkParams(string Provider, string Link);
public sealed record ArtOptionsParams(string GameId, string Kind, IReadOnlyList<string>? Styles, bool? Animated, int? Page, string? SgdbGameId);
public sealed record ArtOptionParams(string GameId, string Kind, string OptionId, bool? Force);
public sealed record GameRefreshParams(string GameId, bool? Refresh);
public sealed record OfferParams(string GameId, string OfferId);
public sealed record GameNameParams(string GameId, string Name);

/// <summary>
/// Track I: data sources. SteamGridDB art picker, IGDB/RAWG enrichment, CheapShark/IsThereAnyDeal
/// prices, Wikidata cross-store identity, Steam Deck and anti-cheat badges, and the library value
/// timeline. The page never sends a URL: every link is built or looked up natively.
/// </summary>
public sealed partial class AppBackend
{
    private DataSourcesService _dataSources = null!;
    public DataSourcesService DataSources => _dataSources;

    private static readonly Dictionary<(string Provider, string Link), string> DataSourceLinks = new()
    {
        [("steamgriddb", "home")] = "https://www.steamgriddb.com/",
        [("steamgriddb", "keys")] = "https://www.steamgriddb.com/profile/preferences/api",
        [("steamgriddb", "terms")] = "https://www.steamgriddb.com/terms",
        [("igdb", "home")] = "https://www.igdb.com/",
        [("igdb", "keys")] = "https://dev.twitch.tv/console/apps/create",
        [("igdb", "docs")] = "https://api-docs.igdb.com/#account-creation",
        [("igdb", "terms")] = "https://www.twitch.tv/p/legal/developer-agreement/",
        [("rawg", "home")] = "https://rawg.io/",
        [("rawg", "keys")] = "https://rawg.io/apidocs",
        [("rawg", "terms")] = "https://rawg.io/tos_api",
        [("itad", "home")] = "https://isthereanydeal.com/",
        [("itad", "keys")] = "https://isthereanydeal.com/apps/my/",
        [("itad", "docs")] = "https://docs.isthereanydeal.com/",
        [("cheapshark", "home")] = "https://www.cheapshark.com/",
        [("cheapshark", "docs")] = "https://apidocs.cheapshark.com/",
        [("wikidata", "home")] = "https://www.wikidata.org/",
        [("wikidata", "terms")] = "https://creativecommons.org/publicdomain/zero/1.0/",
        [("steamdeck", "home")] = "https://www.steamdeck.com/verified",
        [("awacy", "home")] = "https://areweanticheatyet.com/",
        [("awacy", "terms")] = "https://github.com/AreWeAntiCheatYet/AreWeAntiCheatYet/blob/HEAD/LICENSE",
    };

    private void RegisterDataSourceHandlers()
    {
        var secrets = new PerTargetCredentialStore(target =>
        {
            var provider = Enum.GetValues<KeyedProvider>().FirstOrDefault(p => DataSourceKeyStore.Target(p) == target);
            return new WindowsCredentialStore(DataSourceKeyStore.Comment(provider));
        });
        _dataSources = new DataSourcesService(Repository, Settings, Artwork, secrets, _http) { IsGameActive = () => IsGameActive };

        Dispatcher.Register("dataSources.status", _ => Task.FromResult<object?>(_dataSources.Status()));
        Dispatcher.Register<DataSourceConnectParams>("dataSources.connect", async (p, ct) =>
        {
            var provider = RequireProvider(p.Provider);
            var key = RequireText(p.Key, 120, "Key");
            var secret = p.Secret is null ? null : RequireText(p.Secret, 120, "Secret");
            var r = await _dataSources.ConnectAsync(provider, key, secret, ct);
            _events.Emit("dataSources.changed", r.Status);
            if (r.Result.Outcome == "ok" && provider is "igdb" or "rawg") StartDataSourceWork(TimeSpan.FromSeconds(3));
            return r;
        });
        Dispatcher.Register<DataSourceIdParams>("dataSources.test", async (p, ct) => await Run(() => _dataSources.TestAsync(RequireProvider(p.Provider), ct)));
        Dispatcher.Register<DataSourceIdParams>("dataSources.disconnect", (p, _) =>
        {
            var status = Wrap(() => _dataSources.Disconnect(RequireProvider(p.Provider)));
            _events.Emit("dataSources.changed", status);
            return Task.FromResult<object?>(status);
        });
        Dispatcher.Register<DataSourceLinkParams>("dataSources.openLink", (p, _) =>
        {
            if (!DataSourceLinks.TryGetValue((p.Provider, p.Link), out var url)) throw new BridgeException("invalid", "Unknown link.");
            _shell.OpenUri(new Uri(url));
            return Task.FromResult<object?>(true);
        });

        // Art picker (SteamGridDB).
        Dispatcher.Register<ArtOptionsParams>("art.options", async (p, ct) =>
        {
            var gameId = RequireId(p.GameId);
            var kind = RequireArtKind(p.Kind);
            var styles = (p.Styles ?? []).Take(8).Select(s => RequireText(s, 24, "Style")).ToList();
            long? sgdbId = p.SgdbGameId is null ? null
                : long.TryParse(p.SgdbGameId, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0 ? id
                : throw new BridgeException("invalid", "Invalid SteamGridDB game.");
            return await Run(() => _dataSources.GetArtOptionsAsync(gameId, kind, styles, p.Animated ?? false, Math.Clamp(p.Page ?? 0, 0, 50), sgdbId, ct));
        });
        Dispatcher.Register<ArtOptionParams>("art.thumb", async (p, ct) =>
            await Run(() => _dataSources.GetArtThumbAsync(RequireId(p.GameId), RequireArtKind(p.Kind), RequireOption(p.OptionId), p.Force ?? false, ct)));
        Dispatcher.Register<ArtOptionParams>("art.apply", async (p, ct) =>
        {
            var gameId = RequireId(p.GameId);
            var ok = await Call(() => _dataSources.ApplyArtAsync(gameId, RequireArtKind(p.Kind), RequireOption(p.OptionId), ct));
            if (!ok) throw new BridgeException("unavailable", "That image couldn’t be downloaded safely. Try another one.");
            _events.Emit("library.changed", new { reason = "artwork" });
            return true;
        });
        Dispatcher.Register<GameIdParams>("art.userArt", (p, _) => Task.FromResult<object?>(_dataSources.UserArt(RequireId(p.GameId))));
        Dispatcher.Register<ArtworkParams>("art.reset", async (p, ct) =>
        {
            var gameId = RequireId(p.GameId);
            var kind = RequireArtKind(p.Kind, allowAll: true);
            if (!Repository.ResetUserArtwork(gameId, kind)) return false;
            _events.Emit("library.changed", new { reason = "artwork" });
            await RestoreDefaultArtworkAsync(gameId, ct);
            return true;
        });

        // Enrichment (IGDB, RAWG).
        Dispatcher.Register<GameIdParams>("enrichment.get", (p, _) => Task.FromResult<object?>(_dataSources.GetEnrichment(RequireId(p.GameId))));
        Dispatcher.Register<GameIdParams>("enrichment.run", async (p, ct) =>
        {
            var gameId = RequireId(p.GameId);
            var filled = await Call(() => _dataSources.EnrichNowAsync(gameId, ct));
            if (filled.Count > 0) _events.Emit("library.changed", new { reason = "enrichment" });
            return new { filled, details = _dataSources.GetEnrichment(gameId) };
        });
        Dispatcher.Register<GameNameParams>("enrichment.open", (p, _) =>
        {
            var gameId = RequireId(p.GameId);
            var url = Repository.GetEnrichment(gameId).FirstOrDefault(e => e.Source == p.Name && e.Matched)?.Url;
            var safe = JsonRead.SafeUrl(url, "igdb.com", "rawg.io") ?? throw new BridgeException("notFound", "There’s no page for this game on that site.");
            _shell.OpenUri(new Uri(safe));
            return Task.FromResult<object?>(true);
        });

        // Prices.
        Dispatcher.Register<GameRefreshParams>("deals.get", async (p, ct) => await Run(() => _dataSources.GetDealsAsync(RequireId(p.GameId), p.Refresh ?? false, ct)));
        Dispatcher.Register<OfferParams>("deals.open", (p, _) =>
        {
            var url = _dataSources.OfferUrl(RequireId(p.GameId), RequireOption(p.OfferId)) ?? throw new BridgeException("notFound", "That deal is no longer listed. Refresh the prices.");
            _shell.OpenUri(new Uri(url));
            return Task.FromResult<object?>(true);
        });

        // Identity (Wikidata).
        Dispatcher.Register<GameRefreshParams>("identity.get", async (p, ct) => await Run(() => _dataSources.GetIdentityAsync(RequireId(p.GameId), p.Refresh ?? false, ct)));
        Dispatcher.Register<GameNameParams>("identity.open", (p, _) =>
        {
            var url = _dataSources.IdentityUrl(RequireId(p.GameId), RequireText(p.Name, 20, "Name")) ?? throw new BridgeException("notFound", "There’s no page for that ID.");
            _shell.OpenUri(new Uri(url));
            return Task.FromResult<object?>(true);
        });

        // Compatibility.
        Dispatcher.Register<GameIdParams>("compat.get", async (p, ct) => await Run(() => _dataSources.GetCompatAsync(RequireId(p.GameId), ct)));
        Dispatcher.Register("compat.antiCheatMap", _ => Task.FromResult<object?>(_dataSources.AntiCheatMap()));
        Dispatcher.Register<GameIdParams>("compat.openAntiCheat", (p, _) =>
        {
            var game = Repository.GetGame(RequireId(p.GameId));
            var slug = game?.SteamAppId is { } a ? Repository.GetAntiCheat("steam", a)?.Slug : null;
            _shell.OpenUri(new Uri(slug is null ? "https://areweanticheatyet.com/" : $"https://areweanticheatyet.com/game/{slug}"));
            return Task.FromResult<object?>(true);
        });

        // Library value timeline.
        Dispatcher.Register("value.timeline", _ => Task.FromResult<object?>(_dataSources.GetValueTimeline()));
        Dispatcher.Register("value.refreshPrices", async ct => await Run(() => _dataSources.RefreshPricesAsync(ct)));

        StartDataSourceWork(TimeSpan.FromSeconds(90));
    }

    private int _dataSourceWorkRunning;

    /// <summary>
    /// Background, polite and pausable: refreshes the anti-cheat list (weekly), Wikidata identity
    /// for the library (one batched query at a time), and IGDB/RAWG enrichment (only with keys).
    /// Never while a game runs, Offline mode or Data saver is on; repeats every six hours.
    /// </summary>
    private void StartDataSourceWork(TimeSpan delay)
    {
        if (SafeMode || Interlocked.Exchange(ref _dataSourceWorkRunning, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(delay, _life.Token);
                while (!_life.IsCancellationRequested)
                {
                    // Data saver (manual, or a metered connection) skips the round, like Offline mode and a running game;
                    // a skipped round is tried again sooner.
                    var ran = false;
                    if (!Settings.GetBool("privacy.localOnly") && !IsGameActive && !DataSaverActive)
                    {
                        ran = true;
                        try
                        {
                            if (Settings.GetBool("dataSources.antiCheat")) await _dataSources.RefreshAntiCheatAsync(force: false, _life.Token);
                            if (!IsGameActive && !DataSaverActive) await _dataSources.RefreshLibraryIdentityAsync(500, _life.Token);
                            var changed = await _dataSources.Enrichment.RunAsync(40, () => IsGameActive || DataSaverActive, _life.Token);
                            if (changed > 0) _events.Emit("library.changed", new { reason = "enrichment" });
                        }
                        catch (DataSourceException ex)
                        {
                            Log.Warn("datasource", "Background data-source work stopped for this round", new { outcome = ex.Outcome.ToString() });
                        }
                    }
                    await Task.Delay(ran ? TimeSpan.FromHours(6) : TimeSpan.FromMinutes(30), _life.Token);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Warn("datasource", "Background data-source work failed", ex: ex); }
            finally { Interlocked.Exchange(ref _dataSourceWorkRunning, 0); }
        });
    }

    /// <summary>After "Reset to default": store art comes back from the store's cache or CDN.</summary>
    private async Task RestoreDefaultArtworkAsync(string gameId, CancellationToken ct)
    {
        try
        {
            var game = Repository.GetGame(gameId);
            foreach (var platform in Repository.GetInstallations(gameId).Select(i => i.Platform).Where(p => p != PlatformId.Manual).Distinct())
                await ScanPlatformAsync(platform, ct);
            if (game?.SteamAppId is { } appId && !Settings.GetBool("privacy.localOnly") && Settings.GetBool("library.fetchArtwork"))
                await Artwork.FetchSteamArtworkAsync(gameId, appId, ct);
            _events.Emit("library.changed", new { reason = "artwork" });
        }
        catch (Exception ex) when (ex is BridgeException or HttpRequestException or IOException)
        {
            Log.Warn("art", "Restoring default artwork failed", new { gameId }, ex);
        }
    }

    private static string RequireProvider(string? provider) =>
        provider is not null && DataSourcesService.IsKnown(provider) ? provider : throw new BridgeException("invalid", "Unknown data source.");

    private static ArtworkKind RequireArtKind(string? kind, bool allowAll = false) =>
        Enum.TryParse<ArtworkKind>(kind, true, out var k) && Enum.IsDefined(k) && (allowAll || SteamGridDbClient.Supports(k))
            ? k : throw new BridgeException("invalid", "Unknown artwork type.");

    private static string RequireOption(string? id) =>
        id is { Length: > 0 and <= 40 } && id.All(char.IsAsciiLetterOrDigit) ? id : throw new BridgeException("invalid", "Invalid option.");

    private static async Task<object?> Run<T>(Func<Task<T>> f) => await Call(f);

    private static async Task<T> Call<T>(Func<Task<T>> f)
    {
        try { return await f(); }
        catch (DataSourceException ex) { throw ToBridge(ex); }
    }

    private static T Wrap<T>(Func<T> f)
    {
        try { return f(); }
        catch (DataSourceException ex) { throw ToBridge(ex); }
    }

    private static BridgeException ToBridge(DataSourceException ex) => new(ex.Outcome switch
    {
        DataSourceOutcome.Offline => "offline",
        DataSourceOutcome.NotConfigured => "notConfigured",
        DataSourceOutcome.RateLimited => "rateLimited",
        DataSourceOutcome.InvalidKey => "invalidKey",
        DataSourceOutcome.Disabled => "disabled",
        _ => "unavailable",
    }, ex.Message);
}
