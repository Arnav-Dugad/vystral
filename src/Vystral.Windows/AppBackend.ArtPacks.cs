using Vystral.Core.Domain;
using Vystral.Windows.Bridge;
using Vystral.Windows.DataSources;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track N parameter records.
public sealed record ArtPackParams(string Preset, IReadOnlyList<string>? Kinds, string? Scope, bool? ReplaceMine);
public sealed record ArtPackSampleParams(string GameId, string Preset, string Kind);
public sealed record ArtPackIdParams(string Id);

/// <summary>
/// Track N: art packs — one SteamGridDB style across the library as an undoable background job.
/// Needs the data-source handlers (SteamGridDB key, transport) first.
/// </summary>
public sealed partial class AppBackend
{
    private ArtPackService? _artPacks;
    public ArtPackService ArtPacks => _artPacks ?? throw new InvalidOperationException("Art packs are not initialised yet.");

    private void RegisterArtPackHandlers()
    {
        _artPacks = new ArtPackService(Repository, Artwork, _dataSources.SteamGridDb, _dataSources.TransportFor("steamgriddb"),
            new ArtPackManifestStore(Path.Combine(Paths.Root, "artpacks")), ArtPackBlock, ArtPackGames, _life.Token)
        {
            OnProgress = job => _events.Emit("artPacks.progress", job),
            OnArtChanged = () => _events.Emit("library.changed", new { reason = "artwork" }),
        };

        Dispatcher.Register("artPacks.status", _ => Task.FromResult<object?>(ArtPacks.Status()));
        Dispatcher.Register<ArtPackParams>("artPacks.plan", (p, _) => Task.FromResult<object?>(Wrap(() => ArtPacks.Plan(ArtPackRequestFrom(p)))));
        Dispatcher.Register<ArtPackSampleParams>("artPacks.sample", async (p, ct) =>
            await Run(() => ArtPacks.SampleAsync(RequireId(p.GameId), RequirePreset(p.Preset), RequireArtPackKind(p.Kind), ct)));
        Dispatcher.Register<ArtPackParams>("artPacks.start", (p, _) => Task.FromResult<object?>(Wrap(() => ArtPacks.Start(ArtPackRequestFrom(p)))));
        Dispatcher.Register("artPacks.pause", _ => Task.FromResult<object?>(ArtPacks.Pause()));
        Dispatcher.Register("artPacks.resume", _ => Task.FromResult<object?>(ArtPacks.Resume()));
        Dispatcher.Register("artPacks.cancel", _ => Task.FromResult<object?>(ArtPacks.Cancel()));
        Dispatcher.Register<ArtPackIdParams>("artPacks.restore", (p, _) =>
        {
            if (!ArtPackManifestStore.IsId(p.Id)) throw new BridgeException("invalid", "Invalid art pack.");
            return Task.FromResult<object?>(Wrap(() => ArtPacks.Restore(p.Id)));
        });
    }

    private string? ArtPackBlock() =>
        !_dataSources.HasKey(KeyedProvider.SteamGridDb) ? "notConfigured"
        : Settings.GetBool("privacy.localOnly") ? "offline"
        : SafeMode ? "safeMode"
        : _dataSources.DataSaver ? "dataSaver"
        : IsGameActive ? "gameRunning"
        : null;

    private IReadOnlyList<ArtPackGame> ArtPackGames() =>
        Library.Snapshot().Games.Select(g => new ArtPackGame(
            g.Id, g.Title, g.Hidden, g.Installations.Any(i => i.State == "installed"), g.Favorite,
            new[] { g.LastTrackedPlay }.Concat(g.Installations.Select(i => i.ImportedLastPlayed)).Where(s => s is not null).DefaultIfEmpty(null).Max(StringComparer.Ordinal),
            g.Installations.Select(i => i.Platform.ToLowerInvariant()).Distinct().ToList(), g.Collections)).ToList();

    private static ArtPackRequest ArtPackRequestFrom(ArtPackParams p)
    {
        var preset = RequirePreset(p.Preset);
        var kinds = (p.Kinds ?? []).Take(4).Select(RequireArtPackKind).Distinct().ToList();
        if (kinds.Count == 0) throw new BridgeException("invalid", "Choose at least one kind of artwork.");
        var scope = ArtPackScope.Parse(p.Scope ?? "all") ?? throw new BridgeException("invalid", "Unknown selection of games.");
        return new ArtPackRequest(preset, kinds, scope, p.ReplaceMine ?? false);
    }

    private static ArtPackPreset RequirePreset(string? id) => ArtPackPresets.Find(id) ?? throw new BridgeException("invalid", "Unknown art pack style.");

    private static ArtworkKind RequireArtPackKind(string? kind) =>
        Enum.TryParse<ArtworkKind>(kind, true, out var k) && ArtPackPresets.Slots.Contains(k) ? k : throw new BridgeException("invalid", "Unknown artwork type.");
}
