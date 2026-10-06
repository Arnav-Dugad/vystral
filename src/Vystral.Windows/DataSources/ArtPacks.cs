using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Matching;

namespace Vystral.Windows.DataSources;

/// <summary>
/// Track N: an art pack is one SteamGridDB style applied across many games. Each preset says which
/// styles to ask for per slot; an empty list means "any style, best rated first"; a missing slot means
/// the preset has nothing for it (e.g. a blurred logo makes no sense).
/// </summary>
public sealed record ArtPackPreset(string Id, string Label, string Description, IReadOnlyDictionary<ArtworkKind, string[]> Styles)
{
    public bool Supports(ArtworkKind kind) => Styles.ContainsKey(kind);
}

public static class ArtPackPresets
{
    /// <summary>Slots an art pack can fill, in the order they are applied.</summary>
    public static readonly IReadOnlyList<ArtworkKind> Slots = [ArtworkKind.Cover, ArtworkKind.Hero, ArtworkKind.Logo];

    public static readonly IReadOnlyList<ArtPackPreset> All =
    [
        new("official", "Official", "The community’s best-rated art for each game, with official logos.", new Dictionary<ArtworkKind, string[]>
        {
            [ArtworkKind.Cover] = [], [ArtworkKind.Hero] = [], [ArtworkKind.Logo] = ["official"],
        }),
        new("alternate", "Alternate", "Fresh takes on each game’s key art, with custom logos.", new Dictionary<ArtworkKind, string[]>
        {
            [ArtworkKind.Cover] = ["alternate"], [ArtworkKind.Hero] = ["alternate"], [ArtworkKind.Logo] = ["custom"],
        }),
        new("minimal", "Minimal", "Covers without logos and quiet backgrounds: the artwork on its own.", new Dictionary<ArtworkKind, string[]>
        {
            [ArtworkKind.Cover] = ["no_logo"], [ArtworkKind.Hero] = ["alternate"],
        }),
        new("blurred", "Blurred", "Soft, blurred art that lets titles and logos stand out.", new Dictionary<ArtworkKind, string[]>
        {
            [ArtworkKind.Cover] = ["blurred"], [ArtworkKind.Hero] = ["blurred"],
        }),
        new("material", "Material", "Flat, graphic, colour-blocked art in the Material style.", new Dictionary<ArtworkKind, string[]>
        {
            [ArtworkKind.Cover] = ["material"], [ArtworkKind.Hero] = ["material"],
        }),
        new("white", "White logo", "Covers with clean white logos, and white logos everywhere.", new Dictionary<ArtworkKind, string[]>
        {
            [ArtworkKind.Cover] = ["white_logo"], [ArtworkKind.Logo] = ["white"],
        }),
    ];

    public static ArtPackPreset? Find(string? id) => All.FirstOrDefault(p => p.Id == id);
}

/// <summary>Which games a pack applies to: "all", "installed", "collection:{id}" or "platform:{key}".</summary>
public sealed record ArtPackScope(string Kind, string? Value)
{
    public static readonly ArtPackScope AllGames = new("all", null);

    public static ArtPackScope? Parse(string? s)
    {
        if (s is "all") return AllGames;
        if (s is "installed") return new("installed", null);
        if (s is null || s.Length > 80) return null;
        var i = s.IndexOf(':');
        if (i <= 0) return null;
        var (kind, value) = (s[..i], s[(i + 1)..]);
        return kind switch
        {
            "collection" when value.Length is > 0 and <= 64 && value.All(char.IsAsciiLetterOrDigit) => new(kind, value),
            "platform" when Enum.TryParse<PlatformId>(value, true, out var p) && Enum.IsDefined(p) && value.All(char.IsAsciiLetterLower) => new(kind, value),
            _ => null,
        };
    }

    public override string ToString() => Value is null ? Kind : $"{Kind}:{Value}";
}

public sealed record ArtPackRequest(ArtPackPreset Preset, IReadOnlyList<ArtworkKind> Kinds, ArtPackScope Scope, bool ReplaceHandPicked);

/// <summary>What the planner needs to know about a game.</summary>
public sealed record ArtPackGame(string GameId, string Title, bool Hidden, bool Installed, bool Favorite, string? LastPlayed,
    IReadOnlyList<string> Platforms, IReadOnlyList<string> Collections);

public sealed record ArtPackSlot(string GameId, ArtworkKind Kind);

/// <param name="Games">Games with at least one slot to fill.</param>
/// <param name="KeptHandPicked">Slots skipped because they hold art the user chose by hand.</param>
/// <param name="Sample">Up to eight games to preview, in the order the job will visit them.</param>
public sealed record ArtPackPlan(IReadOnlyList<ArtPackSlot> Slots, int Games, int InScope, int KeptHandPicked, IReadOnlyList<string> Sample);

/// <summary>Pure planning: which slots of which games a pack will touch, in the order it touches them.</summary>
public static class ArtPackPlanner
{
    public const int SampleSize = 8;

    public static bool InScope(ArtPackGame g, ArtPackScope scope) => !g.Hidden && scope.Kind switch
    {
        "all" => true,
        "installed" => g.Installed,
        "collection" => g.Collections.Contains(scope.Value!),
        "platform" => g.Platforms.Contains(scope.Value!),
        _ => false,
    };

