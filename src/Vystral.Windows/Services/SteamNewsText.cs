using System.Globalization;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Vystral.Windows.Services;

/// <summary>A run of text inside a block. Rendered as React text (never HTML).</summary>
public sealed record NewsSpan(string Text, bool Bold = false, bool Italic = false);

/// <summary>
/// One block of a sanitized news post. Kind: p | h | li | quote | code | img | hr. For "img",
/// <see cref="Image"/> holds a Steam CDN URL (native side only); the page receives a cached art-host URL instead.
/// </summary>
public sealed record NewsBlock(string Kind, IReadOnlyList<NewsSpan> Spans, string? Image = null);

/// <summary>
/// Track W: turns Steam's news markup (BBCode, HTML, or both mixed) into a small list of typed text
/// blocks. Nothing is passed through as markup: every tag is either understood (headings, paragraphs,
/// lists, quotes, code, bold/italic, line breaks, images) or dropped, scripts/styles/embeds are dropped
/// with their contents, entities are decoded once, control and bidi characters are removed, links keep
/// only their text, and images are kept only when they are HTTPS on Steam's CDNs. Sizes are capped.
/// </summary>
public static partial class SteamNewsText
{
    public const int MaxBlocks = 300;
    public const int MaxBlockChars = 4000;
    public const int MaxTotalChars = 40_000;
    public const int MaxImages = 12;
    public const int MaxInput = 200_000;
    private const string ClanImageBase = "https://clan.akamai.steamstatic.com/images";

    private static readonly HashSet<string> DropWithContents = new(StringComparer.OrdinalIgnoreCase)
    {
        "script", "style", "iframe", "object", "svg", "math", "template", "noscript", "textarea", "select", "video", "audio",
        "previewyoutube", "dynamiclink", "head", "title", "form", "button", "canvas", "applet", "frameset",
    };
    // Void elements (embed, frame, input, …) have no contents to drop; they are simply ignored like any unknown tag.

    private static readonly HashSet<string> Literal = new(StringComparer.OrdinalIgnoreCase) { "code", "pre", "noparse" };

    // [tag], [/tag], [tag=value], [tag attr="value"]; [*] for list items.
    [GeneratedRegex(@"\G\[(/?)(\*|[a-zA-Z][a-zA-Z0-9]{0,15})(=[^\[\]\r\n]{0,300}|\s[^\[\]\r\n]{0,300})?\]")]
    private static partial Regex BbTag();

    // <tag ...>, </tag>, <tag/>; attributes may not contain < or >. Bounded, so hostile input stays linear-ish.
    [GeneratedRegex(@"\G<(/?)([a-zA-Z][a-zA-Z0-9]{0,15})(\s[^<>]{0,1000})?\s*/?>")]
    private static partial Regex HtmlTag();

    [GeneratedRegex(@"\G<(?:![^<>]{0,200}|\?[^<>]{0,200}\?)>")]
    private static partial Regex HtmlDeclaration();

    [GeneratedRegex(@"(?:^|[\s""'])src\s*=\s*(?:""([^""]{0,600})""|'([^']{0,600})'|([^\s""'>\]]{1,600}))", RegexOptions.IgnoreCase)]
    private static partial Regex SrcAttr();

    [GeneratedRegex(@"[ \t\f\v ]+")]
    private static partial Regex Spaces();

    /// <summary>Entities are decoded once, so "&amp;lt;script&amp;gt;" stays visible text, never markup.</summary>
    public static string DecodeEntities(string s) => s.Contains('&') ? WebUtility.HtmlDecode(s) : s;

