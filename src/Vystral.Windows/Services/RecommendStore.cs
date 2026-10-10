using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Windows.Discover;

namespace Vystral.Windows.Services;

/// <summary>One "Not interested" (Track D5): what was dismissed, its feature keys (so suggestions learn), and when.</summary>
public sealed record RecommendDismissal(string Key, string Title, IReadOnlyList<string> Features, string At);

/// <summary>
/// Track D5: the "Not interested" list for recommend.v2. Stored as ui-state/recommend.json in the data folder (not the
/// database or settings: no migration, survives a settings reset, never leaves this PC). Small, validated and capped;
/// an unreadable file starts a fresh list instead of failing.
/// </summary>
public sealed partial class RecommendStore(string dataRoot)
{
    public const int MaxItems = 500;
    public const int MaxFeatures = 12;
    public const int MaxTitle = 200;

    private sealed record FileModel(int Version, List<RecommendDismissal> Items);

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly Lock _lock = new();
    private string FilePath => Path.Combine(dataRoot, "ui-state", "recommend.json");

    /// <summary>Library games, and Track D4's giveaway ids (FreebiesService.ItemId).</summary>
    [GeneratedRegex(@"\A(?:game:[0-9a-f]{32}|free:(?:gp-[0-9]{1,9}|epic-[0-9a-f]{16,32}))\z")]
    private static partial Regex GameOrFreeKey();

    /// <summary>Feature keys: k: (genre or tag), s: (series) or d: (developer), then 1–48 printable characters.</summary>
    [GeneratedRegex(@"\A[ksd]:[^\p{C}]{1,48}\z")]
    private static partial Regex FeatureKey();

    public static bool IsKey(string? key) =>
        key is not null && (GameOrFreeKey().IsMatch(key) || (key.StartsWith("discover:", StringComparison.Ordinal) && DiscoverKeys.IsKey(key["discover:".Length..])));

    public static bool IsFeature(string? f) => f is not null && FeatureKey().IsMatch(f);

    /// <summary>Newest first.</summary>
    public IReadOnlyList<RecommendDismissal> List()
    {
        lock (_lock) return Read();
    }

    public IReadOnlyList<RecommendDismissal> Dismiss(string key, string title, IEnumerable<string>? features, DateTimeOffset now)
    {
        if (!IsKey(key)) throw new ArgumentException("Unknown item.");
        var cleanTitle = CleanTitle(title) ?? throw new ArgumentException("Invalid title.");
        var cleanFeatures = (features ?? []).Where(IsFeature).Distinct(StringComparer.Ordinal).Take(MaxFeatures).ToList();
        lock (_lock)
        {
            var list = Read().Where(d => d.Key != key).ToList();
            list.Insert(0, new RecommendDismissal(key, cleanTitle, cleanFeatures, now.ToUniversalTime().ToString("O")));
            if (list.Count > MaxItems) list.RemoveRange(MaxItems, list.Count - MaxItems);
            Write(list);
            return list;
        }
    }

    public IReadOnlyList<RecommendDismissal> Undismiss(string key)
    {
        if (!IsKey(key)) throw new ArgumentException("Unknown item.");
        lock (_lock)
        {
            var list = Read().Where(d => d.Key != key).ToList();
            Write(list);
            return list;
        }
    }

    public void Clear()
    {
        lock (_lock) Write([]);
    }

    private static string? CleanTitle(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return null;
        var t = title.Trim();
        if (t.Length > MaxTitle) t = t[..MaxTitle];
        return t.Any(char.IsControl) ? null : t;
    }

    private List<RecommendDismissal> Read()
    {
        try
        {
            if (!File.Exists(FilePath)) return [];
            var info = new FileInfo(FilePath);
            if (info.Length > 512 * 1024) throw new InvalidDataException("Too large.");
            var model = JsonSerializer.Deserialize<FileModel>(File.ReadAllText(FilePath), Json);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var items = new List<RecommendDismissal>();
            foreach (var d in model?.Items ?? [])
            {
                if (d is null || !IsKey(d.Key) || !seen.Add(d.Key)) continue;
                var title = CleanTitle(d.Title);
                if (title is null || !DateTimeOffset.TryParse(d.At, out _)) continue;
                items.Add(new RecommendDismissal(d.Key, title, (d.Features ?? []).Where(IsFeature).Distinct(StringComparer.Ordinal).Take(MaxFeatures).ToList(), d.At));
                if (items.Count >= MaxItems) break;
            }
            return items;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException or InvalidDataException or NotSupportedException)
        {
            Log.Warn("recommend", "\"Not interested\" list unreadable; starting fresh", ex: ex);
            return [];
        }
    }

    private void Write(List<RecommendDismissal> items)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(new FileModel(1, items), Json));
            File.Move(tmp, FilePath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn("recommend", "Couldn't save the \"Not interested\" list", ex: ex);
            throw new IOException("VYSTRAL couldn’t save the list. Check that the data folder isn’t read-only.", ex);
        }
    }
}
