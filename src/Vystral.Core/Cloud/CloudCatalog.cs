using System.Text.RegularExpressions;

namespace Vystral.Core.Cloud;

/// <summary>The cloud services VYSTRAL can start a game on. Keys are what the bridge and the database use.</summary>
public static class CloudServices
{
    public const string GeForceNow = "gfn";
    public const string Xbox = "xbox";

    public static readonly IReadOnlyList<string> All = [GeForceNow, Xbox];

    public static bool IsKnown(string? key) => key is GeForceNow or Xbox;

    public static string DisplayName(string key) => key == GeForceNow ? "GeForce NOW" : "Xbox Cloud Gaming";

    /// <summary>The <c>sessions.source</c> value for a cloud session on this service.</summary>
    public static string SessionSource(string key) => key == GeForceNow ? Domain.SessionSources.CloudGfn : Domain.SessionSources.CloudXbox;
}

/// <summary>Store keys a cloud entry can carry (lower case, the same as <c>PlatformInfo.Key</c> where one exists).</summary>
public static class CloudStores
{
    public const string Steam = "steam";
    public const string Xbox = "xbox";
    public const string Epic = "epic";
    public const string Ubisoft = "ubisoft";
    public const string Gog = "gog";
    public const string Ea = "ea";
    public const string BattleNet = "battlenet";

    /// <summary>GeForce NOW's <c>appStore</c> names mapped to VYSTRAL's store keys (others are ignored).</summary>
    public static string? FromGfn(string? appStore) => appStore switch
    {
        "STEAM" => Steam,
        "XBOX" => Xbox,
        "EPIC" => Epic,
        "UPLAY" => Ubisoft,
        "GOG" => Gog,
        "EA_APP" => Ea,
        "BATTLENET" => BattleNet,
        _ => null,
    };
}

/// <summary>How a cloud entry is played. <see cref="InstallToPlay"/> is GeForce NOW's "install on the rig first" mode (paid tiers).</summary>
public static class CloudPlayTypes
{
    public const string Ready = "ready";
    public const string InstallToPlay = "install";
}

/// <summary>A store ID a cloud entry lists. For Xbox the ID is a Microsoft Store product ID (resolved to a package family name separately).</summary>
public sealed record CloudStoreLink(string Store, string StoreId);

/// <summary>
/// One streamable title from a cloud catalogue, already validated. <paramref name="EntryId"/> is GeForce NOW's
/// game UUID or the Store product ID; <paramref name="LaunchKey"/> is GeForce NOW's numeric cmsId or the product ID.
/// <paramref name="Premium"/> is true when the vendor lists a paid membership as the minimum.
/// </summary>
public sealed record CloudCatalogEntry(string Service, string EntryId, string? LaunchKey, string Title, string? PlayType, bool Premium, IReadOnlyList<CloudStoreLink> Links);

/// <summary>Strict validators for every ID that may end up in a URL or a command line.</summary>
public static partial class CloudIds
{
    public static bool IsGfnGameId(string? s) => s is not null && GfnUuid().IsMatch(s);

    /// <summary>GeForce NOW cmsId: digits only (the desktop app's <c>--url-route</c> carries nothing else).</summary>
    public static bool IsCmsId(string? s) => s is { Length: > 0 and <= 12 } && s.All(char.IsAsciiDigit) && s[0] != '0';

    /// <summary>Microsoft Store product ID: 12 upper-case letters or digits (e.g. 9NPDN9R45JX4).</summary>
    public static bool IsProductId(string? s) => s is { Length: 12 } && s.All(c => char.IsAsciiDigit(c) || char.IsAsciiLetterUpper(c));

    /// <summary>Package family name: <c>Name_PublisherHash</c>, the same shape XboxAdapter stores.</summary>
    public static bool IsPackageFamilyName(string? s) => s is not null && s.Length <= 130 && Pfn().IsMatch(s);

    public static bool IsSteamAppId(string? s) => s is { Length: > 0 and <= 10 } && s.All(char.IsAsciiDigit);

    public static bool IsGogId(string? s) => s is { Length: > 0 and <= 12 } && s.All(char.IsAsciiDigit);

    /// <summary>A two-letter country/market code (upper case).</summary>
    public static bool IsMarket(string? s) => s is { Length: 2 } && s.All(char.IsAsciiLetterUpper);

    /// <summary>A store ID worth keeping for a store (anything else from a catalogue is dropped).</summary>
    public static bool IsStoreId(string store, string? id) => store switch
    {
        CloudStores.Steam => IsSteamAppId(id),
        CloudStores.Xbox => IsProductId(id),
        CloudStores.Gog => IsGogId(id),
        _ => id is { Length: > 0 and <= 64 } && id.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '_'),
    };

    [GeneratedRegex(@"\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z")]
    private static partial Regex GfnUuid();

    [GeneratedRegex(@"\A[A-Za-z0-9][A-Za-z0-9.\-]{1,100}_[a-z0-9]{13}\z")]
    private static partial Regex Pfn();
}
