using System.Text.Json;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.DataSources.Identity;
using Vystral.Windows.Discover;
using Vystral.Windows.Services;
using Vystral.Windows.Services.NetworkHealth;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track D4 parameter records.
public sealed record IdentityResolvedParams(string GameId, bool? Refresh);
public sealed record IdentityPinParams(string GameId, string Kind, string? Value);
public sealed record IdentityKindParams(string GameId, string Kind);
public sealed record IdentitySearchParams(string GameId, string Query);
public sealed record FreebiesParams(bool? Refresh);
public sealed record FreebieIdParams(string Id);

/// <summary>ProtonDB's summary for a game page. Status: ok | none | off | notSteam | offline | gameRunning | unavailable | rateLimited.</summary>
/// <param name="Via">How the Steam app was found when it isn't the game's own: matched | pinned.</param>
public sealed record ProtonDto(string Status, string? Message, string? AppId, string? Via, string? Tier, string? BestReported, string? Trending, int Total,
    string? Confidence, string? FetchedAt, bool Stale);

/// <summary>
/// Track D4: every data source for every game. The cross-store identity resolver (Steam app ID, IGDB ID, RAWG slug, GOG
/// product ID and Wikidata item for each game, with confidence and the user's corrections) feeds every Steam-keyed
/// feature for non-Steam games; trailers fall back to RAWG (MP4) and, with "Allow YouTube trailers", IGDB/GOG (YouTube);
/// and four more free sources: GamerPower and Epic free games (<c>freebies.get</c>, for Track D5's shelf), ProtonDB and
/// GOG's catalogue.
/// </summary>
public sealed partial class AppBackend
{
    private IdentityResolverService? _identity;
    private FreebiesService? _freebies;

    public IdentityResolverService Identity => _identity ?? throw new InvalidOperationException("Identity matching is not initialised yet.");

    private static readonly TimeSpan AltTrailerTtl = TimeSpan.FromDays(14);
    private static readonly TimeSpan AltTrailerMissTtl = TimeSpan.FromDays(7);
    private static readonly TimeSpan ProtonTtl = TimeSpan.FromDays(7);

    /// <summary>The Steam app a library game's Steam-keyed features use: its own, your choice, or a high-confidence match.</summary>
    private string? SteamAppIdOf(string gameId) => Repository.GetSteamAppId(gameId) ?? _identity?.SteamAppIdFor(gameId);

    /// <summary>Steam app → game for library-wide features (Library tag filters): the library's own Steam apps plus matched ones.</summary>
    private IReadOnlyDictionary<string, string> SteamAppToGameWithMatches()
    {
        var own = Repository.SteamAppToGame();
        if (_identity is null) return own;
        var merged = new Dictionary<string, string>(own, StringComparer.Ordinal);
        foreach (var (app, game) in _identity.MatchedSteamApps()) merged.TryAdd(app, game);
        return merged;
    }

    /// <summary>"Allow YouTube trailers" is on and nothing forbids a third-party frame right now (Offline, safe mode, Data saver, a game).</summary>
    public bool YouTubeFramesAllowed =>
        !SafeMode && Settings.GetBool(TrailerService.YouTubeSetting) && !Settings.GetBool("privacy.localOnly") && !IsGameActive && _trailers?.DataSaverActive != true;