    /// <summary>Only HTTPS images on Steam's CDNs (clan images, store assets, user images) are kept.</summary>
    public static string? SafeImageUrl(string? raw)
    {
        if (raw is null) return null;
        var url = DecodeEntities(raw.Trim()).Replace("{STEAM_CLAN_IMAGE}", ClanImageBase, StringComparison.Ordinal);
        if (url.Length is 0 or > 500 || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return null;
        if (!uri.IsDefaultPort || uri.UserInfo.Length > 0 || uri.HostNameType != UriHostNameType.Dns) return null;
        var host = uri.Host.ToLowerInvariant();
        var steam = host.EndsWith(".steamstatic.com", StringComparison.Ordinal) || host is "steamcdn-a.akamaihd.net" or "steamuserimages-a.akamaihd.net"
            or "images.steamusercontent.com" or "cdn.steamusercontent.com";
        if (!steam) return null;
        var path = uri.AbsolutePath.ToLowerInvariant();
        return path.EndsWith(".png", StringComparison.Ordinal) || path.EndsWith(".jpg", StringComparison.Ordinal) ||
               path.EndsWith(".jpeg", StringComparison.Ordinal) || path.EndsWith(".webp", StringComparison.Ordinal)
            ? uri.AbsoluteUri : null;
    }

    /// <summary>Plain text of the first blocks (for a collapsed post), clipped at a word.</summary>
    public static string Excerpt(IReadOnlyList<NewsBlock> blocks, int max = 240)
    {
        var sb = new StringBuilder();
        foreach (var b in blocks)
        {
            if (b.Kind is "img" or "hr" or "code") continue;
            var t = string.Concat(b.Spans.Select(s => s.Text)).Replace('\n', ' ').Trim();
            if (t.Length == 0) continue;
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(t);
            if (sb.Length >= max) break;
        }
        var text = Spaces().Replace(sb.ToString(), " ").Trim();
        if (text.Length <= max) return text;
        var cut = text.LastIndexOf(' ', max - 1);
        if (cut < max / 2) cut = max - 1;
        if (char.IsHighSurrogate(text[cut - 1])) cut--;
        return text[..cut].TrimEnd(' ', ',', ';', ':', '.') + "…";
    }

    public static IReadOnlyList<NewsBlock> Parse(string? input)
    {
        if (string.IsNullOrEmpty(input)) return [];
        var raw = input.Length > MaxInput ? input[..MaxInput] : input;
        var w = new Writer();
        var drop = new Stack<string>(); // tags whose contents are being dropped
        var i = 0;
        var imgCloseMissing = false; // remembered so hostile input can't make every [img] search the rest of the post
        while (i < raw.Length && !w.Full)
        {
            var c = raw[i];
            if (c == '<' && string.CompareOrdinal(raw, i, "<!--", 0, 4) == 0)
            {
                var end = raw.IndexOf("-->", i + 4, StringComparison.Ordinal);
                i = end < 0 ? raw.Length : end + 3; // an unclosed comment hides the rest, as in a browser
                continue;
            }
            if (c == '<' && HtmlDeclaration().Match(raw, i) is { Success: true } declaration)
            {
                i += declaration.Length;
                continue;
            }
            Match? tag = c == '[' ? BbTag().Match(raw, i) : c == '<' ? HtmlTag().Match(raw, i) : null;
            if (tag is { Success: true })
            {
                var closing = tag.Groups[1].Value == "/";
                var name = tag.Groups[2].Value.ToLowerInvariant();
                var attr = tag.Groups[3].Value;
                i += tag.Length;
                var bb = c == '[';

                if (drop.Count > 0)
                {
                    // Inside dropped content only the matching close tag matters (nesting counted).
                    if (name == drop.Peek()) { if (closing) drop.Pop(); else drop.Push(name); }
                    continue;
                }
                if (!closing && DropWithContents.Contains(name))
                {
                    if (!SelfClosing(tag.Value)) drop.Push(name);
                    continue;
                }
                if (!closing && Literal.Contains(name))
                {
                    var end = FindClose(raw, i, name, bb);
                    var body = raw[i..(end < 0 ? raw.Length : end)];
                    i = end < 0 ? raw.Length : SkipCloseTag(raw, end);
                    // Inside <pre> markup is still markup; inside [code]/[noparse] it's literal text.
                    w.Code(bb ? body : StripTags(body));
                    continue;
                }
                if (name == "img" && !closing)
                {
                    var src = Src(attr);
                    if (src is null && bb && !SelfClosingBb(attr) && !imgCloseMissing)
                    {
                        // [img]https://…[/img] (the URL is at most 600 characters)
                        var end = FindClose(raw, i, "img", bb: true);
                        if (end < 0) imgCloseMissing = true;
                        else if (end - i <= 600) { src = raw[i..end]; i = SkipCloseTag(raw, end); }
                    }
                    w.Image(SafeImageUrl(src));
                    continue;
                }
                w.Tag(name, closing);
                continue;
            }

            // Plain text up to the next tag-looking character.
            var next = raw.IndexOfAny(['<', '['], i + 1);
            if (next < 0) next = raw.Length;
            if (drop.Count == 0) w.Text(raw[i..next]);
            i = next;
        }
        return w.Finish();
    }

    private static bool SelfClosing(string tag) => tag.EndsWith("/>", StringComparison.Ordinal);
    private static bool SelfClosingBb(string attr) => attr.TrimEnd().EndsWith('/');

    private static string? Src(string attr)
    {
        if (attr.Length == 0) return null;
        if (attr.StartsWith('=')) return attr[1..].Trim().Trim('"', '\'');
        var m = SrcAttr().Match(attr);
        return m.Success ? (m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value) : null;
    }

    /// <summary>Index of the matching close tag (<c>[/name]</c> or <c>&lt;/name&gt;</c>), or -1.</summary>
    private static int FindClose(string raw, int from, string name, bool bb)
    {
        var needle = bb ? $"[/{name}]" : $"</{name}";
        return raw.IndexOf(needle, from, StringComparison.OrdinalIgnoreCase);
    }

    private static int SkipCloseTag(string raw, int at)
    {
        var close = raw[at] == '[' ? raw.IndexOf(']', at) : raw.IndexOf('>', at);
        return close < 0 ? raw.Length : close + 1;
    }

    private static string StripTags(string s) =>
        HtmlTagAnywhere().Replace(s, m => m.Value.StartsWith("<br", StringComparison.OrdinalIgnoreCase) ? "\n" : "");

    [GeneratedRegex(@"<[^<>]{0,4000}>")]
    private static partial Regex HtmlTagAnywhere();

    /// <summary>Removes control characters (except newlines) and Unicode format characters such as bidi overrides.</summary>
    internal static string CleanChars(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var ch in s)
        {
            if (ch == '\n') { sb.Append('\n'); continue; }
            if (ch is '\t' or '\r') { sb.Append(ch == '\t' ? ' ' : '\n'); continue; }
            if (char.IsControl(ch)) continue;
            var cat = char.GetUnicodeCategory(ch);
            if (cat is UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator) continue;
            sb.Append(ch);
        }
        return sb.ToString();
    }

