using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Files;
using Vystral.Windows.DataSources;
using Vystral.Windows.Integrations;
using Vystral.Windows.Services;

namespace Vystral.Windows.Storage;

/// <param name="Id">Opaque: the Workshop item id, or a short hash of a mod folder's name (used to open it).</param>
/// <param name="Title">The Workshop title (opt-in lookup, cached), when known.</param>
/// <param name="Enabled">Mod Organizer 2's selected profile says it's on/off; null when unknown.</param>
/// <param name="Present">The item's folder is on disk (Workshop items can be listed before they've downloaded).</param>
/// <param name="Installed">Track D1: when its folder was created on this PC (the update timeline's "installed"); null when not on disk.</param>
public sealed record ModItemDto(string Id, string Name, string? Title, long? Bytes, string? Updated, bool? Enabled, bool Present, string? Installed = null);

/// <param name="Id">workshop | vortex | mo2-&lt;n&gt;.</param>
/// <param name="Kind">workshop | vortex | mo2.</param>
/// <param name="Folder">The folder on this PC (the user's own path; shown, never sent anywhere).</param>
public sealed record ModSourceDto(string Id, string Kind, string Label, string? Detail, string Folder, long Bytes, int Count, bool Partial, IReadOnlyList<ModItemDto> Items);

/// <param name="Titles">off | offline | notSteam | none (nothing to name) | ready (some can be looked up) | done.</param>
public sealed record ModsDto(string GameId, string? AppId, IReadOnlyList<ModSourceDto> Sources, string Titles, int MissingTitles, string ScannedAt);

/// <summary>
/// Track X: a read-only view of a game's mods — Steam Workshop items (<c>steamapps\workshop\content\&lt;appid&gt;</c> and
/// <c>appworkshop_&lt;appid&gt;.acf</c>), Vortex's default staging folder (<c>%APPDATA%\Vortex\&lt;game&gt;\mods</c>) and Mod
/// Organizer 2 instances in their default place (<c>%LOCALAPPDATA%\ModOrganizer\*</c>) whose game path is this game's folder.
/// Nothing is ever changed: no file is opened for writing, moved or deleted; folders open only in Explorer.
/// </summary>
public sealed partial class ModFolders(Func<string?> steamPath, string cacheDir)
{
    public const int MaxItemsPerSource = 2000;
    public const int FileBudget = 200_000;
    private const int MaxTitleCache = 20_000;
    public static readonly TimeSpan TitleTtl = TimeSpan.FromDays(14);

    /// <summary>Test hooks for the per-user folders.</summary>
    public Func<string> RoamingAppData { get; init; } = () => Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
    public Func<string> LocalAppData { get; init; } = () => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    private readonly ConcurrentDictionary<string, Dictionary<string, string>> _folders = new(StringComparer.Ordinal);
    private readonly Lock _titleLock = new();
    private string TitleFile => Path.Combine(cacheDir, "workshop-titles.json");

    [GeneratedRegex(@"^[0-9]{1,10}\z")]
    private static partial Regex AppId();

    [GeneratedRegex(@"^[A-Za-z0-9 _\-.()]{1,80}\z")]
    private static partial Regex ProfileName();

    public ModsDto List(string gameId, string? appId, IReadOnlyList<string> installPaths, string title, Func<int, string> titlesState)
    {
        var budget = new FolderBudget(FileBudget);
        var sources = new List<ModSourceDto>();
        var folders = new Dictionary<string, string>(StringComparer.Ordinal);
        if (appId is not null && AppId().IsMatch(appId) && Workshop(appId, budget, folders) is { } w) sources.Add(w);
        if (VortexGames.ForSteamApp(appId) is { } vortexId && Vortex(vortexId, budget, folders) is { } v) sources.Add(v);
        sources.AddRange(Mo2(installPaths, title, budget, folders));
        _folders[gameId] = folders;

        var missing = sources.Where(s => s.Kind == "workshop").SelectMany(s => s.Items).Count(i => i.Title is null);
        var state = appId is null ? "notSteam" : sources.All(s => s.Kind != "workshop") ? "none" : titlesState(missing);
        return new ModsDto(gameId, appId, sources, state, missing, DateTimeOffset.UtcNow.ToString("O"));
    }

