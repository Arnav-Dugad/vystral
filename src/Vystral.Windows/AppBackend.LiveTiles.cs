using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

public sealed record LiveLoopParams(string GameId, double? Start, double? Duration, double? Score);

public sealed partial class AppBackend
{
    private LiveTileService? _liveTiles;

    /// <summary>Home live tiles: Steam micro-trailers through the filtered, cached media proxy (https://media.vystral.example/live/…).</summary>
    public LiveTileService LiveTiles => _liveTiles ?? throw new InvalidOperationException("Live tiles are not initialised yet.");

    /// <summary>Track K: live tiles. Needs the trailer service (RegisterStatusHandlers) first.</summary>
    private void RegisterLiveTileHandlers()
    {
        _liveTiles = new LiveTileService(Repository, Settings, Trailers, Path.Combine(Paths.Root, "cache", "live"), () => IsGameActive, $"VYSTRAL/{Version}");
        Dispatcher.Register<GameIdParams>("liveTile.get", async (p, ct) => await LiveTiles.GetAsync(RequireId(p.GameId), ct));
        Dispatcher.Register("liveTile.clearCache", _ => Task.FromResult<object?>(new { freedBytes = LiveTiles.ClearCache() }));
        // Track N: the live-tile director's choice for this game's cached clip (null start = loop it whole).
        Dispatcher.Register<LiveLoopParams>("liveTile.setLoop", (p, _) =>
            Task.FromResult<object?>(LiveTiles.SetLoop(RequireId(p.GameId), p.Start, p.Duration, p.Score ?? 0)));
    }
}
