using System.Text;
using System.Text.RegularExpressions;
using Vystral.Core.Controller;
using Vystral.Core.Parsing;

namespace Vystral.Windows.Integrations;

/// <summary>
/// Track Q: finds the Steam Input layout Steam would use for a game on this PC and reads it. Read-only:
/// it never writes a config, never downloads one (Valve's official configs are only read once Steam itself
/// has put them on disk), and treats every file as untrusted (size and depth caps, paths confined to Steam's folder).
///
/// Where Steam keeps them:
/// <list type="bullet">
/// <item><c>steamapps/common/Steam Controller Configs/&lt;account&gt;/config/configset_&lt;controller&gt;.vdf</c> — which layout each app uses
/// (<c>"template"</c> = a file in <c>controller_base/templates</c>, <c>"workshop"</c> = a downloaded config, <c>"autosave"</c> = your own edits).</item>
/// <item><c>…/config/&lt;appid&gt;/controller_&lt;type&gt;.vdf</c> — your own (auto-saved) layout.</item>
/// <item><c>steamapps/workshop/content/241100/&lt;id&gt;/*</c> — community and official layouts Steam downloaded.</item>
/// <item><c>userdata/&lt;account&gt;/241100/remote/controller_config/&lt;appid&gt;/*.vdf</c> — the older cloud location.</item>
/// </list>
/// </summary>
public sealed partial class SteamInputLocator(Func<string?> steamPath)
{
    private const int MaxConfigSetBytes = 1024 * 1024;
    private const int MaxConfigSets = 64;

    // Xbox layouts first: that's the diagram VYSTRAL draws. Then other common pads, then device-specific sets (newest first).
    private static readonly string[] TypePriority =
    [
        "controller_xboxone", "controller_xboxelite", "controller_xbox360", "controller_generic", "controller_ps5", "controller_ps4",
        "controller_switch_pro", "controller_neptune", "controller_steamcontroller_gordon", "controller_ps3",
    ];

    [GeneratedRegex(@"^[A-Za-z0-9_+\-]{1,80}\.vdf\z")]
    private static partial Regex TemplateName();

    [GeneratedRegex(@"^[0-9]{1,20}\z")]
    private static partial Regex Digits();

    [GeneratedRegex(@"^[A-Za-z0-9_\-]{1,80}\.(?:vdf|bin)\z")]
    private static partial Regex ConfigFileName();

    public ControllerLayoutDto Get(string? appId)
    {
        if (appId is null || !Digits().IsMatch(appId) || appId.Length > 10) return ControllerLayoutDto.Simple("notSteam");
        var steam = steamPath();
        if (steam is null || !Directory.Exists(steam)) return ControllerLayoutDto.Simple("noSteam");
        try
        {
            return Find(Path.GetFullPath(steam), appId) ?? ControllerLayoutDto.Simple("none");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            Services.Log.Warn("controls", "Couldn't read Steam Input files", new { appId }, ex);
            return ControllerLayoutDto.Simple("none");
        }
    }

