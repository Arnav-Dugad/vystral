using System.Globalization;
using System.Text.Json;
using Vystral.Windows.Services;

namespace Vystral.Windows.DataSources;

/// <summary>Tolerant readers for untrusted provider JSON: wrong types are treated as missing, text is cleaned and clipped.</summary>
internal static class JsonRead
{
    public static string? Str(JsonElement e, string name, int max = 400)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return null;
        var s = v.ValueKind switch
        {
            JsonValueKind.String => v.GetString(),
            JsonValueKind.Number => v.GetRawText(),
            _ => null,
        };
        if (s is null) return null;
        s = MetadataService.Clean(s, max);
        return s.Length == 0 ? null : s;
    }

    public static double? Num(JsonElement e, string name)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return null;
        double? d = v.ValueKind switch
        {
            JsonValueKind.Number when v.TryGetDouble(out var n) => n,
            JsonValueKind.String when double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var n) => n,
            _ => null,
        };
        return d is { } x && double.IsFinite(x) ? x : null;
    }

    public static long? Long(JsonElement e, string name)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number when v.TryGetInt64(out var n) => n,
            JsonValueKind.String when long.TryParse(v.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) => n,
            _ => null,
        };
    }

    public static bool Bool(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) &&
        (v.ValueKind == JsonValueKind.True || (v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) && n != 0));

    public static JsonElement? Obj(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object ? v : null;

    public static IEnumerable<JsonElement> Arr(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray() : [];

    /// <summary>Names from an array of objects (<c>[{name:…}]</c>), cleaned, de-duplicated, capped.</summary>
    public static IReadOnlyList<string> Names(JsonElement e, string name, int take = 8, string field = "name") =>
        Arr(e, name).Select(x => x.ValueKind == JsonValueKind.Object ? Str(x, field, 80) : x.ValueKind == JsonValueKind.String ? MetadataService.Clean(x.GetString() ?? "", 80) : null)
            .Where(s => !string.IsNullOrEmpty(s)).Distinct(StringComparer.OrdinalIgnoreCase).Take(take).ToList()!;

    /// <summary>An HTTPS URL on one of <paramref name="hosts"/> (exact or subdomain), default port, no credentials; otherwise null.</summary>
    public static string? SafeUrl(string? url, params string[] hosts)
    {
        if (url is null || url.Length > 600 || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
            !uri.IsDefaultPort || uri.UserInfo.Length > 0) return null;
        var host = uri.Host.ToLowerInvariant();
        return hosts.Any(h => host == h || host.EndsWith("." + h, StringComparison.Ordinal)) ? uri.AbsoluteUri : null;
    }

    public static JsonDocument Parse(string json, string provider)
    {
        try { return JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 32 }); }
        catch (JsonException) { throw new DataSourceException(DataSourceOutcome.Malformed, $"{provider}’s answer couldn’t be read."); }
    }
}
