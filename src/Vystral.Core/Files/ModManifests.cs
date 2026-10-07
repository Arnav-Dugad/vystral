using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Parsing;

namespace Vystral.Core.Files;

// Track X: read-only mod folder viewer — parsing of the files that describe them. Pure and tolerant: every file is
// untrusted (Steam's appworkshop_<appid>.acf, Mod Organizer 2's ModOrganizer.ini and modlist.txt, Steam's public
// GetPublishedFileDetails answer). Nothing here touches the disk or the network.

/// <summary>One Workshop item Steam lists for a game.</summary>
public sealed record WorkshopManifestItem(string ItemId, long? Size, DateTimeOffset? Updated);

public sealed record WorkshopManifest(string AppId, long? SizeOnDisk, bool NeedsUpdate, IReadOnlyList<WorkshopManifestItem> Items);

/// <summary>What a Mod Organizer 2 instance says about itself.</summary>
public sealed record Mo2Instance(string? GameName, string? GamePath, string? SelectedProfile, string? ModsDirectory);

/// <summary>A Workshop item's public title.</summary>
public sealed record WorkshopTitle(string ItemId, string Title, DateTimeOffset? Updated);

public static partial class ModManifests
{
    public const int MaxItems = 5000;
    public const int MaxManifestBytes = 4 * 1024 * 1024;

    /// <summary>Reads appworkshop_&lt;appid&gt;.acf ("AppWorkshop" → "WorkshopItemsInstalled"). Throws <see cref="FormatException"/> for other files.</summary>
    public static WorkshopManifest ParseAppWorkshop(string text)
    {
        if (text.Length > MaxManifestBytes) throw new FormatException("Workshop manifest too large.");
        var root = Vdf.Parse(text, 8)["AppWorkshop"] ?? throw new FormatException("Not a Workshop manifest.");
        if (!root.IsObject) throw new FormatException("Not a Workshop manifest.");
        var appId = root.GetString("appid") is { } a && AppId().IsMatch(a) ? a : throw new FormatException("No app id.");
        var items = new List<WorkshopManifestItem>();
        if (root["WorkshopItemsInstalled"] is { IsObject: true } installed)
        {
            foreach (var (id, node) in installed.Children.Take(MaxItems))
            {
                if (!ItemId().IsMatch(id) || !node.IsObject) continue;
                var size = node.GetLong("size") is >= 0 and var s ? s : (long?)null;
                items.Add(new WorkshopManifestItem(id, size, Unix(node.GetLong("timeupdated"))));
            }
        }
        var sizeOnDisk = root.GetLong("SizeOnDisk") is >= 0 and var total ? total : (long?)null;
        return new WorkshopManifest(appId, sizeOnDisk, root.GetString("NeedsUpdate") == "1", items);
    }

    /// <summary>
    /// ModOrganizer.ini (Qt INI). Values may be wrapped as <c>@ByteArray(…)</c> and use doubled backslashes.
    /// </summary>
    public static Mo2Instance ParseMo2Ini(string text)
    {
        string? gameName = null, gamePath = null, profile = null, mods = null;
        var section = "";
        foreach (var line0 in text.Split('\n').Take(4000))
        {
            var line = line0.Trim();
            if (line.Length == 0 || line[0] is ';' or '#') continue;
            if (line[0] == '[' && line[^1] == ']') { section = line[1..^1].Trim().ToLowerInvariant(); continue; }
            var eq = line.IndexOf('=');
            if (eq <= 0) continue;
            var key = line[..eq].Trim().ToLowerInvariant();
            var value = IniValue(line[(eq + 1)..]);
            if (section == "general")
            {
                if (key == "gamename") gameName = Clip(value, 120);
                else if (key == "gamepath") gamePath = value;
                else if (key == "selected_profile") profile = Clip(value, 120);
            }
            else if (section == "settings" && key == "mod_directory") mods = value;
        }
        return new Mo2Instance(gameName, Path(gamePath), profile, Path(mods));
    }

    /// <summary>modlist.txt: "+Name" enabled, "-Name" disabled, "*Name" unmanaged (e.g. DLC). Later lines don't override earlier ones.</summary>
    public static IReadOnlyDictionary<string, bool> ParseModlist(string text)
    {
        var map = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        foreach (var raw in text.Split('\n').Take(MaxItems * 2))
        {
            var line = raw.Trim();
            if (line.Length < 2 || line[0] == '#') continue;
            if (line[0] is not ('+' or '-')) continue;
            var name = line[1..].Trim();
            if (name.Length is 0 or > 260) continue;
            map.TryAdd(name, line[0] == '+');
        }
        return map;
    }