    /// <summary>The folder for an id from the last listing of this game (never a path from the page).</summary>
    public string? FolderFor(string gameId, string sourceId, string? itemId)
    {
        if (!_folders.TryGetValue(gameId, out var map)) return null;
        return map.TryGetValue(itemId is null ? sourceId : $"{sourceId}/{itemId}", out var path) ? path : null;
    }

    /// <summary>Workshop item ids in the last listing that have no cached title.</summary>
    public IReadOnlyList<string> UntitledWorkshopItems(string gameId)
    {
        if (!_folders.TryGetValue(gameId, out var map)) return [];
        var titles = ReadTitles();
        return map.Keys.Where(k => k.StartsWith("workshop/", StringComparison.Ordinal)).Select(k => k["workshop/".Length..])
            .Where(id => !titles.ContainsKey(id)).Take(WorkshopDetailsClient.Batch).ToList();
    }

    // ---------- Steam Workshop ----------

    private ModSourceDto? Workshop(string appId, FolderBudget budget, Dictionary<string, string> folders)
    {
        var steam = steamPath();
        if (steam is null) return null;
        try
        {
            foreach (var library in SteamAdapter.GetLibraryFolders(steam).Take(32))
            {
                var workshop = Path.Combine(library, "steamapps", "workshop");
                var acf = Path.Combine(workshop, $"appworkshop_{appId}.acf");
                var content = Path.Combine(workshop, "content", appId);
                WorkshopManifest? manifest = null;
                var info = new FileInfo(acf);
                if (info.Exists && info.Length <= ModManifests.MaxManifestBytes)
                {
                    try { manifest = ModManifests.ParseAppWorkshop(File.ReadAllText(acf)); }
                    catch (FormatException ex) { Log.Warn("mods", "A Workshop manifest couldn't be read", new { appId, error = ex.Message }); }
                }
                var contentDir = new DirectoryInfo(content);
                var hasContent = contentDir.Exists && contentDir.LinkTarget is null;
                if (manifest is null && !hasContent) continue;

                var titles = ReadTitles();
                var byId = new Dictionary<string, ModItemDto>(StringComparer.Ordinal);
                foreach (var item in manifest?.Items ?? [])
                    byId[item.ItemId] = new ModItemDto(item.ItemId, item.ItemId, null, item.Size, item.Updated?.ToString("O"), null, false);
                if (hasContent)
                {
                    foreach (var dir in contentDir.EnumerateDirectories().Where(d => ModManifests.IsItemId(d.Name) && d.LinkTarget is null).Take(MaxItemsPerSource))
                    {
                        byId.TryGetValue(dir.Name, out var known);
                        var measured = known?.Bytes is null ? budget.Measure(dir.FullName) : default;
                        byId[dir.Name] = new ModItemDto(dir.Name, dir.Name, null, known?.Bytes ?? measured.Bytes,
                            known?.Updated ?? (measured.Newest ?? new DateTimeOffset(dir.LastWriteTimeUtc, TimeSpan.Zero)).ToString("O"), null, true, Created(dir));
                        folders[$"workshop/{dir.Name}"] = dir.FullName;
                    }
                    folders["workshop"] = contentDir.FullName;
                }
                else folders["workshop"] = workshop;
                var items = byId.Values
                    .Select(i => titles.TryGetValue(i.Id, out var t) ? i with { Title = t.Title } : i)
                    .OrderByDescending(i => i.Updated, StringComparer.Ordinal).Take(MaxItemsPerSource).ToList();
                var total = manifest?.SizeOnDisk is > 0 ? manifest.SizeOnDisk.Value : items.Sum(i => i.Bytes ?? 0);
                var detail = manifest?.NeedsUpdate == true ? "Steam has updates waiting for some items." : null;
                return new ModSourceDto("workshop", "workshop", "Steam Workshop", detail, folders["workshop"], total, items.Count, false, items);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            Log.Warn("mods", "Couldn't read Workshop folders", new { appId }, ex);
        }
        return null;
    }

    // ---------- Vortex (default staging folder) ----------

    private ModSourceDto? Vortex(string vortexId, FolderBudget budget, Dictionary<string, string> folders)
    {
        if (!VortexGames.IsGameId(vortexId)) return null;
        try
        {
            var mods = Path.Combine(RoamingAppData(), "Vortex", vortexId, "mods");
            var dir = new DirectoryInfo(mods);
            if (!dir.Exists || dir.LinkTarget is not null) return null;
            var items = Folders(dir, "vortex", budget, folders, null, out var partial);
            folders["vortex"] = dir.FullName;
            return new ModSourceDto("vortex", "vortex", "Vortex", "Vortex's default staging folder. Which mods are on lives in Vortex itself.",
                dir.FullName, items.Sum(i => i.Bytes ?? 0), items.Count, partial, items);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            Log.Warn("mods", "Couldn't read the Vortex folder", ex: ex);
            return null;
        }
    }

    // ---------- Mod Organizer 2 (global instances) ----------

    private IEnumerable<ModSourceDto> Mo2(IReadOnlyList<string> installPaths, string title, FolderBudget budget, Dictionary<string, string> folders)
    {
        var result = new List<ModSourceDto>();
        try
        {
            var root = new DirectoryInfo(Path.Combine(LocalAppData(), "ModOrganizer"));
            if (!root.Exists) return result;
            var wanted = installPaths.Select(Normalize).Where(p => p is not null).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var n = 0;
            foreach (var instance in root.EnumerateDirectories().Where(d => d.LinkTarget is null).Take(32))
            {
                var ini = new FileInfo(Path.Combine(instance.FullName, "ModOrganizer.ini"));
                if (!ini.Exists || ini.Length > 512 * 1024) continue;
                var info = ModManifests.ParseMo2Ini(File.ReadAllText(ini.FullName));
                var samePath = info.GamePath is not null && wanted.Contains(Normalize(info.GamePath)!);
                var sameName = info.GameName is not null && string.Equals(info.GameName, title, StringComparison.OrdinalIgnoreCase);
                if (!samePath && !sameName) continue;
                // %BASE_DIR%-relative and other custom mod folders aren't followed; only the instance's own or an absolute one.
                var modsPath = info.ModsDirectory is { } custom && !custom.Contains('%') ? custom : Path.Combine(instance.FullName, "mods");
                var dir = new DirectoryInfo(modsPath);
                if (!dir.Exists || dir.LinkTarget is not null) continue;
                IReadOnlyDictionary<string, bool>? enabled = null;
                if (info.SelectedProfile is { } profile && ProfileName().IsMatch(profile) && !profile.Contains(".."))
                {
                    var list = new FileInfo(Path.Combine(instance.FullName, "profiles", profile, "modlist.txt"));
                    if (list.Exists && list.Length <= 1024 * 1024) enabled = ModManifests.ParseModlist(File.ReadAllText(list.FullName));
                }
                var id = $"mo2-{n++}";
                var items = Folders(dir, id, budget, folders, enabled, out var partial);
                folders[id] = dir.FullName;
                var on = enabled is null ? null : (int?)items.Count(i => i.Enabled == true);
                var detail = $"Mod Organizer 2 · {instance.Name}" + (on is { } k ? $" · {k} of {items.Count} on in “{info.SelectedProfile}”" : "") + (samePath ? "" : " · matched by game name");
                result.Add(new ModSourceDto(id, "mo2", "Mod Organizer 2", detail, dir.FullName, items.Sum(i => i.Bytes ?? 0), items.Count, partial, items));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            Log.Warn("mods", "Couldn't read Mod Organizer 2 instances", ex: ex);
        }
        return result;
    }

    private static List<ModItemDto> Folders(DirectoryInfo dir, string sourceId, FolderBudget budget, Dictionary<string, string> folders,
        IReadOnlyDictionary<string, bool>? enabled, out bool partial)
    {
        partial = false;
        var items = new List<ModItemDto>();
        foreach (var d in dir.EnumerateDirectories().Where(d => d.LinkTarget is null).Take(MaxItemsPerSource))
        {
            var m = budget.Measure(d.FullName);
            partial |= m.Partial;
            var id = ShortId(d.Name);
            folders[$"{sourceId}/{id}"] = d.FullName;
            bool? on = enabled is null ? null : enabled.TryGetValue(d.Name, out var e) ? e : false;
            items.Add(new ModItemDto(id, ModManifests.CleanTitle(d.Name), null, m.Bytes, (m.Newest ?? new DateTimeOffset(d.LastWriteTimeUtc, TimeSpan.Zero)).ToString("O"), on, true, Created(d)));
        }
        return [.. items.OrderBy(i => i.Name, StringComparer.CurrentCultureIgnoreCase)];
    }

    /// <summary>Track D1: the folder's creation time (when the mod arrived on this PC), or null when Windows doesn't say.</summary>
    internal static string? Created(DirectoryInfo dir)
    {
        var t = dir.CreationTimeUtc;
        return t.Year < 2000 ? null : new DateTimeOffset(t, TimeSpan.Zero).ToString("O");
    }

    /// <summary>A stable 16-hex id for a folder name, so the page never sends a name or path back.</summary>
    public static string ShortId(string name) =>
        Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(name.ToLowerInvariant())))[..16];

