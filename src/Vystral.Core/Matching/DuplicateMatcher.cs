using Vystral.Core.Domain;

namespace Vystral.Core.Matching;

public enum MatchReason
{
    None,
    SameInstallation,
    ManualLink,
    SharedSteamAppId,
    ExactTitle,
}

public sealed record MatchDecision(string? GameId, MatchReason Reason);

/// <summary>A pair of games that look related but were deliberately NOT merged automatically.</summary>
public sealed record DuplicateSuggestion(string GameIdA, string GameIdB, string Explanation);

/// <summary>Snapshot of an existing game used for matching.</summary>
public sealed record MatchCandidate(
    string GameId,
    string Title,
    string? SteamAppId,
    IReadOnlyCollection<(PlatformId Platform, string PlatformGameId)> Installations);

/// <summary>
/// Conservative cross-store duplicate detection. Evidence, strongest first:
/// existing installation identity → shared Steam appid → identical normalized title incl. edition.
/// Fuzzy similarity alone never merges; it only produces suggestions for the user to confirm.
/// </summary>
public sealed class DuplicateMatcher
{
    private readonly Dictionary<(PlatformId, string), string> _byInstallation = new();
    private readonly Dictionary<string, string> _bySteamAppId = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<MatchCandidate>> _byFullTitle = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<MatchCandidate>> _byBaseTitle = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<PlatformId>> _platforms = new(StringComparer.Ordinal);

    public DuplicateMatcher(IEnumerable<MatchCandidate> existing)
    {
        foreach (var c in existing) Add(c);
    }

    public void Add(MatchCandidate candidate)
    {
        foreach (var inst in candidate.Installations) Register(candidate.GameId, inst.Platform, inst.PlatformGameId);
        if (!string.IsNullOrEmpty(candidate.SteamAppId)) _bySteamAppId.TryAdd(candidate.SteamAppId, candidate.GameId);
        var norm = TitleNormalizer.Normalize(candidate.Title);
        if (norm.Base.Length == 0) return;
        GetList(_byFullTitle, norm.Full).Add(candidate);
        GetList(_byBaseTitle, norm.Base).Add(candidate);
    }

    public MatchDecision Match(DiscoveredInstallation found)
    {
        if (_byInstallation.TryGetValue((found.Platform, found.PlatformGameId), out var existing))
            return new(existing, MatchReason.SameInstallation);

        if (!string.IsNullOrEmpty(found.SteamAppId) && _bySteamAppId.TryGetValue(found.SteamAppId, out var bySteam)
            && !HasPlatform(bySteam, found.Platform))
            return new(bySteam, MatchReason.SharedSteamAppId);

        var norm = TitleNormalizer.Normalize(found.Title);
        if (norm.Base.Length > 0 && _byFullTitle.TryGetValue(norm.Full, out var sameTitle))
        {
            // Two different items on the *same* store with the same title are almost always
            // different products (e.g. a legacy and a current release), so never merge those.
            var target = sameTitle.FirstOrDefault(c => !HasPlatform(c.GameId, found.Platform));
            if (target is not null) return new(target.GameId, MatchReason.ExactTitle);
        }

        return new(null, MatchReason.None);
    }

    /// <summary>Records that an installation now belongs to a game (used while reconciling a scan).</summary>
    public void Register(string gameId, PlatformId platform, string platformGameId, string? steamAppId = null)
    {
        _byInstallation[(platform, platformGameId)] = gameId;
        if (!_platforms.TryGetValue(gameId, out var set)) _platforms[gameId] = set = [];
        set.Add(platform);
        if (!string.IsNullOrEmpty(steamAppId)) _bySteamAppId.TryAdd(steamAppId, gameId);
    }

    /// <summary>Games sharing a base title but differing in edition/platform evidence.</summary>
    public IReadOnlyList<DuplicateSuggestion> Suggestions()
    {
        var result = new List<DuplicateSuggestion>();
        foreach (var (baseTitle, group) in _byBaseTitle)
        {
            var distinct = group.DistinctBy(c => c.GameId).ToList();
            for (var i = 0; i < distinct.Count; i++)
            for (var j = i + 1; j < distinct.Count; j++)
            {
                result.Add(new(distinct[i].GameId, distinct[j].GameId,
                    $"Both titles reduce to “{baseTitle}” but differ in edition or store, so they were kept separate."));
            }
        }
        return result;
    }

    private bool HasPlatform(string gameId, PlatformId platform) =>
        _platforms.TryGetValue(gameId, out var set) && set.Contains(platform);

    private static List<MatchCandidate> GetList(Dictionary<string, List<MatchCandidate>> map, string key)
    {
        if (!map.TryGetValue(key, out var list)) map[key] = list = [];
        return list;
    }
}