    private void RegisterTrackD4Handlers()
    {
        _identity = new IdentityResolverService(Repository, Settings, _dataSources, _dataSources.GogCatalog) { IsGameActive = () => IsGameActive };
        _freebies = new FreebiesService(Repository, Settings, _dataSources, Artwork) { IsGameActive = () => IsGameActive };
        _dataSources.SteamAppFor = g => g.SteamAppId ?? _identity.SteamAppIdFor(g.Id);
        Trailers.SteamAppFor = gameId => _identity.SteamAppFor(gameId) is { } a ? (a.AppId, a.Native ? null : a.Status) : null;
        Trailers.AlternativeLookup = AlternativeTrailerAsync;
        _identity.Changed += gameId =>
        {
            Trailers.ForgetAlternative(gameId);
            foreach (var yt in new[] { "0", "1" }) Repository.DeleteProviderCache("trailer-alt", $"{gameId}:{yt}");
            _events.Emit("identity.changed", new { gameId });
        };
        Settings.Changed += key =>
        {
            if (key is "*" or IdentityResolverService.SettingKey or "dataSources.wikidata" or "dataSources.gogCatalog")
            {
                _identity.InvalidateAll();
                _events.Emit("identity.changed", new { gameId = (string?)null });
                _events.Emit("tags.changed", new { done = 0 });
            }
        };

        // ---------- Cross-store identity ----------
        Dispatcher.Register<IdentityResolvedParams>("identity.resolved", async (p, ct) =>
            await Run(() => Identity.GetAsync(RequireId(p.GameId, "game"), allowNetwork: !SafeMode, p.Refresh ?? false, ct)));
        Dispatcher.Register<IdentityPinParams>("identity.pin", (p, _) =>
        {
            var gameId = RequireId(p.GameId, "game");
            var kind = RequireIdKind(p.Kind);
            var value = p.Value is null ? null : RequireText(p.Value, 120, "ID").Trim();
            return Task.FromResult<object?>(Wrap(() => Identity.Pin(gameId, kind, value)));
        });
        Dispatcher.Register<IdentityKindParams>("identity.unpin", (p, _) =>
            Task.FromResult<object?>(Wrap(() => Identity.Unpin(RequireId(p.GameId, "game"), RequireIdKind(p.Kind)))));
        Dispatcher.Register<IdentitySearchParams>("identity.searchSteam", async (p, ct) =>
        {
            RequireId(p.GameId, "game");
            if (SafeMode) throw new BridgeException("unavailable", "VYSTRAL is in safe mode, so it doesn’t contact Steam.");
            return await Run(() => Identity.SearchSteamAsync(RequireText(p.Query, 100, "Search"), ct));
        });
        Dispatcher.Register<IdentityKindParams>("identity.openId", (p, _) =>
        {
            var url = Identity.Link(RequireId(p.GameId, "game"), RequireIdKind(p.Kind)) ?? throw new BridgeException("notFound", "There’s no page for that ID.");
            _shell.OpenUri(new Uri(url));
            return Task.FromResult<object?>(true);
        });

        // ---------- Free games (GamerPower, Epic) for Track D5's shelf ----------
        Dispatcher.Register<FreebiesParams>("freebies.get", async (p, ct) =>
        {
            if (SafeMode) return new FreebiesDto([], [], "offline");
            return await Run(() => _freebies.GetAsync(p.Refresh ?? false, ct));
        });
        Dispatcher.Register<FreebieIdParams>("freebies.image", async (p, ct) =>
        {
            var id = p.Id is not null && FreebiesService.ItemId().IsMatch(p.Id) ? p.Id : throw new BridgeException("invalid", "Unknown giveaway.");
            return SafeMode ? null : await _freebies.ImageAsync(id, ct);
        });
        Dispatcher.Register<FreebieIdParams>("freebies.open", (p, _) =>
        {
            var id = p.Id is not null && FreebiesService.ItemId().IsMatch(p.Id) ? p.Id : throw new BridgeException("invalid", "Unknown giveaway.");
            var item = _freebies.Find(id) ?? throw new BridgeException("notFound", "That giveaway is no longer listed. Refresh the list.");
            _shell.OpenUri(new Uri(item.Url));
            return Task.FromResult<object?>(true);
        });

        // ---------- ProtonDB ----------
        Dispatcher.Register<GamePageParams>("protondb.get", async (p, ct) =>
        {
            var appId = PageAppId(p);
            var via = p.GameId is not null && appId is not null && Repository.GetSteamAppId(p.GameId) is null ? _identity.SteamAppFor(p.GameId)?.Status : null;
            return await ProtonAsync(appId, via, p.Refresh ?? false, ct);
        });
        Dispatcher.Register<GamePageParams>("protondb.open", (p, _) =>
        {
            var appId = PageAppId(p) ?? throw new BridgeException("notFound", "This game has no Steam app, so ProtonDB doesn’t list it.");
            _shell.OpenUri(new Uri($"https://www.protondb.com/app/{appId}"));
            return Task.FromResult<object?>(true);
        });

        RegisterTrackD4Probes();
        StartIdentityWork(TimeSpan.FromMinutes(2));
    }

