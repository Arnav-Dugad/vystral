using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;

namespace Vystral.Windows.Integrations;

/// <summary>
/// Small read-only helpers shared by the store adapters. Every method is tolerant: bad or
/// unreadable data yields null/false instead of an exception, so one broken entry never
/// aborts a scan.
/// </summary>
internal static class AdapterIo
{
    /// <summary>Normalizes a directory path for comparison (full path, no trailing separator).</summary>
    public static string? PathKey(string? path)
    {
        var p = UninstallScanner.NormalizeDir(path);
        if (p is null) return null;
        try
        {
            p = Path.GetFullPath(p);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException or IOException)
        {
            return null;
        }
        return p.Length > 3 ? p.TrimEnd('\\') : p;
    }

    public static bool SamePath(string? a, string? b)
    {
        var ka = PathKey(a);
        var kb = PathKey(b);
        return ka is not null && kb is not null && string.Equals(ka, kb, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>True when <paramref name="path"/> is <paramref name="root"/> or lies inside it.</summary>
    public static bool IsUnder(string? path, string? root)
    {
        var p = PathKey(path);
        var r = PathKey(root);
        if (p is null || r is null) return false;
        if (string.Equals(p, r, StringComparison.OrdinalIgnoreCase)) return true;
        var prefix = r.EndsWith('\\') ? r : r + "\\";
        return p.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    public static bool DirectoryExists(string? path)
    {
        try
        {
            return !string.IsNullOrWhiteSpace(path) && Directory.Exists(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return false;
        }
    }

    public static bool FileExists(string? path)
    {
        try
        {
            return !string.IsNullOrWhiteSpace(path) && File.Exists(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return false;
        }
    }

    /// <summary>Combines a base directory with a relative path and rejects results that escape the base.</summary>
    public static string? CombineInside(string baseDir, string? relative)
    {
        if (string.IsNullOrWhiteSpace(relative)) return null;
        try
        {
            var rel = relative.Trim().Replace('/', '\\');
            if (Path.IsPathRooted(rel)) return null;
            var full = Path.GetFullPath(Path.Combine(baseDir, rel));
            return IsUnder(full, baseDir) ? full : null;
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException or IOException)
        {
            return null;
        }
    }

    /// <summary>Opens a file for reading while the owning client may still have it open.</summary>
    public static byte[]? ReadAllBytesShared(string path, int maxBytes = 16 * 1024 * 1024)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (fs.Length > maxBytes) return null;
            var buffer = new byte[fs.Length];
            fs.ReadExactly(buffer);
            return buffer;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    public static JsonDocument? ReadJson(string path)
    {
        var bytes = ReadAllBytesShared(path);
        if (bytes is null || bytes.Length == 0) return null;
        try
        {
            return JsonDocument.Parse(bytes, new JsonDocumentOptions
            {
                AllowTrailingCommas = true,
                CommentHandling = JsonCommentHandling.Skip,
                MaxDepth = 64,
            });
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Loads XML without DTD processing or external resolution. Falls back to sniffing UTF-16/UTF-8
    /// when the declared encoding does not match the bytes (seen in some installer files).
    /// </summary>
    public static XDocument? ReadXml(string path)
    {
        var bytes = ReadAllBytesShared(path);
        if (bytes is null || bytes.Length == 0) return null;
        var settings = new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            IgnoreComments = true,
        };
        try
        {
            using var ms = new MemoryStream(bytes);
            using var reader = XmlReader.Create(ms, settings);
            return XDocument.Load(reader);
        }
        catch (XmlException)
        {
        }

        foreach (var encoding in new Encoding[] { Encoding.Unicode, Encoding.UTF8 })
        {
            try
            {
                var text = encoding.GetString(bytes).TrimStart('﻿');
                // Drop the declaration so a mismatched encoding attribute is not re-validated.
                if (text.StartsWith("<?xml", StringComparison.Ordinal))
                {
                    var end = text.IndexOf("?>", StringComparison.Ordinal);
                    if (end > 0) text = text[(end + 2)..];
                }
                using var sr = new StringReader(text);
                using var reader = XmlReader.Create(sr, settings);
                return XDocument.Load(reader);
            }
            catch (XmlException)
            {
            }
        }
        return null;
    }

    public static string? Str(this JsonElement element, string property)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        foreach (var p in element.EnumerateObject())
        {
            if (!p.NameEquals(property) && !string.Equals(p.Name, property, StringComparison.OrdinalIgnoreCase)) continue;
            return p.Value.ValueKind switch
            {
                JsonValueKind.String => string.IsNullOrWhiteSpace(p.Value.GetString()) ? null : p.Value.GetString(),
                JsonValueKind.Number => p.Value.GetRawText(),
                _ => null,
            };
        }
        return null;
    }

    public static JsonElement? Child(this JsonElement element, string property, JsonValueKind kind)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        foreach (var p in element.EnumerateObject())
        {
            if (string.Equals(p.Name, property, StringComparison.OrdinalIgnoreCase) && p.Value.ValueKind == kind) return p.Value;
        }
        return null;
    }

    public static bool GetBool(this JsonElement element, string property) =>
        element.Child(property, JsonValueKind.True) is not null;

    public static IReadOnlyList<string> GetStringArray(this JsonElement element, string property)
    {
        if (element.Child(property, JsonValueKind.Array) is not { } arr) return [];
        return arr.EnumerateArray()
            .Where(e => e.ValueKind == JsonValueKind.String)
            .Select(e => e.GetString()!)
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .ToList();
    }

    /// <summary>Returns a plain executable file name (no path) or null when the input is not an .exe.</summary>
    public static string? ExeFileName(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        var name = path.Trim().Trim('"').Replace('/', '\\');
        var slash = name.LastIndexOf('\\');
        if (slash >= 0) name = name[(slash + 1)..];
        return name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && name.Length > 4 ? name : null;
    }
}
