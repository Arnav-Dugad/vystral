using System.Text.Json;
using System.Text.Json.Nodes;
using Vystral.Core.Domain;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Parameter records: one per method shape. Unknown JSON members are rejected by the dispatcher.
public sealed record GameIdParams(string GameId);
public sealed record FlagParams(string GameId, bool Value);
public sealed record RatingParams(string GameId, int? Rating);
public sealed record NotesParams(string GameId, string Notes);
public sealed record PreferredParams(string GameId, string? InstallationId);
public sealed record LaunchArgsParams(string InstallationId, string? Args);
public sealed record MergeParams(string TargetGameId, string SourceGameId);
public sealed record InstallationIdParams(string InstallationId);
public sealed record DismissParams(string GameIdA, string GameIdB);
public sealed record AddManualParams(string? Title);
public sealed record ArtworkParams(string GameId, string Kind);
public sealed record LaunchParams(string GameId, string? InstallationId);
public sealed record PaletteParams(string GameId, JsonElement Palette);
public sealed record CollectionCreateParams(string Name, string? Icon, JsonElement? Rule);
public sealed record CollectionRenameParams(string CollectionId, string Name);
public sealed record CollectionIdParams(string CollectionId);
public sealed record MembershipParams(string CollectionId, string GameId, bool Member);
public sealed record SessionsParams(string? GameId, int? Limit);
public sealed record SessionIdParams(string SessionId);
public sealed record SettingParams(string Key, JsonElement Value);
public sealed record PlatformToggleParams(string Platform, bool Enabled);
public sealed record ModeParams(string Mode);
public sealed record DragRegionsParams(IReadOnlyList<DragRect> Regions);
public sealed record ExternalParams(string Url);
public sealed record PulseParams(bool Visible);
public sealed record FlagValueParams(bool Value);
public sealed record RumbleParams(double Strength, int DurationMs);
public sealed record ModelParams(string Model);
public sealed record ChatMessage(string Role, string Content);
public sealed record ChatParams(string RequestId, IReadOnlyList<ChatMessage> Messages);
public sealed record QueryParams(string Query);
public sealed record MediaFolderIdParams(string FolderId);

public sealed partial class AppBackend
{
    private static readonly string[] AllowedExternalHosts =
    [
        "github.com", "ollama.com", "store.steampowered.com", "learn.microsoft.com", "www.steamgriddb.com",
        "go.microsoft.com", "support.microsoft.com", "www.pcgamingwiki.com", "steamcommunity.com",
    ];