    /// <summary>Builds blocks; all limits are enforced here.</summary>
    private sealed class Writer
    {
        private readonly List<NewsBlock> _blocks = [];
        private readonly List<NewsSpan> _spans = [];
        private string _kind = "p";
        private int _bold, _italic, _quote, _total, _images, _blockChars;

        public bool Full => _blocks.Count >= MaxBlocks || _total >= MaxTotalChars;

        public void Text(string raw)
        {
            var text = CleanChars(DecodeEntities(raw.Replace("\r\n", "\n", StringComparison.Ordinal)));
            if (text.Length == 0) return;
            // A blank line ends a paragraph; single newlines stay as line breaks inside it.
            var parts = text.Split("\n\n");
            for (var p = 0; p < parts.Length; p++)
            {
                if (p > 0) Flush();
                Append(parts[p]);
            }
        }

        private void Append(string s)
        {
            s = Spaces().Replace(s, " ");
            if (s.Length == 0) return;
            var room = Math.Min(MaxBlockChars - _blockChars, MaxTotalChars - _total);
            if (room <= 0) return;
            if (s.Length > room) s = s[..(char.IsHighSurrogate(s[room - 1]) ? room - 1 : room)];
            var bold = _bold > 0;
            var italic = _italic > 0;
            if (_spans.Count > 0 && _spans[^1] is { } last && last.Bold == bold && last.Italic == italic)
                _spans[^1] = last with { Text = last.Text + s };
            else
                _spans.Add(new NewsSpan(s, bold, italic));
            _blockChars += s.Length;
            _total += s.Length;
        }

