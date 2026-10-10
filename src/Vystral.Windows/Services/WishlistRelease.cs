using System.Globalization;
using System.Text.RegularExpressions;

namespace Vystral.Windows.Services;

/// <summary>
/// How precisely a release date is known, and the window it falls in. <see cref="Precision"/> is one of
/// <c>day</c>, <c>month</c>, <c>quarter</c>, <c>half</c>, <c>season</c>, <c>year</c> or <c>tba</c> (no date at all).
/// <see cref="From"/>/<see cref="To"/> are calendar days (inclusive), null for <c>tba</c>. <see cref="Label"/> is the
/// honest wording to show ("Q1 2027", "Summer 2027", "To be announced"), or null for an exact day.
/// </summary>
public sealed record ReleaseWindow(string Precision, DateOnly? From, DateOnly? To, string? Label)
{
    public static readonly ReleaseWindow Tba = new("tba", null, null, "To be announced");
}

/// <summary>
/// Track D2: reads Steam's release facts (<c>steam_release_date</c>, <c>is_coming_soon</c>, <c>coming_soon_display</c>
/// and the publisher's free-text <c>custom_release_date_message</c>) into a <see cref="ReleaseWindow"/>, so the wishlist
/// calendar puts a game on a day only when Steam gives a day, and labels everything else with the precision it really
/// has. Pure and unit-tested with the shapes Steam really sends ("2027", "Q1 2027", "Early 2027", "To be announced"…).
/// </summary>
public static partial class WishlistRelease
{
    private const int MinYear = 1970;
    private const int MaxYear = 2100;

    /// <param name="release">The exact release instant (null when Steam only gives part of the date).</param>
    /// <param name="hint">Steam's raw timestamp, also for vague dates (where it marks the month, quarter or year).</param>
    /// <param name="comingSoon">Steam's is_coming_soon.</param>
    /// <param name="display">Steam's coming_soon_display, or null.</param>
    /// <param name="text">The publisher's custom release message, or VYSTRAL's own text for a vague Steam date.</param>
    public static ReleaseWindow Parse(DateTimeOffset? release, DateTimeOffset? hint, bool comingSoon, string? display, string? text)
    {
        if (!comingSoon)
        {
            if (release is { } out_) return Day(DateOnly.FromDateTime(out_.UtcDateTime), null);
            // Out, without a date: whatever the text says, or simply "out".
            return FromText(text) is { Precision: not "tba" } w ? w : new ReleaseWindow("tba", null, null, CleanLabel(text) ?? "Out now");
        }

        // Steam shows only part of the date: trust the display mode and the timestamp's month/quarter/year.
        var at = hint ?? release;
        if (at is { } h && display is "date_month" or "date_quarter" or "date_year")
        {
            var d = h.UtcDateTime;
            if (d.Year is >= MinYear and <= MaxYear)
                return display switch
                {
                    "date_month" => Month(d.Year, d.Month),
                    "date_quarter" => Quarter(d.Year, (d.Month - 1) / 3 + 1),
                    _ => Year(d.Year),
                };
        }

        // A full date with a real instant: an exact day.
        if (release is { } r && display is "date_full") return Day(DateOnly.FromDateTime(r.UtcDateTime), null);
        // Free text from the publisher ("Q1 2027", "Early 2027", "Coming soon"…).
        if (FromText(text) is { } fromText) return fromText;
        // No display mode at all (older answers) but an instant: an exact day.
        if (release is { } r2) return Day(DateOnly.FromDateTime(r2.UtcDateTime), null);
        return ReleaseWindow.Tba with { Label = display is "text_comingsoon" ? "Coming soon" : "To be announced" };
    }