    private void RegisterAppHandlers()
    {
        Dispatcher.Register("app.info", _ => Task.FromResult<object?>(new
        {
            version = Version,
            safeMode = SafeMode,
            previousRunCrashed = PreviousRunCrashed,
            startupProblem = StartupProblem,
            dataPath = Paths.Root,
            window = _shell.GetWindowState(),
            settings = Settings.GetAll(),
            launch = Sessions.Current,
            update = Updates.State,
            os = Environment.OSVersion.VersionString,
            cpuCount = Environment.ProcessorCount,
        }));
        Dispatcher.Register("app.ready", _ =>
        {
            OnUiReady();
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register<ModeParams>("window.setMode", (p, _) =>
        {
            if (p.Mode is not ("desktop" or "immersive")) throw new BridgeException("invalid", "Unknown mode.");
            _shell.SetMode(p.Mode);
            return Task.FromResult<object?>(_shell.GetWindowState());
        });
        Dispatcher.Register("window.state", _ => Task.FromResult<object?>(_shell.GetWindowState()));
        Dispatcher.Register("window.minimize", _ => { _shell.Minimize(); return Task.FromResult<object?>(true); });
        Dispatcher.Register("window.toggleMaximize", _ => { _shell.ToggleMaximize(); return Task.FromResult<object?>(_shell.GetWindowState()); });
        Dispatcher.Register("window.close", _ => { _shell.Close(); return Task.FromResult<object?>(true); });
        Dispatcher.Register<DragRegionsParams>("window.dragRegions", (p, _) =>
        {
            if (p.Regions.Count > 16 || p.Regions.Any(r => r.Width < 0 || r.Height < 0 || r.Width > 20000 || r.Height > 400))
                throw new BridgeException("invalid", "Invalid drag regions.");
            _shell.SetDragRegions(p.Regions);
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register<FlagValueParams>("window.captionTheme", (p, _) =>
        {
            _shell.SetCaptionTheme(p.Value);
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register<PulseParams>("window.pulse", (p, _) =>
        {
            _shell.SetPulseVisible(p.Visible);
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register<RumbleParams>("controller.rumble", (p, _) =>
        {
            if (Settings.GetBool("controller.vibration") && !IsGameActive)
                _shell.Rumble(Math.Clamp(p.Strength, 0, 1), Math.Clamp(p.DurationMs, 10, 400));
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register<ExternalParams>("app.openExternal", (p, _) =>
        {
            if (!Uri.TryCreate(p.Url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
                !AllowedExternalHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase))
                throw new BridgeException("forbidden", "VYSTRAL only opens trusted links.");
            _shell.OpenUri(uri);
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register("app.openLogs", _ => { _shell.OpenFolder(Paths.Logs); return Task.FromResult<object?>(true); });
        Dispatcher.Register("app.openDataFolder", _ => { _shell.OpenFolder(Paths.Root); return Task.FromResult<object?>(true); });

        Dispatcher.Register("settings.get", _ => Task.FromResult<object?>(Settings.GetAll()));
        Dispatcher.Register<SettingParams>("settings.set", (p, _) =>
        {
            var error = Settings.Set(p.Key, JsonNode.Parse(p.Value.GetRawText()));
            if (error is not null) throw new BridgeException("invalid", error);
            _events.Emit("settings.changed", Settings.GetAll());
            if (p.Key is "library.fetchMetadata" or "library.fetchArtwork" && Settings.GetBool("library.fetchMetadata")) Library.StartEnrichment();
            return Task.FromResult<object?>(Settings.GetAll());
        });
        Dispatcher.Register("settings.reset", _ =>
        {
            Settings.ResetAll();
            Repository.Audit("settings.reset", null);
            _events.Emit("settings.changed", Settings.GetAll());
            return Task.FromResult<object?>(Settings.GetAll());
        });

        Dispatcher.Register("update.state", _ => Task.FromResult<object?>(Updates.State));
        Dispatcher.Register("update.check", async _ => await Updates.CheckAsync());
        Dispatcher.Register("update.download", async _ => await Updates.DownloadAsync());
        Dispatcher.Register("update.cancel", _ => { Updates.CancelDownload(); return Task.FromResult<object?>(Updates.State); });
        Dispatcher.Register("update.apply", _ =>
        {
            var state = Updates.ApplyAndRestart();
            if (state.Phase == "applying") Shutdown();
            return Task.FromResult<object?>(state);
        });
        Dispatcher.Register("update.openReleases", _ =>
        {
            _shell.OpenUri(new Uri(UpdateService.RepositoryUrl + "/releases"));
            return Task.FromResult<object?>(true);
        });

        Dispatcher.Register("ai.status", async ct => await Ai.GetStatusAsync(ct));
        Dispatcher.Register<ModelParams>("ai.pull", (p, ct) =>
        {
            if (!OllamaService.IsValidModelName(p.Model)) throw new BridgeException("invalid", "That model name isn't valid.");
            _ = Task.Run(() => Ai.PullAsync(p.Model));
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register("ai.cancelPull", _ => { Ai.CancelPull(); return Task.FromResult<object?>(true); });
        Dispatcher.Register<ChatParams>("ai.chat", (p, ct) =>
        {
            if (p.Messages.Count is 0 or > 40) throw new BridgeException("invalid", "Invalid conversation.");
            var history = p.Messages.Select(m => (RequireText(m.Role, 16, "Role"), RequireText(m.Content, 4000, "Message"))).ToList();
            var requestId = RequireText(p.RequestId, 40, "Request id");
            var context = OllamaService_BuildContext();
            _ = Task.Run(async () =>
            {
                try { await Ai.ChatAsync(requestId, history, context); }
                catch (BridgeException ex) { _events.Emit("ai.chat", new { requestId, done = true, error = ex.Message }); }
            });
            return Task.FromResult<object?>(true);
        });
        Dispatcher.Register("ai.cancelChat", _ => { Ai.CancelChat(); return Task.FromResult<object?>(true); });
        Dispatcher.Register<QueryParams>("ai.parseQuery", async (p, ct) =>
        {
            var query = RequireText(p.Query, 300, "Query");
            var genres = Library.Snapshot().Games.SelectMany(g => g.Genres).Distinct().ToList();
            try { return await Ai.ParseQueryAsync(query, genres, ct); }
            catch (HttpRequestException) { throw new BridgeException("unavailable", "Ollama isn't responding."); }
        });
    }

    private string OllamaService_BuildContext() => OllamaService.BuildLibraryContext(Library.Snapshot());
}
