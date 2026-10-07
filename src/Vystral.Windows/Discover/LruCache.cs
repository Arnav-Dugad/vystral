namespace Vystral.Windows.Discover;

/// <summary>A small thread-safe least-recently-used cache with an optional time to live. Memory only.</summary>
public sealed class LruCache<TKey, TValue>(int capacity, TimeSpan? ttl = null, Func<DateTimeOffset>? clock = null) where TKey : notnull
{
    private readonly Dictionary<TKey, LinkedListNode<(TKey Key, TValue Value, DateTimeOffset At)>> _map = [];
    private readonly LinkedList<(TKey Key, TValue Value, DateTimeOffset At)> _order = new();
    private readonly Lock _lock = new();
    private readonly Func<DateTimeOffset> _clock = clock ?? (() => DateTimeOffset.UtcNow);

    public int Count
    {
        get { lock (_lock) return _map.Count; }
    }

    public bool TryGet(TKey key, out TValue value)
    {
        lock (_lock)
        {
            if (_map.TryGetValue(key, out var node))
            {
                if (ttl is { } t && _clock() - node.Value.At > t)
                {
                    _order.Remove(node);
                    _map.Remove(key);
                }
                else
                {
                    _order.Remove(node);
                    _order.AddFirst(node);
                    value = node.Value.Value;
                    return true;
                }
            }
            value = default!;
            return false;
        }
    }

    public TValue? Get(TKey key) => TryGet(key, out var v) ? v : default;

    public void Set(TKey key, TValue value)
    {
        lock (_lock)
        {
            if (_map.TryGetValue(key, out var existing)) _order.Remove(existing);
            var node = _order.AddFirst((key, value, _clock()));
            _map[key] = node;
            while (_map.Count > capacity && _order.Last is { } last)
            {
                _order.RemoveLast();
                _map.Remove(last.Value.Key);
            }
        }
    }

    public void Remove(TKey key)
    {
        lock (_lock)
        {
            if (_map.Remove(key, out var node)) _order.Remove(node);
        }
    }

    public void Clear()
    {
        lock (_lock)
        {
            _map.Clear();
            _order.Clear();
        }
    }
}