        public void Tag(string name, bool closing)
        {
            switch (name)
            {
                case "b" or "strong" or "u":
                    _bold = Math.Max(0, _bold + (closing ? -1 : 1));
                    break;
                case "i" or "em":
                    _italic = Math.Max(0, _italic + (closing ? -1 : 1));
                    break;
                case "br":
                    Append("\n");
                    break;
                case "h1" or "h2" or "h3" or "h4" or "h5" or "h6":
                    Flush();
                    _kind = closing ? "p" : "h";
                    break;
                case "*" or "li":
                    Flush();
                    _kind = closing ? "p" : "li";
                    break;
                case "list" or "olist" or "ul" or "ol":
                    Flush();
                    _kind = "p";
                    break;
                case "quote" or "blockquote":
                    Flush();
                    _quote = Math.Max(0, _quote + (closing ? -1 : 1));
                    break;
                case "hr":
                    Flush();
                    if (_blocks.Count > 0 && _blocks[^1].Kind != "hr" && !Full) _blocks.Add(new NewsBlock("hr", []));
                    break;
                case "p" or "div" or "tr" or "table" or "section" or "article" or "center" or "td" or "th" or "carousel" or "header" or "footer":
                    Flush();
                    break;
                // Links keep their text only; anything else (span, font, color, size, url, spoiler, strike…) is ignored.
            }
        }

        public void Code(string body)
        {
            Flush();
            var text = CleanChars(DecodeEntities(body.Replace("\r\n", "\n", StringComparison.Ordinal))).Trim('\n');
            if (text.Trim().Length == 0 || Full) return;
            var room = Math.Min(MaxBlockChars, MaxTotalChars - _total);
            if (room <= 0) return;
            if (text.Length > room) text = text[..room];
            _total += text.Length;
            _blocks.Add(new NewsBlock("code", [new NewsSpan(text)]));
        }

        public void Image(string? url)
        {
            if (url is null || _images >= MaxImages || Full) return;
            Flush();
            _images++;
            _blocks.Add(new NewsBlock("img", [], url));
        }

        public void Flush()
        {
            if (_spans.Count > 0)
            {
                // Trim the block's edges (including stray line breaks) and drop it when nothing visible is left.
                var first = _spans[0] with { Text = _spans[0].Text.TrimStart(' ', '\n') };
                _spans[0] = first;
                _spans[^1] = _spans[^1] with { Text = _spans[^1].Text.TrimEnd(' ', '\n') };
                var spans = _spans.Where(s => s.Text.Length > 0).Select(s => s with { Text = CollapseBreaks(s.Text) }).ToList();
                if (spans.Count > 0 && spans.Any(s => s.Text.Trim().Length > 0) && _blocks.Count < MaxBlocks)
                    _blocks.Add(new NewsBlock(_kind == "p" && _quote > 0 ? "quote" : _kind, spans));
            }
            _spans.Clear();
            _blockChars = 0;
        }

        private static string CollapseBreaks(string s)
        {
            while (s.Contains("\n\n\n", StringComparison.Ordinal)) s = s.Replace("\n\n\n", "\n\n", StringComparison.Ordinal);
            return s.Replace(" \n", "\n", StringComparison.Ordinal).Replace("\n ", "\n", StringComparison.Ordinal);
        }

        public IReadOnlyList<NewsBlock> Finish()
        {
            Flush();
            // No divider at either end.
            while (_blocks.Count > 0 && _blocks[^1].Kind == "hr") _blocks.RemoveAt(_blocks.Count - 1);
            while (_blocks.Count > 0 && _blocks[0].Kind == "hr") _blocks.RemoveAt(0);
            return _blocks;
        }
    }
}
