namespace Vystral.Core.Contracts;

// These records are serialized to the React UI with camelCase names. Their TypeScript
// mirror lives in ui/src/bridge/types.ts — keep both in sync.

public sealed record ArtworkDto(string? Cover, string? Hero, string? Logo, string? Header, string? Icon);

public sealed record InstallationDto(
    string Id,
    string Platform,
    string PlatformGameId,
    string Title,
    string State,
    string? InstallPath,
    string? Drive,
    long? SizeBytes,
    bool ClientRequired,
    string LaunchKind,
    string? ImportedLastPlayed,
    int? ImportedPlaytimeMinutes,
    string? UserLaunchArgs,
    bool ManualLink,
    string LastSeen);

public sealed record GameDto(
    string Id,
    string Title,
    string SortTitle,
    string? Description,
    string? Developer,
    string? Publisher,
    string? ReleaseDate,
    IReadOnlyList<string> Genres,
    bool Favorite,
    bool Hidden,
    int? UserRating,
    string? Notes,
    string? PreferredInstallationId,
    string? MetadataSource,
    string? Palette,
    ArtworkDto Art,
    IReadOnlyList<InstallationDto> Installations,
    IReadOnlyList<string> Collections,
    long TrackedSeconds,
    int SessionCount,
    string? LastTrackedPlay,
    string Added,
    string? Status = null,
    string? StatusChangedAt = null);

public sealed record CollectionDto(string Id, string Name, string? Icon, int SortOrder, string? Rule, int Count);

public sealed record DuplicateSuggestionDto(string GameIdA, string GameIdB, string Explanation);

public sealed record LibrarySnapshotDto(
    IReadOnlyList<GameDto> Games,
    IReadOnlyList<CollectionDto> Collections,
    IReadOnlyList<DuplicateSuggestionDto> DuplicateSuggestions,
    string? LastScan);

public sealed record AdapterInfoDto(
    string Platform,
    string DisplayName,
    bool Enabled,
    string Status,
    string? ClientPath,
    string? Detail,
    IReadOnlyList<string> Capabilities,
    IReadOnlyList<string> Limitations,
    int? LastScanCount,
    string? LastScanError,
    int? LastScanMs);

public sealed record SessionDto(
    string Id,
    string GameId,
    string? InstallationId,
    string Start,
    string? End,
    int DurationSeconds,
    string Source,
    string? PerfSummary);

public sealed record PerfSampleDto(int T, double? Cpu, double? Gpu, double? GpuMemMb, double? RamMb, double? GpuTempC);
