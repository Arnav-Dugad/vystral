using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Vystral.Windows.Ai;

/// <summary>
/// Track C5: helpers for untrusted model output. Models only phrase and plan: every structured answer is parsed
/// with limits and validated by the feature, and every sentence shown to the user may only contain numbers that
/// VYSTRAL itself gave the model (<see cref="OnlyKnownNumbers"/>), so a model can't invent playtime or counts.
/// </summary>
public static partial class AiText
{
    public const int MaxJsonChars = 16_000;

    /// <summary>The first JSON object in a model's answer (tolerates code fences and a sentence around it), or null.</summary>
    public static JsonObject? ExtractObject(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start < 0 || end <= start || end - start + 1 > MaxJsonChars) return null;
        try
        {
            return JsonNode.Parse(text[start..(end + 1)], documentOptions: new JsonDocumentOptions { MaxDepth = 16 }) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>A string node, or null for any other type.</summary>
    public static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    public static bool? Bool(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;

    public static double? Num(JsonNode? n) =>
        n is JsonValue v && v.TryGetValue<double>(out var d) && double.IsFinite(d) ? d : null;

    /// <summary>Plain, single-paragraph text: control and bidi/format characters removed, markdown emphasis dropped, whitespace collapsed, clipped.</summary>
    public static string Clean(string? s, int max)
    {
        if (string.IsNullOrEmpty(s)) return "";
        var sb = new StringBuilder(Math.Min(s.Length, max + 16));
        foreach (var c in s)
        {
            if (char.IsControl(c)) { sb.Append(' '); continue; }
            var cat = char.GetUnicodeCategory(c);
            if (cat is System.Globalization.UnicodeCategory.Format) continue; // bidi overrides, zero-width joiners
            if (c is '*' or '`' or '#') continue;
            sb.Append(c);
        }
        var text = Spaces().Replace(sb.ToString(), " ").Trim().TrimStart('-', '•', ' ');
        return text.Length > max ? text[..max].TrimEnd() + "…" : text;
    }

    /// <summary>
    /// True when every number in <paramref name="answer"/> also appears in <paramref name="facts"/> (the text VYSTRAL
    /// sent, which the model was told to quote exactly). "12.5" and "12,5" are the same number; ordinals like "3rd"
    /// count as their digits.
    /// </summary>
    public static bool OnlyKnownNumbers(string answer, string facts)
    {
        var allowed = new HashSet<string>(Numbers(facts), StringComparer.Ordinal);
        return Numbers(answer).All(allowed.Contains);
    }

    private static IEnumerable<string> Numbers(string s)
    {
        foreach (Match m in Number().Matches(s))
        {
            var n = m.Value.Replace(',', '.');
            // "1.234" style thousands separators and plain integers both reduce to their digit string as well.
            yield return n.TrimEnd('.');
        }
    }

    [GeneratedRegex(@"\d+(?:[.,]\d+)*")]
    private static partial Regex Number();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();

    /// <summary>"12 h 30 min", "45 min", "under a minute" — the same wording the facts use, so models can quote it.</summary>
    public static string Duration(double seconds)
    {
        if (seconds < 60) return "under a minute";
        var minutes = (long)Math.Round(seconds / 60);
        var h = minutes / 60;
        var m = minutes % 60;
        return h == 0 ? $"{m} min" : m == 0 ? $"{h} h" : $"{h} h {m} min";
    }
}
