using System.Text.Json;
using Vystral.Core.Domain;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

public sealed partial class AppBackend
{
    private void RegisterLibraryHandlers()
    {
        Dispatcher.Register("library.get", _ => Task.FromResult<object?>(Library.Snapshot()));
        Dispatcher.Register("library.scan", async ct =>
        {
            var report = await Library.ScanAsync(ct);
            return report is null ? new { alreadyRunning = true } : report;
        });
        Dispatcher.Register("library.adapters", _ => Task.FromResult<object?>(Library.GetAdapters()));
        Dispatcher.Register<PlatformToggleParams>("library.setPlatformEnabled", (p, _) =>
        {
            if (!PlatformInfo.TryParse(p.Platform, out var platform) || platform == PlatformId.Manual)
                throw new BridgeException("invalid", "Unknown platform.");
            var error = Settings.SetPlatformEnabled(platform.Key(), p.Enabled);
            if (error is not null) throw new BridgeException("invalid", error);
            return Task.FromResult<object?>(Library.GetAdapters());
        });

        Dispatcher.Register<FlagParams>("game.setFavorite", (p, _) => Ok(Repository.UpdateGameFlags(RequireId(p.GameId), favorite: p.Value)));
        Dispatcher.Register<FlagParams>("game.setHidden", (p, _) =>
        {
            var ok = Repository.UpdateGameFlags(RequireId(p.GameId), hidden: p.Value);
            OnLibraryIdentityChanged(); // hidden games are never watched for detection
            return Ok(ok);
        });
        Dispatcher.Register<RatingParams>("game.setRating", (p, _) =>
        {
            if (p.Rating is < 1 or > 5) throw new BridgeException("invalid", "Ratings are 1 to 5 stars.");
            return Ok(Repository.UpdateGameFlags(RequireId(p.GameId), rating: p.Rating, clearRating: p.Rating is null));
        });
        Dispatcher.Register<NotesParams>("game.setNotes", (p, _) =>
            Ok(Repository.UpdateGameFlags(RequireId(p.GameId), notes: RequireText(p.Notes, 20000, "Notes", allowEmpty: true), setNotes: true)));
        Dispatcher.Register<PreferredParams>("game.setPreferred", (p, _) =>
            Ok(Repository.SetPreferredInstallation(RequireId(p.GameId), p.InstallationId is null ? null : RequireId(p.InstallationId, "installation"))));
        Dispatcher.Register<LaunchArgsParams>("game.setLaunchArgs", (p, _) =>
        {
            var args = p.Args is null || p.Args.Trim().Length == 0 ? null : RequireText(p.Args, 1024, "Launch options");
            if (args is not null && args.Any(char.IsControl)) throw new BridgeException("invalid", "Launch options contain invalid characters.");
            var ok = Repository.SetUserLaunchArgs(RequireId(p.InstallationId, "installation"), args);
            if (ok) Repository.Audit("game.setLaunchArgs", $"{p.InstallationId}: {args ?? "(cleared)"}");
            return Ok(ok);
        });
        Dispatcher.Register<MergeParams>("game.merge", (p, _) =>
        {
            var (target, source) = (RequireId(p.TargetGameId), RequireId(p.SourceGameId));
            var ok = Repository.MergeGames(target, source);
            if (ok)
            {
                OnGamesMerged(target, source);
                _events.Emit("library.changed", new { reason = "merge" });
            }
            return Ok(ok);
        });
        Dispatcher.Register<InstallationIdParams>("game.unmerge", (p, _) =>
        {
            var installationId = RequireId(p.InstallationId, "installation");
            var originalGameId = Repository.GetInstallation(installationId)?.GameId;
            var newId = Repository.UnmergeInstallation(installationId)
                        ?? throw new BridgeException("invalid", "That version can't be separated (it's the only one).");
            if (originalGameId is not null) OnGameSplit(originalGameId, newId);
            _events.Emit("library.changed", null);
            return Task.FromResult<object?>(newId);
        });
        Dispatcher.Register<DismissParams>("game.dismissDuplicate", (p, _) =>
        {
            Repository.DismissDuplicate(RequireId(p.GameIdA), RequireId(p.GameIdB));
            return Ok(true);
        });
        Dispatcher.Register<AddManualParams>("game.addManual", async (p, _) =>
        {
            var exe = await _shell.PickExecutableAsync();
            if (exe is null) return null;
            if (!string.Equals(Path.GetExtension(exe), ".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(exe))
                throw new BridgeException("invalid", "Choose a program (.exe) file.");
            var title = string.IsNullOrWhiteSpace(p.Title)
                ? System.Diagnostics.FileVersionInfo.GetVersionInfo(exe).ProductName is { Length: > 0 } pn ? pn : Path.GetFileNameWithoutExtension(exe)
                : RequireText(p.Title, 200, "Title");
            var gameId = Repository.AddManualGame(title, exe, null);
            _events.Emit("library.changed", null);
            return gameId;
        });
        Dispatcher.Register<GameIdParams>("game.removeManual", (p, _) =>
        {
            var ok = Repository.RemoveManualGame(RequireId(p.GameId));
            if (!ok) throw new BridgeException("invalid", "Only games you added yourself can be removed. Store games disappear when you uninstall them in their store.");
            _events.Emit("library.changed", null);
            return Ok(true);
        });
        Dispatcher.Register<ArtworkParams>("game.chooseArtwork", async (p, _) =>
        {
            var gameId = RequireId(p.GameId);
            if (!Enum.TryParse<ArtworkKind>(p.Kind, true, out var kind)) throw new BridgeException("invalid", "Unknown artwork type.");
            var file = await _shell.PickImageAsync();
            if (file is null) return false;
            if (!_artworkImport(gameId, kind, file)) throw new BridgeException("invalid", "That file isn't a supported image (JPG, PNG or WebP under 12 MB).");
            Repository.Audit("game.setArtwork", $"{gameId} {kind}");
            _events.Emit("library.changed", null);
            return true;
        });
        Dispatcher.Register<PaletteParams>("game.savePalette", (p, _) =>
        {
            var raw = p.Palette.GetRawText();
            if (raw.Length > 2000 || p.Palette.ValueKind != JsonValueKind.Object) throw new BridgeException("invalid", "Invalid palette.");
            Repository.SetPalette(RequireId(p.GameId), raw);
            return Ok(true);
        });
        Dispatcher.Register<GameIdParams>("game.openFolder", (p, _) =>
        {
            var inst = Repository.GetInstallations(RequireId(p.GameId)).FirstOrDefault(i => i.InstallPath is not null && Directory.Exists(i.InstallPath))
                       ?? throw new BridgeException("notFound", "The install folder wasn't found.");
            _shell.OpenFolder(inst.InstallPath!);
            return Ok(true);
        });
        Dispatcher.Register<InstallationIdParams>("game.openInStore", (p, _) =>
        {
            var inst = Repository.GetInstallation(RequireId(p.InstallationId, "installation")) ?? throw new BridgeException("notFound", "Unknown installation.");
            var adapter = _adapters.FirstOrDefault(a => a.Platform == inst.Platform);
            var uri = adapter?.GetClientPageUri(inst.PlatformGameId);
            if (uri is null || !Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) throw new BridgeException("unsupported", $"{inst.Platform.DisplayName()} doesn't support opening game pages directly.");
            _shell.OpenUri(parsed);
            return Ok(true);
        });

        Dispatcher.Register<LaunchParams>("game.launch", (p, _) =>
            Task.FromResult<object?>(Sessions.Launch(RequireId(p.GameId), p.InstallationId is null ? null : RequireId(p.InstallationId, "installation"))));
        Dispatcher.Register("game.stopTracking", _ => { Sessions.StopTracking(); return Ok(true); });
        Dispatcher.Register("game.focus", _ => Ok(Sessions.FocusGame()));
        Dispatcher.Register("launch.current", _ => Task.FromResult<object?>(Sessions.Current));

        Dispatcher.Register<CollectionCreateParams>("collections.create", (p, _) =>
        {
            var rule = p.Rule is { ValueKind: JsonValueKind.Object } r ? r.GetRawText() : null;
            if (rule is { Length: > 4000 }) throw new BridgeException("invalid", "Rule too large.");
            var id = Repository.CreateCollection(RequireText(p.Name, 60, "Name"), p.Icon is null ? null : RequireText(p.Icon, 32, "Icon"), rule);
            _events.Emit("library.changed", null);
            return Task.FromResult<object?>(id);
        });
        Dispatcher.Register<CollectionRenameParams>("collections.rename", (p, _) =>
        {
            var ok = Repository.RenameCollection(RequireId(p.CollectionId, "collection"), RequireText(p.Name, 60, "Name"));
            _events.Emit("library.changed", null);
            return Ok(ok);
        });
        Dispatcher.Register<CollectionIdParams>("collections.delete", (p, _) =>
        {
            var ok = Repository.DeleteCollection(RequireId(p.CollectionId, "collection"));
            _events.Emit("library.changed", null);
            return Ok(ok);
        });
        Dispatcher.Register<MembershipParams>("collections.setMembership", (p, _) =>
        {
            Repository.SetCollectionMembership(RequireId(p.CollectionId, "collection"), RequireId(p.GameId), p.Member);
            return Ok(true);
        });

        Dispatcher.Register<SessionsParams>("sessions.list", (p, _) =>
            Task.FromResult<object?>(Repository.ListSessions(p.GameId is null ? null : RequireId(p.GameId), Math.Clamp(p.Limit ?? 500, 1, 10000))));
        Dispatcher.Register<SessionIdParams>("sessions.samples", (p, _) =>
            Task.FromResult<object?>(Repository.GetPerfSamples(RequireId(p.SessionId, "session"))));

        Dispatcher.Register("media.folders", _ => Task.FromResult<object?>(Media.GetFolders()));
        Dispatcher.Register("media.list", _ =>
        {
            var snapshot = Library.Snapshot();
            var bySteam = snapshot.Games
                .SelectMany(g => g.Installations.Where(i => i.Platform == "steam").Select(i => (i.PlatformGameId, g.Id)))
                .GroupBy(x => x.PlatformGameId).ToDictionary(x => x.Key, x => x.First().Id);
            return Task.FromResult<object?>(Media.List(a => bySteam.GetValueOrDefault(a), snapshot.Games.Select(g => (g.Id, g.Title)).ToList()));
        });
        Dispatcher.Register("media.addFolder", async _ =>
        {
            var folder = await _shell.PickFolderAsync();
            if (folder is null) return null;
            if (folder.StartsWith(@"\\", StringComparison.Ordinal)) throw new BridgeException("invalid", "Network folders aren't supported.");
            Repository.AddMediaFolder(folder);
            return Media.GetFolders();
        });
        Dispatcher.Register<MediaFolderIdParams>("media.removeFolder", (p, _) =>
        {
            Repository.RemoveMediaFolder(RequireId(p.FolderId, "folder"));
            return Task.FromResult<object?>(Media.GetFolders());
        });
    }

    private bool _artworkImport(string gameId, ArtworkKind kind, string file) => Artwork.ImportLocal(gameId, kind, file, "user");

    private static Task<object?> Ok(bool value)
    {
        if (!value) throw new BridgeException("notFound", "That item no longer exists.");
        return Task.FromResult<object?>(true);
    }
}
