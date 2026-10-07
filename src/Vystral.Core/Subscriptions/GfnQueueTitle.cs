using System.Globalization;
using System.Text.RegularExpressions;

namespace Vystral.Core.Subscriptions;

/// <summary>What a window title said about a cloud queue. Either part may be missing.</summary>
public sealed record QueueReading(int? Position, int? EtaMinutes);

/// <summary>
/// Track V: reads a GeForce NOW queue position or wait time out of a window title, if the title carries one.
/// It is deliberately strict: a number only counts when a queue word sits right next to it ("Position in queue: 12",
/// "#12 in queue", "Queue 12", "12 in line", "ETA 5 min", "Estimated wait: 1 h 5 min"), so a game called
/// "Forza Horizon 5" or "Cyberpunk 2077" never reads as a queue. Unknown wording returns null.
/// <para>
/// Whether the GeForce NOW app ever writes this into its window title is unverified (it couldn't be observed on the
/// development PC without starting a session). The stream process appearing is the dependable signal; this parser is
/// a bonus that costs nothing when the title says nothing.
/// </para>
/// </summary>
public static partial class GfnQueueTitle
{
    public const int MaxTitleLength = 512;
    public const int MaxPosition = 100_000;
    public const int MaxEtaMinutes = 24 * 60;

    public static QueueReading? Parse(string? title)
    {
        if (string.IsNullOrWhiteSpace(title) || title.Length > MaxTitleLength) return null;
        var t = title.Replace(' ', ' ').Replace(' ', ' ');
        int? position = null;
        foreach (var rx in new[] { PositionAfter(), PositionBefore() })
        {
            var m = rx.Match(t);
            if (m.Success && Number(m.Groups["n"].Value) is { } n && n is > 0 and <= MaxPosition)
            {
                position = n;
                break;
            }
        }
        var eta = Eta(t);
        return position is null && eta is null ? null : new QueueReading(position, eta);
    }

    private static int? Eta(string t)
    {
        foreach (Match m in EtaRx().Matches(t))
        {
            // "Wait" or "ETA" with no time after it says nothing; a later match may.
            if (!m.Groups["h"].Success && !m.Groups["m"].Success) continue;
            var hours = m.Groups["h"].Success ? Number(m.Groups["h"].Value) : 0;
            var minutes = m.Groups["m"].Success ? Number(m.Groups["m"].Value) : 0;
            if (hours is null || minutes is null) return null;
            var total = hours.Value * 60 + minutes.Value;
            return total is >= 0 and <= MaxEtaMinutes ? Math.Max(1, total) : null;
        }
        return LessThanMinute().IsMatch(t) ? 1 : null;
    }

    /// <summary>Digits with optional thousands separators ("1,234", "1.234", "1 234").</summary>
    private static int? Number(string s)
    {
        var digits = new string(s.Where(char.IsAsciiDigit).ToArray());
        return digits.Length is > 0 and <= 7 && int.TryParse(digits, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : null;
    }

    private const string Num = @"(?<n>\d{1,3}(?:[,. ]\d{3})+|\d{1,7})";

    // "Position in queue: 12", "Queue position 12", "Place in line: 12", "In queue: #12", "Queue: 12", "Queue 12".
    [GeneratedRegex(@"\b(?:(?:position|place|spot)\s+in\s+(?:the\s+)?(?:queue|line)|queue\s+position|in\s+queue|queue)\s*[:#\-–]?\s*#?" + Num + @"\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, 200)]
    private static partial Regex PositionAfter();

    // "#12 in queue", "12 in line", "You're #12 in the queue", "12th in line".
    [GeneratedRegex(@"(?:^|[\s(\[|·•\-–:])#?" + Num + @"(?:st|nd|rd|th)?\s+in\s+(?:the\s+)?(?:queue|line)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, 200)]
    private static partial Regex PositionBefore();

    // "ETA 5 min", "Estimated wait: 1 h 5 min", "Wait time ~12 minutes", "ETA: 1h 5m", "Estimated wait time: 3 mins".
    [GeneratedRegex(@"\b(?:eta|estimated\s+(?:wait(?:\s+time)?|time)|wait(?:\s+time)?)\s*[:\-–]?\s*[~≈]?\s*(?:about\s+)?(?:(?<h>\d{1,2})\s*(?:h|hr|hrs|hour|hours)\b\s*)?(?:(?<m>\d{1,4})\s*(?:m|min|mins|minute|minutes)\b)?", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, 200)]
    private static partial Regex EtaRx();

    [GeneratedRegex(@"\b(?:eta|wait)\b[^|]{0,20}\bless\s+than\s+(?:a|1)\s+min", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, 200)]
    private static partial Regex LessThanMinute();
}