    /// <summary>
    /// Track X: the layout the game uses next to the one it started from — the template or Workshop layout Steam
    /// recorded as its "progenitor", else a template with the same name, else Steam's Gamepad template for the
    /// controller type. Only files already in Steam's folder are read; nothing is written or downloaded.
    /// </summary>
    public ControllerCompareDto Compare(string? appId)
    {
        var yours = Get(appId);
        if (yours.Status != "steamInput") return ControllerCompareDto.Simple("notSteamInput", yours);
        var steam = steamPath();
        if (steam is null) return ControllerCompareDto.Simple("notSteamInput", yours);
        try
        {
            steam = Path.GetFullPath(steam);
            var found = FindDetailed(steam, appId!);
            if (found is null || found.Layout.Status != "steamInput") return ControllerCompareDto.Simple("notSteamInput", yours);
            var layout = found.Layout;
            if (layout.SourceKind == "template")
                return new ControllerCompareDto("same", layout, layout, "self", layout.TemplateName ?? layout.Title, [], layout.Sets.Sum(s => s.Controls.Count), [], [], null);

            var templates = Path.Combine(steam, "controller_base", "templates");
            if (SteamInputCompare.Progenitor(found.Progenitor) is { } origin)
            {
                var baseline = origin.Kind == "template"
                    ? LoadDetailed(Path.Combine(templates, origin.Value), steam, "template", layout.ControllerType)?.Layout
                    : FirstConfig(Path.Combine(steam, "steamapps", "workshop", "content", "241100", origin.Value), layout.ControllerType) is { } w
                        ? LoadDetailed(w, steam, "workshop", layout.ControllerType)?.Layout : null;
                if (baseline is { Status: "steamInput" })
                    return SteamInputCompare.Compare(layout, baseline, "progenitor", baseline.Title ?? "the layout it started from");
            }

            // Same name as a template for this controller type ("Gamepad", "Keyboard (WASD) and Mouse").
            var candidates = TemplatesFor(templates, layout.ControllerType);
            if (layout.Title is { Length: > 0 } title)
            {
                foreach (var file in candidates)
                {
                    if (LoadDetailed(file, steam, "template", layout.ControllerType)?.Layout is { Status: "steamInput" } t &&
                        string.Equals(t.Title, title, StringComparison.OrdinalIgnoreCase))
                        return SteamInputCompare.Compare(layout, t, "title", t.Title);
                }
            }
            foreach (var name in SteamInputCompare.DefaultTemplateCandidates(layout.ControllerType))
            {
                if (!TemplateName().IsMatch(name)) continue;
                if (LoadDetailed(Path.Combine(templates, name), steam, "template", layout.ControllerType)?.Layout is { Status: "steamInput" } d)
                    return SteamInputCompare.Compare(layout, d, "controllerDefault", d.Title ?? "Gamepad");
            }
            return ControllerCompareDto.Simple("noDefault", layout, "Steam's templates aren't on this PC, so there's nothing to compare with.");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            Services.Log.Warn("controls", "Couldn't compare Steam Input layouts", new { appId }, ex);
            return ControllerCompareDto.Simple("noDefault", yours, "VYSTRAL couldn't read Steam's templates.");
        }
    }

    /// <summary>Template files for one controller type (at most 16), so a name match never parses the whole folder.</summary>
    private static IReadOnlyList<string> TemplatesFor(string templates, string? controllerType)
    {
        if (!Directory.Exists(templates) || controllerType is not { Length: > 0 and <= 40 }) return [];
        var prefix = controllerType.ToLowerInvariant() + "_";
        return new DirectoryInfo(templates).EnumerateFiles("*.vdf").Take(400)
            .Where(f => TemplateName().IsMatch(f.Name) && f.Name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            .OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase).Take(16).Select(f => f.FullName).ToList();
    }

    /// <summary>A layout found on disk, with the "progenitor" Steam recorded in it (what a personal layout started from).</summary>
    private sealed record Found(ControllerLayoutDto Layout, string? Progenitor);

    private ControllerLayoutDto? Find(string steam, string appId) => FindDetailed(steam, appId)?.Layout;

    private Found? FindDetailed(string steam, string appId)
    {
        var configsRoot = Path.Combine(steam, "steamapps", "common", "Steam Controller Configs");
        foreach (var account in Accounts(steam, configsRoot))
        {
            var config = Path.Combine(configsRoot, account, "config");
            if (!Directory.Exists(config)) continue;
            foreach (var (setFile, type) in ConfigSets(config))
            {
                var node = ReadConfigSetEntry(setFile, steam, appId);
                if (node is null) continue;
                if (node.GetString("template") is { } template && TemplateName().IsMatch(template))
                {
                    var file = Path.Combine(steam, "controller_base", "templates", template);
                    if (LoadDetailed(file, steam, "template", type) is { } t) return t with { Layout = t.Layout with { TemplateName = t.Layout.Title }, Progenitor = "templates\\" + template };
                }
                if (node.GetString("workshop") is { } workshop && Digits().IsMatch(workshop))
                {
                    var dir = Path.Combine(steam, "steamapps", "workshop", "content", "241100", workshop);
                    if (FirstConfig(dir, null) is { } file && LoadDetailed(file, steam, "workshop", type) is { } w) return w;
                }
                if (FirstConfig(Path.Combine(config, appId), type) is { } own && LoadDetailed(own, steam, "personal", type) is { } p) return p;
            }
            // No entry in any set, but Steam may still have saved your edits for this app.
            if (FirstConfig(Path.Combine(config, appId), "controller_xboxone") is { } saved && LoadDetailed(saved, steam, "personal", null) is { } s) return s;
            var legacy = Path.Combine(steam, "userdata", account, "241100", "remote", "controller_config", appId);
            if (FirstConfig(legacy, "controller_xboxone") is { } cloud && LoadDetailed(cloud, steam, "personal", null) is { } c) return c;
        }
        return null;
    }