    /// <summary>
    /// Favourites first, then the most recently played, then by title — so the part of the library people
    /// look at changes first. Slots whose current art the user chose by hand are skipped unless the request
    /// says to replace them; slots the preset has no style for are never planned.
    /// </summary>
    public static ArtPackPlan Plan(IReadOnlyList<ArtPackGame> games, IReadOnlyList<ArtworkRow> art, ArtPackRequest request)
    {
        var rows = art.GroupBy(a => a.GameId).ToDictionary(g => g.Key, g => g.ToDictionary(a => a.Kind, StringComparer.Ordinal));
        var kinds = ArtPackPresets.Slots.Where(k => request.Kinds.Contains(k) && request.Preset.Supports(k)).ToList();
        var ordered = games.Where(g => InScope(g, request.Scope))
            .OrderByDescending(g => g.Favorite)
            .ThenByDescending(g => g.LastPlayed ?? "", StringComparer.Ordinal)
            .ThenBy(g => g.Title, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var slots = new List<ArtPackSlot>();
        var sample = new List<string>();
        var kept = 0;
        var gamesTouched = 0;
        foreach (var g in ordered)
        {
            var mine = rows.GetValueOrDefault(g.GameId);
            var any = false;
            foreach (var kind in kinds)
            {
                var current = mine?.GetValueOrDefault(kind.ToString().ToLowerInvariant());
                if (LibraryRepository.IsHandPicked(current) && !request.ReplaceHandPicked)
                {
                    kept++;
                    continue;
                }
                slots.Add(new ArtPackSlot(g.GameId, kind));
                any = true;
            }
            if (!any) continue;
            gamesTouched++;
            if (sample.Count < SampleSize) sample.Add(g.GameId);
        }
        return new ArtPackPlan(slots, gamesTouched, ordered.Count, kept, sample);
    }

    /// <summary>
    /// The image a pack uses for a slot: static only, best score first (ties: lowest ID, i.e. oldest), covers
    /// must be portrait. Null when SteamGridDB has nothing in this style — the slot is then left as it is
    /// rather than mixing in another style.
    /// </summary>
    public static SgdbImage? PickImage(IReadOnlyList<SgdbImage> images, ArtworkKind kind) =>
        images
            .Where(i => i.Mime is not "image/gif" && !i.Url.Contains("/animated", StringComparison.OrdinalIgnoreCase))
            .Where(i => kind != ArtworkKind.Cover || i.Width == 0 || i.Height == 0 || i.Height > i.Width)
            .OrderByDescending(i => i.Score)
            .ThenBy(i => i.Id)
            .FirstOrDefault();

    /// <summary>
    /// Matching with confidence only: a Steam app ID match first; otherwise a title search whose single
    /// result with exactly the same normalized title is used. Anything less certain is not matched.
    /// </summary>
    public static (SgdbGame? Game, string? By) Match(SgdbGame? bySteamAppId, string title, IReadOnlyList<SgdbGame>? searchResults)
    {
        if (bySteamAppId is not null) return (bySteamAppId, "steam");
        if (searchResults is null) return (null, null);
        var exact = SteamGridDbClient.PickExact(title, searchResults);
        return exact is null ? (null, null) : (exact, "title");
    }

    /// <summary>A rough duration: one match lookup per game, then an image list and a download per slot, at the job's pace.</summary>
    public static int EstimateSeconds(int games, int slots, TimeSpan apiSpacing, TimeSpan downloadSpacing) =>
        (int)Math.Ceiling(games * apiSpacing.TotalSeconds + slots * (apiSpacing.TotalSeconds + downloadSpacing.TotalSeconds));

    /// <summary>A normalized title key used to cache title matches (so renamed games are looked up again).</summary>
    public static string TitleKey(string title) => TitleNormalizer.Normalize(title).Full;
}

/// <summary>
/// Spaces operations at least <see cref="Spacing"/> apart and honours a pause asked for by the provider.
/// SteamGridDB asks API users to be gentle; the transport already serializes API calls (400 ms apart),
/// and an art pack additionally paces its image downloads with one of these.
/// </summary>
public sealed class ArtPackPacer(TimeSpan spacing, Func<DateTime>? clock = null, Func<TimeSpan, CancellationToken, Task>? delay = null)
{
    private readonly Func<DateTime> _clock = clock ?? (() => DateTime.UtcNow);
    private readonly Func<TimeSpan, CancellationToken, Task> _delay = delay ?? Task.Delay;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private DateTime _next = DateTime.MinValue;

    public TimeSpan Spacing { get; } = spacing;

    /// <summary>Waits until the next operation may start, then reserves the following slot.</summary>
    public async Task WaitAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var now = _clock();
            if (_next > now) await _delay(_next - now, ct);
            var after = _clock();
            _next = (after > _next ? after : _next) + Spacing;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Pushes the next slot out (e.g. after a 429 with Retry-After).</summary>
    public void Defer(TimeSpan wait)
    {
        var until = _clock() + wait;
        if (until > _next) _next = until;
    }
}
