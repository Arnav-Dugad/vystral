using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Vystral.Core.Contracts;
using Vystral.Core.Matching;

namespace Vystral.Windows.Ai;

/// <summary>
/// A validated "Ask the Journal" query: what to measure, how to group it, over which local dates (inclusive), and
/// optional game/genre/store filters. Built from a model's JSON or from the UI's ready-made questions; never trusted as-is.
/// </summary>
public sealed record JournalSpec(
    string Metric,
    string GroupBy,
    string? From,
    string? To,
    IReadOnlyList<string> GameIds,
    IReadOnlyList<string> Genres,
    IReadOnlyList<string> Platforms,
    string Sort,
    int Limit);

public sealed record JournalRow(string Key, string Label, double Value, string? GameId);

/// <summary>The query's result: rows for the chart, totals and plain-language labels. <c>Unit</c>: "seconds" | "count" | "days".</summary>
public sealed record JournalResultDto(
    JournalSpec Spec,
    IReadOnlyList<JournalRow> Rows,
    string Unit,
    string Chart,
    double Total,
    int Sessions,
    int Games,
    string RangeLabel,
    string Description,
    IReadOnlyList<string> Notes,
    IReadOnlyList<string> Unmatched);

/// <summary>
/// Track C5: "Ask the Journal". The model only turns a question into a <see cref="JournalSpec"/> (validated here
/// against a closed schema) and later phrases the numbers this class computed from the local sessions.
/// </summary>
public static class JournalQuery
{
    public static readonly string[] Metrics = ["playtime", "sessions", "days", "average", "longest"];
    public static readonly string[] Groups = ["game", "genre", "platform", "month", "weekday", "hour", "day", "none"];
    public static readonly string[] Presets = ["last7", "last30", "thisMonth", "lastMonth", "thisYear", "lastYear", "all"];
    public static readonly string[] PlatformKeys = ["steam", "xbox", "epic", "gog", "ea", "ubisoft", "battlenet", "manual"];
    private static readonly DateOnly Earliest = new(2000, 1, 1);

    /// <summary>The JSON shape models must produce (also shown to them as the contract).</summary>
    public const string Schema = """
        {"metric":"playtime|sessions|days|average|longest","groupBy":"game|genre|platform|month|weekday|hour|day|none",
         "from":"YYYY-MM-DD (optional)","to":"YYYY-MM-DD (optional)","preset":"last7|last30|thisMonth|lastMonth|thisYear|lastYear|all (instead of from/to)",
         "games":["exact game titles from the list, optional"],"genres":["genres from the list, optional"],
         "platforms":["steam|xbox|epic|gog|ea|ubisoft|battlenet|manual"],"sort":"desc|asc","limit":1-20}
        """;

