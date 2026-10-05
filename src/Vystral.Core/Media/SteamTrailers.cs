using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vystral.Core.Media;

/// <summary>
/// A trailer chosen from Steam's public appdetails. <see cref="Format"/> is "hls" (an HLS master
/// playlist of fragmented-MP4 segments, which is what Steam serves today) or "mp4"/"webm" (the
/// single-file fields Steam used to include and may still return for some apps).
/// </summary>
public sealed record SteamTrailer(string SteamAppId, string MovieId, string? Name, string Format, string Url, string? Thumbnail, bool Highlight);

/// <summary>
/// Picks a trailer from appdetails JSON and maps the UI's proxy paths to upstream URLs.
/// Everything here is pure and allow-listed: only HTTPS URLs on Steam's own CDN hosts, only for
/// the exact appid, and only a fixed set of file names, so the proxy can never fetch an
/// arbitrary URL even if the database or the page were tampered with.
/// </summary>
public static partial class SteamTrailers
{
    /// <summary>Steam CDN hosts that serve store trailers (video) and their legacy single files.</summary>
    public static readonly IReadOnlySet<string> AllowedHosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "video.akamai.steamstatic.com", "video.fastly.steamstatic.com", "video.cloudflare.steamstatic.com",
        "cdn.akamai.steamstatic.com", "cdn.fastly.steamstatic.com", "cdn.cloudflare.steamstatic.com",
        "shared.akamai.steamstatic.com", "shared.fastly.steamstatic.com", "shared.cloudflare.steamstatic.com",
        "steamcdn-a.akamaihd.net",
    };

    /// <summary>The fixed path used by the UI for a single-file (legacy mp4/webm) trailer.</summary>
    public const string FileEntry = "video";

    /// <summary>The fixed path used by the UI for an HLS trailer's master playlist.</summary>
    public const string MasterEntry = "hls_264_master.m3u8";

    /// <summary>
    /// Chooses the best trailer for <paramref name="appId"/>: the first highlighted movie (else the first
    /// movie) that has a usable source. HLS is preferred because it lets the player cap resolution and
    /// buffer only what it shows; legacy single files are used only when no HLS is offered, mp4 (H.264)
    /// before webm, and the "max" quality before "480". Returns null when nothing is usable.
    /// </summary>
    public static SteamTrailer? Select(string appId, string appDetailsJson)
    {
        if (!AppIdPattern().IsMatch(appId)) return null;
        using var doc = JsonDocument.Parse(appDetailsJson);
        if (!doc.RootElement.TryGetProperty(appId, out var entry) || entry.ValueKind != JsonValueKind.Object ||
            !entry.TryGetProperty("success", out var ok) || ok.ValueKind != JsonValueKind.True ||
            !entry.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object ||
            !data.TryGetProperty("movies", out var movies) || movies.ValueKind != JsonValueKind.Array)
            return null;

        var candidates = new List<SteamTrailer>();
        foreach (var m in movies.EnumerateArray())
        {
            if (m.ValueKind != JsonValueKind.Object) continue;
            var t = FromMovie(appId, m);
            if (t is not null) candidates.Add(t);
        }
        return candidates.FirstOrDefault(c => c.Highlight) ?? candidates.FirstOrDefault();
    }

    private static SteamTrailer? FromMovie(string appId, JsonElement m)
    {
        var movieId = m.TryGetProperty("id", out var id) && id.ValueKind is JsonValueKind.Number or JsonValueKind.String ? id.ToString() : "";
        if (!MovieIdPattern().IsMatch(movieId)) return null;
        var name = m.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? Trim(n.GetString()!, 160) : null;
        var thumb = m.TryGetProperty("thumbnail", out var th) && th.ValueKind == JsonValueKind.String && IsAllowedUrl(th.GetString(), out _) ? th.GetString() : null;
        var highlight = m.TryGetProperty("highlight", out var h) && h.ValueKind == JsonValueKind.True;

        if (m.TryGetProperty("hls_h264", out var hls) && hls.ValueKind == JsonValueKind.String && IsValidHlsMaster(appId, hls.GetString()))
            return new SteamTrailer(appId, movieId, name, "hls", hls.GetString()!, thumb, highlight);

        foreach (var (field, format) in new[] { ("mp4", "mp4"), ("webm", "webm") })
        {
            if (!m.TryGetProperty(field, out var files) || files.ValueKind != JsonValueKind.Object) continue;
            foreach (var quality in new[] { "max", "480" })
            {
                if (files.TryGetProperty(quality, out var u) && u.ValueKind == JsonValueKind.String && IsAllowedUrl(u.GetString(), out var uri) &&
                    uri!.AbsolutePath.EndsWith("." + format, StringComparison.OrdinalIgnoreCase))
                    return new SteamTrailer(appId, movieId, name, format, uri.AbsoluteUri, thumb, highlight);
            }
        }
        return null;
    }

    /// <summary>An HLS master on an allowed host, under /store_trailers/{appId}/…, named hls_264_master.m3u8.</summary>
    public static bool IsValidHlsMaster(string appId, string? url)
    {
        if (!IsAllowedUrl(url, out var uri)) return false;
        var segments = uri!.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments.Length >= 3 && segments[0] == "store_trailers" && segments[1] == appId &&
               segments[^1] == MasterEntry && segments.All(s => SafeSegment().IsMatch(s));
    }

    /// <summary>HTTPS, default port, no credentials, on an allow-listed Steam CDN host.</summary>
    public static bool IsAllowedUrl(string? url, out Uri? uri)
    {
        uri = null;
        if (string.IsNullOrEmpty(url) || url.Length > 1000 || !Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
        if (u.Scheme != Uri.UriSchemeHttps || !u.IsDefaultPort || u.UserInfo.Length > 0 || !AllowedHosts.Contains(u.Host)) return false;
        uri = u;
        return true;
    }

    /// <summary>
    /// Maps a relative path requested by the UI (below /trailer/{gameId}/) to the upstream URL, or null
    /// if it isn't one of the files this trailer is allowed to serve. HLS trailers may only fetch the
    /// master, variant/audio playlists and fMP4 segments in the master's own folder; single-file
    /// trailers only expose <see cref="FileEntry"/>.
    /// </summary>
    public static Uri? ResolveUpstream(SteamTrailer trailer, string relativePath)
    {
        if (relativePath.Length is 0 or > 120) return null;
        if (trailer.Format is "mp4" or "webm")
            return relativePath == FileEntry && IsAllowedUrl(trailer.Url, out var file) ? file : null;
        if (trailer.Format != "hls" || !IsValidHlsMaster(trailer.SteamAppId, trailer.Url)) return null;
        if (!HlsFile().IsMatch(relativePath)) return null;

        var master = new Uri(trailer.Url);
        var folder = master.GetLeftPart(UriPartial.Path);
        folder = folder[..(folder.LastIndexOf('/') + 1)];
        // The master keeps its cache-busting query; the files it references are immutable.
        var upstream = new Uri(folder + relativePath + (relativePath == MasterEntry ? master.Query : ""));
        // Belt and braces: the result must still be inside the trailer's folder on the same host.
        return upstream.Host == master.Host && upstream.AbsoluteUri.StartsWith(folder, StringComparison.Ordinal) ? upstream : null;
    }

    /// <summary>The media type the proxy returns for a relative path (never taken from upstream).</summary>
    public static string ContentTypeFor(SteamTrailer trailer, string relativePath) =>
        relativePath.EndsWith(".m3u8", StringComparison.Ordinal) ? "application/vnd.apple.mpegurl"
        : relativePath.EndsWith(".m4s", StringComparison.Ordinal) ? "video/mp4"
        : trailer.Format == "webm" ? "video/webm" : "video/mp4";

    private static string Trim(string s, int max)
    {
        var t = new string(s.Where(c => !char.IsControl(c)).ToArray()).Trim();
        return t.Length > max ? t[..max] : t;
    }

    [GeneratedRegex(@"^[0-9]{1,10}\z")]
    private static partial Regex AppIdPattern();

    [GeneratedRegex(@"^[0-9]{1,12}\z")]
    private static partial Regex MovieIdPattern();

    [GeneratedRegex(@"^[A-Za-z0-9_.\-]{1,80}\z")]
    private static partial Regex SafeSegment();

    [GeneratedRegex(@"^(?:hls_264_master\.m3u8|hls_264_[0-9]{1,2}_(?:video|audio)\.m3u8|dash_h264/(?:init-stream[0-9]{1,2}\.m4s|chunk-stream[0-9]{1,2}-[0-9]{1,6}\.m4s))\z")]
    private static partial Regex HlsFile();
}
