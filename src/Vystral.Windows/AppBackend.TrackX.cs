using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using Vystral.Core.Domain;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using Vystral.Windows.Integrations;
using Vystral.Windows.Launch;
using Vystral.Windows.Services;
using Vystral.Windows.Storage;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track X parameter records.
public sealed record HealthNewsSeenParams(IReadOnlyList<string>? IssueIds, bool? All);
public sealed record UninstallParams(string GameId, string? InstallationId);
public sealed record ModsOpenParams(string GameId, string SourceId, string? ItemId);
public sealed record SavesParams(string GameId, bool? Refresh);
public sealed record SavesOpenParams(string GameId, string LocationId);

/// <summary>
/// Track X: library tools. A background health re-check that announces new issues on Home once, "Compare with default"
/// for Steam Input layouts, the uninstall advisor, a read-only mod folder viewer (Workshop, Vortex, Mod Organizer 2) and
/// the save-file locator (PCGamingWiki, opt-in). All of it reads; the only things it opens are folders in Explorer, the
/// store's own uninstall (steam://uninstall/&lt;appid&gt;, a store page, or Windows' Installed apps) and PCGamingWiki's article.
/// </summary>
public sealed partial class AppBackend
{
    private HealthWatchService _healthWatch = null!;
    private ModFolders _mods = null!;
    private SaveLocator _saves = null!;
    private readonly ConcurrentDictionary<string, ModsDto> _lastMods = new(StringComparer.Ordinal);
    private int _titlesRunning;

    [GeneratedRegex(@"^(?:workshop|vortex|mo2-[0-9]{1,2})\z")]
    private static partial Regex ModSourceId();

    [GeneratedRegex(@"^(?:[0-9a-f]{16}|[0-9]{1,20})\z")]
    private static partial Regex ModItemId();

    [GeneratedRegex(@"^s[0-9]{1,3}\z")]
    private static partial Regex SaveLocationId();

