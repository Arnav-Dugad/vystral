using System.Text.Json.Nodes;

namespace Vystral.Windows.Ai;

/// <summary>
/// Track C5: a smart collection's rule, stored in the collection's <c>rule_json</c> and evaluated live by the
/// interface (ui/src/lib/smartFilter.ts mirrors this schema). Version 1 fields, all optional:
/// <code>
/// genresAny / genresNone        string[] (≤ 8, ≤ 40 chars)        statusAny / statusNone   ("backlog"|"playing"|"beaten"|"completed"|"abandoned"|"none")[]
/// platforms                     store keys                         installed / favorite / neverPlayed / inSubscription   bool
/// ttbMaxHours / ttbMinHours     0–1000 (IGDB main story)           playedMaxHours / playedMinHours   0–100000
/// notPlayedDays / playedWithinDays   0–36500                       sizeMaxGb / sizeMinGb   0–100000
/// releasedFrom / releasedTo     years 1950–2100                    titleIncludes   string ≤ 60
/// </code>
/// Validation rebuilds the object from known fields only, so whatever is stored is canonical.
/// </summary>
public static class SmartFilterSpec
{
    public static readonly string[] Statuses = ["backlog", "playing", "beaten", "completed", "abandoned", "none"];
    private static readonly string[] Numbers =
        ["ttbMaxHours", "ttbMinHours", "playedMaxHours", "playedMinHours", "notPlayedDays", "playedWithinDays", "sizeMaxGb", "sizeMinGb", "releasedFrom", "releasedTo"];
    private static readonly string[] Bools = ["installed", "favorite", "neverPlayed", "inSubscription"];

    private static (double Min, double Max) Range(string key) => key switch
    {
        "ttbMaxHours" or "ttbMinHours" => (0, 1000),
        "notPlayedDays" or "playedWithinDays" => (0, 36500),
        "releasedFrom" or "releasedTo" => (1950, 2100),
        _ => (0, 100000),
    };

    public const string Schema = """
        {"genresAny":["genres from the list"],"genresNone":["genres from the list"],
         "statusAny":["backlog|playing|beaten|completed|abandoned|none"],"statusNone":["backlog|playing|beaten|completed|abandoned|none"],
         "platforms":["steam|xbox|epic|gog|ea|ubisoft|battlenet|manual"],"installed":true,"favorite":true,"neverPlayed":true,"inSubscription":true,
         "ttbMaxHours":20,"ttbMinHours":0,"playedMaxHours":5,"playedMinHours":0,"notPlayedDays":90,"playedWithinDays":30,
         "sizeMaxGb":50,"sizeMinGb":0,"releasedFrom":2015,"releasedTo":2024,"titleIncludes":"text"}
        """;

    /// <summary>
    /// Rebuilds a rule from untrusted JSON. <paramref name="knownGenres"/> (when given, e.g. for model output) drops
    /// genres the library doesn't have; a saved rule is validated without it. Wrong types and out-of-range values
    /// reject the rule. A rule with no criteria at all is rejected too (it would just be "everything").
    /// </summary>
    public static JsonObject? Validate(JsonObject? o, IReadOnlyCollection<string>? knownGenres, out List<string> dropped)
    {
        dropped = [];
        if (o is null || o.Count > 30) return null;
        var r = new JsonObject { ["v"] = 1 };
        if (o["v"] is not null && AiText.Num(o["v"]) is not 1) return null;

        foreach (var key in new[] { "genresAny", "genresNone" })
        {
            if (o[key] is null) continue;
            if (o[key] is not JsonArray arr || arr.Count > 8) return null;
            var list = new List<string>();
            foreach (var n in arr)
            {
                if (AiText.Str(n) is not { Length: > 0 and <= 40 } g || g.Any(char.IsControl)) return null;
                var canon = knownGenres is null ? g.Trim() : knownGenres.FirstOrDefault(k => string.Equals(k, g.Trim(), StringComparison.OrdinalIgnoreCase));
                if (canon is null) { dropped.Add(AiText.Clean(g, 40)); continue; }
                if (!list.Contains(canon, StringComparer.OrdinalIgnoreCase)) list.Add(canon);
            }
            if (list.Count > 0) r[key] = new JsonArray(list.Select(x => (JsonNode)x).ToArray());
        }
        foreach (var key in new[] { "statusAny", "statusNone" })
        {
            if (o[key] is null) continue;
            if (o[key] is not JsonArray arr || arr.Count > 6) return null;
            var list = new List<string>();
            foreach (var n in arr)
            {
                if (AiText.Str(n) is not { } s || !Statuses.Contains(s)) return null;
                if (!list.Contains(s)) list.Add(s);
            }
            if (list.Count > 0) r[key] = new JsonArray(list.Select(x => (JsonNode)x).ToArray());
        }
        if (o["platforms"] is not null)
        {
            if (o["platforms"] is not JsonArray arr || arr.Count > 8) return null;
            var list = new List<string>();
            foreach (var n in arr)
            {
                if (AiText.Str(n) is not { } p || !JournalQuery.PlatformKeys.Contains(p)) return null;
                if (!list.Contains(p)) list.Add(p);
            }
            if (list.Count > 0) r["platforms"] = new JsonArray(list.Select(x => (JsonNode)x).ToArray());
        }
        foreach (var key in Bools)
        {
            if (o[key] is null) continue;
            if (AiText.Bool(o[key]) is not { } b) return null;
            r[key] = b;
        }
        foreach (var key in Numbers)
        {
            if (o[key] is null) continue;
            var (min, max) = Range(key);
            if (AiText.Num(o[key]) is not { } d || d < min || d > max) return null;
            r[key] = Math.Round(d, 2);
        }
        if (o["titleIncludes"] is not null)
        {
            if (AiText.Str(o["titleIncludes"]) is not { Length: <= 60 } t || t.Any(char.IsControl)) return null;
            if (t.Trim().Length > 0) r["titleIncludes"] = t.Trim();
        }
        // Contradictions a model might produce: min above max.
        foreach (var (lo, hi) in new[] { ("ttbMinHours", "ttbMaxHours"), ("playedMinHours", "playedMaxHours"), ("sizeMinGb", "sizeMaxGb"), ("releasedFrom", "releasedTo") })
            if (AiText.Num(r[lo]) is { } a && AiText.Num(r[hi]) is { } b && a > b) return null;
        return r.Count > 1 ? r : null;
    }

    /// <summary>Validates a stored/bridge rule string (≤ 4,000 chars) and returns its canonical JSON, or null.</summary>
    public static string? Canonical(string? json)
    {
        if (json is null || json.Length > 4000) return null;
        try
        {
            return Validate(JsonNode.Parse(json) as JsonObject, null, out _)?.ToJsonString();
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }
}
