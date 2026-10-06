using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vystral.Windows.Recap;

/// <summary>One announced seasonal sale (inclusive dates as Valve published them; no start time).</summary>
public sealed record SaleDto(string Id, string Name, string Start, string End);

/// <summary>
/// The sale calendar for the UI: the sale on now (if any), the next announced one, and where the dates come
/// from. <c>Next</c> is null when no future sale has been announced yet; VYSTRAL never guesses one.
/// </summary>
public sealed record SaleForecastDto(SaleDto? Current, SaleDto? Next, int? DaysUntilNext, int? DaysLeftInCurrent, string Source, string SourceUrl,
    string Retrieved, int Version, bool Outdated);

/// <summary>Steam's seasonal sale dates, shipped with the app (<c>steam-sales.json</c>). Pure and unit-tested.</summary>
public static partial class SaleCalendar
{
    public sealed record Calendar(int Version, string Source, string SourceUrl, DateOnly Retrieved, IReadOnlyList<Sale> Sales);

    public sealed record Sale(string Id, string Name, DateOnly Start, DateOnly End);

    private static readonly Lazy<Calendar> Embedded = new(() =>
    {
        using var stream = typeof(SaleCalendar).Assembly.GetManifestResourceStream("Vystral.Windows.Recap.steam-sales.json")
                           ?? throw new InvalidOperationException("The sale calendar resource is missing.");
        using var reader = new StreamReader(stream);
        return Parse(reader.ReadToEnd());
    });

    public static Calendar Shipped => Embedded.Value;

    /// <summary>
    /// Parses and validates the calendar: a positive version, an https source on a Valve domain, a retrieval
    /// date, and sales with unique ids, names, start ≤ end, at most 60 days long, sorted and not overlapping.
    /// Throws <see cref="FormatException"/> on anything else (it is shipped data; a bad file must fail tests).
    /// </summary>
    public static Calendar Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new FormatException("Calendar must be an object.");
        var version = root.TryGetProperty("version", out var v) && v.TryGetInt32(out var n) && n > 0 ? n : throw new FormatException("Bad version.");
        var source = Text(root, "source", 200);
        var url = Text(root, "sourceUrl", 300);
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || u.Scheme != "https" ||
            !(u.Host.EndsWith("steamgames.com", StringComparison.OrdinalIgnoreCase) || u.Host.EndsWith("steampowered.com", StringComparison.OrdinalIgnoreCase)))
            throw new FormatException("The source must be an https page on a Valve domain.");
        var retrieved = Date(Text(root, "retrieved", 10));
        if (!root.TryGetProperty("sales", out var arr) || arr.ValueKind != JsonValueKind.Array) throw new FormatException("Missing sales.");
        var sales = new List<Sale>();
        foreach (var s in arr.EnumerateArray())
        {
            var id = Text(s, "id", 40);
            if (!IdPattern().IsMatch(id)) throw new FormatException($"Bad sale id '{id}'.");
            var sale = new Sale(id, Text(s, "name", 80), Date(Text(s, "start", 10)), Date(Text(s, "end", 10)));
            if (sale.End < sale.Start) throw new FormatException($"{id} ends before it starts.");
            if (sale.End.DayNumber - sale.Start.DayNumber > 60) throw new FormatException($"{id} is implausibly long.");
            sales.Add(sale);
        }
        if (sales.Select(s => s.Id).Distinct().Count() != sales.Count) throw new FormatException("Duplicate sale ids.");
        for (var i = 1; i < sales.Count; i++)
            if (sales[i].Start <= sales[i - 1].End) throw new FormatException("Sales must be in order and must not overlap.");
        return new Calendar(version, source, url, retrieved, sales);
    }

    /// <summary>
    /// The sale running on <paramref name="today"/> (inclusive dates) and the next one that starts after it.
    /// <c>Outdated</c> is set when every listed sale is over, so the UI says there's nothing announced.
    /// </summary>
    public static SaleForecastDto Forecast(Calendar c, DateOnly today)
    {
        var current = c.Sales.FirstOrDefault(s => s.Start <= today && today <= s.End);
        var next = c.Sales.Where(s => s.Start > today).OrderBy(s => s.Start).FirstOrDefault();
        return new SaleForecastDto(
            current is null ? null : Dto(current), next is null ? null : Dto(next),
            next is null ? null : next.Start.DayNumber - today.DayNumber,
            current is null ? null : current.End.DayNumber - today.DayNumber,
            c.Source, c.SourceUrl, c.Retrieved.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), c.Version,
            current is null && next is null);
    }

    private static SaleDto Dto(Sale s) =>
        new(s.Id, s.Name, s.Start.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), s.End.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));

    private static string Text(JsonElement o, string name, int max) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { Length: > 0 } s && s.Length <= max
            ? s : throw new FormatException($"Missing or bad '{name}'.");

    private static DateOnly Date(string s) =>
        DateOnly.TryParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : throw new FormatException($"Bad date '{s}'.");

    [GeneratedRegex(@"\A[a-z0-9-]{1,40}\z")]
    private static partial Regex IdPattern();
}
