using System.Text;
using Vystral.Core.Contracts;
using Vystral.Core.Matching;

namespace Vystral.Windows.Ai;

/// <summary>One deterministic reason two entries look alike (<c>Supports</c> = true) or look different (false).</summary>
public sealed record DuplicateFactDto(string Kind, string Text, bool Supports);

public sealed record DuplicateExplanationDto(IReadOnlyList<DuplicateFactDto> Facts, string? Sentence, string? AiLabel, string? Note, AiEngineDto Engine, string? Sent);

/// <summary>
/// Track C5: why the duplicate suggestion thinks two library entries are one game. The facts are computed here
/// (same Steam app ID, the same title once edition words are set aside, release year, developer, stores); a model
/// may only phrase them as one sentence, and without AI the facts are shown as they are.
/// </summary>
public static class DuplicateFacts
{
    public static List<DuplicateFactDto> For(GameDto a, GameDto b, string? steamA, string? steamB)
    {
        var facts = new List<DuplicateFactDto>();
        if (steamA is not null && steamA == steamB)
            facts.Add(new("steamAppId", $"Both point to the same Steam app ({steamA}).", true));

        var na = TitleNormalizer.Normalize(a.Title);
        var nb = TitleNormalizer.Normalize(b.Title);
        if (string.Equals(a.Title.Trim(), b.Title.Trim(), StringComparison.OrdinalIgnoreCase))
            facts.Add(new("title", "The titles are identical.", true));
        else if (na.Base.Length > 0 && na.Base == nb.Base)
            facts.Add(new("title", $"Both titles read “{na.Base}” once edition words are set aside.", true));

        if (!na.EditionTokens.SetEquals(nb.EditionTokens))
        {
            string Ed(NormalizedTitle n) => n.EditionTokens.Count == 0 ? "the standard edition" : $"the {string.Join(" ", n.EditionTokens)} edition";
            facts.Add(new("edition", $"One looks like {Ed(na)}, the other like {Ed(nb)}.", false));
        }

        var ya = Year(a.ReleaseDate);
        var yb = Year(b.ReleaseDate);
        if (ya is not null && ya == yb) facts.Add(new("year", $"Both were released in {ya}.", true));
        else if (ya is not null && yb is not null) facts.Add(new("year", $"Release years differ: {ya} and {yb}.", false));

        if (!string.IsNullOrWhiteSpace(a.Developer) && string.Equals(a.Developer.Trim(), b.Developer?.Trim(), StringComparison.OrdinalIgnoreCase))
            facts.Add(new("developer", $"Same developer: {a.Developer.Trim()}.", true));

        var sa = a.Installations.Select(i => i.Platform).Distinct().ToList();
        var sb = b.Installations.Select(i => i.Platform).Distinct().ToList();
        var shared = sa.Intersect(sb).ToList();
        if (shared.Count > 0)
            facts.Add(new("store", $"Both are on {string.Join(" and ", shared.Select(JournalQuery.PlatformName))}, where they’re listed as separate products.", false));
        else if (sa.Count > 0 && sb.Count > 0)
            facts.Add(new("store", $"They come from different stores: {string.Join(", ", sa.Select(JournalQuery.PlatformName))} and {string.Join(", ", sb.Select(JournalQuery.PlatformName))}.", true));
        return facts;
    }

    private static string? Year(string? date) => date is { Length: >= 4 } d && d[..4].All(char.IsAsciiDigit) ? d[..4] : null;

    public static string Facts(GameDto a, GameDto b, IReadOnlyList<DuplicateFactDto> facts)
    {
        var sb = new StringBuilder();
        sb.Append("Entry A: ").AppendLine(a.Title);
        sb.Append("Entry B: ").AppendLine(b.Title);
        foreach (var f in facts) sb.Append(f.Supports ? "- same: " : "- different: ").AppendLine(f.Text);
        return sb.ToString();
    }
}
