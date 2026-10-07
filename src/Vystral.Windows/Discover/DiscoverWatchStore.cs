using System.Globalization;
using System.Text.Json;
using Vystral.Windows.Services;

namespace Vystral.Windows.Discover;

/// <summary>One game on the "Watching" list.</summary>
public sealed record DiscoverWatchItem(string Key, string Title, int? Year, string? SteamAppId, string AddedAt, string? PriceWhenAdded);

/// <summary>
/// Track U: the local "Watching" list for games that aren't in the library, stored as ui-state/discover-watching.json in
/// the data folder (no migration; survives a settings reset). Small, validated on read, capped, written atomically.
/// It never syncs anywhere; Steam wishlist sync is a separate feature.
/// </summary>
public sealed class DiscoverWatchStore(string dataRoot)
{
    public const int MaxItems = 200;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly Lock _lock = new();
    private string FilePath => Path.Combine(dataRoot, "ui-state", "discover-watching.json");

    public IReadOnlyList<DiscoverWatchItem> List()
    {
        lock (_lock) return Read();
    }

    public bool Contains(string key)
    {
        lock (_lock) return Read().Any(i => i.Key == key);
    }

    /// <summary>Adds (or, with <paramref name="on"/> false, removes) a game. Returns the new list.</summary>
    public IReadOnlyList<DiscoverWatchItem> Set(DiscoverWatchItem item, bool on)
    {
        if (!DiscoverKeys.IsKey(item.Key)) throw new ArgumentException("Invalid key.");
        lock (_lock)
        {
            var list = Read().Where(i => i.Key != item.Key).ToList();
            if (on)
            {
                var clean = Clean(item);
                if (clean is null) throw new ArgumentException("Invalid item.");
                list.Insert(0, clean);
                if (list.Count > MaxItems) list = list.Take(MaxItems).ToList();
            }
            Write(list);
            return list;
        }
    }

    private static DiscoverWatchItem? Clean(DiscoverWatchItem i)
    {
        if (!DiscoverKeys.IsKey(i.Key)) return null;
        var title = MetadataService.Clean(i.Title ?? "", 200);
        if (title.Length == 0) return null;
        var steam = i.SteamAppId is { } s && DiscoverKeys.SteamAppId().IsMatch(s) ? s : null;
        var added = DateTimeOffset.TryParse(i.AddedAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var at) ? at.ToString("O") : DateTimeOffset.UtcNow.ToString("O");
        var price = i.PriceWhenAdded is { Length: > 0 } p ? MetadataService.Clean(p, 24) : null;
        return new DiscoverWatchItem(i.Key, title, i.Year is > 1950 and < 2200 ? i.Year : null, steam, added, string.IsNullOrEmpty(price) ? null : price);
    }

    private List<DiscoverWatchItem> Read()
    {
        try
        {
            _unreadable = false;
            if (!File.Exists(FilePath)) return [];
            if (new FileInfo(FilePath).Length > 512 * 1024) throw new IOException("The watching list is unexpectedly large.");
            var items = JsonSerializer.Deserialize<List<DiscoverWatchItem>>(File.ReadAllText(FilePath), Json) ?? [];
            return items.Select(Clean).OfType<DiscoverWatchItem>().DistinctBy(i => i.Key).Take(MaxItems).ToList();
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException or NotSupportedException)
        {
            // Unreadable: show an empty list and leave the file alone (never delete user data as an error response);
            // the next change sets it aside under another name before writing a new list.
            Log.Warn("discover", "Watching list unreadable", ex: ex);
            _unreadable = true;
            return [];
        }
    }

    private bool _unreadable;

    private void Write(List<DiscoverWatchItem> items)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        if (_unreadable && File.Exists(FilePath))
        {
            File.Move(FilePath, Path.Combine(Path.GetDirectoryName(FilePath)!, $"discover-watching.unreadable-{DateTime.UtcNow:yyyyMMddHHmmss}.json"), overwrite: true);
            _unreadable = false;
        }
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(items, Json));
        File.Move(tmp, FilePath, overwrite: true);
    }
}
