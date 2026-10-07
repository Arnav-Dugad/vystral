using System.Globalization;
using System.Text;
using Vystral.Core.Matching;

namespace Vystral.Windows.Discover;

/// <summary>A library game as Discover sees it (for "In your library").</summary>
public sealed record DiscoverLibraryGame(string GameId, string Title, string? SteamAppId, int? Year);

/// <summary>The library, indexed once (normalizing thousands of titles per keystroke would be wasteful).</summary>
public sealed class DiscoverLibraryIndex
{
    public static readonly DiscoverLibraryIndex Empty = Build([]);

    private readonly Dictionary<string, DiscoverLibraryGame> _bySteam = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<DiscoverLibraryGame>> _byTitle = new(StringComparer.Ordinal);

    public int Count { get; private set; }

    public static DiscoverLibraryIndex Build(IEnumerable<DiscoverLibraryGame> games)
    {
        var index = new DiscoverLibraryIndex();
        foreach (var g in games)
        {
            index.Count++;
            if (g.SteamAppId is { } s) index._bySteam.TryAdd(s, g);
            var key = DiscoverMerger.Norm(g.Title);
            if (key.Length == 0) continue;
            if (!index._byTitle.TryGetValue(key, out var list)) index._byTitle[key] = list = [];
            list.Add(g);
        }
        return index;
    }

    public DiscoverLibraryGame? BySteam(string appId) => _bySteam.GetValueOrDefault(appId);

    public IReadOnlyList<DiscoverLibraryGame> ByTitle(string normalized) => _byTitle.TryGetValue(normalized, out var l) ? l : [];
}

/// <summary>A merged search result before it becomes a DTO (keeps every image candidate and ID for the page).</summary>
public sealed class DiscoverEntry
{
    public required string Key { get; set; }
    public required string Title { get; set; }
    public int? Year { get; set; }
    public string? ReleaseDate { get; set; }
    public DiscoverIds Ids { get; set; } = new();
    public List<string> Stores { get; } = [];
    public List<string> Platforms { get; } = [];
    public List<string> Genres { get; } = [];
    public List<string> Sources { get; } = [];
    public List<DiscoverImage> Images { get; } = [];
    public StorePrice? Price { get; set; }
    public string Kind { get; set; } = "game";
    public string? LibraryGameId { get; set; }
    public double Score { get; set; }
    public int BestRank { get; set; } = int.MaxValue;
    public int Popularity { get; set; }
    internal string Normalized { get; set; } = "";
    internal string TitleSource { get; set; } = "";
    internal List<DiscoverHit> Hits { get; } = [];
}

/// <summary>
/// Merges and de-duplicates answers from several sources, conservatively:
/// <list type="number">
/// <item>Hits that share a strong identifier (Steam app ID, IGDB ID or slug, RAWG slug, Wikidata item) are the same game,
/// unless another identifier of the same kind disagrees. Wikidata hits often carry several IDs, so they can join groups.</item>
/// <item>Otherwise, a hit joins a group from <em>another</em> source with an identical normalized title (edition words
/// included) when both release years are known and within one year of each other, or when one year is unknown and that
/// title is unambiguous (exactly one candidate group, and the incoming source has only one hit with that title).</item>
/// <item>Two hits from the same source are never merged by title, and nothing with conflicting IDs is ever merged.</item>
/// </list>
/// Library games are matched by Steam app ID, else by an exact normalized title whose years agree (or are unknown).
/// </summary>
public static class DiscoverMerger
{
    public const int MaxResults = 300;