    /// <summary>
    /// The public answer of ISteamRemoteStorage/GetPublishedFileDetails. Only items whose own result is 1 count; titles
    /// are cleaned (control and bidi characters removed) and clipped; ids must be digits.
    /// </summary>
    public static IReadOnlyList<WorkshopTitle> ParsePublishedFileDetails(string json)
    {
        var list = new List<WorkshopTitle>();
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
            if (!doc.RootElement.TryGetProperty("response", out var response) || response.ValueKind != JsonValueKind.Object) return list;
            if (!response.TryGetProperty("publishedfiledetails", out var items) || items.ValueKind != JsonValueKind.Array) return list;
            foreach (var item in items.EnumerateArray().Take(200))
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                if (!item.TryGetProperty("result", out var r) || r.ValueKind != JsonValueKind.Number || r.GetInt32() != 1) continue;
                var id = item.TryGetProperty("publishedfileid", out var idEl) ? idEl.ValueKind switch
                {
                    JsonValueKind.String => idEl.GetString(),
                    JsonValueKind.Number => idEl.GetRawText(),
                    _ => null,
                } : null;
                if (id is null || !ItemId().IsMatch(id)) continue;
                var title = item.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? CleanTitle(t.GetString()) : null;
                if (string.IsNullOrEmpty(title)) continue;
                DateTimeOffset? updated = item.TryGetProperty("time_updated", out var u) && u.ValueKind == JsonValueKind.Number && u.TryGetInt64(out var secs)
                    ? Unix(secs) : null;
                list.Add(new WorkshopTitle(id, title, updated));
            }
        }
        catch (JsonException) { }
        return list;
    }

    public static string CleanTitle(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return "";
        var chars = s.Where(c => !char.IsControl(c) && CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.Format).ToArray();
        var clean = new string(chars).Trim();
        return clean.Length <= 120 ? clean : clean[..119].TrimEnd() + "…";
    }

    public static bool IsItemId(string? s) => s is not null && ItemId().IsMatch(s);

    private static DateTimeOffset? Unix(long? seconds) =>
        seconds is > 0 and < 32503680000 ? DateTimeOffset.FromUnixTimeSeconds(seconds.Value) : null;

    private static string IniValue(string raw)
    {
        var v = raw.Trim();
        if (v.StartsWith("@ByteArray(", StringComparison.Ordinal) && v.EndsWith(')')) v = v["@ByteArray(".Length..^1];
        if (v.Length >= 2 && v[0] == '"' && v[^1] == '"') v = v[1..^1];
        return v.Replace(@"\\", @"\");
    }

    /// <summary>A local, fully qualified folder path, or null (UNC, relative, control characters, too long).</summary>
    private static string? Path(string? p)
    {
        if (string.IsNullOrWhiteSpace(p) || p.Length > 400 || p.Any(char.IsControl)) return null;
        p = p.Replace('/', '\\').Trim();
        if (p.StartsWith(@"\\", StringComparison.Ordinal) || p.Length < 3 || p[1] != ':' || !char.IsAsciiLetter(p[0]) || p[2] != '\\') return null;
        if (p.Split('\\').Any(s => s == "..")) return null;
        return p.TrimEnd('\\');
    }

    private static string? Clip(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..max];

    [GeneratedRegex(@"^[0-9]{1,10}\z")]
    private static partial Regex AppId();

    [GeneratedRegex(@"^[0-9]{1,20}\z")]
    private static partial Regex ItemId();
}

/// <summary>Vortex keeps each game's mods in %APPDATA%\Vortex\&lt;gameId&gt;\mods by default. Its ids for common Steam games.</summary>
public static class VortexGames
{
    private static readonly Dictionary<string, string> BySteamApp = new(StringComparer.Ordinal)
    {
        // Only ids we're sure of; a wrong guess would simply find no folder.
        ["489830"] = "skyrimse", ["72850"] = "skyrim", ["377160"] = "fallout4", ["22380"] = "falloutnv", ["22300"] = "fallout3",
        ["22330"] = "oblivion", ["22320"] = "morrowind", ["1716740"] = "starfield", ["1091500"] = "cyberpunk2077", ["292030"] = "witcher3",
        ["1086940"] = "baldursgate3", ["413150"] = "stardewvalley", ["1245620"] = "eldenring", ["582010"] = "monsterhunterworld",
        ["892970"] = "valheim",
    };

    public static string? ForSteamApp(string? appId) => appId is not null && BySteamApp.TryGetValue(appId, out var id) ? id : null;

    /// <summary>Vortex game ids are lower-case letters and digits.</summary>
    public static bool IsGameId(string? s) => s is { Length: > 0 and <= 40 } && s.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c));
}
