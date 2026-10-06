using System.Text.Json;
using Vystral.Core.Data;

namespace Vystral.Windows.Recap;

/// <summary>
/// IGDB's time-to-beat estimate for one game, in seconds (player-submitted averages: "hastily" = main story,
/// "normally" = main + extras, "completely" = completionist). Any of the three may be missing.
/// </summary>
public sealed record TimeToBeatDto(long? Main, long? Extras, long? Completionist, int Count, string Fetched, string Source = "igdb");

/// <summary>The cached time-to-beat map for the library, and why it might be empty.</summary>
public sealed record TimeToBeatMapDto(IReadOnlyDictionary<string, TimeToBeatDto> Games, string? Reason);

/// <summary>Reads time to beat from cached IGDB facts (written by enrichment). Never fetches anything.</summary>
public static class TimeToBeatData
{
    /// <summary>Upper bound, matching the IGDB parser: anything at or above 10,000 hours is not a real estimate.</summary>
    public const long MaxSeconds = 36_000_000;

    /// <summary>Extracts the estimate from IGDB facts JSON, or null when there is none (or it is malformed).</summary>
    public static TimeToBeatDto? Extract(string factsJson, DateTimeOffset fetched)
    {
        if (string.IsNullOrWhiteSpace(factsJson)) return null;
        try
        {
            using var doc = JsonDocument.Parse(factsJson, new JsonDocumentOptions { MaxDepth = 16 });
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("timeToBeat", out var t) || t.ValueKind != JsonValueKind.Object)
                return null;
            static long? Secs(JsonElement o, string name) =>
                o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) && n > 0 && n < MaxSeconds ? n : null;
            var main = Secs(t, "hastily");
            var extras = Secs(t, "normally");
            var complete = Secs(t, "completely");
            if (main is null && extras is null && complete is null) return null;
            var count = t.TryGetProperty("count", out var c) && c.ValueKind == JsonValueKind.Number && c.TryGetInt64(out var cn) ? (int)Math.Clamp(cn, 0, 10_000_000) : 0;
            return new TimeToBeatDto(main, extras, complete, count, fetched.ToString("O"));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static IReadOnlyDictionary<string, TimeToBeatDto> Map(IEnumerable<IgdbFactsRow> rows)
    {
        var map = new Dictionary<string, TimeToBeatDto>(StringComparer.Ordinal);
        foreach (var r in rows)
            if (Extract(r.DataJson, r.Fetched) is { } t) map[r.GameId] = t;
        return map;
    }

    /// <summary>
    /// How far along <paramref name="playedSeconds"/> is against the first known estimate (main, then extras,
    /// then completionist), clamped to 0..1; null when nothing is known. The UI uses the same rule (lib/timeToBeat.ts).
    /// </summary>
    public static double? Progress(long playedSeconds, TimeToBeatDto? t)
    {
        var target = t?.Main ?? t?.Extras ?? t?.Completionist;
        if (target is not > 0) return null;
        return Math.Clamp(Math.Max(0, playedSeconds) / (double)target.Value, 0, 1);
    }
}
