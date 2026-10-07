using System.Text;
using System.Text.RegularExpressions;

namespace Vystral.Core.Files;

// Track X: save-game locations from PCGamingWiki ("Save game data location" — {{Game data/saves|Windows|{{p|appdata}}\Game\}}).
// Everything here is untrusted text from a public wiki: templates are parsed by hand with caps, and a path is only
// accepted when it starts at a known Windows folder token and every segment after it is a plain name. Pure; no disk.

/// <summary>One save location as the wiki writes it.</summary>
/// <param name="Platform">windows | steam | microsoftStore | gog | epic | ea | ubisoft | battlenet.</param>
/// <param name="Raw">The location text after notes and references were removed (shown in mono).</param>
public sealed record WikiSaveLocation(string Platform, string Raw);

/// <summary>Where a token points. <see cref="Kind"/> is one of the keys in <see cref="SaveLocations.RootKinds"/>.</summary>
public sealed record SavePathPattern(string Kind, IReadOnlyList<string> Segments, bool HasWildcard, string Display);

public static partial class SaveLocations
{
    public const int MaxTemplates = 24, MaxPathsPerTemplate = 12, MaxLocations = 40, MaxRawLength = 400, MaxSegments = 24;

    /// <summary>Root kinds: the user's profile folders, shared folders, the game's install folder and Steam's folder.</summary>
    public static readonly IReadOnlyDictionary<string, string> RootKinds = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["userprofile"] = "%USERPROFILE%",
        ["documents"] = "Documents",
        ["savedgames"] = "Saved Games",
        ["appdata"] = "%APPDATA%",
        ["localappdata"] = "%LOCALAPPDATA%",
        ["locallow"] = "AppData\\LocalLow",
        ["programdata"] = "%PROGRAMDATA%",
        ["public"] = "%PUBLIC%",
        ["game"] = "Install folder",
        ["steam"] = "Steam",
    };

    private static readonly Dictionary<string, string> Platforms = new(StringComparer.OrdinalIgnoreCase)
    {
        ["windows"] = "windows", ["steam"] = "steam", ["microsoft store"] = "microsoftStore", ["xbox"] = "microsoftStore",
        ["gog.com"] = "gog", ["gog"] = "gog", ["epic games store"] = "epic", ["epic games"] = "epic", ["origin"] = "ea", ["ea app"] = "ea",
        ["uplay"] = "ubisoft", ["ubisoft connect"] = "ubisoft", ["battle.net"] = "battlenet",
    };

    /// <summary>{{p|…}} path tokens VYSTRAL understands (lower case, backslashes). Registry and non-Windows tokens are refused.</summary>
    private static readonly Dictionary<string, (string Kind, string[] Tail)> Tokens = new(StringComparer.OrdinalIgnoreCase)
    {
        ["userprofile"] = ("userprofile", []),
        ["userprofile\\documents"] = ("documents", []),
        ["userprofile\\my documents"] = ("documents", []),
        ["userprofile\\saved games"] = ("savedgames", []),
        ["userprofile\\appdata\\locallow"] = ("locallow", []),
        ["appdata"] = ("appdata", []),
        ["localappdata"] = ("localappdata", []),
        ["programdata"] = ("programdata", []),
        ["public"] = ("public", []),
        ["allusersprofile"] = ("programdata", []),
        ["game"] = ("game", []),
        ["steam"] = ("steam", []),
    };

    private static readonly Dictionary<string, string> EnvVars = new(StringComparer.OrdinalIgnoreCase)
    {
        ["USERPROFILE"] = "userprofile", ["APPDATA"] = "appdata", ["LOCALAPPDATA"] = "localappdata", ["PROGRAMDATA"] = "programdata",
        ["ALLUSERSPROFILE"] = "programdata", ["PUBLIC"] = "public",
    };

    /// <summary>Segment placeholders that stand for one folder name (any).</summary>
    private static readonly HashSet<string> WildTokens = new(StringComparer.OrdinalIgnoreCase) { "uid", "userid", "steamid", "user id", "username" };

    /// <summary>Reads every <c>{{Game data/saves|platform|path|path…}}</c> template. Capped and tolerant: anything odd is skipped.</summary>
    public static IReadOnlyList<WikiSaveLocation> ParseWikitext(string? wikitext)
    {
        var result = new List<WikiSaveLocation>();
        if (string.IsNullOrEmpty(wikitext)) return result;
        var text = Comment().Replace(wikitext.Length > 2_000_000 ? wikitext[..2_000_000] : wikitext, "");
        var templates = 0;
        foreach (Match m in SavesTemplate().Matches(text))
        {
            if (++templates > MaxTemplates || result.Count >= MaxLocations) break;
            var body = Balanced(text, m.Index);
            if (body is null) continue;
            var args = SplitArgs(body);
            if (args.Count < 3) continue;
            if (!Platforms.TryGetValue(args[1].Trim(), out var platform)) continue;
            foreach (var raw in args.Skip(2).Take(MaxPathsPerTemplate))
            {
                var clean = CleanArg(raw);
                if (clean.Length is 0 or > MaxRawLength) continue;
                if (result.Any(r => r.Platform == platform && r.Raw.Equals(clean, StringComparison.OrdinalIgnoreCase))) continue;
                result.Add(new WikiSaveLocation(platform, clean));
                if (result.Count >= MaxLocations) break;
            }
        }
        return result;
    }

    /// <summary>
    /// Turns a wiki path into a root and plain segments, or null when it isn't safe or isn't a Windows folder:
    /// it must start with exactly one known token ({{p|appdata}}, %LOCALAPPDATA%, …); no drive letters, UNC paths,
    /// "..", ":" or other reserved characters; placeholders such as &lt;user-id&gt; or {{p|uid}} become one-folder
    /// wildcards, and "*" is allowed only inside a segment.
    /// </summary>
    public static SavePathPattern? Expand(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw) || raw.Length > MaxRawLength) return null;
        var s = raw.Trim();
        if (s.Any(c => char.IsControl(c))) return null;

        string kind;
        string rest;
        var token = LeadingToken().Match(s);
        var env = LeadingEnv().Match(s);
        if (token.Success)
        {
            var name = token.Groups[1].Value.Trim().Replace('/', '\\');
            if (!Tokens.TryGetValue(name, out var t)) return null; // registry, macOS/Linux or unknown token
            kind = t.Kind;
            rest = s[token.Length..];
        }
        else if (env.Success)
        {
            if (!EnvVars.TryGetValue(env.Groups[1].Value, out var k)) return null;
            kind = k;
            rest = s[env.Length..];
        }
        else return null; // literal drive paths and relative paths aren't followed

        // A token for the profile followed by a well-known folder name maps to the real (possibly redirected) folder.
        var segments = new List<string>();
        var wildcard = false;
        var display = new StringBuilder(RootKinds[kind]);
        foreach (var part0 in rest.Split('\\', '/'))
        {
            var part = part0.Trim();
            if (part.Length == 0) continue;
            if (segments.Count >= MaxSegments) return null;
            var inline = InlineToken().Match(part);
            if (inline.Success && inline.Length == part.Length)
            {
                if (!WildTokens.Contains(inline.Groups[1].Value.Trim())) return null;
                segments.Add("*");
                wildcard = true;
                display.Append("\\<").Append(inline.Groups[1].Value.Trim().ToLowerInvariant()).Append('>');
                continue;
            }
            if (Placeholder().IsMatch(part))
            {
                segments.Add("*");
                wildcard = true;
                display.Append('\\').Append(part);
                continue;
            }
            if (part.Contains("{{") || part.Contains("}}") || part.Contains('%')) return null;
            if (part is "." or ".." || part.Length > 255 || part.EndsWith('.') && part.Trim('.').Length == 0) return null;
            if (part.IndexOfAny(['<', '>', ':', '"', '|', '?']) >= 0) return null;
            if (part.Contains('*')) wildcard = true;
            if (segments.Count == 0 && kind == "userprofile" && WellKnown(part) is { } known)
            {
                kind = known;
                display.Clear().Append(RootKinds[kind]);
                continue;
            }
            segments.Add(part);
            display.Append('\\').Append(part);
        }
        return new SavePathPattern(kind, segments, wildcard, display.ToString());
    }

    private static string? WellKnown(string segment) => segment.ToLowerInvariant() switch
    {
        "documents" or "my documents" => "documents",
        "saved games" => "savedgames",
        _ => null,
    };

    /// <summary>True for a segment pattern such as "*.sav" or "Profile*" matching <paramref name="name"/> (ordinal, ignore case).</summary>
    public static bool Matches(string pattern, string name)
    {
        if (pattern == "*") return true;
        if (!pattern.Contains('*')) return pattern.Equals(name, StringComparison.OrdinalIgnoreCase);
        var parts = pattern.Split('*');
        var pos = 0;
        for (var i = 0; i < parts.Length; i++)
        {
            var p = parts[i];
            if (p.Length == 0) continue;
            var at = name.IndexOf(p, pos, StringComparison.OrdinalIgnoreCase);
            if (at < 0 || (i == 0 && at != 0)) return false;
            pos = at + p.Length;
        }
        return parts[^1].Length == 0 || name.EndsWith(parts[^1], StringComparison.OrdinalIgnoreCase);
    }

    // ---------- template parsing ----------

    /// <summary>The template text between the outer "{{" and its matching "}}", or null when unbalanced or too long.</summary>
    private static string? Balanced(string text, int start)
    {
        var depth = 0;
        for (var i = start; i < text.Length - 1 && i - start < 8000; i++)
        {
            if (text[i] == '{' && text[i + 1] == '{') { depth++; i++; }
            else if (text[i] == '}' && text[i + 1] == '}')
            {
                depth--;
                i++;
                if (depth == 0) return text.Substring(start + 2, i - 1 - (start + 2));
            }
        }
        return null;
    }

    /// <summary>Splits template arguments on top-level "|" (not inside nested {{…}} or [[…]]).</summary>
    private static List<string> SplitArgs(string body)
    {
        var args = new List<string>();
        var sb = new StringBuilder();
        int braces = 0, brackets = 0;
        for (var i = 0; i < body.Length; i++)
        {
            var c = body[i];
            var next = i + 1 < body.Length ? body[i + 1] : '\0';
            if (c == '{' && next == '{') { braces++; sb.Append("{{"); i++; continue; }
            if (c == '}' && next == '}') { braces = Math.Max(0, braces - 1); sb.Append("}}"); i++; continue; }
            if (c == '[' && next == '[') { brackets++; sb.Append("[["); i++; continue; }
            if (c == ']' && next == ']') { brackets = Math.Max(0, brackets - 1); sb.Append("]]"); i++; continue; }
            if (c == '|' && braces == 0 && brackets == 0) { args.Add(sb.ToString()); sb.Clear(); continue; }
            sb.Append(c);
            if (args.Count > 2 + MaxPathsPerTemplate) break;
        }
        args.Add(sb.ToString());
        return args;
    }

    /// <summary>Drops references, comments, notes and markup that aren't part of the path.</summary>
    private static string CleanArg(string arg)
    {
        var s = Comment().Replace(arg, "");
        s = RefPair().Replace(s, "");
        s = RefSingle().Replace(s, "");
        s = Note().Replace(s, "");
        s = s.Replace("&nbsp;", " ").Replace("''", "");
        s = s.Replace('\n', ' ').Replace('\r', ' ').Trim();
        return s.TrimEnd('\\', '/').Trim();
    }

    [GeneratedRegex(@"\{\{\s*Game[ _]data/saves\s*\|", RegexOptions.IgnoreCase)]
    private static partial Regex SavesTemplate();

    [GeneratedRegex(@"^\{\{\s*[pP]\s*\|\s*([^{}|]{1,60})\}\}")]
    private static partial Regex LeadingToken();

    [GeneratedRegex(@"^%([A-Za-z_]{1,24})%")]
    private static partial Regex LeadingEnv();

    [GeneratedRegex(@"\{\{\s*[pP]\s*\|\s*([^{}|]{1,60})\}\}")]
    private static partial Regex InlineToken();

    [GeneratedRegex(@"^<[A-Za-z0-9 _\-]{1,40}>\z")]
    private static partial Regex Placeholder();

    [GeneratedRegex(@"<!--.*?-->", RegexOptions.Singleline)]
    private static partial Regex Comment();

    [GeneratedRegex(@"<ref[^>/]*>.*?</ref>", RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex RefPair();

    [GeneratedRegex(@"<ref[^>]*/>", RegexOptions.IgnoreCase)]
    private static partial Regex RefSingle();

    [GeneratedRegex(@"\{\{\s*(?:note|cn|citation needed|refcheck|refurl|ref)[^{}]*\}\}", RegexOptions.IgnoreCase)]
    private static partial Regex Note();
}
