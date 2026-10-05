using Vystral.Core.Data;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

public sealed record SetStatusParams(string GameId, string? Status);

public sealed partial class AppBackend
{
    private TrailerService? _trailers;
    private NetworkCostService? _network;

    /// <summary>Steam trailer lookup and the filtered media proxy (https://media.vystral.example/trailer/…).</summary>
    public TrailerService Trailers => _trailers ?? throw new InvalidOperationException("Trailers are not initialised yet.");

    /// <summary>Game status tracking, trailers, network cost and data saver.</summary>
    private void RegisterStatusHandlers()
    {
        _network = new NetworkCostService();
        _trailers = new TrailerService(Repository, Settings, _network, _http, () => IsGameActive, $"VYSTRAL/{Version}");
        Artwork.SkipDownloads = () => _trailers.DataSaverActive;
        Settings.Changed += key =>
        {
            // Turning data saver off resumes artwork that was deferred while it was on.
            if (key.StartsWith("dataSaver.", StringComparison.Ordinal) && !_trailers.DataSaverActive) Library.StartEnrichment();
        };

        Dispatcher.Register<SetStatusParams>("game.setStatus", (p, _) =>
        {
            var gameId = RequireId(p.GameId);
            var status = p.Status is null ? null : RequireText(p.Status, 16, "Status");
            if (!GameStatus.IsValid(status)) throw new BridgeException("invalid", "Unknown status.");
            var change = Repository.SetStatus(gameId, status) ?? throw new BridgeException("notFound", "That item no longer exists.");
            if (change.Changed) _events.Emit("status.changed", new { gameId, status = change.Status, previous = change.Previous, at = change.ChangedAt });
            return Task.FromResult<object?>(new { status = change.Status, statusChangedAt = change.ChangedAt, previous = change.Previous, changed = change.Changed });
        });

        Dispatcher.Register("status.history", _ => Task.FromResult<object?>(Repository.GetStatusHistory()));

        Dispatcher.Register<GameIdParams>("trailer.get", async (p, ct) => await Trailers.GetAsync(RequireId(p.GameId), ct));

        Dispatcher.Register("network.status", _ =>
        {
            var cost = _network.Current;
            var manual = Settings.GetBool("dataSaver.enabled");
            var metered = Settings.GetBool("dataSaver.onMetered") && cost.Metered;
            return Task.FromResult<object?>(new
            {
                cost.Connected, cost.Metered, cost.CostType, cost.Roaming, cost.OverDataLimit, cost.ApproachingDataLimit,
                dataSaverActive = manual || metered,
                dataSaverReason = manual ? "manual" : metered ? "metered" : null,
            });
        });
    }
}