    /// <summary>Reads a free-text release message. Unreadable text is "tba" with the text itself as the label (never a guessed date).</summary>
    public static ReleaseWindow? FromText(string? text)
    {
        var label = CleanLabel(text);
        if (label is null) return null;
        var t = Normalize(label);
        if (t.Length == 0) return ReleaseWindow.Tba with { Label = label };

        Match m;
        if ((m = YearOnly().Match(t)).Success && YearOf(m.Groups["y"].Value) is { } y0) return Year(y0) with { Label = label };

        if ((m = QuarterRx().Match(t)).Success && YearOf(m.Groups["y"].Value) is { } yq)
        {
            var q = m.Groups["q"].Success ? m.Groups["q"].Value : m.Groups["q2"].Success ? m.Groups["q2"].Value : m.Groups["q3"].Value;
            var n = q switch { "first" or "1st" => 1, "second" or "2nd" => 2, "third" or "3rd" => 3, "fourth" or "4th" => 4, _ => int.Parse(q, CultureInfo.InvariantCulture) };
            return Quarter(yq, n) with { Label = label };
        }

        if ((m = HalfRx().Match(t)).Success && YearOf(m.Groups["y"].Value) is { } yh)
        {
            var h = m.Groups["h"].Value is "1" or "first" or "1st" ? 1 : 2;
            return new ReleaseWindow("half", new DateOnly(yh, h == 1 ? 1 : 7, 1), h == 1 ? new DateOnly(yh, 6, 30) : new DateOnly(yh, 12, 31), label);
        }

        if ((m = SeasonRx().Match(t)).Success && YearOf(m.Groups["y"].Value) is { } ys)
            return Season(ys, m.Groups["s"].Value, label);

        if ((m = PartOfYearRx().Match(t)).Success && YearOf(m.Groups["y"].Value) is { } yp)
            return m.Groups["part"].Value switch
            {
                "early" or "beginning of" or "start of" => new ReleaseWindow("season", new DateOnly(yp, 1, 1), new DateOnly(yp, 4, 30), label),
                "mid" or "middle of" => new ReleaseWindow("season", new DateOnly(yp, 5, 1), new DateOnly(yp, 8, 31), label),
                _ => new ReleaseWindow("season", new DateOnly(yp, 9, 1), new DateOnly(yp, 12, 31), label),
            };

        if ((m = MonthYearRx().Match(t)).Success && YearOf(m.Groups["y"].Value) is { } ym && MonthOf(m.Groups["m"].Value) is { } mo)
            return Month(ym, mo) with { Label = label };

        if (ExactDay(t) is { } day) return Day(day, null);

        return ReleaseWindow.Tba with { Label = label };
    }

    private static ReleaseWindow Day(DateOnly d, string? label) => new("day", d, d, label);

    private static ReleaseWindow Month(int y, int m) =>
        new("month", new DateOnly(y, m, 1), new DateOnly(y, m, DateTime.DaysInMonth(y, m)), new DateTime(y, m, 1).ToString("MMMM yyyy", CultureInfo.InvariantCulture));

    private static ReleaseWindow Quarter(int y, int q) =>
        new("quarter", new DateOnly(y, (q - 1) * 3 + 1, 1), new DateOnly(y, q * 3, DateTime.DaysInMonth(y, q * 3)), $"Q{q} {y}");

    private static ReleaseWindow Year(int y) => new("year", new DateOnly(y, 1, 1), new DateOnly(y, 12, 31), y.ToString(CultureInfo.InvariantCulture));

    /// <summary>
    /// Northern-hemisphere seasons, as publishers on Steam use them. "Winter 2026" can mean early 2026 or the turn of
    /// 2026/27, so its window covers both. "Early/late summer" narrows nothing VYSTRAL could promise.
    /// </summary>
    private static ReleaseWindow Season(int y, string season, string label)
    {
        var (from, to) = season switch
        {
            "spring" => (new DateOnly(y, 3, 1), new DateOnly(y, 5, 31)),
            "summer" => (new DateOnly(y, 6, 1), new DateOnly(y, 8, 31)),
            "fall" or "autumn" => (new DateOnly(y, 9, 1), new DateOnly(y, 11, 30)),
            "winter" when y < MaxYear => (new DateOnly(y, 1, 1), new DateOnly(y + 1, 2, DateTime.DaysInMonth(y + 1, 2))),
            "winter" => (new DateOnly(y, 1, 1), new DateOnly(y, 12, 31)),
            _ => (new DateOnly(y, 11, 1), new DateOnly(y, 12, 31)), // holiday (season)
        };
        return new ReleaseWindow("season", from, to, label);
    }

