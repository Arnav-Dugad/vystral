using System.Text.RegularExpressions;
using Vystral.Windows.Integrations;

namespace Vystral.Windows.Services;

/// <summary>A sanitized block for the page. For "img", <c>Image</c> is an art-host URL (or null until loaded) and <c>ImageId</c> names it.</summary>
public sealed record NewsBlockDto(string Kind, IReadOnlyList<NewsSpan> Spans, string? Image, string? ImageId);

public sealed record NewsPostDto(string Gid, string Title, string? Author, string Date, bool Patch, string Excerpt, IReadOnlyList<NewsBlockDto> Blocks, int Images, int ImagesLoaded);

/// <summary>Status: ok | none | off | notSteam | offline | unavailable | rateLimited.</summary>
public sealed record NewsDto(string Status, string? Message, string? FetchedAt, bool Stale, IReadOnlyList<NewsPostDto> Posts);

public sealed class NewsCachePost
{
    public string Gid { get; set; } = "";
    public string Title { get; set; } = "";
    public string? Author { get; set; }
    public DateTimeOffset Date { get; set; }
    public List<string> Tags { get; set; } = [];
    public List<NewsBlock> Blocks { get; set; } = [];
    public Dictionary<string, string> ImageFiles { get; set; } = [];
}

public sealed class NewsCacheFile
{
    public int Version { get; set; } = 1;
    public string AppId { get; set; } = "";
    public DateTimeOffset Fetched { get; set; }
    public List<NewsCachePost> Posts { get; set; } = [];
}

/// <summary>
/// Track W: recent official announcements and patch notes on game pages (<c>news.patchNotes</c>, on by
/// default; public ISteamNews/GetNewsForApp, no key). Posts are sanitized once (<see cref="SteamNewsText"/>)
/// and cached per app as JSON for six hours. Images are only ever Steam CDN images copied into the art
/// cache when the user expands a post (not with Data saver unless asked), and served through the art host.
/// Nothing is fetched in Offline mode or while a game runs.
/// </summary>
public sealed partial class SteamNewsService
{
    public const string SettingKey = "news.patchNotes";
    public static readonly TimeSpan Ttl = TimeSpan.FromHours(6);
    public const int PostCount = 8;
    internal const int MaxCacheFiles = 300;
    internal const int MaxImagesPerPost = 6;

    private readonly SteamWebApiClient _api;
    private readonly SettingsService _settings;
    private readonly ArtworkService _artwork;
    private readonly string _folder;
    private readonly Lock _lock = new();
    private readonly SemaphoreSlim _gate = new(1, 1);

    public Func<bool> IsGameActive { get; set; } = () => false;
    public Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

    public SteamNewsService(SteamWebApiClient api, SettingsService settings, ArtworkService artwork, string folder)
    {
        _api = api;
        _settings = settings;
        _artwork = artwork;
        _folder = folder;
    }

    private bool LocalOnly => _settings.GetBool("privacy.localOnly");
    private bool DataSaver => _artwork.SkipDownloads?.Invoke() == true;

    [GeneratedRegex(@"\b(?:patch|hotfix|update|changelog|release notes|fixes|v?\d+\.\d+(?:\.\d+)?[a-z]?)\b", RegexOptions.IgnoreCase)]
    private static partial Regex PatchTitle();

    internal static bool IsPatch(string title, IReadOnlyCollection<string> tags) =>
        tags.Contains("patchnotes", StringComparer.OrdinalIgnoreCase) || PatchTitle().IsMatch(title);

