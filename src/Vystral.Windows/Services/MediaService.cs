using Vystral.Core.Data;
using Vystral.Core.Matching;
using Vystral.Windows.Integrations;

namespace Vystral.Windows.Services;

public sealed record MediaFolderDto(string Id, string Path, string Label, bool Automatic, bool Exists);

public sealed record MediaItemDto(
    string Url,
    string ThumbUrl,
    string Name,
    string Kind,           // image | video
    string FolderId,
    string ModifiedAt,    // file timestamp; the UI labels it as such
    long SizeBytes,
    string? GameId,
    string? MatchedBy);   // "steam-appid" | "filename" | null

/// <summary>
/// Moments Vault: lists screenshots and clips from folders the user approved. Files are served
/// to the UI through a filtered handler that only resolves paths inside those folders and only
/// for image/video types. Nothing is uploaded, moved or modified.
/// </summary>
public sealed class MediaService(LibraryRepository repo, SettingsService settings, SteamAdapter steam)
{
    public const string MediaHost = "media.vystral.example";
    private static readonly HashSet<string> ImageExt = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
    private static readonly HashSet<string> VideoExt = [".mp4", ".webm"];
    private const int MaxItems = 4000;

    private readonly Lock _lock = new();
    private Dictionary<string, string> _roots = new(StringComparer.Ordinal);

    public IReadOnlyList<MediaFolderDto> GetFolders()
    {
        var list = new List<MediaFolderDto>();
        var steamPath = steam.FindSteamPath();
        if (steamPath is not null)
        {
            var p = Path.Combine(steamPath, "userdata");
            list.Add(new("steam", p, "Steam screenshots", true, Directory.Exists(p)));
        }
        var captures = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "Captures");
        list.Add(new("gamebar", captures, "Xbox Game Bar captures", true, Directory.Exists(captures)));
        foreach (var (id, path) in repo.GetMediaFolders())
            list.Add(new(id, path, Path.GetFileName(path.TrimEnd('\\')) is { Length: > 0 } n ? n : path, false, Directory.Exists(path)));
        lock (_lock) _roots = list.ToDictionary(f => f.Id, f => f.Path, StringComparer.Ordinal);
        return list;
    }

    public IReadOnlyList<MediaItemDto> List(Func<string, string?> gameIdForSteamApp, IReadOnlyList<(string Id, string Title)> games)
    {
        if (!settings.GetBool("moments.enabled")) return [];
        var titleIndex = games.Select(g => (g.Id, Key: TitleNormalizer.Normalize(g.Title).Base))
            .Where(g => g.Key.Length >= 3).OrderByDescending(g => g.Key.Length).ToList();
        var items = new List<MediaItemDto>();
        foreach (var folder in GetFolders().Where(f => f.Exists))
        {
            IEnumerable<string> files;
            try
            {
                files = folder.Id == "steam"
                    ? Directory.EnumerateDirectories(folder.Path)
                        .Select(acc => Path.Combine(acc, "760", "remote"))
                        .Where(Directory.Exists)
                        .SelectMany(r => Directory.EnumerateFiles(r, "*.*", new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 3, IgnoreInaccessible = true }))
                        .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}thumbnails{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase))
                    : Directory.EnumerateFiles(folder.Path, "*.*", new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 4, IgnoreInaccessible = true });
                foreach (var file in files)
                {
                    var ext = Path.GetExtension(file).ToLowerInvariant();
                    var kind = ImageExt.Contains(ext) ? "image" : VideoExt.Contains(ext) ? "video" : null;
                    if (kind is null) continue;
                    var info = new FileInfo(file);
                    var rel = Path.GetRelativePath(folder.Path, file).Replace('\\', '/');
                    var encoded = string.Join('/', rel.Split('/').Select(Uri.EscapeDataString));
                    string? gameId = null, matchedBy = null;
                    if (folder.Id == "steam")
                    {
                        // userdata/<account>/760/remote/<appid>/screenshots/<file>
                        var parts = rel.Split('/');
                        if (parts.Length >= 5 && parts[3].All(char.IsAsciiDigit) && gameIdForSteamApp(parts[3]) is { } gid)
                            (gameId, matchedBy) = (gid, "steam-appid");
                    }
                    else
                    {
                        var stem = TitleNormalizer.Normalize(Path.GetFileNameWithoutExtension(file)).Base;
                        var hit = titleIndex.FirstOrDefault(t => stem.StartsWith(t.Key + " ", StringComparison.Ordinal) || stem == t.Key);
                        if (hit.Id is not null) (gameId, matchedBy) = (hit.Id, "filename");
                    }
                    items.Add(new MediaItemDto(
                        $"https://{MediaHost}/f/{folder.Id}/{encoded}",
                        kind == "image" ? $"https://{MediaHost}/t/{folder.Id}/{encoded}" : "",
                        info.Name, kind, folder.Id, info.LastWriteTime.ToString("O"), info.Length, gameId, matchedBy));
                    if (items.Count >= MaxItems * 2) break;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Log.Warn("media", "Media folder unreadable", new { folder.Id }, ex);
            }
        }
        return items.OrderByDescending(i => i.ModifiedAt).Take(MaxItems).ToList();
    }

    /// <summary>
    /// Maps a media URL path ("f/&lt;folder&gt;/&lt;relative&gt;" or "t/...") to a file on disk, or null if it
    /// isn't inside an approved folder or isn't an allowed media type.
    /// </summary>
    public (string Path, bool Thumbnail, string ContentType)? Resolve(string urlPath)
    {
        if (!settings.GetBool("moments.enabled")) return null;
        var parts = urlPath.TrimStart('/').Split('/', 3);
        if (parts.Length != 3 || parts[0] is not ("f" or "t")) return null;
        string? root;
        lock (_lock)
        {
            if (_roots.Count == 0) { }
            _roots.TryGetValue(parts[1], out root);
        }
        if (root is null)
        {
            GetFolders();
            lock (_lock) _roots.TryGetValue(parts[1], out root);
        }
        if (root is null) return null;
        string full;
        try
        {
            var relative = string.Join(Path.DirectorySeparatorChar, parts[2].Split('/').Select(Uri.UnescapeDataString));
            full = Path.GetFullPath(Path.Combine(root, relative));
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }
        var rootFull = Path.GetFullPath(root).TrimEnd('\\') + "\\";
        if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) return null;
        var ext = Path.GetExtension(full).ToLowerInvariant();
        var type = ext switch
        {
            ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".webp" => "image/webp", ".gif" => "image/gif",
            ".bmp" => "image/bmp", ".mp4" => "video/mp4", ".webm" => "video/webm", _ => null,
        };
        return type is null ? null : (full, parts[0] == "t", type);
    }
}
