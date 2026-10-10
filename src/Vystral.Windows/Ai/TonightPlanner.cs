using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Vystral.Core.Contracts;
using Vystral.Windows.Recap;
using Vystral.Windows.Subscriptions;

namespace Vystral.Windows.Ai;

/// <summary>A game VYSTRAL considers for tonight. <c>Kind</c>: "library" (owned) or "subscription" (included in a plan, not owned).</summary>
public sealed record TonightCandidate(string Ref, string Kind, string? GameId, string? ProductId, string Title, IReadOnlyList<string> Genres,
    bool Installed, double PlayedHours, double? AvgSessionMinutes, double? TtbLeftHours, string? Status, string? Plan, bool Leaving,
    string? LastPlayed, double Score, IReadOnlyList<string> Reasons);

public sealed record TonightPickDto(string Kind, string? GameId, string? ProductId, string Title, string Reason, IReadOnlyList<string> Facts,
    bool Installed, string? Plan);

public sealed record TonightDto(string Intro, IReadOnlyList<TonightPickDto> Picks, int Considered, AiEngineDto Engine, string? AiLabel, string? Note,
    string? Sent);

/// <summary>
/// Track C5: "What should I play tonight?". Candidates and their reasons are chosen deterministically from the library
/// (and games your subscriptions include); a model may only re-rank those candidates by reference ("c1"…"c8") and phrase
/// a reason. Nothing outside the list can be suggested, and nothing is ever launched.
/// </summary>
public static class TonightPlanner
{
    public static readonly string[] Moods = ["any", "chill", "intense", "story", "brainy", "social"];

    private static readonly Dictionary<string, string[]> MoodGenres = new()
    {
        ["chill"] = ["casual", "simulation", "puzzle", "platformer", "indie", "family", "farming", "sandbox", "exploration"],
        ["intense"] = ["action", "shooter", "racing", "fighting", "horror", "hack and slash", "survival", "arcade"],
        ["story"] = ["rpg", "role-playing", "adventure", "narrative", "visual novel", "point-and-click", "story"],
        ["brainy"] = ["strategy", "puzzle", "tactics", "tactical", "turn-based", "simulation", "card", "management"],
        ["social"] = ["multiplayer", "co-op", "coop", "party", "sports", "mmo", "online"],
    };

    public static string MoodLabel(string mood) => mood switch
    {
        "chill" => "something chill", "intense" => "something intense", "story" => "a good story", "brainy" => "something to think about",
        "social" => "playing with others", _ => "anything",
    };

    public static List<TonightCandidate> Candidates(IReadOnlyList<GameDto> games, IReadOnlyDictionary<string, TimeToBeatDto> ttb,
        IReadOnlyDictionary<string, IReadOnlyList<SubsBadgeDto>> subs, IReadOnlyList<SubsPickDto> included, string mood, int minutes,
        bool includeSubs, DateTimeOffset now, int take = 8)
    {
        var list = new List<TonightCandidate>();
        foreach (var g in games)
        {
            if (g.Hidden || g.Status is "completed" or "abandoned") continue;
            var installed = g.Installations.Any(i => i.State == "installed");
            var badge = includeSubs && subs.TryGetValue(g.Id, out var b) && b.Count > 0 ? b[0] : null;
            if (!installed && badge is null) continue; // tonight means playable now (installed) or included in a plan you have
            var played = g.TrackedSeconds > 0 ? g.TrackedSeconds / 3600.0 : (g.Installations.Max(i => i.ImportedPlaytimeMinutes) ?? 0) / 60.0;
            double? avg = g.SessionCount > 0 && g.TrackedSeconds > 0 ? g.TrackedSeconds / 60.0 / g.SessionCount : null;
            double? left = ttb.TryGetValue(g.Id, out var t) && (t.Main ?? t.Extras) is { } est && est > 0 ? Math.Max(0, est / 3600.0 - played) : null;
            var last = new[] { g.LastTrackedPlay }.Concat(g.Installations.Select(i => i.ImportedLastPlayed)).Where(x => x is not null).Max();
            var daysSince = last is not null && DateTimeOffset.TryParse(last, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var lp) ? (now - lp).TotalDays : (double?)null;

            double score = 0;
            var reasons = new List<string>();
            if (installed) score += 3;
            if (g.Status == "playing") { score += 3; reasons.Add("You marked it as playing"); }
            else if (g.Status == "backlog") { score += 1.5; reasons.Add("It’s on your backlog"); }
            if (left is { } l && l > 0 && l * 60 <= minutes * 1.05) { score += 4; reasons.Add($"About {Hours(l)} left to the credits, so you could finish it tonight"); }
            else if (left is { } l2 && l2 > 0 && l2 < 6) { score += 1.5; reasons.Add($"About {Hours(l2)} left to the credits"); }
            if (avg is { } a)
            {
                if (a <= minutes * 1.1) { score += 2; reasons.Add($"Your sessions average {Minutes(a)}, which fits your {Minutes(minutes)}"); }
                else if (a > minutes * 2) { score -= 2; }
            }
            if (MoodMatch(mood, g.Genres) is { } genre) { score += 2.5; reasons.Add($"{genre} suits {MoodLabel(mood)}"); }
            if (daysSince is { } ds && ds <= 14 && g.Status != "beaten") { score += 1.5; reasons.Add($"You played it {Ago(ds)}, so it’s fresh"); }
            else if (daysSince is { } ds2 && ds2 > 90 && played > 1) { score += 0.5; reasons.Add($"You haven’t played it for {Ago(ds2)[..^4].TrimEnd()}"); }
            if (played == 0 && minutes >= 60) { score += 0.75; reasons.Add("You haven’t started it yet"); }
            if (g.Favorite) { score += 1; reasons.Add("One of your favorites"); }
            if (badge is not null && !installed) reasons.Add($"Included with {badge.PlanName}");
            if (badge is { Leaving: true }) { score += 2; reasons.Add($"Leaving {badge.PlanName} soon"); }
            if (g.Status == "beaten") score -= 2;
            if (reasons.Count == 0) reasons.Add(installed ? "Installed and ready" : "Available to you");

            list.Add(new TonightCandidate("", "library", g.Id, null, g.Title, g.Genres.Take(4).ToList(), installed, Math.Round(played, 1),
                avg is { } av ? Math.Round(av) : null, left is { } lf ? Math.Round(lf, 1) : null, g.Status, badge?.PlanName, badge?.Leaving == true,
                last?.Length >= 10 ? last[..10] : last, score, reasons));
        }
        if (includeSubs)
        {
            foreach (var p in included.Take(12))
            {
                var reasons = new List<string> { $"Included with {p.PlanName}, and you don’t own it" };
                var score = 1.0;
                if (p.Reason == "leaving") { score += 2; reasons.Add("Leaving the plan soon"); }
                else if (p.Reason == "new") { score += 1; reasons.Add("Recently added to the plan"); }
                list.Add(new TonightCandidate("", "subscription", null, p.ProductId, p.Title, [], false, 0, null, null, null, p.PlanName,
                    p.Reason == "leaving", null, score, reasons));
            }
        }
        return list.OrderByDescending(c => c.Score).ThenBy(c => c.Title, StringComparer.OrdinalIgnoreCase).Take(take)
            .Select((c, i) => c with { Ref = $"c{i + 1}" }).ToList();
    }

