using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vystral.Windows.Integrations;

/// <summary>One friend from ISteamUser/GetFriendList (relationship=friend).</summary>
public sealed record SteamFriend(string SteamId, DateTimeOffset? FriendSince);

/// <summary>
/// Public profile status from ISteamUser/GetPlayerSummaries/v2. Every field is untrusted: names are
/// cleaned and clipped, avatar URLs are kept only on Steam's avatar CDN, ids are validated.
/// </summary>
public sealed record SteamPlayerSummary(
    string SteamId,
    string PersonaName,
    int PersonaState,
    string? AvatarUrl,
    string? GameAppId,
    string? GameName,
    DateTimeOffset? LastLogoff,
    bool PublicProfile);

/// <summary>Track P: friends' activity (ISteamUser/GetFriendList/v1 and GetPlayerSummaries/v2).</summary>
public sealed partial class SteamWebApiClient
{
    /// <summary>GetPlayerSummaries accepts at most 100 SteamIDs per request.</summary>
    public const int SummaryBatch = 100;
    /// <summary>Steam's own friend limit is far below this; anything larger is treated as malformed input and clipped.</summary>
    public const int MaxFriends = 3000;

    public async Task<IReadOnlyList<SteamFriend>> GetFriendListAsync(string steamId, CancellationToken ct)
    {
        var key = RequireKey();
        var (status, body) = await GetAsync($"ISteamUser/GetFriendList/v1/?key={key}&steamid={RequireSteamId(steamId)}&relationship=friend&format=json", ct);
        ThrowForFriendListStatus(status, body);
        EnsureOk(status);
        return ParseFriendList(body);
    }

