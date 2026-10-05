namespace Vystral.Core.Contracts;

// Track F (data & insight). Serialized to the UI with camelCase names; mirrored in
// ui/src/bridge/types.ts (search for "Track F"). Keep both in sync.

// ---------------------------------------------------------------- achievements

/// <summary>One unlocked Steam achievement in the merged feed.</summary>
/// <param name="Icon">Cached icon on the art host, or null. Never a remote URL.</param>
public sealed record AchievementFeedItemDto(
    string AppId,
    string? GameId,
    string GameTitle,
    string ApiName,
    string Name,
    string? Description,
    string UnlockedAt,
    double? GlobalPercent,
    string? Icon);

/// <summary>
/// A page of the achievement feed, newest unlock first.
/// Status: ok | notConnected | localOnly | empty.
/// </summary>
public sealed record AchievementFeedDto(
    string Status,
    IReadOnlyList<AchievementFeedItemDto> Items,
    int Offset,
    int Total,
    bool HasMore);

/// <summary>A game with at least 70% of its achievements unlocked but not all of them.</summary>
public sealed record NearCompletionDto(
    string AppId,
    string? GameId,
    string GameTitle,
    int Unlocked,
    int Total,
    int Remaining,
    double Fraction,
    /// <summary>Name of the rarest achievement still locked; null when it is a hidden one (no spoilers).</summary>
    string? RarestRemainingName,
    double? RarestRemainingPercent,
    bool RarestRemainingHidden,
    string? LastUnlockAt);

/// <summary>Status: ok | notConnected | localOnly | empty.</summary>
public sealed record AchievementOverviewDto(
    string Status,
    string? Message,
    int TotalUnlocked,
    int GamesWithData,
    int Rare,
    int UltraRare,
    string? LastFetched,
    IReadOnlyList<NearCompletionDto> NearCompletion);

/// <summary>Pushed as 'achievements.unlocked' after a session when Steam reports new unlocks from it.</summary>
/// <param name="RareThreshold">Smallest of 1/2/5/10 % that the rarest new unlock is below; null when none is below 10%.</param>
/// <param name="RareCount">How many of the new unlocks are below <paramref name="RareThreshold"/>.</param>
public sealed record AchievementUnlockEventDto(
    string SessionId,
    string GameId,
    string GameTitle,
    string AppId,
    IReadOnlyList<AchievementFeedItemDto> Items,
    double? RareThreshold,
    int RareCount);

// ---------------------------------------------------------------- GPU driver comparison

public sealed record DriverVersionDto(string Version, string? GpuName, string FirstSeen, string LastSeen, int Sessions);

/// <summary>Median figures over the sessions of one game on one driver.</summary>
public sealed record DriverSideDto(
    string Version,
    string? GpuName,
    int Sessions,
    double? FpsAvg,
    double? Fps1Low,
    double? FrameTimeP99Ms,
    string From,
    string To);

public sealed record DriverGameComparisonDto(
    string GameId,
    DriverSideDto Before,
    DriverSideDto After,
    /// <summary>When the newer driver was first seen in any tracked session.</summary>
    string ChangedAt,
    /// <summary>Fewer than three sessions on either side.</summary>
    bool SmallSample,
    /// <summary>The GPU name differs between the two sides (a different graphics card or a laptop switching GPUs).</summary>
    bool GpuChanged);

public sealed record DriverInsightDto(
    IReadOnlyList<DriverVersionDto> Drivers,
    IReadOnlyList<DriverGameComparisonDto> Games,
    int SessionsWithDriver,
    int SessionsWithFps,
    /// <summary>Games played on two or more drivers where no frame rate was measured.</summary>
    int GamesWithoutFps);

// ---------------------------------------------------------------- background apps

public sealed record BackgroundAppStatDto(
    string Name,
    string DisplayName,
    /// <summary>Analysed sessions in which the app was among the heaviest.</summary>
    int Sessions,
    /// <summary>Share of analysed sessions in which it was seen (0–1).</summary>
    double Presence,
    double? RoughPresence,
    double? CleanPresence,
    /// <summary>RoughPresence − CleanPresence; positive means "seen more often in rough sessions".</summary>
    double? Lift,
    double? AvgMb,
    double? MaxMb,
    double? AvgCpu);

/// <summary>
/// Which other apps tend to be running during rough sessions. Correlation only.
/// Mode: fps (rough = poor 1% lows, frequent stutter or a saturated CPU) | memory (rough = memory nearly full) | none.
/// </summary>
public sealed record BackgroundImpactDto(
    string Mode,
    int SessionsAnalyzed,
    int RoughSessions,
    int CleanSessions,
    bool Enough,
    IReadOnlyList<BackgroundAppStatDto> Suspects,
    IReadOnlyList<BackgroundAppStatDto> Common,
    IReadOnlyList<string> Hidden,
    bool Collecting);
