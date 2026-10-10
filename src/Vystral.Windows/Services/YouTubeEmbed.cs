using System.Text.RegularExpressions;

namespace Vystral.Windows.Services;

/// <summary>
/// Track D4: the one kind of third-party frame VYSTRAL's page may load — a YouTube trailer in privacy-enhanced mode
/// (<c>https://www.youtube-nocookie.com/embed/{11-character id}</c>), and only while "Allow YouTube trailers" is on.
/// The window's FrameNavigationStarting handler asks <see cref="IsAllowedFrame"/>; every other frame navigation is
/// still cancelled (including anything the YouTube player tries to open inside itself), top-level navigation outside
/// the app stays cancelled, and new windows, downloads and permission requests stay denied. The page additionally
/// sandboxes the frame without top navigation or popups, and its CSP allows frames from this one origin only.
/// </summary>
public static partial class YouTubeEmbed
{
    public const string Host = "www.youtube-nocookie.com";
    public const string Origin = "https://" + Host;

    /// <summary>Query parameters the page sets; anything else (playlists, list IDs, widget referrers…) is refused.</summary>
    private static readonly HashSet<string> AllowedParameters = new(StringComparer.Ordinal)
    {
        "autoplay", "mute", "playsinline", "rel", "controls", "modestbranding", "enablejsapi", "iv_load_policy", "disablekb", "fs", "cc_load_policy", "origin",
    };

    public static string EmbedUrl(string videoId) => $"{Origin}/embed/{videoId}";

    /// <summary>True only for an embed URL of one video on youtube-nocookie.com, with known, simple parameters.</summary>
    public static bool IsAllowedFrame(string? uri, bool enabled)
    {
        if (!enabled || uri is null || uri.Length > 400 || !Uri.TryCreate(uri, UriKind.Absolute, out var u)) return false;
        if (u.Scheme != Uri.UriSchemeHttps || !u.IsDefaultPort || u.UserInfo.Length > 0 || !string.Equals(u.Host, Host, StringComparison.OrdinalIgnoreCase)) return false;
        if (!EmbedPath().IsMatch(u.AbsolutePath)) return false;
        var query = u.Query.TrimStart('?');
        if (query.Length == 0) return true;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var pair in query.Split('&'))
        {
            var eq = pair.IndexOf('=');
            if (eq <= 0) return false;
            var key = pair[..eq];
            var value = pair[(eq + 1)..];
            if (!AllowedParameters.Contains(key) || !seen.Add(key)) return false;
            if (key == "origin" ? value != Uri.EscapeDataString("https://app.vystral.example") && value != "https%3A%2F%2Fapp.vystral.example"
                                : !SimpleValue().IsMatch(value)) return false;
        }
        return true;
    }

    [GeneratedRegex(@"\A/embed/[A-Za-z0-9_\-]{11}\z")]
    private static partial Regex EmbedPath();

    [GeneratedRegex(@"\A[0-9]{1,2}\z")]
    private static partial Regex SimpleValue();
}
