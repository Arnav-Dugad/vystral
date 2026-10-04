using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Vystral.Core.Matching;

/// <summary>
/// A title broken into a comparable base and the edition qualifiers that were stripped from it.
/// Sequel numbers, subtitles, "Remastered" and "Remake" stay in <see cref="Base"/>, because
/// those denote different products and must never be merged automatically.
/// </summary>
public sealed record NormalizedTitle(string Original, string Base, IReadOnlySet<string> EditionTokens)
{
    /// <summary>Base plus edition: two installations match exactly only if this is identical.</summary>
    public string Full => EditionTokens.Count == 0 ? Base : $"{Base} [{string.Join(' ', EditionTokens.Order())}]";
}

public static partial class TitleNormalizer
{
    // Qualifiers that describe packaging of the *same* game. Deliberately excludes
    // remaster/remake/redux/reforged/anniversary which often ship as distinct products.
    private static readonly string[] EditionPhrases =
    [
        "game of the year edition", "game of the year", "goty edition", "goty",
        // Longer phrases must precede phrases they contain ("digital deluxe edition" before "deluxe edition").
        "definitive edition", "complete edition", "digital deluxe edition", "deluxe edition", "ultimate edition",
        "gold edition", "premium edition", "standard edition",
        "collectors edition", "enhanced edition", "special edition", "legendary edition",
        "director's cut", "directors cut", "windows edition", "pc edition", "for windows 10", "for windows",
        "(pc)", "(windows)", "- windows", "steam edition", "epic edition", "xbox edition",
    ];

    private static readonly Dictionary<string, string> Roman = new()
    {
        ["ii"] = "2", ["iii"] = "3", ["iv"] = "4", ["v"] = "5", ["vi"] = "6",
        ["vii"] = "7", ["viii"] = "8", ["ix"] = "9", ["x"] = "10", ["xi"] = "11", ["xii"] = "12",
        ["xiii"] = "13", ["xiv"] = "14", ["xv"] = "15", ["xvi"] = "16",
    };

    public static NormalizedTitle Normalize(string title)
    {
        var text = title.Trim();
        // Strip trademark symbols and fold diacritics so "Pokémon" == "Pokemon".
        text = text.Replace("™", "").Replace("®", "").Replace("©", "");
        text = RemoveDiacritics(text).ToLowerInvariant();
        text = text.Replace('’', '\'').Replace('–', '-').Replace('—', '-').Replace("&", " and ");

        var editions = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var phrase in EditionPhrases)
        {
            var idx = text.IndexOf(phrase, StringComparison.Ordinal);
            if (idx < 0) continue;
            // Only strip when the phrase is at a word boundary to avoid mangling titles.
            var before = idx == 0 || !char.IsLetterOrDigit(text[idx - 1]);
            var afterIdx = idx + phrase.Length;
            var after = afterIdx >= text.Length || !char.IsLetterOrDigit(text[afterIdx]);
            if (!before || !after) continue;
            var canonical = CanonicalEdition(phrase);
            // Platform qualifiers ("for Windows", "(PC)") describe the store, not the product.
            if (canonical != "platform") editions.Add(canonical);
            text = text.Remove(idx, phrase.Length);
        }

        text = NonWord().Replace(text, " ");
        var words = text.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Select(w => Roman.TryGetValue(w, out var digit) ? digit : w)
            .ToList();
        // Leading article is noise for matching ("The Witcher 3" vs "Witcher 3").
        if (words.Count > 1 && words[0] == "the") words.RemoveAt(0);

        return new NormalizedTitle(title, string.Join(' ', words), editions);
    }

    /// <summary>Sort key: case-insensitive, leading article ignored, diacritics folded.</summary>
    public static string SortKey(string title)
    {
        var t = RemoveDiacritics(title.Replace("™", "").Replace("®", "")).Trim();
        foreach (var article in new[] { "The ", "A ", "An " })
        {
            if (t.StartsWith(article, StringComparison.OrdinalIgnoreCase) && t.Length > article.Length)
            {
                t = t[article.Length..];
                break;
            }
        }
        return t.ToLowerInvariant();
    }

    /// <summary>Removes trademark glyphs and odd whitespace for display, without altering meaning.</summary>
    public static string CleanDisplayTitle(string title) =>
        MultiSpace().Replace(title.Replace("™", "").Replace("®", "").Replace(' ', ' '), " ").Trim();

    private static string CanonicalEdition(string phrase) => phrase switch
    {
        "game of the year edition" or "game of the year" or "goty edition" or "goty" => "goty",
        "director's cut" or "directors cut" => "directors-cut",
        "windows edition" or "pc edition" or "for windows 10" or "for windows" or "(pc)" or "(windows)" or "- windows"
            or "steam edition" or "epic edition" or "xbox edition" => "platform",
        _ => phrase.Replace(" edition", "").Replace(' ', '-'),
    };

    private static string RemoveDiacritics(string text)
    {
        var normalized = text.Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(normalized.Length);
        foreach (var c in normalized)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) sb.Append(c);
        }
        return sb.ToString().Normalize(NormalizationForm.FormC);
    }

    [GeneratedRegex(@"[^a-z0-9]+")]
    private static partial Regex NonWord();

    [GeneratedRegex(@"\s+")]
    private static partial Regex MultiSpace();
}