    public static List<DiscoverEntry> Merge(IEnumerable<DiscoverHit> hits, string query, DiscoverLibraryIndex library)
    {
        var ordered = hits
            .OrderBy(h => h.Source == DiscoverSources.Wikidata ? 1 : 0) // Wikidata last: it carries the IDs that glue other groups together
            .ThenBy(h => DiscoverSources.Priority(h.Source))
            .ThenBy(h => h.Rank)
            .ToList();
        var titleCounts = ordered.GroupBy(h => (h.Source, Norm(h.Title))).ToDictionary(g => g.Key, g => g.Count());
        var groups = new List<DiscoverEntry>();

        foreach (var hit in ordered)
        {
            var norm = Norm(hit.Title);
            // 1. Strong identifiers.
            var byId = groups.Where(g => g.Ids.SharesWith(hit.Ids) && !g.Ids.ConflictsWith(hit.Ids)).ToList();
            DiscoverEntry? target = null;
            if (byId.Count > 0)
            {
                target = byId[0];
                // A hit that links several groups glues them together when nothing disagrees.
                foreach (var other in byId.Skip(1))
                {
                    if (target.Ids.ConflictsWith(other.Ids) || target.Sources.Intersect(other.Sources).Any(s => !SameIdentity(target, other, s))) continue;
                    foreach (var h in other.Hits) Add(target, h);
                    groups.Remove(other);
                }
            }
            // 2. Careful title + year.
            if (target is null && norm.Length > 0)
            {
                var candidates = groups.Where(g => g.Normalized == norm && !g.Sources.Contains(hit.Source) && !g.Ids.ConflictsWith(hit.Ids)).ToList();
                var yearMatches = candidates.Where(g => g.Year is { } gy && hit.Year is { } hy && Math.Abs(gy - hy) <= 1).ToList();
                if (yearMatches.Count == 1) target = yearMatches[0];
                else if (yearMatches.Count == 0 && candidates.Count == 1 && titleCounts[(hit.Source, norm)] == 1 &&
                         (candidates[0].Year is null || hit.Year is null) &&
                         groups.Count(g => g.Normalized == norm) == 1)
                    target = candidates[0];
            }
            if (target is null)
            {
                target = new DiscoverEntry { Key = "", Title = hit.Title, Normalized = norm, TitleSource = hit.Source };
                groups.Add(target);
            }
            Add(target, hit);
        }

        foreach (var g in groups)
        {
            g.Key = DiscoverKeys.KeyFor(g.Ids, g.Hits[0].Source, g.Hits[0].SourceId);
            g.LibraryGameId = MatchLibrary(g, library);
            g.Score = Score(g, query);
        }
        // One result per key (two groups can end up with the same key only through identical IDs, which step 1 prevents; be safe).
        return groups
            .GroupBy(g => g.Key, StringComparer.Ordinal).Select(x => x.First())
            .OrderByDescending(g => g.LibraryGameId is not null)
            .ThenByDescending(g => g.Score)
            .ThenBy(g => g.BestRank)
            .ThenBy(g => g.Title, StringComparer.OrdinalIgnoreCase)
            .Take(MaxResults)
            .ToList();
    }

    private static bool SameIdentity(DiscoverEntry a, DiscoverEntry b, string source) =>
        a.Hits.Where(h => h.Source == source).Select(h => h.SourceId).Order().SequenceEqual(b.Hits.Where(h => h.Source == source).Select(h => h.SourceId).Order());

