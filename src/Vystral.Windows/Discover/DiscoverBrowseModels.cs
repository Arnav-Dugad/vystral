namespace Vystral.Windows.Discover;

// Track C3: Discover's browse shelves. Mirrored in ui/src/bridge/types.discover.ts (camelCase). Additive only:
// Immersive Discover (Track C6) builds on these.

/// <summary>The library game a "Because you played" shelf starts from.</summary>
/// <param name="Why">recent (played in the last weeks) or mostPlayed.</param>
public sealed record DiscoverShelfSeedDto(string GameId, string Title, string Why);

/// <summary>One horizontal row of games.</summary>
/// <param name="Id">trending, specials, newReleases, comingSoon, free, or because:&lt;library game id&gt;.</param>
/// <param name="Kind">store (Steam's lists) or because (games like one you played).</param>
/// <param name="Reason">Plain words for where the row comes from ("Similar games, according to IGDB").</param>
/// <param name="Source">steam or igdb.</param>
public sealed record DiscoverShelfDto(string Id, string Kind, string Title, string? Reason, string Source, DiscoverShelfSeedDto? Seed,
    IReadOnlyList<DiscoverResultDto> Items);

/// <summary>Steam's store shelves.</summary>
/// <param name="State">ready, off (the opt-in is off), offline, or failed (nothing saved to show).</param>
/// <param name="Reason">Why the shelves are old or missing: offline, rateLimited, unavailable, or null.</param>
/// <param name="Stale">The shelves are an older copy (Offline mode, or Steam didn't answer this time).</param>
public sealed record DiscoverFeaturedDto(string State, string? Reason, string? Fetched, bool Stale, IReadOnlyList<DiscoverShelfDto> Shelves);

/// <summary>"Because you played …" shelves.</summary>
/// <param name="State">ready, off (searching online is off), offline, noSeeds (nothing played yet), noSource (no IGDB key and no Steam shelves), or failed.</param>
/// <param name="Source">igdb or steam: what the suggestions come from.</param>
public sealed record DiscoverSimilarDto(string State, string? Source, string? Reason, string? Fetched, bool Stale, IReadOnlyList<DiscoverShelfDto> Shelves);

/// <summary>One page of a genre or tag.</summary>
/// <param name="State">ready, offline, noSource, or failed.</param>
public sealed record DiscoverGenreDto(string Genre, string Label, string State, string? Source, string? Reason, int Page, bool HasMore,
    IReadOnlyList<DiscoverResultDto> Results);