    public async Task<NewsDto> GetAsync(string? appId, bool refresh, CancellationToken ct)
    {
        if (!_settings.GetBool(SettingKey)) return new NewsDto("off", null, null, false, []);
        if (appId is null || !IsAppId(appId)) return new NewsDto("notSteam", null, null, false, []);
        var cached = Read(appId);
        var fresh = cached is not null && Now() - cached.Fetched < Ttl;
        if (fresh && !refresh) return ToDto(cached!, false, null);
        if (LocalOnly)
            return cached is null ? new NewsDto("offline", "Offline mode is on, so VYSTRAL doesn’t ask Steam for news.", null, false, [])
                : ToDto(cached, true, "Offline mode is on, so these are the posts saved on this PC.");
        if (IsGameActive())
            return cached is null ? new NewsDto("unavailable", "VYSTRAL doesn’t contact Steam while a game is running.", null, false, [])
                : ToDto(cached, true, "Showing saved posts. VYSTRAL doesn’t contact Steam while a game is running.");

        await _gate.WaitAsync(ct);
        try
        {
            // Someone else may have refreshed it while this call waited.
            cached = Read(appId);
            if (cached is not null && Now() - cached.Fetched < (refresh ? TimeSpan.FromMinutes(2) : Ttl)) return ToDto(cached, false, null);
            IReadOnlyList<SteamNewsItem> items;
            try { items = await _api.GetNewsAsync(appId, PostCount, ct); }
            catch (SteamApiException ex)
            {
                var status = ex.Outcome == SteamApiOutcome.RateLimited ? "rateLimited" : "unavailable";
                return cached is null ? new NewsDto(status, ex.Message, null, false, []) : ToDto(cached, true, ex.Message);
            }
            var file = new NewsCacheFile { AppId = appId, Fetched = Now() };
            foreach (var item in items.OrderByDescending(i => i.Date))
            {
                var keep = cached?.Posts.FirstOrDefault(p => p.Gid == item.Gid);
                file.Posts.Add(new NewsCachePost
                {
                    Gid = item.Gid, Title = item.Title, Author = item.Author, Date = item.Date, Tags = item.Tags.ToList(),
                    Blocks = SteamNewsText.Parse(item.Contents).ToList(),
                    ImageFiles = keep?.ImageFiles ?? [],
                });
            }
            Write(appId, file);
            return ToDto(file, false, null);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Copies one post's Steam CDN images into the art cache (user expanded it). Data saver needs <paramref name="force"/>.</summary>
    public async Task<NewsDto> LoadImagesAsync(string appId, string gid, bool force, CancellationToken ct)
    {
        var cached = Read(appId);
        var post = cached?.Posts.FirstOrDefault(p => p.Gid == gid);
        if (cached is null || post is null) return new NewsDto("none", "That post is no longer listed. Refresh the news.", null, false, []);
        if (!LocalOnly && !IsGameActive() && (!DataSaver || force))
        {
            var urls = post.Blocks.Where(b => b.Kind == "img" && b.Image is not null).Select(b => b.Image!).Distinct().Take(MaxImagesPerPost).ToList();
            foreach (var url in urls)
            {
                if (post.ImageFiles.TryGetValue(url, out var have) && _artwork.CachedFileExists(have)) continue;
                // Checked again here: only Steam CDN images, through the same size, type and magic-byte checks as all artwork.
                if (SteamNewsText.SafeImageUrl(url) is not { } safe) continue;
                if (await _artwork.CacheThumbAsync(safe, "news", ct) is { } rel) post.ImageFiles[url] = rel;
            }
            Write(appId, cached);
        }
        return ToDto(cached, Now() - cached.Fetched >= Ttl, null);
    }

    /// <summary>The full post on Steam, built natively from the validated appid and a post id this app's cache lists.</summary>
    public Uri? PostUrl(string appId, string gid) =>
        IsAppId(appId) && Read(appId)?.Posts.Any(p => p.Gid == gid) == true ? new Uri($"https://store.steampowered.com/news/app/{appId}/view/{gid}") : null;

    private NewsDto ToDto(NewsCacheFile file, bool stale, string? message)
    {
        var posts = file.Posts.Select(p =>
        {
            var images = 0;
            var loaded = 0;
            var blocks = p.Blocks.Select(b =>
            {
                if (b.Kind != "img") return new NewsBlockDto(b.Kind, b.Spans, null, null);
                images++;
                var rel = b.Image is not null && p.ImageFiles.TryGetValue(b.Image, out var f) && _artwork.CachedFileExists(f) ? f : null;
                if (rel is not null) loaded++;
                return new NewsBlockDto("img", [], rel is null ? null : ArtworkService.Url("", rel), ImageId(b.Image));
            }).ToList();
            return new NewsPostDto(p.Gid, p.Title, p.Author, p.Date.ToString("O"), IsPatch(p.Title, p.Tags), SteamNewsText.Excerpt(p.Blocks), blocks, images, loaded);
        }).ToList();
        return new NewsDto(posts.Count == 0 ? "none" : "ok", message, file.Fetched.ToString("O"), stale, posts);
    }

    private static string? ImageId(string? url) => url is null ? null : JsonFileCache.AccountKey(url)[..12];

    // ---------- Cache files ----------

    private string PathFor(string appId) => Path.Combine(_folder, $"{appId}.json");

    private NewsCacheFile? Read(string appId)
    {
        lock (_lock) return Validate(JsonFileCache.Read<NewsCacheFile>(PathFor(appId), 2 * 1024 * 1024), appId);
    }

    private void Write(string appId, NewsCacheFile file)
    {
        lock (_lock)
        {
            JsonFileCache.Write(PathFor(appId), file);
            Prune();
        }
    }

    private void Prune()
    {
        try
        {
            var files = new DirectoryInfo(_folder).EnumerateFiles("*.json").OrderByDescending(f => f.LastWriteTimeUtc).Skip(MaxCacheFiles).ToList();
            foreach (var f in files)
            {
                try { f.Delete(); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    private static readonly HashSet<string> Kinds = ["p", "h", "li", "quote", "code", "img", "hr"];

    /// <summary>The cache sits in a user-writable folder, so everything is checked again on the way back in.</summary>
    internal static NewsCacheFile? Validate(NewsCacheFile? f, string appId)
    {
        if (f is null || f.Version != 1 || f.AppId != appId || f.Posts is null) return null;
        var total = 0;
        f.Posts = f.Posts.Where(p => p is not null && p.Gid is { Length: > 0 and <= 20 } && p.Gid.All(char.IsAsciiDigit)).DistinctBy(p => p.Gid).Take(SteamWebApiClient.MaxNews).ToList();
        foreach (var p in f.Posts)
        {
            p.Title = SteamWebApiClient.CleanText(p.Title, 200) ?? "Untitled post";
            p.Author = SteamWebApiClient.CleanText(p.Author, 60);
            p.Tags = (p.Tags ?? []).Where(t => t is { Length: > 0 and <= 40 } && t.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-')).Take(12).ToList();
            var blocks = new List<NewsBlock>();
            foreach (var b in (p.Blocks ?? []).Take(SteamNewsText.MaxBlocks))
            {
                if (b is null || !Kinds.Contains(b.Kind)) continue;
                if (b.Kind == "img")
                {
                    if (SteamNewsText.SafeImageUrl(b.Image) is { } img) blocks.Add(new NewsBlock("img", [], img));
                    continue;
                }
                var spans = (b.Spans ?? []).Where(s => s is not null).Select(s => s with { Text = Clip(SteamNewsText.CleanChars(s.Text ?? ""), SteamNewsText.MaxBlockChars) })
                    .Where(s => s.Text.Length > 0).Take(200).ToList();
                total += spans.Sum(s => s.Text.Length);
                if (total > SteamNewsText.MaxTotalChars * 2) break;
                if (spans.Count > 0 || b.Kind == "hr") blocks.Add(new NewsBlock(b.Kind, b.Kind == "hr" ? [] : spans));
            }
            p.Blocks = blocks;
            p.ImageFiles = (p.ImageFiles ?? []).Where(kv => SteamNewsText.SafeImageUrl(kv.Key) is not null && kv.Value is { Length: <= 60 } v &&
                                                            v.StartsWith("_thumbs/news/", StringComparison.Ordinal) && !v.Contains("..", StringComparison.Ordinal))
                .Take(MaxImagesPerPost * 2).ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);
        }
        return f;
    }

    private static string Clip(string s, int max) => s.Length <= max ? s : s[..max];

    private static bool IsAppId(string s) => s.Length is > 0 and <= 10 && s.All(char.IsAsciiDigit);
}