    private static string RequireIdKind(string? kind) =>
        kind is not null && IdKinds.All.Contains(kind) ? kind : throw new BridgeException("invalid", "Unknown ID kind.");

    // ---------- Trailers from other sources ----------

    /// <summary>
    /// RAWG's MP4 trailer first (with your RAWG key), then — only with "Allow YouTube trailers" on — IGDB's (your Twitch app)
    /// and GOG's (GOG catalogue on) YouTube trailers. Uses only IDs the resolver trusts. Cached per game for two weeks.
    /// </summary>
    private async Task<ExternalTrailer?> AlternativeTrailerAsync(string gameId, bool network, CancellationToken ct)
    {
        var youtube = Settings.GetBool(TrailerService.YouTubeSetting);
        var key = $"{gameId}:{(youtube ? 1 : 0)}";
        var cached = Repository.GetProviderCache("trailer-alt", key);
        ExternalTrailer? Read(string body)
        {
            try { return ExternalTrailers.Validate(JsonSerializer.Deserialize<ExternalTrailer?>(body, JsonFileCache.Options)); }
            catch (JsonException) { return null; }
        }
        if (cached is { Fresh: true }) return Read(cached.Value.Body);
        if (!network || SafeMode || _identity is null) return cached is { } stale ? Read(stale.Body) : null;

        ExternalTrailer? found = null;
        var asked = false;
        if (_dataSources.ProviderReady("rawg") && _identity.UsedId(gameId, IdKinds.Rawg) is { } rawg)
        {
            asked = true;
            found = ExternalTrailers.ParseRawgMovies(await _dataSources.Rawg.GetMoviesJsonAsync(rawg, ct));
        }
        if (found is null && youtube && _dataSources.ProviderReady("igdb") && _identity.UsedId(gameId, IdKinds.Igdb) is { } igdb && long.TryParse(igdb, out var igdbId))
        {
            asked = true;
            found = ExternalTrailers.ParseIgdbVideos(await _dataSources.Igdb.GetVideosJsonAsync(igdbId, ct));
        }
        if (found is null && youtube && Settings.GetBool("dataSources.gogCatalog") && _identity.UsedId(gameId, IdKinds.Gog) is { } gog)
        {
            asked = true;
            found = ExternalTrailers.FromGog(await _dataSources.GogCatalog.GetVideosAsync(gog, ct));
        }
        if (asked) Repository.SetProviderCache("trailer-alt", key, JsonSerializer.Serialize(found, JsonFileCache.Options), found is null ? AltTrailerMissTtl : AltTrailerTtl);
        return found;
    }

    // ---------- ProtonDB ----------

    private async Task<ProtonDto> ProtonAsync(string? appId, string? via, bool refresh, CancellationToken ct)
    {
        ProtonDto Dto(string status, string? message, ProtonSummary? s, DateTimeOffset? fetched, bool stale) =>
            new(status, message, appId, via, s?.Tier, s?.BestReported, s?.Trending, s?.Total ?? 0, s?.Confidence, fetched?.ToString("O"), stale);
        if (!Settings.GetBool("dataSources.protondb")) return Dto("off", null, null, null, false);
        if (!IdKinds.IsValid(IdKinds.Steam, appId)) return Dto("notSteam", null, null, null, false);
        var cached = Repository.GetProviderCache("protondb", appId!);
        ProtonSummary? saved = null;
        var hadAnswer = false;
        if (cached is { } c)
        {
            try
            {
                using var doc = JsonDocument.Parse(c.Body);
                hadAnswer = true;
                saved = doc.RootElement.ValueKind == JsonValueKind.Object ? ProtonDbClient.Parse(appId!, c.Body) : null;
            }
            catch (Exception ex) when (ex is JsonException or DataSourceException) { hadAnswer = false; }
        }
        if (cached is { Fresh: true } && hadAnswer && !refresh) return Dto(saved is null ? "none" : "ok", null, saved, cached.Value.Fetched, false);
        if (SafeMode || Settings.GetBool("privacy.localOnly"))
            return Dto(hadAnswer ? saved is null ? "none" : "ok" : "offline", "Offline mode is on, so VYSTRAL doesn’t ask ProtonDB.", saved, cached?.Fetched, hadAnswer);
        if (IsGameActive) return Dto("gameRunning", "VYSTRAL doesn’t contact ProtonDB while a game is running.", saved, cached?.Fetched, hadAnswer);
        try
        {
            var s = await _dataSources.ProtonDb.GetAsync(appId!, ct);
            // Stored in ProtonDB's own field names, so the cache reads back through the same parser.
            Repository.SetProviderCache("protondb", appId!, s is null ? "null" : JsonSerializer.Serialize(new
            {
                tier = s.Tier, bestReportedTier = s.BestReported, trendingTier = s.Trending, score = s.Score, confidence = s.Confidence, total = s.Total,
            }), ProtonTtl);
            return Dto(s is null ? "none" : "ok", null, s, DateTimeOffset.UtcNow, false);
        }
        catch (DataSourceException ex)
        {
            return Dto(GamePage.GamePageIds.Status(ex.Outcome), ex.Message, saved, cached?.Fetched, hadAnswer);
        }
    }

