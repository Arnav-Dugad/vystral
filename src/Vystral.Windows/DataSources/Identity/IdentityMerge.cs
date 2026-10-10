using System.Globalization;
using System.Text.RegularExpressions;
using Vystral.Core.Matching;

namespace Vystral.Windows.DataSources.Identity;

/// <summary>The ID kinds the cross-store resolver knows (Track D4).</summary>
public static partial class IdKinds
{
    public const string Steam = "steam";
    public const string Igdb = "igdb";
    public const string Rawg = "rawg";
    public const string Gog = "gog";
    public const string Wikidata = "wikidata";

    public static readonly string[] All = [Steam, Igdb, Rawg, Gog, Wikidata];

    /// <summary>A well-formed value for its kind (every value is checked before it's stored, shown or used in a URL).</summary>
    public static bool IsValid(string kind, string? value) => value is not null && kind switch
    {
        Steam => SteamAppId().IsMatch(value),
        Igdb => IgdbId().IsMatch(value),
        Rawg => RawgId().IsMatch(value),
        Gog => GogId().IsMatch(value),
        Wikidata => Qid().IsMatch(value),
        _ => false,
    };

    public static string Label(string kind) => kind switch
    {
        Steam => "Steam",
        Igdb => "IGDB",
        Rawg => "RAWG",
        Gog => "GOG",
        Wikidata => "Wikidata",
        _ => kind,
    };

    [GeneratedRegex(@"\A[1-9][0-9]{0,9}\z")]
    private static partial Regex SteamAppId();

    [GeneratedRegex(@"\A[1-9][0-9]{0,11}\z")]
    private static partial Regex IgdbId();

    /// <summary>RAWG's numeric ID or its slug (both are accepted by its API).</summary>
    [GeneratedRegex(@"\A[a-z0-9][a-z0-9\-]{0,119}\z")]
    private static partial Regex RawgId();

    [GeneratedRegex(@"\A[1-9][0-9]{0,11}\z")]
    private static partial Regex GogId();

    [GeneratedRegex(@"\AQ[1-9][0-9]{0,11}\z")]
    private static partial Regex Qid();
}

/// <summary>Where a piece of evidence came from. <see cref="Method"/> is a short machine word the page turns into words.</summary>
/// <param name="Source">store | pin | wikidata | igdb | rawg | steam | gog | metadata</param>
/// <param name="Method">native | chosen | storeId | exactTitleYear | exactTitle | editionTitle | crossCheck | earlierMatch</param>
public sealed record IdEvidence(string Kind, string Value, string Source, string Method, double Confidence, string? Name = null, int? Year = null);

/// <summary>One resolved ID with how sure VYSTRAL is.</summary>
/// <param name="Status">native (the store said so) | pinned (you chose) | matched (used automatically) | suggested (shown, not used) | conflict (sources disagree)</param>
public sealed record ResolvedId(string Kind, string Value, double Confidence, string Status, IReadOnlyList<IdEvidence> Evidence, string? Name);

/// <summary>A value the user can pick when fixing a match.</summary>
public sealed record IdCandidate(string Kind, string Value, string? Name, int? Year, double Confidence, IReadOnlyList<string> Sources);

/// <summary>
/// Track D4: turns evidence from several sources into one answer per ID kind, honestly. Pure and unit-tested.
/// <list type="bullet">
/// <item>A store's own ID or the user's choice is certain (1.0) and always wins.</item>
/// <item>Independent sources agreeing on a value add up (1 − Π(1 − cᵢ), one vote per source, capped at 0.99).</item>
/// <item>Two values for the same kind that are both plausible are a <i>conflict</i>: neither is used until the user picks.</item>
/// <item>Only values at or above <see cref="UseThreshold"/> are used automatically; <see cref="SuggestThreshold"/> and up are shown as suggestions.</item>
/// </list>
/// </summary>
public static class IdentityMerge
{
    /// <summary>Confidence from which a matched ID is used for features (labelled as matched).</summary>
    public const double UseThreshold = 0.8;
    /// <summary>Confidence from which a matched ID is shown as a suggestion the user can confirm.</summary>
    public const double SuggestThreshold = 0.6;
    /// <summary>A rival value this likely makes the best one a conflict.</summary>
    public const double ConflictThreshold = 0.6;
    private const double Cap = 0.99;

