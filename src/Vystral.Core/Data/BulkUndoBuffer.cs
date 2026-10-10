namespace Vystral.Core.Data;

/// <summary>
/// Track D1: the last few Library bulk changes, kept in memory so their Undo can restore exactly what the database
/// held (the page only ever holds an opaque token, never the previous values). Each token works once, for a limited
/// time; the oldest entries make room for new ones. Thread-safe.
/// </summary>
public sealed class BulkUndoBuffer(int capacity = 8, TimeSpan? lifetime = null, Func<DateTimeOffset>? clock = null)
{
    public static readonly TimeSpan DefaultLifetime = TimeSpan.FromMinutes(15);

    private readonly Lock _lock = new();
    private readonly LinkedList<(string Token, BulkAction Action, IReadOnlyList<BulkBefore> Before, DateTimeOffset At)> _entries = new();
    private readonly TimeSpan _lifetime = lifetime ?? DefaultLifetime;
    private readonly Func<DateTimeOffset> _clock = clock ?? (() => DateTimeOffset.UtcNow);

    /// <summary>Keeps a change for undo; returns its token (32 hex characters).</summary>
    public string Add(BulkAction action, IReadOnlyList<BulkBefore> before)
    {
        var token = LibraryRepository.NewId();
        lock (_lock)
        {
            _entries.AddLast((token, action, before, _clock()));
            while (_entries.Count > Math.Max(1, capacity)) _entries.RemoveFirst();
        }
        return token;
    }

    /// <summary>Removes and returns the change for <paramref name="token"/>, or null when it's unknown, used or expired.</summary>
    public (BulkAction Action, IReadOnlyList<BulkBefore> Before)? Take(string token)
    {
        lock (_lock)
        {
            for (var node = _entries.First; node is not null; node = node.Next)
            {
                if (!string.Equals(node.Value.Token, token, StringComparison.Ordinal)) continue;
                _entries.Remove(node);
                return _clock() - node.Value.At > _lifetime ? null : (node.Value.Action, node.Value.Before);
            }
        }
        return null;
    }
}
