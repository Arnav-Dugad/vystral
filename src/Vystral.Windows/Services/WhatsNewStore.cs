using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Windows.Services.Rollback;

namespace Vystral.Windows.Services;

/// <summary>Per-user "what's new" memory: the last version whose tour was seen, and seen "New" badges.</summary>
public sealed record WhatsNewState
{
    /// <summary>The version whose "What's new" was last shown (or skipped). Null: not known (upgraded from an older VYSTRAL).</summary>
    public string? LastSeenVersion { get; init; }
    /// <summary>The version this PC started with. Null: installed before this was tracked.</summary>
    public string? FirstVersion { get; init; }
    /// <summary>Feature keys whose "New" badge was seen, with when.</summary>
    public Dictionary<string, string> SeenBadges { get; init; } = [];
}

/// <summary>
/// Stored as ui-state/whatsnew.json in the data folder (not the database or settings, so it never
/// needs a migration and survives a settings reset). Small, validated, and capped.
/// </summary>
public sealed partial class WhatsNewStore(string dataRoot)
{
    public const int MaxBadges = 400;
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private readonly Lock _lock = new();
    private string FilePath => Path.Combine(dataRoot, "ui-state", "whatsnew.json");

    [GeneratedRegex(@"^[a-z0-9][a-z0-9.\-]{0,63}\z")]
    public static partial Regex BadgeKeyPattern();

    /// <summary>
    /// The state, created on first use: a brand-new install (onboarding not done) has seen the
    /// current version already, so neither the tour nor badges appear; an existing install that
    /// predates this file gets the current version's tour once.
    /// </summary>
    public WhatsNewState Get(string currentVersion, bool onboardingCompleted)
    {
        lock (_lock)
        {
            var state = Read();
            if (state is not null) return state;
            state = onboardingCompleted
                ? new WhatsNewState()
                : new WhatsNewState { LastSeenVersion = currentVersion, FirstVersion = currentVersion };
            Write(state);
            return state;
        }
    }

    public WhatsNewState MarkVersionSeen(string version)
    {
        if (!AppVersion.IsValid(version)) throw new ArgumentException("Invalid version.");
        return Change(s => s with
        {
            LastSeenVersion = s.LastSeenVersion is { } last && AppVersion.IsValid(last) && AppVersion.Compare(last, version) > 0 ? last : version,
        });
    }

    public WhatsNewState MarkBadgesSeen(IEnumerable<string> keys, DateTimeOffset now)
    {
        var list = keys.ToList();
        if (list.Count > 50 || list.Any(k => !BadgeKeyPattern().IsMatch(k))) throw new ArgumentException("Invalid badge keys.");
        return Change(s =>
        {
            var seen = new Dictionary<string, string>(s.SeenBadges);
            foreach (var k in list) seen.TryAdd(k, now.ToString("O"));
            // Oldest first out when the cap is reached; expired keys never show anyway.
            foreach (var old in seen.OrderBy(p => p.Value, StringComparer.Ordinal).Take(Math.Max(0, seen.Count - MaxBadges)).Select(p => p.Key).ToList())
                seen.Remove(old);
            return s with { SeenBadges = seen };
        });
    }

    private WhatsNewState Change(Func<WhatsNewState, WhatsNewState> change)
    {
        lock (_lock)
        {
            var next = change(Read() ?? new WhatsNewState());
            Write(next);
            return next;
        }
    }

    private WhatsNewState? Read()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            var s = JsonSerializer.Deserialize<WhatsNewState>(File.ReadAllText(FilePath));
            if (s is null) return null;
            return s with
            {
                LastSeenVersion = AppVersion.IsValid(s.LastSeenVersion) ? s.LastSeenVersion : null,
                FirstVersion = AppVersion.IsValid(s.FirstVersion) ? s.FirstVersion : null,
                SeenBadges = s.SeenBadges?.Where(p => BadgeKeyPattern().IsMatch(p.Key)).ToDictionary() ?? [],
            };
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            Log.Warn("whatsnew", "What's-new state unreadable; starting fresh", ex: ex);
            return null;
        }
    }

    private void Write(WhatsNewState state)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(state, Json));
            File.Move(tmp, FilePath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn("whatsnew", "Couldn't save what's-new state", ex: ex);
        }
    }
}