    public static (IReadOnlyList<ResolvedId> Ids, IReadOnlyList<IdCandidate> Candidates) Merge(IEnumerable<IdEvidence> evidence,
        IReadOnlyDictionary<string, string?>? pins = null)
    {
        var valid = evidence.Where(e => IdKinds.IsValid(e.Kind, e.Value) && double.IsFinite(e.Confidence) && e.Confidence > 0).ToList();
        var ids = new List<ResolvedId>();
        var candidates = new List<IdCandidate>();
        foreach (var kind in IdKinds.All)
        {
            var forKind = valid.Where(e => e.Kind == kind).ToList();
            var groups = forKind.GroupBy(e => e.Value, StringComparer.Ordinal)
                .Select(g => (Value: g.Key, Score: Combine(g), Evidence: (IReadOnlyList<IdEvidence>)g.OrderByDescending(e => e.Confidence).ToList()))
                .OrderByDescending(g => g.Score).ThenBy(g => g.Value, StringComparer.Ordinal).ToList();
            candidates.AddRange(groups.Select(g => new IdCandidate(kind, g.Value, NameOf(g.Evidence), YearOf(g.Evidence), Math.Round(g.Score, 3),
                g.Evidence.Select(e => e.Source).Distinct().ToList())));

            // The user's word is final: a value, or "none" (null) to say this game isn't on that service.
            if (pins is not null && pins.TryGetValue(kind, out var pinned))
            {
                if (pinned is not null && IdKinds.IsValid(kind, pinned))
                {
                    var ev = groups.FirstOrDefault(g => g.Value == pinned).Evidence ?? [];
                    ids.Add(new ResolvedId(kind, pinned, 1.0, "pinned", [new IdEvidence(kind, pinned, "pin", "chosen", 1.0), .. ev], NameOf(ev)));
                }
                continue;
            }
            if (groups.Count == 0) continue;
            var best = groups[0];
            if (best.Evidence.Any(e => e.Method == "native"))
            {
                ids.Add(new ResolvedId(kind, best.Value, 1.0, "native", best.Evidence, NameOf(best.Evidence)));
                continue;
            }
            var rival = groups.Count > 1 ? groups[1].Score : 0;
            if (rival >= ConflictThreshold && best.Score >= SuggestThreshold)
            {
                ids.Add(new ResolvedId(kind, best.Value, Math.Round(best.Score, 3), "conflict", best.Evidence, NameOf(best.Evidence)));
                continue;
            }
            // A weaker rival still costs some certainty.
            var effective = Math.Round(Math.Max(0, best.Score - rival / 2), 3);
            var status = effective >= UseThreshold ? "matched" : effective >= SuggestThreshold ? "suggested" : null;
            if (status is not null) ids.Add(new ResolvedId(kind, best.Value, effective, status, best.Evidence, NameOf(best.Evidence)));
        }
        return (ids, candidates);
    }

    /// <summary>Independent sources add up; the same source twice counts once (its strongest statement).</summary>
    internal static double Combine(IEnumerable<IdEvidence> evidence)
    {
        var bySource = evidence.GroupBy(e => e.Source).Select(g => Math.Clamp(g.Max(e => e.Confidence), 0, 1)).ToList();
        if (bySource.Any(c => c >= 1)) return 1;
        var miss = bySource.Aggregate(1.0, (acc, c) => acc * (1 - c));
        return Math.Min(Cap, 1 - miss);
    }

    private static string? NameOf(IReadOnlyList<IdEvidence> ev) => ev.Select(e => e.Name).FirstOrDefault(n => !string.IsNullOrWhiteSpace(n));
    private static int? YearOf(IReadOnlyList<IdEvidence> ev) => ev.Select(e => e.Year).FirstOrDefault(y => y is not null);

    // ---------- Title matching shared by every title-based source ----------

    /// <summary>How a store/database title compares with the library title: exact, exact but another edition, or not the same.</summary>
    public static string? TitleMatch(string libraryTitle, string candidate)
    {
        var a = TitleNormalizer.Normalize(libraryTitle);
        var b = TitleNormalizer.Normalize(candidate);
        if (a.Base.Length == 0 || a.Base != b.Base) return null;
        return a.Full == b.Full ? "exact" : "edition";
    }

    /// <summary>
    /// Confidence for a title-based match: a unique exact title with an agreeing year (±1) is 0.85, without a year
    /// to compare 0.7, another edition of it 0.1 less; a year that disagrees, or several equally good candidates, is no match.
    /// </summary>
    public static (int Index, double Confidence, string Method)? PickByTitle<T>(string libraryTitle, int? libraryYear, IReadOnlyList<T> hits,
        Func<T, string> name, Func<T, int?> year)
    {
        var scored = hits.Select((h, i) => (i, Match: TitleMatch(libraryTitle, name(h)), Year: year(h))).Where(x => x.Match is not null).ToList();
        if (scored.Count == 0) return null;
        // Exact titles beat other editions; among several exact titles the year must single one out.
        var exact = scored.Where(x => x.Match == "exact").ToList();
        var pool = exact.Count > 0 ? exact : scored;
        if (libraryYear is { } ly)
        {
            var agreeing = pool.Where(x => x.Year is { } y && Math.Abs(y - ly) <= 1).ToList();
            var unknown = pool.Where(x => x.Year is null).ToList();
            if (agreeing.Count == 1)
            {
                var hit = agreeing[0];
                var conf = hit.Match == "exact" ? 0.85 : 0.75;
                // Another candidate with the same title but no year to compare leaves some doubt.
                if (unknown.Count > 0) conf -= 0.15;
                return (hit.i, conf, hit.Match == "exact" ? "exactTitleYear" : "editionTitle");
            }
            if (agreeing.Count > 1) return null;
            if (agreeing.Count == 0 && pool.All(x => x.Year is not null)) return null; // every candidate is from another year
        }
        if (pool.Count != 1) return null;
        var only = pool[0];
        return (only.i, only.Match == "exact" ? 0.7 : 0.6, only.Match == "exact" ? "exactTitle" : "editionTitle");
    }

    /// <summary>The year in a stored release date ("2020-12-10", "2020", "Dec 10, 2020"), if it says one.</summary>
    public static int? YearOf(string? date)
    {
        if (string.IsNullOrWhiteSpace(date)) return null;
        var m = Regex.Match(date, @"(?<![0-9])(19[5-9][0-9]|2[01][0-9][0-9])(?![0-9])");
        return m.Success ? int.Parse(m.Value, CultureInfo.InvariantCulture) : null;
    }
}