    private static string? MoodMatch(string mood, IReadOnlyList<string> genres)
    {
        if (!MoodGenres.TryGetValue(mood, out var wanted)) return null;
        return genres.FirstOrDefault(g => wanted.Any(w => g.Contains(w, StringComparison.OrdinalIgnoreCase)));
    }

    private static string Hours(double h) => h < 1 ? $"{Math.Max(5, Math.Round(h * 60 / 5) * 5):0} min" : $"{Math.Round(h * 2) / 2:0.#} h";
    private static string Minutes(double m) => m >= 90 ? $"{Math.Round(m / 30) / 2:0.#} h" : $"{Math.Round(m):0} min";
    private static string Ago(double days) => days < 1 ? "today" : days < 2 ? "yesterday" : days < 60 ? $"{Math.Round(days):0} days ago" : $"{Math.Round(days / 30):0} months ago";

    /// <summary>The candidate list as sent to a model (and the only numbers its reasons may contain).</summary>
    public static string Facts(IReadOnlyList<TonightCandidate> cs, string mood, int minutes, string? note)
    {
        var sb = new StringBuilder();
        sb.Append("Mood: ").AppendLine(MoodLabel(mood));
        sb.Append("Time available: ").AppendLine(Minutes(minutes));
        if (!string.IsNullOrWhiteSpace(note)) sb.Append("They also said: ").AppendLine(AiText.Clean(note, 300));
        foreach (var c in cs)
        {
            sb.Append(c.Ref).Append(": ").Append(c.Title);
            if (c.Genres.Count > 0) sb.Append(" | genres: ").Append(string.Join(", ", c.Genres));
            sb.Append(c.Kind == "subscription" ? " | not owned, included with " + c.Plan : c.Installed ? " | installed" : " | not installed, included with " + c.Plan);
            if (c.PlayedHours > 0) sb.Append(" | played: ").Append(c.PlayedHours.ToString("0.#", CultureInfo.InvariantCulture)).Append(" h");
            if (c.AvgSessionMinutes is { } a) sb.Append(" | typical session: ").Append(Minutes(a));
            if (c.TtbLeftHours is { } l) sb.Append(" | left to the credits: ").Append(Hours(l));
            if (c.Status is not null) sb.Append(" | status: ").Append(c.Status);
            if (c.Leaving) sb.Append(" | leaving the plan soon");
            sb.Append(" | why: ").AppendLine(string.Join("; ", c.Reasons));
        }
        return sb.ToString();
    }

    /// <summary>VYSTRAL's own picks: the top three candidates with their first two reasons.</summary>
    public static List<TonightPickDto> PlainPicks(IReadOnlyList<TonightCandidate> cs) =>
        cs.Take(3).Select(c => ToPick(c, string.Join(". ", c.Reasons.Take(2)) + ".")).ToList();

    public static TonightPickDto ToPick(TonightCandidate c, string reason) =>
        new(c.Kind, c.GameId, c.ProductId, c.Title, reason, c.Reasons, c.Installed, c.Plan);

    /// <summary>Validates a model's plan: {"intro": "...", "picks": [{"ref": "c1", "reason": "..."}]}. Unknown refs reject the answer.</summary>
    public static (string Intro, List<TonightPickDto> Picks)? ValidatePlan(JsonObject? o, IReadOnlyList<TonightCandidate> cs, string facts)
    {
        if (o?["picks"] is not JsonArray arr || arr.Count is 0 or > 3) return null;
        var intro = AiText.Clean(AiText.Str(o["intro"]), 220);
        if (!AiText.OnlyKnownNumbers(intro, facts)) intro = "";
        var picks = new List<TonightPickDto>();
        foreach (var n in arr)
        {
            if (n is not JsonObject p || AiText.Str(p["ref"]) is not { } r) return null;
            var c = cs.FirstOrDefault(x => x.Ref == r);
            if (c is null || picks.Any(x => x.Title == c.Title)) return null;
            var reason = AiText.Clean(AiText.Str(p["reason"]), 240);
            if (reason.Length < 3 || !AiText.OnlyKnownNumbers(reason, facts)) return null;
            picks.Add(ToPick(c, reason));
        }
        return (intro, picks);
    }
}
