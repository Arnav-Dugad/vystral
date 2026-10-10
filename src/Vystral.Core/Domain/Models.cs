namespace Vystral.Core.Domain;

/// <summary>How a game is started. Only these three kinds exist; anything else is rejected.</summary>
public enum LaunchKind
{
    /// <summary>A registered store protocol, e.g. steam://rungameid/123. Scheme is allow-listed per platform.</summary>
    Uri,
    /// <summary>An executable on disk, started directly with no shell interpretation.</summary>
    Executable,
    /// <summary>A packaged app identity (AppUserModelID), activated through Windows.</summary>
    PackagedApp,
}

public sealed record LaunchTarget(LaunchKind Kind, string Value, string? Arguments = null, string? WorkingDirectory = null);

/// <summary>Raw result of an adapter scan before it is reconciled with the database.</summary>
public sealed record DiscoveredInstallation
{
    public required PlatformId Platform { get; init; }
    /// <summary>Stable identifier inside the platform (Steam appid, Epic AppName, package family name, ...).</summary>
    public required string PlatformGameId { get; init; }
    public required string Title { get; init; }
    public string? InstallPath { get; init; }
    public long? SizeBytes { get; init; }
    public DateTimeOffset? LastPlayed { get; init; }
    public int? PlaytimeMinutes { get; init; }
    public required LaunchTarget Launch { get; init; }
    /// <summary>True when the store client must be running/installed for the game to start.</summary>
    public bool ClientRequired { get; init; }
    /// <summary>Known Steam appid, used as strong evidence for duplicate detection and metadata.</summary>
    public string? SteamAppId { get; init; }
    /// <summary>Local image files the platform already keeps (never downloaded by the adapter).</summary>
    public IReadOnlyDictionary<ArtworkKind, string> LocalArtwork { get; init; } = new Dictionary<ArtworkKind, string>();
    /// <summary>Executable file names (no paths) that indicate the game is running.</summary>
    public IReadOnlyList<string> ProcessHints { get; init; } = [];
    public InstallState State { get; init; } = InstallState.Installed;
    /// <summary>Track C1: "saveData" when <see cref="LastPlayed"/> is estimated from save-data write times rather than a store record.</summary>
    public string? LastPlayedSource { get; init; }
    /// <summary>Track C1: the publisher's display name as the package declares it (fills an empty game field only).</summary>
    public string? Publisher { get; init; }
    /// <summary>Track C1: the installed package version (Xbox), e.g. "1.478.564.2".</summary>
    public string? Version { get; init; }
    /// <summary>Track C1: when the package was installed, when Windows says.</summary>
    public DateTimeOffset? InstalledAt { get; init; }
}

/// <summary>Track C1: where an imported last-played date came from when it isn't the store's own record.</summary>
public static class LastPlayedSources
{
    /// <summary>Estimated from the newest write time in the game's own save-data folders.</summary>
    public const string SaveData = "saveData";
}

public enum ArtworkKind
{
    Cover,   // portrait 2:3
    Hero,    // wide background
    Logo,    // transparent title logo
    Header,  // 460x215-ish landscape capsule
    Icon,
}

public sealed record Installation
{
    public required string Id { get; init; }
    public required string GameId { get; init; }
    public required PlatformId Platform { get; init; }
    public required string PlatformGameId { get; init; }
    public required string Title { get; init; }
    public string? InstallPath { get; init; }
    public long? SizeBytes { get; init; }
    public required InstallState State { get; init; }
    public required LaunchTarget Launch { get; init; }
    public bool ClientRequired { get; init; }
    public DateTimeOffset? ImportedLastPlayed { get; init; }
    public int? ImportedPlaytimeMinutes { get; init; }
    public string? SteamAppId { get; init; }
    public IReadOnlyList<string> ProcessHints { get; init; } = [];
    public DateTimeOffset FirstSeen { get; init; }
    public DateTimeOffset LastSeen { get; init; }
    /// <summary>When true, the user pinned this installation to its game; the matcher must not move it.</summary>
    public bool ManualLink { get; init; }
}

public sealed record Game
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required string SortTitle { get; init; }
    public string? Description { get; init; }
    public string? Developer { get; init; }
    public string? Publisher { get; init; }
    public string? ReleaseDate { get; init; }
    public IReadOnlyList<string> Genres { get; init; } = [];
    public bool Favorite { get; init; }
    public bool Hidden { get; init; }
    public int? UserRating { get; init; }
    public string? Notes { get; init; }
    public string? PreferredInstallationId { get; init; }
    public string? MetadataSource { get; init; }
    public string? PaletteJson { get; init; }
    public string? SteamAppId { get; init; }
    public DateTimeOffset Added { get; init; }
}

public sealed record PlaySession
{
    public required string Id { get; init; }
    public required string GameId { get; init; }
    public string? InstallationId { get; init; }
    public required DateTimeOffset Start { get; init; }
    public DateTimeOffset? End { get; init; }
    public int DurationSeconds { get; init; }
    /// <summary>Observed by VYSTRAL ("tracked", "detected", "background"; see <see cref="SessionSources"/>) or "imported" (read from a platform). Never conflated.</summary>
    public required string Source { get; init; }
    public string? PerfSummaryJson { get; init; }
}

public sealed record Collection(string Id, string Name, string? Icon, int SortOrder, string? RuleJson);