    private void RegisterTrackXHandlers()
    {
        // ---------- New health issues on Home ----------
        _healthWatch = new HealthWatchService(LibHealth.Check, Paths.Root, _events, () => IsGameActive, () => Settings.GetBool(HealthWatchService.SettingKey));
        Library.ScanCompleted += () => _healthWatch.Poke("scan");
        _installs.Completed += (_, _) => _healthWatch.Poke("install");
        _ = Task.Run(() => _healthWatch.RunAsync(_life.Token));
        Dispatcher.Register("health.news", _ => Task.FromResult<object?>(_healthWatch.Current()));
        Dispatcher.Register<HealthNewsSeenParams>("health.newsSeen", (p, _) =>
        {
            var ids = p.All == true
                ? _healthWatch.Current().Issues.Select(i => i.Id).ToList()
                : (p.IssueIds ?? []).Take(50).Select(RequireIssueId).ToList();
            return Task.FromResult<object?>(_healthWatch.Acknowledge(ids));
        });

        // ---------- Steam Input: compare with default ----------
        Dispatcher.Register<GameIdParams>("controls.compare", async (p, _) =>
        {
            var game = Repository.GetGame(RequireId(p.GameId, "game")) ?? throw new BridgeException("notFound", "That game is no longer in your library.");
            var appId = game.SteamAppId ?? Repository.GetSteamInstallation(game.Id)?.AppId;
            return await Task.Run(() => _steamInput!.Compare(appId));
        });

        // ---------- Uninstall advisor ----------
        Dispatcher.Register<UninstallParams>("uninstall.advice", async (p, _) => await Task.Run(() => UninstallAdvice(p)));
        Dispatcher.Register<UninstallParams>("uninstall.open", (p, _) => Task.FromResult<object?>(OpenUninstall(p)));

        // ---------- Mods ----------
        _mods = new ModFolders(_steam.FindSteamPath, Path.Combine(Paths.Root, "cache"));
        Dispatcher.Register<GameIdParams>("mods.list", async (p, _) =>
        {
            var (game, appId, paths) = GameFiles(p.GameId);
            var dto = await Task.Run(() => _mods.List(game.Id, appId, paths, game.Title, TitlesState));
            _lastMods[game.Id] = dto;
            return dto;
        });
        Dispatcher.Register<GameIdParams>("mods.titles", async (p, ct) => await WorkshopTitlesAsync(RequireId(p.GameId, "game"), ct));
        Dispatcher.Register<ModsOpenParams>("mods.open", (p, _) =>
        {
            var gameId = RequireId(p.GameId, "game");
            if (!ModSourceId().IsMatch(p.SourceId ?? "")) throw new BridgeException("invalid", "Unknown mod folder.");
            if (p.ItemId is not null && !ModItemId().IsMatch(p.ItemId)) throw new BridgeException("invalid", "Unknown mod.");
            var folder = _mods.FolderFor(gameId, p.SourceId!, p.ItemId) ?? throw new BridgeException("notFound", "That folder isn't in the list any more. Refresh and try again.");
            _shell.OpenFolder(folder);
            return Task.FromResult<object?>(true);
        });

        // ---------- Save files (PCGamingWiki, opt-in) ----------
        _saves = new SaveLocator(Path.Combine(Paths.Root, "cache"));
        Dispatcher.Register<SavesParams>("saves.lookup", async (p, ct) => await SavesAsync(p, ct));
        Dispatcher.Register<SavesOpenParams>("saves.open", (p, _) =>
        {
            var gameId = RequireId(p.GameId, "game");
            if (!SaveLocationId().IsMatch(p.LocationId ?? "")) throw new BridgeException("invalid", "Unknown save location.");
            var folder = _saves.FolderFor(gameId, p.LocationId!) ?? throw new BridgeException("notFound", "That folder isn't in the list any more. Check again and retry.");
            _shell.OpenFolder(folder);
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register<GameIdParams>("saves.openArticle", (p, _) =>
        {
            var (game, appId, _) = GameFiles(p.GameId);
            var article = appId is null ? null : _saves.Cached(appId)?.Article;
            if (article is null || !PcGamingWikiClient.IsTitle(article)) throw new BridgeException("notFound", $"PCGamingWiki has no article for {game.Title} yet.");
            _shell.OpenUri(PcGamingWikiClient.ArticleUrl(article));
            return Task.FromResult<object?>(true);
        });
    }

    /// <summary>The game, its Steam app id and its installed folders (from the database, never from the page).</summary>
    private (Game Game, string? AppId, IReadOnlyList<string> Paths) GameFiles(string? gameId)
    {
        var id = RequireId(gameId, "game");
        var game = Repository.GetGame(id) ?? throw new BridgeException("notFound", "That game is no longer in your library.");
        var appId = game.SteamAppId ?? Repository.GetSteamInstallation(id)?.AppId;
        var paths = Repository.GetInstallations(id).Where(i => i.State == InstallState.Installed && i.InstallPath is not null)
            .Select(i => i.InstallPath!).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        return (game, appId, paths);
    }

    private string TitlesState(int missing) =>
        !Settings.GetBool("dataSources.workshopTitles") ? "off"
        : missing == 0 ? "done"
        : Settings.GetBool("privacy.localOnly") || SafeMode ? "offline"
        : "ready";

    private async Task<ModsDto> WorkshopTitlesAsync(string gameId, CancellationToken ct)
    {
        if (!Settings.GetBool("dataSources.workshopTitles")) throw new BridgeException("off", "Workshop titles are off. Turn them on in Settings › Data sources.");
        EnsureOnline("look up Workshop titles");
        if (SafeMode) throw new BridgeException("unavailable", "VYSTRAL is in safe mode, so it doesn’t contact Steam.");
        if (IsGameActive) throw new BridgeException("busy", "Lookups wait until you finish playing.");
        if (!_lastMods.TryGetValue(gameId, out var last)) throw new BridgeException("notFound", "Open the mod list first.");
        if (Interlocked.Exchange(ref _titlesRunning, 1) == 1) throw new BridgeException("busy", "Already looking those up.");
        try
        {
            var ids = _mods.UntitledWorkshopItems(gameId);
            if (ids.Count > 0)
            {
                try { _mods.SaveTitles(await DataSources.WorkshopDetails.TitlesAsync(ids, ct)); }
                catch (DataSourceException ex) { throw new BridgeException("unavailable", ex.Message); }
            }
            var titles = _mods.ReadTitles();
            var sources = last.Sources.Select(s => s.Kind != "workshop" ? s : s with
            {
                Items = s.Items.Select(i => titles.TryGetValue(i.Id, out var t) ? i with { Title = t.Title } : i).ToList(),
            }).ToList();
            var missing = sources.Where(s => s.Kind == "workshop").SelectMany(s => s.Items).Count(i => i.Title is null);
            var dto = last with { Sources = sources, MissingTitles = missing, Titles = "done" }; // private or removed items have no public title
            _lastMods[gameId] = dto;
            return dto;
        }
        finally
        {
            Interlocked.Exchange(ref _titlesRunning, 0);
        }
    }

    private async Task<SavesDto> SavesAsync(SavesParams p, CancellationToken ct)
    {
        var (game, appId, paths) = GameFiles(p.GameId);
        SavesDto Empty(string status, string? message) => new(game.Id, status, message, null, [], null, false);
        if (appId is null) return Empty("noSteamApp", "Save locations are looked up by Steam app ID, and this game doesn’t have one.");
        if (!Settings.GetBool("dataSources.pcgamingwiki")) return Empty("off", null);

        var cached = _saves.Cached(appId);
        var stale = cached is null || !SaveLocator.Fresh(cached, DateTimeOffset.UtcNow) || p.Refresh == true;
        string? note = null;
        if (stale)
        {
            string? blocked = Settings.GetBool("privacy.localOnly") ? "Offline mode is on, so PCGamingWiki wasn’t asked."
                : SafeMode ? "VYSTRAL is in safe mode, so it doesn’t contact PCGamingWiki."
                : IsGameActive ? "Lookups wait until you finish playing."
                : null;
            if (blocked is not null)
            {
                if (cached is null) return Empty(IsGameActive ? "busy" : "offline", blocked);
                note = blocked;
            }
            else
            {
                try { cached = await _saves.FetchAsync(DataSources.PcGamingWiki, appId, ct); stale = false; }
                catch (DataSourceException ex)
                {
                    if (cached is null) return Empty("error", ex.Message);
                    note = ex.Message;
                }
            }
        }
        var steam = _steam.FindSteamPath();
        var account = steam is null ? null : SteamAdapter.FindMostRecentAccountId(steam);
        var locations = await Task.Run(() => _saves.Check(game.Id, cached!, paths, steam, account), ct);
        var status = cached!.Article is null ? "notFound" : locations.Count == 0 ? "none" : "ok";
        return new SavesDto(game.Id, status, note, cached.Article, locations, cached.Fetched, stale);
    }

    // ---------- uninstall ----------

    private Installation UninstallTarget(UninstallParams p)
    {
        var gameId = RequireId(p.GameId, "game");
        var installs = Repository.GetInstallations(gameId);
        if (installs.Count == 0) throw new BridgeException("notFound", "That game is no longer in your library.");
        var inst = p.InstallationId is { } iid
            ? installs.FirstOrDefault(i => i.Id == RequireId(iid, "installation")) ?? throw new BridgeException("notFound", "That version is no longer in your library.")
            : installs.Where(i => i.State == InstallState.Installed).OrderByDescending(i => i.Platform == PlatformId.Steam).FirstOrDefault()
              ?? throw new BridgeException("invalid", "This game isn’t installed.");
        if (inst.State != InstallState.Installed) throw new BridgeException("invalid", "This version isn’t installed.");
        return inst;
    }

    private UninstallAdviceDto UninstallAdvice(UninstallParams p)
    {
        var inst = UninstallTarget(p);
        var steam = _steam.FindSteamPath();
        var appId = inst.Platform == PlatformId.Steam ? inst.PlatformGameId : null;
        long? size = null;
        var sizeSource = "none";
        if (appId is not null && UninstallFacts.SteamSizeOnDisk(steam, appId) is { } s) { size = s; sizeSource = "manifest"; }
        else if (inst.SizeBytes is > 0) { size = inst.SizeBytes; sizeSource = "scan"; }
        var saves = appId is not null
            ? UninstallFacts.SteamCloud(steam, steam is null ? null : SteamAdapter.FindMostRecentAccountId(steam), appId)
            : new CloudSavesDto("unknown", 0, 0, null);

        var services = new List<AdviceServiceDto>();
        if (inst.Platform == PlatformId.Xbox)
            services.Add(new("gamepass", "Xbox app", "If it came with Game Pass, you can install it again any time while your membership is active."));
        try
        {
            if (_cloud is not null && _cloud.ForGame(inst.GameId) is { Enabled: true } cloud)
            {
                foreach (var o in cloud.Options.Take(4))
                    services.Add(new(o.Service, o.ServiceName, o.Service == "xbox"
                        ? "Listed for Xbox Cloud Gaming, so with Game Pass Ultimate you could stream it instead of reinstalling."
                        : "Listed on GeForce NOW, so you could stream your copy instead of reinstalling."));
            }
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            Log.Warn("uninstall", "Cloud listing unavailable for the advisor", ex: ex);
        }

        var (action, label) = UninstallAction(inst);
        string? drive = null;
        try { drive = inst.InstallPath is { } path && Path.IsPathFullyQualified(path) ? Path.GetPathRoot(path)?.TrimEnd('\\') : null; }
        catch (ArgumentException) { }
        return new UninstallAdviceDto(inst.GameId, inst.Id, inst.Platform.Key(), size, sizeSource, drive, saves, services, action, label);
    }

    private (string Action, string Label) UninstallAction(Installation inst)
    {
        if (inst.Platform == PlatformId.Manual) return ("none", "");
        if (inst.Platform == PlatformId.Steam && StoreActions.Steam(StoreAction.Uninstall, inst.PlatformGameId) is not null) return ("steamUninstall", "Open Steam’s uninstall");
        var adapter = _adapters.FirstOrDefault(a => a.Platform == inst.Platform);
        return adapter?.GetClientPageUri(inst.PlatformGameId) is { } page && Uri.TryCreate(page, UriKind.Absolute, out _)
            ? ("openStore", $"Open {inst.Platform.DisplayName()}")
            : ("windowsApps", "Open Windows’ Installed apps");
    }

    private object OpenUninstall(UninstallParams p)
    {
        var inst = UninstallTarget(p);
        if (IsGameActive) throw new BridgeException("busy", "Close your game before uninstalling anything.");
        var (action, _) = UninstallAction(inst);
        switch (action)
        {
            case "steamUninstall":
                RequireSteamClient();
                var uri = StoreActions.Steam(StoreAction.Uninstall, inst.PlatformGameId) ?? throw new BridgeException("invalid", "This Steam game can’t be uninstalled from VYSTRAL.");
                _shell.OpenUri(uri);
                _installs.WatchUninstall(inst.PlatformGameId, inst.GameId);
                Repository.Audit("steam.uninstall", inst.PlatformGameId);
                break;
            case "openStore":
                var page = _adapters.First(a => a.Platform == inst.Platform).GetClientPageUri(inst.PlatformGameId)!;
                _shell.OpenUri(new Uri(page));
                break;
            case "windowsApps":
                _shell.OpenUri(new Uri(WindowsInstalledApps));
                break;
            default:
                throw new BridgeException("unsupported", "You added this one yourself, so remove it the way you installed it.");
        }
        return new { action };
    }

    /// <summary>Windows' documented Settings link for Apps › Installed apps (the only ms-settings link VYSTRAL opens).</summary>
    public const string WindowsInstalledApps = "ms-settings:appsfeatures";
}
