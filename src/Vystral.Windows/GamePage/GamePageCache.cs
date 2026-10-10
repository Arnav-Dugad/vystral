using Vystral.Windows.Services;

namespace Vystral.Windows.GamePage;

/// <summary>
/// Track C4: one small JSON cache file holding entries by key (no database migration). Reads are size-capped and
/// validated by the owner on the way in (the file sits in a user-writable folder); writes are atomic and trim the
/// oldest entries beyond <paramref name="maxEntries"/>.
/// </summary>
internal sealed class GamePageCache<TEntry>(string path, int maxEntries, long maxBytes, Func<TEntry, DateTimeOffset> fetchedOf,
    Func<Dictionary<string, TEntry>, Dictionary<string, TEntry>> validate) where TEntry : class
{
    public sealed class FileShape
    {
        public int Version { get; set; } = 1;
        public Dictionary<string, TEntry> Entries { get; set; } = [];
    }

    private readonly Lock _lock = new();
    private Dictionary<string, TEntry>? _entries;

    private Dictionary<string, TEntry> Load()
    {
        if (_entries is not null) return _entries;
        var file = JsonFileCache.Read<FileShape>(path, maxBytes);
        _entries = file is { Version: 1, Entries: not null } ? validate(file.Entries) : [];
        return _entries;
    }

    public TEntry? Get(string key)
    {
        lock (_lock) return Load().GetValueOrDefault(key);
    }

    public IReadOnlyDictionary<string, TEntry> All()
    {
        lock (_lock) return new Dictionary<string, TEntry>(Load(), StringComparer.Ordinal);
    }

    public void Set(string key, TEntry entry) => SetMany([new(key, entry)]);

    public void SetMany(IEnumerable<KeyValuePair<string, TEntry>> items)
    {
        lock (_lock)
        {
            var map = Load();
            foreach (var (k, v) in items) map[k] = v;
            if (map.Count > maxEntries)
                foreach (var old in map.OrderBy(kv => fetchedOf(kv.Value)).Take(map.Count - maxEntries).Select(kv => kv.Key).ToList())
                    map.Remove(old);
            JsonFileCache.Write(path, new FileShape { Entries = map });
        }
    }

    public void Clear()
    {
        lock (_lock)
        {
            _entries = [];
            JsonFileCache.Delete(path);
        }
    }
}

internal static class GamePageIds
{
    public static bool IsAppId(string? s) => s is { Length: > 0 and <= 10 } && s.All(char.IsAsciiDigit) && s[0] != '0';

    /// <summary>"Steam asked us to slow down" and friends, as the short status words the page understands.</summary>
    public static string Status(DataSources.DataSourceOutcome outcome) => outcome switch
    {
        DataSources.DataSourceOutcome.RateLimited => "rateLimited",
        DataSources.DataSourceOutcome.InvalidKey => "invalidKey",
        DataSources.DataSourceOutcome.Offline => "offline",
        _ => "unavailable",
    };
}
