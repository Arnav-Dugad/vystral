using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Media;

namespace Vystral.Windows.DataSources;

/// <summary>
/// Track D4: a trailer from somewhere other than the game's own Steam page. <see cref="Kind"/> is <c>file</c> (a
/// single MP4 served through VYSTRAL's trailer proxy, like Steam's legacy files) or <c>youtube</c> (a YouTube video
/// ID, only ever shown with "Allow YouTube trailers" on, in a sandboxed youtube-nocookie.com frame).
/// </summary>
/// <param name="Source">rawg | igdb | gog</param>
public sealed record ExternalTrailer(string Source, string Kind, string? Url, string? YouTubeId, string? Name);

/// <summary>
/// Pure parsers and allow-lists for trailers from RAWG (MP4 files), IGDB and GOG (YouTube IDs). Everything that comes
/// back is untrusted: a file URL must be HTTPS on a known video CDN with a plain .mp4 path, and a YouTube ID must be
/// exactly YouTube's 11-character shape, so the proxy or the embed can never be pointed anywhere else.
/// </summary>
public static partial class ExternalTrailers
{
    /// <summary>Hosts a non-Steam MP4 trailer may come from: Steam's video CDNs (RAWG mostly relays Steam's files) and RAWG's own media CDN.</summary>
    public static readonly IReadOnlySet<string> FileHosts = new HashSet<string>(SteamTrailers.AllowedHosts.Append("media.rawg.io"), StringComparer.OrdinalIgnoreCase);

    public const int MaxUrlLength = 400;

    public static bool IsYouTubeId(string? id) => id is not null && YouTubeId().IsMatch(id);

    /// <summary>HTTPS, default port, no credentials or query, an allow-listed host, safe path segments, ending in .mp4.</summary>
    public static bool IsAllowedFile(string? url, out Uri? uri)
    {
        uri = null;
        if (url is null || url.Length > MaxUrlLength || !Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
        if (u.Scheme != Uri.UriSchemeHttps || !u.IsDefaultPort || u.UserInfo.Length > 0 || u.Query.Length > 0 || u.Fragment.Length > 0) return false;
        if (!FileHosts.Contains(u.Host)) return false;
        var segments = u.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length is 0 or > 12 || !segments.All(s => Segment().IsMatch(s) && s is not ("." or ".."))) return false;
        if (!segments[^1].EndsWith(".mp4", StringComparison.OrdinalIgnoreCase)) return false;
        uri = u;
        return true;
    }

    /// <summary>The upstream file for a proxied request: only the fixed single-file entry of an allow-listed MP4 trailer.</summary>
    public static Uri? ResolveUpstream(ExternalTrailer trailer, string relativePath) =>
        trailer.Kind == "file" && relativePath == SteamTrailers.FileEntry && IsAllowedFile(trailer.Url, out var uri) ? uri : null;

    /// <summary>
    /// RAWG's <c>/games/{id}/movies</c>: <c>results[].{id, name, data: {"480": url, "max": url}}</c>. Picks the first
    /// movie with an allow-listed file, "max" quality first.
    /// </summary>
    public static ExternalTrailer? ParseRawgMovies(string json)
    {
        using var doc = JsonRead.Parse(json, "RAWG");
        foreach (var m in JsonRead.Arr(doc.RootElement, "results").Take(20))
        {
            if (JsonRead.Obj(m, "data") is not { } data) continue;
            foreach (var quality in new[] { "max", "480" })
            {
                var url = data.TryGetProperty(quality, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                if (IsAllowedFile(url, out var uri)) return new ExternalTrailer("rawg", "file", uri!.AbsoluteUri, null, Name(JsonRead.Str(m, "name", 120)));
            }
        }
        return null;
    }

    /// <summary>
    /// IGDB's <c>game_videos</c>: <c>[{video_id, name}]</c>, YouTube IDs. Prefers one named like a trailer (launch,
    /// announcement and reveal trailers included) over gameplay videos and developer diaries.
    /// </summary>
    public static ExternalTrailer? ParseIgdbVideos(string json)
    {
        using var doc = JsonRead.Parse(json, "IGDB");
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
        var videos = doc.RootElement.EnumerateArray().Take(30)
            .Select(v => (Id: JsonRead.Str(v, "video_id", 20), Name: Name(JsonRead.Str(v, "name", 120))))
            .Where(v => IsYouTubeId(v.Id)).ToList();
        if (videos.Count == 0) return null;
        var pick = videos.FirstOrDefault(v => v.Name is { } n && n.Contains("trailer", StringComparison.OrdinalIgnoreCase));
        if (pick.Id is null) pick = videos[0];
        return new ExternalTrailer("igdb", "youtube", null, pick.Id, pick.Name);
    }

    public static ExternalTrailer? FromGog(IReadOnlyList<GogVideo> videos) =>
        videos.FirstOrDefault() is { } v ? new ExternalTrailer("gog", "youtube", null, v.YouTubeId, null) : null;

    /// <summary>Re-checks a trailer read back from the cache (the database is user-writable).</summary>
    public static ExternalTrailer? Validate(ExternalTrailer? t) => t switch
    {
        null => null,
        { Source: not ("rawg" or "igdb" or "gog") } => null,
        { Kind: "file" } when IsAllowedFile(t.Url, out var u) => t with { Url = u!.AbsoluteUri, YouTubeId = null, Name = Name(t.Name) },
        { Kind: "youtube" } when IsYouTubeId(t.YouTubeId) => t with { Url = null, Name = Name(t.Name) },
        _ => null,
    };

    public static string SourceLabel(string source) => source switch { "rawg" => "RAWG", "igdb" => "IGDB", "gog" => "GOG", _ => "Steam" };

    private static string? Name(string? s)
    {
        if (s is null) return null;
        var t = new string(s.Where(c => !char.IsControl(c) && char.GetUnicodeCategory(c) != System.Globalization.UnicodeCategory.Format).ToArray()).Trim();
        return t.Length == 0 ? null : t.Length > 120 ? t[..120] : t;
    }

    [GeneratedRegex(@"\A[A-Za-z0-9_\-]{11}\z")]
    private static partial Regex YouTubeId();

    [GeneratedRegex(@"\A[A-Za-z0-9_.\-]{1,120}\z")]
    private static partial Regex Segment();
}