    // ---------- Health and background work ----------

    /// <summary>
    /// Network health rows for the new sources (Settings → Privacy → Network health; Track D6's health page can list the
    /// same probes through <c>network.health.list</c>, and each source's last test and pause through <c>dataSources.status</c>).
    /// Shown only while the source is turned on.
    /// </summary>
    private void RegisterTrackD4Probes()
    {
        if (_health is null) return;
        _health.Register(new HealthProbe
        {
            Id = "provider.gamerpower", Label = "GamerPower", Purpose = "Free games to claim", Url = new Uri("https://www.gamerpower.com/api/worth"),
            Method = HttpMethod.Get, Visible = ctx => ctx.Setting("dataSources.gamerpower"),
        });
        _health.Register(new HealthProbe
        {
            Id = "provider.epicfree", Label = "Epic free games", Purpose = "This week’s free games on Epic", Url = new Uri(EpicFreeGamesClient.Endpoint),
            Method = HttpMethod.Get, Visible = ctx => ctx.Setting("dataSources.epicFreeGames"),
        });
        _health.Register(new HealthProbe
        {
            Id = "provider.protondb", Label = "ProtonDB", Purpose = "Linux compatibility on game pages", Url = new Uri("https://www.protondb.com/"),
            AnyResponseIsHealthy = true, Visible = ctx => ctx.Setting("dataSources.protondb"),
        });
        _health.Register(new HealthProbe
        {
            Id = "provider.gogcatalog", Label = "GOG catalogue", Purpose = "Matching games to GOG, GOG trailers", Url = new Uri("https://catalog.gog.com/v1/catalog?limit=1"),
            Method = HttpMethod.Get, Visible = ctx => ctx.Setting("dataSources.gogCatalog"),
        });
    }

    private int _identityWorkRunning;

    /// <summary>Background, polite and pausable: matches up to 25 non-Steam games a round, every six hours (sooner after a skipped round).</summary>
    private void StartIdentityWork(TimeSpan delay)
    {
        if (SafeMode || Interlocked.Exchange(ref _identityWorkRunning, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(delay, _life.Token);
                while (!_life.IsCancellationRequested)
                {
                    var ran = false;
                    if (_identity is { } id && id.BlockReason() is null && !DataSaverActive)
                    {
                        ran = true;
                        try
                        {
                            var done = await id.RefreshLibraryAsync(25, () => IsGameActive || DataSaverActive, _life.Token);
                            if (done > 0) _events.Emit("tags.changed", new { done = 0 });
                        }
                        catch (DataSourceException ex) { Log.Warn("identity", "Background matching stopped for this round", new { outcome = ex.Outcome.ToString() }); }
                    }
                    await Task.Delay(ran ? TimeSpan.FromHours(6) : TimeSpan.FromMinutes(30), _life.Token);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Log.Warn("identity", "Background matching failed", ex: ex); }
            finally { Interlocked.Exchange(ref _identityWorkRunning, 0); }
        });
    }
}