    private static IEnumerable<string> Accounts(string steam, string configsRoot)
    {
        if (!Directory.Exists(configsRoot)) yield break;
        var recent = SteamAdapter.FindMostRecentAccountId(steam);
        var all = new DirectoryInfo(configsRoot).EnumerateDirectories()
            .Where(d => Digits().IsMatch(d.Name))
            .OrderByDescending(d => d.Name == recent).ThenByDescending(d => d.LastWriteTimeUtc)
            .Take(8).Select(d => d.Name).ToList();
        foreach (var a in all) yield return a;
    }

    private static IEnumerable<(string File, string? Type)> ConfigSets(string config)
    {
        var files = new DirectoryInfo(config).EnumerateFiles("configset_*.vdf").Take(MaxConfigSets * 2).ToList();
        string? TypeOf(FileInfo f)
        {
            var t = Path.GetFileNameWithoutExtension(f.Name)["configset_".Length..];
            return t.StartsWith("controller_", StringComparison.OrdinalIgnoreCase) ? t.ToLowerInvariant() : null;
        }
        return files
            .Select(f => (File: f, Type: TypeOf(f)))
            .OrderBy(x => x.Type is { } t && Array.IndexOf(TypePriority, t) is var i and >= 0 ? i : TypePriority.Length)
            .ThenByDescending(x => x.File.LastWriteTimeUtc)
            .Take(MaxConfigSets)
            .Select(x => (x.File.FullName, x.Type));
    }

    private static VdfNode? ReadConfigSetEntry(string file, string steam, string appId)
    {
        var text = ReadCapped(file, steam, MaxConfigSetBytes);
        if (text is null) return null;
        try
        {
            return Vdf.Parse(text, 8)["controller_config"]?[appId] is { IsObject: true } node ? node : null;
        }
        catch (FormatException) { return null; }
    }

    /// <summary>The preferred config file in a folder: controller_&lt;type&gt;.vdf when present, else the first readable one.</summary>
    private static string? FirstConfig(string dir, string? type)
    {
        if (!Directory.Exists(dir)) return null;
        var files = new DirectoryInfo(dir).EnumerateFiles().Where(f => ConfigFileName().IsMatch(f.Name)).Take(32).ToList();
        return (files.FirstOrDefault(f => type is not null && f.Name.Equals(type + ".vdf", StringComparison.OrdinalIgnoreCase))
                ?? files.FirstOrDefault(f => f.Name.StartsWith("controller_xbox", StringComparison.OrdinalIgnoreCase))
                ?? files.OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase).FirstOrDefault())?.FullName;
    }

    private static Found? LoadDetailed(string file, string steam, string kind, string? typeHint)
    {
        var text = ReadCapped(file, steam, SteamInputLayout.MaxBytes);
        if (text is null) return null;
        try
        {
            var root = Vdf.Parse(text, SteamInputLayout.MaxDepth);
            var layout = SteamInputLayout.Map(root, kind);
            var progenitor = root["controller_mappings"]?.GetString("progenitor");
            return new Found(layout.ControllerType is null && typeHint is not null
                ? layout with { ControllerType = typeHint, ControllerLabel = SteamInputLayout.ControllerLabel(typeHint) }
                : layout, progenitor);
        }
        catch (FormatException ex)
        {
            Services.Log.Warn("controls", "A Steam Input layout couldn't be read", new { kind, error = ex.Message });
            return new Found(ControllerLayoutDto.Simple("unreadable", "Steam has a layout for this game, but VYSTRAL couldn't read it.") with { SourceKind = kind }, null);
        }
    }

    /// <summary>Reads a text file only if it is inside Steam's folder, not a link out of it, and small enough.</summary>
    internal static string? ReadCapped(string file, string root, int maxBytes)
    {
        var full = Path.GetFullPath(file);
        var prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
        var info = new FileInfo(full);
        if (!info.Exists || info.Length == 0 || info.Length > maxBytes || info.LinkTarget is not null) return null;
        var bytes = File.ReadAllBytes(full);
        if (bytes.Length > maxBytes || Array.IndexOf(bytes, (byte)0) >= 0) return null; // binary, not text KeyValues
        return Encoding.UTF8.GetString(bytes);
    }
}
