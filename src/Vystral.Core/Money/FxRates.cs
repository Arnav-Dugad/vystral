using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vystral.Core.Money;

/// <summary>
/// Track D6: one day's exchange rates, all against <see cref="Base"/> (1 Base = Rates[code] code). The base itself is
/// always in <see cref="Rates"/> with 1.0, so any two listed currencies convert through it.
/// </summary>
public sealed record FxSnapshot(string Base, string Date, IReadOnlyDictionary<string, double> Rates, DateTimeOffset FetchedAt);

/// <summary>
/// Track D6: parses and applies exchange rates from Frankfurter (api.frankfurter.dev: free, keyless, open source; rates
/// published by the European Central Bank and other central banks). The answer is untrusted: only ISO 4217-shaped
/// codes, finite positive rates in a sane range and a date-shaped date are kept, the number of entries is capped, and
/// rows with a different base than the first are ignored. Both the v2 list shape
/// (<c>[{"date","base","quote","rate"}]</c>) and the older v1 object shape (<c>{"base","date","rates":{…}}</c>) are read.
/// </summary>
public static partial class FxRates
{
    public const int MaxBytes = 256 * 1024;
    public const int MaxEntries = 400;
    /// <summary>Fewer usable rates than this means the answer isn't a rates table at all.</summary>
    public const int MinEntries = 5;
    private const double MinRate = 1e-7, MaxRate = 1e9;

    [GeneratedRegex(@"^[A-Z]{3}\z")]
    private static partial Regex CodeRx();

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}\z")]
    private static partial Regex DateRx();

    /// <summary>True for a three-letter upper-case code (the shape of ISO 4217; whether it exists is the rates' business).</summary>
    public static bool IsCode(string? code) => code is { Length: 3 } && CodeRx().IsMatch(code);

    /// <summary>The parsed table, or null when the text isn't a usable rates answer.</summary>
    public static FxSnapshot? Parse(string? json, DateTimeOffset fetchedAt)
    {
        if (string.IsNullOrWhiteSpace(json) || json.Length > MaxBytes) return null;
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 8 });
            return doc.RootElement.ValueKind switch
            {
                JsonValueKind.Array => ParseList(doc.RootElement, fetchedAt),
                JsonValueKind.Object => ParseObject(doc.RootElement, fetchedAt),
                _ => null,
            };
        }
        catch (JsonException) { return null; }
    }

    private static FxSnapshot? ParseList(JsonElement list, DateTimeOffset fetchedAt)
    {
        // Valid rows first; the base is the one most rows agree on, so a stray row can't pick it.
        var rows = new List<(string Base, string Quote, double Rate, string Date)>();
        foreach (var row in list.EnumerateArray())
        {
            if (rows.Count >= MaxEntries * 2) break;
            if (row.ValueKind != JsonValueKind.Object) continue;
            var b = Str(row, "base");
            var q = Str(row, "quote");
            var d = Str(row, "date");
            if (!IsCode(b) || !IsCode(q) || d is null || !DateRx().IsMatch(d) || !TryRate(row, "rate", out var rate)) continue;
            rows.Add((b!, q!, rate, d));
        }
        if (rows.Count == 0) return null;
        var baseCode = rows.GroupBy(r => r.Base).OrderByDescending(g => g.Count()).ThenBy(g => g.Key, StringComparer.Ordinal).First().Key;
        string? latest = null;
        var rates = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var r in rows)
        {
            if (r.Base != baseCode) continue;
            if (rates.Count >= MaxEntries) break;
            if (latest is null || string.CompareOrdinal(r.Date, latest) > 0) latest = r.Date;
            rates[r.Quote] = r.Rate;
        }
        return Finish(baseCode, latest, rates, fetchedAt);
    }

    private static FxSnapshot? ParseObject(JsonElement o, DateTimeOffset fetchedAt)
    {
        var b = Str(o, "base");
        var d = Str(o, "date");
        if (!IsCode(b) || !o.TryGetProperty("rates", out var r) || r.ValueKind != JsonValueKind.Object) return null;
        var rates = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var p in r.EnumerateObject())
        {
            if (rates.Count >= MaxEntries) break;
            if (!IsCode(p.Name) || p.Value.ValueKind != JsonValueKind.Number || !p.Value.TryGetDouble(out var rate) || !Sane(rate)) continue;
            rates[p.Name] = rate;
        }
        return Finish(b, d is not null && DateRx().IsMatch(d) ? d : null, rates, fetchedAt);
    }

    private static FxSnapshot? Finish(string? baseCode, string? date, Dictionary<string, double> rates, DateTimeOffset fetchedAt)
    {
        if (baseCode is null || date is null) return null;
        rates[baseCode] = 1.0;
        return rates.Count < MinEntries ? null : new FxSnapshot(baseCode, date, rates, fetchedAt);
    }

    private static string? Str(JsonElement o, string name) =>
        o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool TryRate(JsonElement o, string name, out double rate)
    {
        rate = 0;
        return o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out rate) && Sane(rate);
    }

    private static bool Sane(double r) => double.IsFinite(r) && r >= MinRate && r <= MaxRate;

    /// <summary>
    /// <paramref name="amount"/> of <paramref name="from"/> in <paramref name="to"/>, or null when either currency isn't
    /// in the table (or the amount isn't a finite number). Same currency is returned unchanged, even without rates.
    /// </summary>
    public static double? Convert(double amount, string? from, string? to, FxSnapshot? fx)
    {
        if (!double.IsFinite(amount) || !IsCode(from) || !IsCode(to)) return null;
        if (from == to) return amount;
        if (fx is null || !fx.Rates.TryGetValue(from!, out var f) || !fx.Rates.TryGetValue(to!, out var t)) return null;
        var v = amount / f * t;
        return double.IsFinite(v) ? v : null;
    }

    /// <summary>The rates as a JSON object for the cache file and the bridge (invariant culture, round-trippable).</summary>
    public static string Serialize(FxSnapshot s)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("base", s.Base);
            w.WriteString("date", s.Date);
            w.WriteString("fetchedAt", s.FetchedAt.ToString("O", CultureInfo.InvariantCulture));
            w.WriteStartObject("rates");
            foreach (var (k, v) in s.Rates.OrderBy(p => p.Key, StringComparer.Ordinal)) w.WriteNumber(k, v);
            w.WriteEndObject();
            w.WriteEndObject();
        }
        return System.Text.Encoding.UTF8.GetString(ms.ToArray());
    }

    /// <summary>Reads a cache file written by <see cref="Serialize"/> (validated exactly like a network answer).</summary>
    public static FxSnapshot? Deserialize(string? json)
    {
        if (string.IsNullOrWhiteSpace(json) || json.Length > MaxBytes) return null;
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 8 });
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            var at = Str(root, "fetchedAt");
            if (at is null || !DateTimeOffset.TryParse(at, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var fetchedAt)) return null;
            return ParseObject(root, fetchedAt);
        }
        catch (JsonException) { return null; }
    }
}