    /// <summary>Summaries for up to <see cref="SummaryBatch"/> ids per request; several requests for longer lists.</summary>
    public async Task<IReadOnlyList<SteamPlayerSummary>> GetPlayerSummariesAsync(IReadOnlyList<string> steamIds, CancellationToken ct)
    {
        var result = new List<SteamPlayerSummary>(steamIds.Count);
        foreach (var batch in steamIds.Where(IsSteamId64).Distinct(StringComparer.Ordinal).Chunk(SummaryBatch))
        {
            var key = RequireKey();
            var (status, body) = await GetAsync($"ISteamUser/GetPlayerSummaries/v2/?key={key}&steamids={string.Join(',', batch)}&format=json", ct);
            if (status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                throw new SteamApiException(SteamApiOutcome.InvalidKey, "Steam didn’t accept the Web API key.");
            EnsureOk(status);
            result.AddRange(ParsePlayerSummaries(body));
        }
        return result;
    }

    /// <summary>
    /// GetFriendList answers 401 when the account's friends list isn't public. A 403 usually means the
    /// key itself was refused (Steam's HTML error page then asks to verify the key=); otherwise it's
    /// treated as the friends list being hidden too.
    /// </summary>
    internal static void ThrowForFriendListStatus(HttpStatusCode status, string body)
    {
        if (status == HttpStatusCode.Unauthorized)
            throw new SteamApiException(SteamApiOutcome.PrivateProfile, PrivateFriendsMessage);
        if (status == HttpStatusCode.Forbidden)
        {
            var keyProblem = body.Contains("key=", StringComparison.OrdinalIgnoreCase) || body.Contains("verify your", StringComparison.OrdinalIgnoreCase);
            throw keyProblem
                ? new SteamApiException(SteamApiOutcome.InvalidKey, "Steam didn’t accept your Web API key. Check it in Settings → Library & stores.")
                : new SteamApiException(SteamApiOutcome.PrivateProfile, PrivateFriendsMessage);
        }
    }

    internal const string PrivateFriendsMessage =
        "Steam won’t share your friends list because it isn’t public. In Steam, open your profile → Edit Profile → Privacy Settings and set “Friends List” to Public. Only your own setting matters here; your friends don’t need to change anything.";

    internal static IReadOnlyList<SteamFriend> ParseFriendList(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var result = new List<SteamFriend>();
            if (doc.RootElement.ValueKind != JsonValueKind.Object) throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s friends list couldn’t be read.");
            // An account with no friends answers {} or {"friendslist":{"friends":[]}}.
            if (!doc.RootElement.TryGetProperty("friendslist", out var list) || list.ValueKind != JsonValueKind.Object ||
                !list.TryGetProperty("friends", out var friends) || friends.ValueKind != JsonValueKind.Array)
                return result;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var f in friends.EnumerateArray())
            {
                if (result.Count >= MaxFriends) break;
                if (f.ValueKind != JsonValueKind.Object) continue;
                var id = Str(f, "steamid");
                if (!IsSteamId64(id) || !seen.Add(id!)) continue;
                var relationship = Str(f, "relationship");
                if (relationship is not null && !relationship.Equals("friend", StringComparison.OrdinalIgnoreCase)) continue;
                DateTimeOffset? since = f.TryGetProperty("friend_since", out var s) && s.TryGetInt64(out var t) && t is > 0 and < 32503680000
                    ? DateTimeOffset.FromUnixTimeSeconds(t) : null;
                result.Add(new SteamFriend(id!, since));
            }
            return result;
        }
        catch (JsonException)
        {
            throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s friends list couldn’t be read.");
        }
    }

    internal static IReadOnlyList<SteamPlayerSummary> ParsePlayerSummaries(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("response", out var response) || response.ValueKind != JsonValueKind.Object)
                throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s profile answer couldn’t be read.");
            var result = new List<SteamPlayerSummary>();
            if (!response.TryGetProperty("players", out var players) || players.ValueKind != JsonValueKind.Array) return result;
            foreach (var p in players.EnumerateArray())
            {
                if (result.Count >= SummaryBatch * 40) break;
                if (p.ValueKind != JsonValueKind.Object) continue;
                var id = Str(p, "steamid");
                if (!IsSteamId64(id)) continue;
                var name = CleanText(Str(p, "personaname"), 64) ?? "Steam friend";
                var state = p.TryGetProperty("personastate", out var ps) && ps.TryGetInt32(out var st) && st is >= 0 and <= 6 ? st : 0;
                var avatar = SafeAvatarUrl(Str(p, "avatarmedium")) ?? SafeAvatarUrl(Str(p, "avatar"));
                // gameid is a 64-bit "game ID": plain Steam apps are their appid; shortcuts and mods use high bits.
                var gameId = Str(p, "gameid");
                string? appId = gameId is { Length: > 0 and <= 10 } && gameId.All(char.IsAsciiDigit) &&
                                long.TryParse(gameId, NumberStyles.None, CultureInfo.InvariantCulture, out var g) && g is > 0 and <= uint.MaxValue
                    ? g.ToString(CultureInfo.InvariantCulture) : null;
                var gameName = CleanText(Str(p, "gameextrainfo"), 128);
                if (appId is null && gameName is null && gameId is { Length: > 0 }) gameName = "A non-Steam game";
                DateTimeOffset? lastLogoff = p.TryGetProperty("lastlogoff", out var ll) && ll.TryGetInt64(out var l) && l is > 0 and < 32503680000
                    ? DateTimeOffset.FromUnixTimeSeconds(l) : null;
                var visible = p.TryGetProperty("communityvisibilitystate", out var cv) && cv.TryGetInt32(out var v) && v == 3;
                result.Add(new SteamPlayerSummary(id!, name, state, avatar, appId, gameName, lastLogoff, visible));
            }
            return result;
        }
        catch (JsonException)
        {
            throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s profile answer couldn’t be read.");
        }
    }

    /// <summary>
    /// Avatar images are kept only when they are HTTPS on Steam's avatar CDN with a hash-shaped file
    /// name, so the avatar cache can never be pointed anywhere else.
    /// </summary>
    internal static string? SafeAvatarUrl(string? url)
    {
        if (url is null || url.Length > 300 || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return null;
        if (!uri.IsDefaultPort || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0) return null;
        if (!AvatarHosts.Contains(uri.Host.ToLowerInvariant())) return null;
        return AvatarPath().IsMatch(uri.AbsolutePath) ? uri.AbsoluteUri : null;
    }

    internal static readonly HashSet<string> AvatarHosts = new(StringComparer.Ordinal)
    {
        "avatars.steamstatic.com", "avatars.akamai.steamstatic.com", "avatars.cloudflare.steamstatic.com", "avatars.fastly.steamstatic.com",
        "steamcdn-a.akamaihd.net",
    };

    // Current: /<40-hex>_medium.jpg; legacy: /steamcommunity/public/images/avatars/ab/<40-hex>_medium.jpg.
    [GeneratedRegex(@"^/(?:steamcommunity/public/images/avatars/[0-9a-f]{2}/)?[0-9a-f]{40}(?:_medium|_full)?\.jpg\z")]
    private static partial Regex AvatarPath();

    private static bool IsSteamId64(string? s) =>
        s is { Length: 17 } && s.All(char.IsAsciiDigit) && s.StartsWith("7656119", StringComparison.Ordinal);

    /// <summary>Removes control and format characters (bidi overrides included), trims and clips.</summary>
    internal static string? CleanText(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        var clean = new string(s.Where(c => !char.IsControl(c) && char.GetUnicodeCategory(c) != UnicodeCategory.Format).ToArray()).Trim();
        if (clean.Length == 0) return null;
        if (clean.Length <= max) return clean;
        var cut = char.IsHighSurrogate(clean[max - 1]) ? max - 1 : max; // never split an emoji
        return clean[..cut].TrimEnd() + "…";
    }
}