    private static string? Normalize(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        try { return Path.GetFullPath(path).TrimEnd('\\'); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { return null; }
    }

    // ---------- title cache (cache\workshop-titles.json) ----------

    private sealed record CachedTitle(string Title, string? Updated, string Fetched);

    public IReadOnlyDictionary<string, CachedTitleView> ReadTitles()
    {
        lock (_titleLock)
        {
            try
            {
                if (!File.Exists(TitleFile) || new FileInfo(TitleFile).Length > 8 * 1024 * 1024) return new Dictionary<string, CachedTitleView>();
                var map = JsonSerializer.Deserialize<Dictionary<string, CachedTitle>>(File.ReadAllText(TitleFile)) ?? [];
                var now = DateTimeOffset.UtcNow;
                return map.Where(p => ModManifests.IsItemId(p.Key) && p.Value?.Title is { Length: > 0 and <= 160 }
                                      && DateTimeOffset.TryParse(p.Value.Fetched, out var at) && now - at < TitleTtl)
                    .ToDictionary(p => p.Key, p => new CachedTitleView(ModManifests.CleanTitle(p.Value.Title)), StringComparer.Ordinal);
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                return new Dictionary<string, CachedTitleView>();
            }
        }
    }

    public void SaveTitles(IReadOnlyList<WorkshopTitle> titles)
    {
        if (titles.Count == 0) return;
        lock (_titleLock)
        {
            try
            {
                Dictionary<string, CachedTitle> map = [];
                if (File.Exists(TitleFile) && new FileInfo(TitleFile).Length <= 8 * 1024 * 1024)
                {
                    try { map = JsonSerializer.Deserialize<Dictionary<string, CachedTitle>>(File.ReadAllText(TitleFile)) ?? []; }
                    catch (JsonException) { map = []; }
                }
                var now = DateTimeOffset.UtcNow.ToString("O");
                foreach (var t in titles) map[t.ItemId] = new CachedTitle(t.Title, t.Updated?.ToString("O"), now);
                foreach (var old in map.OrderBy(p => p.Value.Fetched, StringComparer.Ordinal).Take(Math.Max(0, map.Count - MaxTitleCache)).Select(p => p.Key).ToList())
                    map.Remove(old);
                Directory.CreateDirectory(cacheDir);
                var tmp = TitleFile + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(map));
                File.Move(tmp, TitleFile, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Log.Warn("mods", "Couldn't save Workshop titles", ex: ex);
            }
        }
    }
}

public sealed record CachedTitleView(string Title);
