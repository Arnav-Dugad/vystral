using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vystral.Windows.Services;

/// <summary>
/// The <c>vystral:</c> URI scheme used to open a page in VYSTRAL from a Windows notification
/// (toast protocol activation). Any program or web page can launch a registered URI, so the
/// input is treated as hostile: only a fixed shape is accepted
/// (<c>vystral://open?route=&lt;name&gt;[&amp;id|sessionId|section=&lt;value&gt;]</c>), every value is
/// checked against an allow-list or an ID pattern, and the result is a route to *navigate to*.
/// Nothing is ever executed or launched from a URI.
/// </summary>
public static partial class ActivationUri
{
    public const string Scheme = "vystral";
    public const string Host = "open";
    /// <summary>The single switch the registered command passes: <c>"Vystral.exe" --uri "%1"</c>.</summary>
    public const string Switch = "--uri";
    public const int MaxLength = 512;

    /// <summary>Route names a notification may open (a subset of the UI's routes).</summary>
    public static readonly IReadOnlySet<string> RouteNames = new HashSet<string>(StringComparer.Ordinal)
        { "home", "library", "game", "journal", "performance", "settings", "storage", "health" };

    /// <summary>The one optional parameter each route accepts, and whether it is required.</summary>
    private static readonly Dictionary<string, (string Key, bool Required)> RouteParam = new(StringComparer.Ordinal)
    {
        ["game"] = ("id", true),
        ["performance"] = ("sessionId", false),
        ["settings"] = ("section", false),
        ["journal"] = ("tab", false),
    };

    /// <summary>Builds the URI for a route JSON (as produced by <see cref="NotificationPolicy.Route"/>). Null if the route isn't allowed.</summary>
    public static string? Build(string routeJson)
    {
        Dictionary<string, string> pairs;
        try
        {
            using var doc = JsonDocument.Parse(routeJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            pairs = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var p in doc.RootElement.EnumerateObject())
            {
                if (p.Value.ValueKind != JsonValueKind.String) return null;
                pairs[p.Name == "name" ? "route" : p.Name] = p.Value.GetString()!;
            }
        }
        catch (JsonException)
        {
            return null;
        }
        if (Validate(pairs) is null) return null;

        var sb = new StringBuilder($"{Scheme}://{Host}?route=").Append(pairs["route"]);
        foreach (var (k, v) in pairs)
            if (k != "route") sb.Append('&').Append(k).Append('=').Append(v); // values are [A-Za-z0-9-] only: no escaping needed
        return sb.ToString();
    }

    /// <summary>Parses an activation URI into a validated route JSON, or null if anything about it is unexpected.</summary>
    public static string? RouteFromUri(string? uri)
    {
        if (string.IsNullOrEmpty(uri) || uri.Length > MaxLength) return null;
        if (uri.Any(c => c <= ' ' || c >= 0x7f || c is '"' or '\\' or '<' or '>' or '`' or '{' or '}' or '|' or '^')) return null;

        // Parse by hand rather than with System.Uri so nothing is normalised, unescaped or resolved behind our back.
        var prefix = $"{Scheme}://{Host}";
        if (!uri.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
        var rest = uri[prefix.Length..];
        if (rest.StartsWith('/')) rest = rest[1..];
        if (!rest.StartsWith('?')) return null;
        var query = rest[1..];
        if (query.Length == 0 || query.Contains('#')) return null;

        var pairs = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in query.Split('&'))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0) return null;
            var key = part[..eq];
            var value = part[(eq + 1)..];
            // No percent-escapes at all: every legitimate value is plain ASCII letters, digits and '-'.
            if (!pairs.TryAdd(key, value)) return null;
        }
        return Validate(pairs);
    }

    /// <summary>Validates notification activation arguments (Windows App SDK path), same rules as URIs.</summary>
    public static string? RouteFromArguments(IDictionary<string, string>? args)
    {
        if (args is null) return null;
        var pairs = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (k, v) in args)
            if (!pairs.TryAdd(k, v)) return null;
        return Validate(pairs);
    }

    /// <summary>
    /// The URI from VYSTRAL's own command line, only when the process was started exactly as the
    /// registered command does (<c>--uri &lt;uri&gt;</c> and nothing else).
    /// </summary>
    public static string? FromArgs(IReadOnlyList<string> args) =>
        args.Count == 2 && args[0] == Switch ? args[1] : null;

    /// <summary>
    /// The URI from a raw command line (a launch redirected from a second VYSTRAL process). The
    /// first token may be the executable path. Same rule: exactly <c>--uri &lt;uri&gt;</c>.
    /// </summary>
    public static string? FromCommandLine(string? commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine) || commandLine.Length > MaxLength * 2) return null;
        var tokens = Tokenize(commandLine);
        if (tokens.Count == 3 && tokens[0] != Switch) tokens.RemoveAt(0); // leading executable path
        return FromArgs(tokens);
    }

    /// <summary>Splits a command line the way the C runtime does for the cases that matter here (quotes, spaces).</summary>
    public static List<string> Tokenize(string commandLine)
    {
        var tokens = new List<string>();
        var current = new StringBuilder();
        bool quoted = false, any = false;
        foreach (var c in commandLine)
        {
            if (c == '"') { quoted = !quoted; any = true; continue; }
            if (!quoted && char.IsWhiteSpace(c))
            {
                if (any) tokens.Add(current.ToString());
                current.Clear();
                any = false;
                continue;
            }
            current.Append(c);
            any = true;
        }
        if (any) tokens.Add(current.ToString());
        return tokens;
    }

    private static string? Validate(Dictionary<string, string> pairs)
    {
        if (!pairs.TryGetValue("route", out var name) || !RouteNames.Contains(name)) return null;
        var route = new Dictionary<string, string> { ["name"] = name };
        RouteParam.TryGetValue(name, out var param);
        foreach (var (key, value) in pairs)
        {
            if (key == "route") continue;
            if (key != param.Key || !ValueOk(key, value)) return null; // unknown, misplaced or malformed parameter
            route[key] = value;
        }
        if (param.Required && !route.ContainsKey(param.Key)) return null;
        return JsonSerializer.Serialize(route);
    }

    private static bool ValueOk(string key, string value) => key switch
    {
        "id" or "sessionId" => Hex32().IsMatch(value),
        "section" => Section().IsMatch(value),
        "tab" => value is "sessions" or "achievements",
        _ => false,
    };

    // \z, not $: '$' would also match before a trailing newline.
    [GeneratedRegex(@"^[0-9a-f]{32}\z")]
    private static partial Regex Hex32();

    [GeneratedRegex(@"^[a-z]{1,24}\z")]
    private static partial Regex Section();
}
