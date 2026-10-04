using System.Text;

namespace Vystral.Core.Parsing;

/// <summary>A node in a Valve KeyValues (text VDF/ACF) document. Keys are case-insensitive.</summary>
public sealed class VdfNode
{
    private readonly Dictionary<string, VdfNode> _children = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<KeyValuePair<string, VdfNode>> _ordered = [];

    public string? Value { get; }
    public bool IsObject => Value is null;

    internal VdfNode(string? value) => Value = value;

    public IEnumerable<KeyValuePair<string, VdfNode>> Children => _ordered;

    public VdfNode? this[string key] => _children.TryGetValue(key, out var node) ? node : null;

    public string? GetString(string key) => this[key]?.Value;

    public long? GetLong(string key) => long.TryParse(GetString(key), out var v) ? v : null;

    /// <summary>Follows a path of keys, e.g. ("UserLocalConfigStore","Software","Valve","Steam","apps").</summary>
    public VdfNode? Path(params string[] keys)
    {
        VdfNode? node = this;
        foreach (var key in keys)
        {
            node = node?[key];
            if (node is null) return null;
        }
        return node;
    }

    internal void Add(string key, VdfNode node)
    {
        // Duplicate keys occur in real files; the first occurrence wins for lookup, all are kept in order.
        _children.TryAdd(key, node);
        _ordered.Add(new(key, node));
    }
}

/// <summary>
/// Tolerant parser for the text KeyValues format used by Steam's libraryfolders.vdf,
/// appmanifest_*.acf and localconfig.vdf. Malformed input yields a <see cref="FormatException"/>,
/// never a partially-trusted tree.
/// </summary>
public static class Vdf
{
    public const int MaxDepth = 64;

    public static VdfNode Parse(string text)
    {
        var root = new VdfNode(null);
        var reader = new Tokenizer(text);
        ParseObject(reader, root, depth: 0, topLevel: true);
        return root;
    }

    public static VdfNode ParseFile(string path) => Parse(File.ReadAllText(path, Encoding.UTF8));

    private static void ParseObject(Tokenizer reader, VdfNode target, int depth, bool topLevel)
    {
        if (depth > MaxDepth) throw new FormatException("VDF nesting too deep.");
        while (true)
        {
            var token = reader.Next();
            if (token is null)
            {
                if (topLevel) return;
                throw new FormatException("Unexpected end of VDF input; missing '}'.");
            }
            if (token.Value.Kind == TokenKind.CloseBrace)
            {
                if (topLevel) throw new FormatException("Unexpected '}' at top level.");
                return;
            }
            if (token.Value.Kind != TokenKind.String)
                throw new FormatException($"Expected key at position {reader.Position}.");

            var key = token.Value.Text;
            var next = reader.Next() ?? throw new FormatException($"Missing value for key '{key}'.");
            if (next.Kind == TokenKind.OpenBrace)
            {
                var child = new VdfNode(null);
                ParseObject(reader, child, depth + 1, topLevel: false);
                target.Add(key, child);
            }
            else if (next.Kind == TokenKind.String)
            {
                target.Add(key, new VdfNode(next.Text));
            }
            else
            {
                throw new FormatException($"Unexpected '}}' after key '{key}'.");
            }
            reader.SkipConditional();
        }
    }

    private enum TokenKind { String, OpenBrace, CloseBrace }

    private readonly record struct Token(TokenKind Kind, string Text);

    private sealed class Tokenizer(string text)
    {
        private int _pos;
        public int Position => _pos;

        public Token? Next()
        {
            SkipTrivia();
            if (_pos >= text.Length) return null;
            var c = text[_pos];
            if (c == '{') { _pos++; return new Token(TokenKind.OpenBrace, "{"); }
            if (c == '}') { _pos++; return new Token(TokenKind.CloseBrace, "}"); }
            if (c == '"') return new Token(TokenKind.String, ReadQuoted());
            return new Token(TokenKind.String, ReadBare());
        }

        /// <summary>Skips platform conditionals such as [$WIN32] that may follow a value.</summary>
        public void SkipConditional()
        {
            var save = _pos;
            SkipTrivia(stopAtNewline: true);
            if (_pos < text.Length && text[_pos] == '[')
            {
                var end = text.IndexOf(']', _pos);
                _pos = end < 0 ? text.Length : end + 1;
            }
            else
            {
                _pos = save;
            }
        }

        private void SkipTrivia(bool stopAtNewline = false)
        {
            while (_pos < text.Length)
            {
                var c = text[_pos];
                if (c == '\n' && stopAtNewline) return;
                if (char.IsWhiteSpace(c) || c == '﻿') { _pos++; continue; }
                if (c == '/' && _pos + 1 < text.Length && text[_pos + 1] == '/')
                {
                    var nl = text.IndexOf('\n', _pos);
                    _pos = nl < 0 ? text.Length : nl + 1;
                    continue;
                }
                return;
            }
        }

        private string ReadQuoted()
        {
            _pos++; // opening quote
            var sb = new StringBuilder();
            while (_pos < text.Length)
            {
                var c = text[_pos++];
                if (c == '"') return sb.ToString();
                if (c == '\\' && _pos < text.Length)
                {
                    var e = text[_pos++];
                    sb.Append(e switch { 'n' => '\n', 't' => '\t', '\\' => '\\', '"' => '"', _ => e });
                    continue;
                }
                sb.Append(c);
            }
            throw new FormatException("Unterminated string in VDF input.");
        }

        private string ReadBare()
        {
            var start = _pos;
            while (_pos < text.Length && !char.IsWhiteSpace(text[_pos]) && text[_pos] is not ('{' or '}' or '"'))
                _pos++;
            return text[start.._pos];
        }
    }
}