    private static void Add(DiscoverEntry g, DiscoverHit hit)
    {
        if (g.Hits.Any(h => h.Source == hit.Source && h.SourceId == hit.SourceId)) return;
        g.Hits.Add(hit);
        g.Ids = g.Ids.Merge(hit.Ids);
        if (!g.Sources.Contains(hit.Source)) g.Sources.Add(hit.Source);
        g.Sources.Sort((a, b) => DiscoverSources.Priority(a).CompareTo(DiscoverSources.Priority(b)));
        // The most trusted source names the game and dates it.
        if (DiscoverSources.Priority(hit.Source) < DiscoverSources.Priority(g.TitleSource))
        {
            g.Title = hit.Title;
            g.TitleSource = hit.Source;
            g.Normalized = Norm(hit.Title);
        }
        if (hit.Year is not null && (g.Year is null || hit.Source != DiscoverSources.Rawg && hit.ReleaseDate is not null && g.ReleaseDate is null))
        {
            g.Year = hit.Year;
            g.ReleaseDate = hit.ReleaseDate ?? g.ReleaseDate;
        }
        foreach (var s in hit.Stores) if (!g.Stores.Contains(s)) g.Stores.Add(s);
        foreach (var s in DiscoverParsers.StoresOf(hit.Ids)) if (!g.Stores.Contains(s)) g.Stores.Add(s);
        foreach (var p in hit.Platforms) if (!g.Platforms.Contains(p) && g.Platforms.Count < 8) g.Platforms.Add(p);
        foreach (var x in hit.Genres) if (!g.Genres.Contains(x, StringComparer.OrdinalIgnoreCase) && g.Genres.Count < 6) g.Genres.Add(x);
        foreach (var i in hit.Images) if (!g.Images.Contains(i) && g.Images.Count < 16) g.Images.Add(i);
        g.Price ??= hit.Price;
        if (hit.Kind == "game") g.Kind = "game";
        else if (g.Hits.Count == 1) g.Kind = hit.Kind;
        g.BestRank = Math.Min(g.BestRank, hit.Rank);
        g.Popularity = Math.Max(g.Popularity, hit.Popularity);
    }

    private static string? MatchLibrary(DiscoverEntry g, DiscoverLibraryIndex library)
    {
        if (g.Ids.Steam is { } appId && library.BySteam(appId) is { } bySteam) return bySteam.GameId;
        // A library game with a different Steam app ID is a different game, whatever its title.
        var candidates = library.ByTitle(g.Normalized).Where(l => l.SteamAppId is null || g.Ids.Steam is null).ToList();
        if (candidates.Count != 1) return null;
        var c = candidates[0];
        return c.Year is { } ly && g.Year is { } gy && Math.Abs(ly - gy) > 1 ? null : c.GameId;
    }

    /// <summary>Relevance to the typed text (exact &gt; prefix &gt; word prefix &gt; every word &gt; contains), then agreement and the sources' own order.</summary>
    internal static double Score(DiscoverEntry g, string query)
    {
        var t = Simple(g.Title);
        var q = Simple(query);
        double text;
        if (q.Length == 0) text = 50;
        else if (t == q) text = 100;
        else if (t.StartsWith(q, StringComparison.Ordinal)) text = 90 - Math.Min(20, t.Length - q.Length) * 0.2;
        else
        {
            var words = t.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var qWords = q.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (words.Any(w => w.StartsWith(q, StringComparison.Ordinal))) text = 75;
            else if (qWords.All(qw => words.Any(w => w.StartsWith(qw, StringComparison.Ordinal)))) text = 70;
            else if (t.Contains(q, StringComparison.Ordinal)) text = 55;
            else text = 30; // the source matched it some other way (an alternative name, a typo it forgave)
        }
        var agreement = (g.Sources.Count - 1) * 4;
        var rank = Math.Max(0, 8 - g.BestRank);
        var popularity = Math.Min(6, Math.Log10(1 + g.Popularity) * 1.5);
        var extra = g.Kind == "extra" ? -25 : 0;
        return Math.Round(text + agreement + rank + popularity + extra, 2);
    }

    /// <summary>Case, accents, symbols and roman numerals folded, for relevance only (matching uses <see cref="TitleNormalizer"/>).</summary>
    internal static string Simple(string s)
    {
        var lower = TitleNormalizer.Normalize(s).Original.ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(lower.Length);
        foreach (var c in lower)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark) continue;
            sb.Append(char.IsLetterOrDigit(c) ? c : ' ');
        }
        var words = sb.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(w => w switch
        {
            "ii" => "2", "iii" => "3", "iv" => "4", "v" => "5", "vi" => "6", "vii" => "7", "viii" => "8", "ix" => "9", "x" => "10",
            _ => w,
        });
        return string.Join(' ', words);
    }

    internal static string Norm(string title) => TitleNormalizer.Normalize(title).Full;
}
