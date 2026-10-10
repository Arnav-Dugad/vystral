using Vystral.Core.Data;
using Vystral.Windows.Bridge;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

/// <param name="Action">status | favorite | hidden | collection | played.</param>
/// <param name="Value">On or off, for every action except status.</param>
public sealed record BulkEditParams(IReadOnlyList<string> GameIds, string Action, string? Status, bool? Value, string? CollectionId);

public sealed record BulkUndoParams(string Token);

// Track D1: Library bulk actions with a one-step undo, and the game versions the update timeline shows.
public sealed partial class AppBackend
{
    private readonly BulkUndoBuffer _bulkUndo = new();

    private void RegisterTrackD1Handlers()
    {
        Dispatcher.Register<BulkEditParams>("library.bulkEdit", (p, _) =>
        {
            if (p.GameIds is not { Count: > 0 }) throw new BridgeException("invalid", "Choose at least one game.");
            if (p.GameIds.Count > LibraryRepository.MaxBulkGames)
                throw new BridgeException("invalid", $"That’s more than {LibraryRepository.MaxBulkGames:N0} games. Narrow the selection and try again.");
            var ids = p.GameIds.Select(id => RequireId(id)).ToList();
            var action = ParseBulkAction(p);
            BulkResult result;
            try { result = Repository.BulkEdit(ids, action); }
            catch (BulkEditRefusedException ex) { throw new BridgeException("invalid", ex.Message); }
            var token = result.Changed > 0 ? _bulkUndo.Add(action, result.Before) : null;
            if (result.Changed > 0) _events.Emit("library.changed", new { reason = "bulk" });
            return Task.FromResult<object?>(new { token, requested = result.Requested, found = result.Found, changed = result.Changed });
        });

        Dispatcher.Register<BulkUndoParams>("library.bulkUndo", (p, _) =>
        {
            var entry = _bulkUndo.Take(RequireId(p.Token, "undo token"))
                        ?? throw new BridgeException("expired", "That change can’t be undone any more. Change the games back from the Library.");
            var restored = Repository.BulkRestore(entry.Action, entry.Before);
            _events.Emit("library.changed", new { reason = "bulk" });
            return Task.FromResult<object?>(new { restored });
        });

        // Steam builds and Xbox package versions VYSTRAL saw for this game's copies (recorded after scans), oldest first.
        Dispatcher.Register<GameIdParams>("versions.history", (p, _) =>
            Task.FromResult<object?>(Repository.GetVersionHistory(RequireId(p.GameId))));
    }

    internal static BulkAction ParseBulkAction(BulkEditParams p)
    {
        var kind = p.Action is { } a && BulkAction.Kinds.Contains(a, StringComparer.Ordinal) ? a : throw new BridgeException("invalid", "Unknown action.");
        if (kind == "status")
        {
            var status = p.Status is null ? null : RequireText(p.Status, 16, "Status");
            if (!GameStatus.IsValid(status)) throw new BridgeException("invalid", "Unknown status.");
            return new BulkAction(kind, Status: status);
        }
        var value = p.Value ?? throw new BridgeException("invalid", "Say whether to turn it on or off.");
        return kind == "collection"
            ? new BulkAction(kind, Value: value, CollectionId: RequireId(p.CollectionId, "collection"))
            : new BulkAction(kind, Value: value);
    }
}
