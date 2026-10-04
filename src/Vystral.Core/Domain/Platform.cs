namespace Vystral.Core.Domain;

/// <summary>Storefronts and sources VYSTRAL can read from. Stored as lowercase strings in the database.</summary>
public enum PlatformId
{
    Steam,
    Xbox,
    Epic,
    Gog,
    Ea,
    Ubisoft,
    BattleNet,
    Manual,
}

/// <summary>
/// What an adapter can genuinely do. Adapters must never claim a capability the
/// underlying platform does not expose; the UI renders these flags directly.
/// </summary>
[Flags]
public enum AdapterCapabilities
{
    None = 0,
    DiscoverInstalled = 1 << 0,
    ImportOwned = 1 << 1,
    Launch = 1 << 2,
    LocalArtwork = 1 << 3,
    ImportPlaytime = 1 << 4,
    ImportLastPlayed = 1 << 5,
    Achievements = 1 << 6,
    InstallSize = 1 << 7,
    OpenInClient = 1 << 8,
}

public enum InstallState
{
    Installed,
    /// <summary>Previously discovered but not seen in the latest successful scan.</summary>
    Missing,
    /// <summary>Owned but not installed (only where ownership is legitimately readable).</summary>
    NotInstalled,
}

public static class PlatformInfo
{
    public static string Key(this PlatformId id) => id switch
    {
        PlatformId.BattleNet => "battlenet",
        _ => id.ToString().ToLowerInvariant(),
    };

    public static bool TryParse(string? key, out PlatformId id)
    {
        foreach (var value in Enum.GetValues<PlatformId>())
        {
            if (string.Equals(value.Key(), key, StringComparison.OrdinalIgnoreCase))
            {
                id = value;
                return true;
            }
        }
        id = default;
        return false;
    }

    public static string DisplayName(this PlatformId id) => id switch
    {
        PlatformId.Steam => "Steam",
        PlatformId.Xbox => "Xbox",
        PlatformId.Epic => "Epic Games",
        PlatformId.Gog => "GOG",
        PlatformId.Ea => "EA app",
        PlatformId.Ubisoft => "Ubisoft Connect",
        PlatformId.BattleNet => "Battle.net",
        PlatformId.Manual => "Added by you",
        _ => id.ToString(),
    };
}
