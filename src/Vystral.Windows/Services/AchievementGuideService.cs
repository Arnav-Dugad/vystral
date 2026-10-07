using System.Text.RegularExpressions;
using Vystral.Core.Data;

namespace Vystral.Windows.Services;

/// <summary>One achievement to aim for. <c>Description</c> is null for hidden achievements until the user reveals it.</summary>
public sealed record GuideAchievementDto(string ApiName, string Name, string? Description, bool Hidden, double? GlobalPercent, string? Icon, bool Achieved, string? UnlockedAt);

/// <summary>Status mirrors <see cref="AchievementsDto"/> (ok | none | private | error | notSteam | notConnected | noAccount | localOnly).</summary>
public sealed record AchievementGuideDto(
    string Status,
    string? Message,
    int Total,
    int Unlocked,
    int HiddenLocked,
    IReadOnlyList<GuideAchievementDto> Next,
    GuideAchievementDto? Goal,
    string? FetchedAt);

public sealed class AchievementGoalEntry
{
    public string ApiName { get; set; } = "";
    public DateTimeOffset At { get; set; }
}

public sealed class AchievementGoalFile
{
    public int Version { get; set; } = 1;
    public Dictionary<string, AchievementGoalEntry> Goals { get; set; } = [];
}

/// <summary>
/// Track W: the achievement guide on game pages: locked achievements, easiest first (highest share of
/// players), hidden ones marked and revealed only on request, and one pinned "Current goal" per game.
/// Uses only the achievement data VYSTRAL already caches (and the same Steam calls as the Achievements tab).
/// Goals live in ui-state/achievement-goals.json in the data folder.
/// </summary>
public sealed partial class AchievementGuideService(LibraryRepository repo, ArtworkService artwork, string goalFile)
{
    public const int MaxGoals = 2000;
    public const int MaxNext = 12;
    private readonly Lock _lock = new();

    [GeneratedRegex(@"\A[^\x00-\x20\x7F]{1,200}\z")]
    public static partial Regex ApiNamePattern();

    /// <summary>Locked achievements, easiest first: highest global percentage, unknown rarity last, then schema order.</summary>
    internal static IReadOnlyList<AchievementDto> NextUp(IReadOnlyList<AchievementDto> all, int take = MaxNext) =>
        all.Select((a, i) => (a, i)).Where(x => !x.a.Achieved)
            .OrderBy(x => x.a.GlobalPercent is null)
            .ThenByDescending(x => x.a.GlobalPercent ?? 0)
            .ThenBy(x => x.i)
            .Take(take).Select(x => x.a).ToList();

    public AchievementGuideDto Build(string gameId, AchievementsDto data)
    {
        var next = NextUp(data.Achievements).Select(ToGuide).ToList();
        var goalName = GoalFor(gameId);
        GuideAchievementDto? goal = null;
        if (goalName is not null && data.Achievements.FirstOrDefault(a => a.ApiName == goalName) is { } g) goal = ToGuide(g);
        return new AchievementGuideDto(data.Status, data.Message, data.Total, data.Unlocked,
            data.Achievements.Count(a => a.Hidden && !a.Achieved), next, goal, data.FetchedAt);
    }

    private static GuideAchievementDto ToGuide(AchievementDto a) =>
        new(a.ApiName, a.Name, a.Hidden && !a.Achieved ? null : a.Description, a.Hidden, a.GlobalPercent, a.Icon, a.Achieved, a.UnlockedAt);

    /// <summary>The cached description of one achievement (hidden ones included: the user asked to see it).</summary>
    public string? Reveal(string gameId, string apiName)
    {
        if (repo.GetSteamInstallation(gameId) is not { } inst) return null;
        return repo.GetAchievements(inst.AppId).FirstOrDefault(r => r.ApiName == apiName)?.Description;
    }

    /// <summary>The pinned goal from the cache only (never contacts Steam): for the Play button area.</summary>
    public GuideAchievementDto? Goal(string gameId)
    {
        if (GoalFor(gameId) is not { } apiName || repo.GetSteamInstallation(gameId) is not { } inst) return null;
        var row = repo.GetAchievements(inst.AppId).FirstOrDefault(r => r.ApiName == apiName);
        if (row is null) return null;
        var file = row.Achieved ? row.IconFile ?? row.IconGrayFile : row.IconGrayFile ?? row.IconFile;
        return new GuideAchievementDto(row.ApiName, row.DisplayName, row.Hidden && !row.Achieved ? null : row.Description, row.Hidden, row.GlobalPercent,
            artwork.CachedFileExists(file) ? ArtworkService.Url(gameId, file!) : null, row.Achieved, row.UnlockTime?.ToString("O"));
    }

    /// <summary>Pins (or, with null, clears) the goal. The achievement must exist in this game's cached list.</summary>
    public bool SetGoal(string gameId, string? apiName, DateTimeOffset now)
    {
        if (apiName is not null)
        {
            if (repo.GetSteamInstallation(gameId) is not { } inst || repo.GetAchievements(inst.AppId).All(r => r.ApiName != apiName)) return false;
        }
        lock (_lock)
        {
            var file = Read();
            if (apiName is null) file.Goals.Remove(gameId);
            else file.Goals[gameId] = new AchievementGoalEntry { ApiName = apiName, At = now };
            // Oldest out when the cap is reached.
            foreach (var old in file.Goals.OrderBy(g => g.Value.At).Take(Math.Max(0, file.Goals.Count - MaxGoals)).Select(g => g.Key).ToList())
                file.Goals.Remove(old);
            return JsonFileCache.Write(goalFile, file);
        }
    }

    public string? GoalFor(string gameId)
    {
        lock (_lock) return Read().Goals.TryGetValue(gameId, out var g) ? g.ApiName : null;
    }

    private AchievementGoalFile Read()
    {
        var f = JsonFileCache.Read<AchievementGoalFile>(goalFile, 1024 * 1024);
        if (f is null || f.Version != 1 || f.Goals is null) return new AchievementGoalFile();
        f.Goals = f.Goals.Where(g => g.Key is { Length: 32 } && g.Key.All(char.IsAsciiHexDigitLower) && g.Value is not null &&
                                     g.Value.ApiName is not null && ApiNamePattern().IsMatch(g.Value.ApiName))
            .Take(MaxGoals).ToDictionary(g => g.Key, g => g.Value, StringComparer.Ordinal);
        return f;
    }
}