    private static DateOnly? ExactDay(string t)
    {
        string[] formats =
        [
            "yyyy-MM-dd", "d MMMM yyyy", "d MMM yyyy", "MMMM d yyyy", "MMM d yyyy", "d MMM, yyyy", "MMM d, yyyy", "MMMM d, yyyy", "d MMMM, yyyy",
        ];
        var cleaned = OrdinalSuffix().Replace(t, "$1").Replace("sept ", "sep ", StringComparison.Ordinal);
        return DateTime.TryParseExact(cleaned, formats, CultureInfo.InvariantCulture, DateTimeStyles.AllowWhiteSpaces, out var d) && d.Year is >= MinYear and <= MaxYear
            ? DateOnly.FromDateTime(d) : null;
    }

    private static int? YearOf(string s)
    {
        if (!int.TryParse(s.TrimStart('\''), NumberStyles.None, CultureInfo.InvariantCulture, out var y)) return null;
        if (s.Length <= 3) y += 2000; // '27 or 27
        return y is >= MinYear and <= MaxYear ? y : null;
    }

    private static int? MonthOf(string s) => s[..3] switch
    {
        "jan" => 1, "feb" => 2, "mar" => 3, "apr" => 4, "may" => 5, "jun" => 6,
        "jul" => 7, "aug" => 8, "sep" => 9, "oct" => 10, "nov" => 11, "dec" => 12,
        _ => null,
    };

    /// <summary>The text as Steam sent it, cleaned for display (no control characters, at most 60 characters).</summary>
    private static string? CleanLabel(string? text) => Integrations.SteamWebApiClient.CleanText(text, 60);

    /// <summary>Lower case, without trademark signs, filler words ("coming", "expected", "release") and punctuation noise.</summary>
    internal static string Normalize(string label)
    {
        var t = label.ToLowerInvariant().Replace('’', '\'').Replace('–', '-').Replace('—', '-');
        t = Noise().Replace(t, " ");
        t = Filler().Replace(t, " ");
        t = Spaces().Replace(t, " ").Trim(' ', '.', ',', '-', ':', ';');
        return t;
    }

    [GeneratedRegex(@"[™®©!*~]|\(.*?\)|\[.*?\]")]
    private static partial Regex Noise();

    [GeneratedRegex(@"\bearly access\b|\b(?:coming|comes|launching|launches|release[sd]?|releasing|expected|planned|targeting|available|out|estimated|est\.?|in|on|by|the|approx\.?|around|scheduled for|date)\b")]
    private static partial Regex Filler();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();

    [GeneratedRegex(@"\A(?<y>\d{4})\z")]
    private static partial Regex YearOnly();

    [GeneratedRegex(@"\A(?:q\s?(?<q>[1-4])|(?<q2>[1-4])\s?q|(?<q3>first|second|third|fourth|1st|2nd|3rd|4th) quarter(?: of)?)[\s,/\-]*(?<y>'?\d{2}|\d{4})\z|\A(?<y>\d{4})[\s,/\-]*q\s?(?<q>[1-4])\z")]
    private static partial Regex QuarterRx();

    [GeneratedRegex(@"\A(?:h\s?(?<h>[12])|(?<h>first|second|1st|2nd) half(?: of)?)[\s,/\-]*(?<y>'?\d{2}|\d{4})\z|\A(?<y>\d{4})[\s,/\-]*h\s?(?<h>[12])\z")]
    private static partial Regex HalfRx();

    [GeneratedRegex(@"\A(?:(?<part>early|mid|late|end of|beginning of|start of)[\s\-]*)?(?<s>spring|summer|fall|autumn|winter|holiday season|holidays|holiday)(?: of)?[\s,]*(?<y>'?\d{2}|\d{4})\z")]
    private static partial Regex SeasonRx();

    [GeneratedRegex(@"\A(?<part>early|mid|middle of|late|end of|beginning of|start of)[\s\-]*(?<y>\d{4})\z")]
    private static partial Regex PartOfYearRx();

    [GeneratedRegex(@"\A(?<m>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?[\s,]*(?<y>\d{4})\z")]
    private static partial Regex MonthYearRx();

    [GeneratedRegex(@"\b(\d{1,2})(?:st|nd|rd|th)\b")]
    private static partial Regex OrdinalSuffix();
}