    /// <summary>
    /// Validates untrusted JSON into a spec. Missing fields take defaults; a field of the wrong type or an unknown
    /// enum value rejects the whole query (null). Titles resolve to library games; unknown titles are reported in
    /// <paramref name="unmatched"/>. Genres must exist in the library.
    /// </summary>
    public static JournalSpec? Validate(JsonObject? o, IReadOnlyList<GameDto> games, DateOnly today, out List<string> unmatched)
    {
        unmatched = [];
        if (o is null || o.Count > 20) return null;

        string? Enum(string name, string[] allowed, string fallback, out bool bad)
        {
            bad = false;
            if (o[name] is null) return fallback;
            if (AiText.Str(o[name]) is not { } s || !allowed.Contains(s)) { bad = true; return null; }
            return s;
        }

        var metric = Enum("metric", Metrics, "playtime", out var badMetric);
        var group = Enum("groupBy", Groups, "game", out var badGroup);
        var sort = Enum("sort", ["desc", "asc"], "desc", out var badSort);
        if (badMetric || badGroup || badSort) return null;

        var limit = 10;
        if (o["limit"] is not null)
        {
            if (AiText.Num(o["limit"]) is not { } l) return null;
            limit = (int)Math.Clamp(Math.Round(l), 1, 20);
        }

        // Dates: an explicit range wins over a preset; both are clamped to 2000-01-01 … today.
        DateOnly? from = null, to = null;
        if (o["from"] is not null || o["to"] is not null)
        {
            if (o["from"] is not null) { if (ParseDate(AiText.Str(o["from"])) is not { } f) return null; from = f; }
            if (o["to"] is not null) { if (ParseDate(AiText.Str(o["to"])) is not { } t) return null; to = t; }
        }
        else if (o["preset"] is not null)
        {
            if (AiText.Str(o["preset"]) is not { } preset || !Presets.Contains(preset)) return null;
            (from, to) = ResolvePreset(preset, today);
        }
        if (from is { } a && to is { } b && a > b) (from, to) = (b, a);
        if (from < Earliest) from = Earliest;
        if (to > today) to = today;
        if (from > today) return null;

        // Games by title (exact, then the same normalised base title, then a unique substring).
        var gameIds = new List<string>();
        if (o["games"] is not null)
        {
            if (o["games"] is not JsonArray arr || arr.Count > 5) return null;
            foreach (var n in arr)
            {
                if (AiText.Str(n) is not { Length: > 0 and <= 120 } title) return null;
                var id = ResolveTitle(title, games);
                if (id is null) unmatched.Add(AiText.Clean(title, 120));
                else if (!gameIds.Contains(id)) gameIds.Add(id);
            }
        }

        var known = games.SelectMany(g => g.Genres).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var genres = new List<string>();
        if (o["genres"] is not null)
        {
            if (o["genres"] is not JsonArray arr || arr.Count > 5) return null;
            foreach (var n in arr)
            {
                if (AiText.Str(n) is not { Length: > 0 and <= 40 } g) return null;
                var canon = known.FirstOrDefault(k => string.Equals(k, g, StringComparison.OrdinalIgnoreCase));
                if (canon is null) unmatched.Add(AiText.Clean(g, 40));
                else if (!genres.Contains(canon)) genres.Add(canon);
            }
        }

        var platforms = new List<string>();
        if (o["platforms"] is not null)
        {
            if (o["platforms"] is not JsonArray arr || arr.Count > 8) return null;
            foreach (var n in arr)
            {
                if (AiText.Str(n) is not { } p || !PlatformKeys.Contains(p)) return null;
                if (!platforms.Contains(p)) platforms.Add(p);
            }
        }

        return new JournalSpec(metric!, group!, from?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), to?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            gameIds, genres, platforms, sort!, limit);
    }

    public static (DateOnly? From, DateOnly? To) ResolvePreset(string preset, DateOnly today) => preset switch
    {
        "last7" => (today.AddDays(-6), today),
        "last30" => (today.AddDays(-29), today),
        "thisMonth" => (new DateOnly(today.Year, today.Month, 1), today),
        "lastMonth" => (new DateOnly(today.Year, today.Month, 1).AddMonths(-1), new DateOnly(today.Year, today.Month, 1).AddDays(-1)),
        "thisYear" => (new DateOnly(today.Year, 1, 1), today),
        "lastYear" => (new DateOnly(today.Year - 1, 1, 1), new DateOnly(today.Year - 1, 12, 31)),
        _ => (null, null),
    };

    private static DateOnly? ParseDate(string? s) =>
        s is { Length: 10 } && DateOnly.TryParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;

    internal static string? ResolveTitle(string title, IReadOnlyList<GameDto> games)
    {
        var exact = games.FirstOrDefault(g => string.Equals(g.Title, title.Trim(), StringComparison.OrdinalIgnoreCase));
        if (exact is not null) return exact.Id;
        var wanted = TitleNormalizer.Normalize(title).Base;
        if (wanted.Length == 0) return null;
        var byBase = games.Where(g => TitleNormalizer.Normalize(g.Title).Base == wanted).ToList();
        if (byBase.Count >= 1) return byBase[0].Id;
        var partial = games.Where(g => TitleNormalizer.Normalize(g.Title).Base.Contains(wanted, StringComparison.Ordinal)).Take(2).ToList();
        return partial.Count == 1 ? partial[0].Id : null;
    }

    // ---------------- Execution ----------------

    /// <summary>Runs the spec over finished sessions. A session counts on the local day it started.</summary>
    public static JournalResultDto Execute(JournalSpec spec, IReadOnlyList<SessionDto> sessions, IReadOnlyList<GameDto> games, IReadOnlyList<string> unmatched, TimeZoneInfo? zone = null)
    {
        zone ??= TimeZoneInfo.Local;
        var byId = new Dictionary<string, GameDto>(StringComparer.Ordinal);
        foreach (var g in games) byId.TryAdd(g.Id, g);
        var installPlatform = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var i in games.SelectMany(g => g.Installations)) installPlatform.TryAdd(i.Id, i.Platform);
        DateOnly? from = spec.From is null ? null : DateOnly.ParseExact(spec.From, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        DateOnly? to = spec.To is null ? null : DateOnly.ParseExact(spec.To, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        var notes = new List<string>();

        var picked = new List<(SessionDto S, GameDto G, DateTime Local, string Platform)>();
        foreach (var s in sessions)
        {
            if (s.End is null || s.DurationSeconds <= 0 || !byId.TryGetValue(s.GameId, out var g)) continue;
            if (!DateTimeOffset.TryParse(s.Start, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var start)) continue;
            var local = TimeZoneInfo.ConvertTime(start, zone).DateTime;
            var day = DateOnly.FromDateTime(local);
            if (from is { } f && day < f) continue;
            if (to is { } t && day > t) continue;
            if (spec.GameIds.Count > 0 && !spec.GameIds.Contains(g.Id)) continue;
            if (spec.Genres.Count > 0 && !g.Genres.Any(x => spec.Genres.Contains(x, StringComparer.OrdinalIgnoreCase))) continue;
            var platform = s.InstallationId is not null && installPlatform.TryGetValue(s.InstallationId, out var p) ? p
                : g.Installations.FirstOrDefault()?.Platform ?? "manual";
            if (spec.Platforms.Count > 0 && !spec.Platforms.Contains(platform)) continue;
            picked.Add((s, g, local, platform));
        }

        IEnumerable<(string Key, string Label, string? GameId, (SessionDto S, GameDto G, DateTime Local, string Platform) Item)> Keys(
            (SessionDto S, GameDto G, DateTime Local, string Platform) x) => spec.GroupBy switch
        {
            "game" => [(x.G.Id, x.G.Title, x.G.Id, x)],
            "genre" => (x.G.Genres.Count == 0 ? ["Unknown genre"] : x.G.Genres).Select(gn => (gn.ToLowerInvariant(), gn, (string?)null, x)),
            "platform" => [(x.Platform, PlatformName(x.Platform), null, x)],
            "month" => [(x.Local.ToString("yyyy-MM", CultureInfo.InvariantCulture), x.Local.ToString("MMM yyyy", CultureInfo.InvariantCulture), null, x)],
            "weekday" => [(WeekdayKey(x.Local), x.Local.ToString("ddd", CultureInfo.InvariantCulture), null, x)],
            "hour" => [(x.Local.Hour.ToString("00", CultureInfo.InvariantCulture), HourLabel(x.Local.Hour), null, x)],
            "day" => [(x.Local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), x.Local.ToString("MMM d", CultureInfo.InvariantCulture), null, x)],
            _ => [("all", "Total", null, x)],
        };

        double Measure(IReadOnlyCollection<(SessionDto S, GameDto G, DateTime Local, string Platform)> items) => spec.Metric switch
        {
            "sessions" => items.Count,
            "days" => items.Select(i => DateOnly.FromDateTime(i.Local)).Distinct().Count(),
            "average" => items.Count == 0 ? 0 : items.Average(i => (double)i.S.DurationSeconds),
            "longest" => items.Count == 0 ? 0 : items.Max(i => (double)i.S.DurationSeconds),
            _ => items.Sum(i => (double)i.S.DurationSeconds),
        };

        var grouped = picked.SelectMany(Keys)
            .GroupBy(k => k.Key, StringComparer.Ordinal)
            .Select(grp => new JournalRow(grp.Key, grp.First().Label, Math.Round(Measure(grp.Select(z => z.Item).ToList()), 2), grp.First().GameId))
            .ToList();

        var timeGroup = spec.GroupBy is "month" or "weekday" or "hour" or "day";
        List<JournalRow> rows;
        if (timeGroup && picked.Count == 0 && spec.GroupBy is "month" or "day" && (from is null || to is null))
        {
            rows = [];
        }
        else if (timeGroup)
        {
            rows = Fill(spec.GroupBy, grouped, from ?? picked.Select(p => DateOnly.FromDateTime(p.Local)).DefaultIfEmpty().Min(),
                to ?? picked.Select(p => DateOnly.FromDateTime(p.Local)).DefaultIfEmpty().Max(), notes);
        }
        else
        {
            var ordered = spec.Sort == "asc" ? grouped.OrderBy(r => r.Value).ThenBy(r => r.Label, StringComparer.OrdinalIgnoreCase)
                : grouped.OrderByDescending(r => r.Value).ThenBy(r => r.Label, StringComparer.OrdinalIgnoreCase);
            rows = ordered.Take(spec.Limit).ToList();
            if (grouped.Count > rows.Count) notes.Add($"Showing {rows.Count} of {grouped.Count}.");
        }
        if (spec.GroupBy == "genre" && picked.Any(p => p.G.Genres.Count > 1)) notes.Add("A game with several genres counts toward each of them.");

        var unit = spec.Metric switch { "sessions" => "count", "days" => "days", _ => "seconds" };
        var total = Math.Round(Measure(picked), 2);
        var rangeLabel = RangeLabel(from, to);
        return new JournalResultDto(spec, rows, unit, timeGroup ? "column" : "bar", total, picked.Count, picked.Select(p => p.G.Id).Distinct().Count(),
            rangeLabel, Describe(spec, games), notes, unmatched);
    }

    private static List<JournalRow> Fill(string group, List<JournalRow> rows, DateOnly from, DateOnly to, List<string> notes)
    {
        var have = rows.ToDictionary(r => r.Key, StringComparer.Ordinal);
        JournalRow Get(string key, string label) => have.TryGetValue(key, out var r) ? r : new JournalRow(key, label, 0, null);
        switch (group)
        {
            case "weekday":
                return Enumerable.Range(0, 7).Select(i => Get(i.ToString(CultureInfo.InvariantCulture),
                    new DateTime(2024, 1, 1).AddDays(i).ToString("ddd", CultureInfo.InvariantCulture))).ToList(); // 2024-01-01 was a Monday
            case "hour":
                return Enumerable.Range(0, 24).Select(h => Get(h.ToString("00", CultureInfo.InvariantCulture), HourLabel(h))).ToList();
            case "month":
            {
                var list = new List<JournalRow>();
                for (var m = new DateOnly(from.Year, from.Month, 1); m <= to && list.Count < 120; m = m.AddMonths(1))
                    list.Add(Get(m.ToString("yyyy-MM", CultureInfo.InvariantCulture), m.ToString("MMM yyyy", CultureInfo.InvariantCulture)));
                return list.Count > 0 ? list : rows.OrderBy(r => r.Key, StringComparer.Ordinal).ToList();
            }
            default: // day
            {
                if (to.DayNumber - from.DayNumber > 92)
                {
                    notes.Add("Only days with play are shown for ranges over three months.");
                    return rows.OrderBy(r => r.Key, StringComparer.Ordinal).ToList();
                }
                var list = new List<JournalRow>();
                for (var d = from; d <= to; d = d.AddDays(1))
                    list.Add(Get(d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), d.ToString("MMM d", CultureInfo.InvariantCulture)));
                return list;
            }
        }
    }

    /// <summary>Monday = "0" … Sunday = "6".</summary>
    private static string WeekdayKey(DateTime d) => (((int)d.DayOfWeek + 6) % 7).ToString(CultureInfo.InvariantCulture);

    private static string HourLabel(int h) => h == 0 ? "12 am" : h < 12 ? $"{h} am" : h == 12 ? "12 pm" : $"{h - 12} pm";

    public static string PlatformName(string p) => p switch
    {
        "steam" => "Steam", "xbox" => "Xbox", "epic" => "Epic Games", "gog" => "GOG", "ea" => "EA app",
        "ubisoft" => "Ubisoft Connect", "battlenet" => "Battle.net", _ => "Added by you",
    };

    public static string RangeLabel(DateOnly? from, DateOnly? to)
    {
        if (from is null && to is null) return "all time";
        string D(DateOnly d) => d.ToString("d MMM yyyy", CultureInfo.InvariantCulture);
        if (from is { } f && to is { } t)
        {
            if (f.Day == 1 && t == new DateOnly(t.Year, t.Month, 1).AddMonths(1).AddDays(-1) && f.Year == t.Year && f.Month == t.Month)
                return f.ToString("MMMM yyyy", CultureInfo.InvariantCulture);
            if (f == new DateOnly(f.Year, 1, 1) && t == new DateOnly(f.Year, 12, 31)) return f.Year.ToString(CultureInfo.InvariantCulture);
            return f == t ? D(f) : $"{D(f)} – {D(t)}";
        }
        return from is { } only ? $"since {D(only)}" : $"until {D(to!.Value)}";
    }

    /// <summary>The query in words, e.g. "Playtime by game · August 2026 · Steam · top 10".</summary>
    public static string Describe(JournalSpec spec, IReadOnlyList<GameDto> games)
    {
        var metric = spec.Metric switch
        {
            "sessions" => "Sessions", "days" => "Days played", "average" => "Average session", "longest" => "Longest session", _ => "Playtime",
        };
        var parts = new List<string> { spec.GroupBy == "none" ? metric : $"{metric} by {spec.GroupBy}" };
        DateOnly? from = spec.From is null ? null : DateOnly.ParseExact(spec.From, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        DateOnly? to = spec.To is null ? null : DateOnly.ParseExact(spec.To, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        parts.Add(RangeLabel(from, to));
        if (spec.GameIds.Count > 0)
            parts.Add(string.Join(", ", spec.GameIds.Select(id => games.FirstOrDefault(g => g.Id == id)?.Title ?? "?")));
        if (spec.Genres.Count > 0) parts.Add(string.Join(" or ", spec.Genres));
        if (spec.Platforms.Count > 0) parts.Add(string.Join(" or ", spec.Platforms.Select(PlatformName)));
        if (spec.GroupBy is "game" or "genre" or "platform") parts.Add(spec.Sort == "asc" ? $"bottom {spec.Limit}" : $"top {spec.Limit}");
        return string.Join(" · ", parts);
    }

    public static string Format(double value, string unit) => unit switch
    {
        "count" => value == 1 ? "1 session" : $"{value:0} sessions",
        "days" => value == 1 ? "1 day" : $"{value:0} days",
        _ => AiText.Duration(value),
    };

    /// <summary>VYSTRAL's own one-paragraph answer (used without AI, and when a model's phrasing is rejected).</summary>
    public static string PlainAnswer(JournalResultDto r)
    {
        if (r.Sessions == 0)
            return r.Unmatched.Count > 0
                ? $"VYSTRAL couldn’t find {string.Join(", ", r.Unmatched.Select(u => $"“{u}”"))} in your library, and no sessions matched in {r.RangeLabel}."
                : $"No tracked sessions match in {r.RangeLabel}.";
        var top = r.Rows.Where(x => x.Value > 0).OrderByDescending(x => x.Value).FirstOrDefault();
        var total = Format(r.Total, r.Unit);
        var sessions = r.Sessions == 1 ? "1 session" : $"{r.Sessions} sessions";
        return r.Spec.Metric switch
        {
            "playtime" when r.Spec.GroupBy == "none" => $"You played for {total} in {r.RangeLabel}, across {sessions}.",
            "playtime" when top is not null => $"{top.Label} leads {r.RangeLabel} with {Format(top.Value, r.Unit)}. In total you played {total} across {sessions}.",
            "sessions" when top is not null && r.Spec.GroupBy != "none" => $"{top.Label} has the most sessions in {r.RangeLabel}: {Format(top.Value, r.Unit)} of {sessions} in total.",
            "days" when top is not null && r.Spec.GroupBy != "none" => $"{top.Label} was played on the most days in {r.RangeLabel}: {Format(top.Value, r.Unit)}.",
            "average" when top is not null && r.Spec.GroupBy != "none" => $"{top.Label} has the longest average session in {r.RangeLabel}: {Format(top.Value, r.Unit)}.",
            "longest" when top is not null && r.Spec.GroupBy != "none" => $"The longest session in {r.RangeLabel} was in {top.Label}: {Format(top.Value, r.Unit)}.",
            "sessions" => $"You played {sessions} in {r.RangeLabel}.",
            "days" => $"You played on {total} in {r.RangeLabel}.",
            "average" => $"Your average session in {r.RangeLabel} lasted {total}.",
            "longest" => $"Your longest session in {r.RangeLabel} lasted {total}.",
            _ => $"You played {total} in {r.RangeLabel}.",
        };
    }

    /// <summary>The facts a model may quote when phrasing (rows formatted exactly as VYSTRAL shows them).</summary>
    public static string Facts(JournalResultDto r)
    {
        var sb = new StringBuilder();
        sb.Append("Query: ").AppendLine(r.Description);
        sb.Append("Range: ").AppendLine(r.RangeLabel);
        sb.Append("Total: ").Append(Format(r.Total, r.Unit)).Append(" across ").Append(r.Sessions).Append(r.Sessions == 1 ? " session" : " sessions")
          .Append(" in ").Append(r.Games).AppendLine(r.Games == 1 ? " game" : " games");
        foreach (var row in r.Rows.Where(x => x.Value > 0).OrderByDescending(x => x.Value).Take(12))
            sb.Append("- ").Append(row.Label).Append(": ").AppendLine(Format(row.Value, r.Unit));
        if (r.Unmatched.Count > 0) sb.Append("Not in the library: ").AppendLine(string.Join(", ", r.Unmatched));
        return sb.ToString();
    }
}
