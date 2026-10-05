using System.Security.Cryptography;
using System.Text;

namespace Vystral.Core.Media;

/// <summary>
/// Steam "micro-trailers": the short (about 8 s), silent, 853×480 loops the Steam store plays when
/// you hover a capsule. Steam publishes one next to every store trailer, in the same CDN folder as
/// the trailer's HLS master playlist (<c>…/store_trailers/{appid}/{id}/{hash}/{ts}/microtrailer.mp4</c>,
/// with a <c>.webm</c> twin). IStoreBrowseService/GetItems lists them as <c>trailers.highlights[].microtrailer</c>;
/// appdetails (which VYSTRAL already reads for trailers) no longer names them, so the URL is derived
/// from the stored HLS master. Everything here is pure and allow-listed, like <see cref="SteamTrailers"/>.
/// </summary>
public static class SteamMicroTrailers
{
    /// <summary>The only file name the live-tile proxy ever fetches (H.264, plays in WebView2 without MSE).</summary>
    public const string FileName = "microtrailer.mp4";

    /// <summary>Observed sizes are 1.4–3 MB; anything much larger is refused rather than cached.</summary>
    public const int MaxBytes = 6 * 1024 * 1024;

    /// <summary>
    /// The micro-trailer beside an HLS trailer's master playlist, on the same allow-listed host and in
    /// the same folder, or null for legacy single-file trailers and anything that doesn't validate.
    /// </summary>
    public static Uri? Resolve(SteamTrailer? trailer)
    {
        if (trailer is null || trailer.Format != "hls" || !SteamTrailers.IsValidHlsMaster(trailer.SteamAppId, trailer.Url)) return null;
        var master = new Uri(trailer.Url);
        var folder = master.GetLeftPart(UriPartial.Path);
        folder = folder[..(folder.LastIndexOf('/') + 1)];
        var uri = new Uri(folder + FileName);
        // Belt and braces: still HTTPS on the same allow-listed host, inside the trailer's own folder.
        return uri.Host == master.Host && uri.AbsoluteUri.StartsWith(folder, StringComparison.Ordinal) && SteamTrailers.IsAllowedUrl(uri.AbsoluteUri, out _)
            ? uri
            : null;
    }

    /// <summary>
    /// A short, stable key for a micro-trailer URL. Steam's folder names include a content hash, so a
    /// new trailer gets a new key (and a new cache file) while an unchanged one is never re-downloaded.
    /// </summary>
    public static string CacheKey(Uri uri) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(uri.AbsoluteUri)))[..16];

    /// <summary>True when the bytes start like an ISO-BMFF (MP4) file: a box size, then <c>ftyp</c>.</summary>
    public static bool LooksLikeMp4(ReadOnlySpan<byte> head) =>
        head.Length >= 12 && head[4] == (byte)'f' && head[5] == (byte)'t' && head[6] == (byte)'y' && head[7] == (byte)'p';
}
