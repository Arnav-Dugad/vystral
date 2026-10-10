using Vystral.Core.Contracts;

namespace Vystral.Tests.Ai;

/// <summary>Small, fictional library and session builders for the Track C5 tests.</summary>
internal static class AiTestData
{
    private static int _n;

    public static string Id(int n) => n.ToString("x32");

    public static GameDto Game(string title, string[]? genres = null, string platform = "steam", bool installed = true, long trackedSeconds = 0,
        int sessions = 0, string? status = null, string? release = null, string? developer = null, string? lastPlayed = null, bool hidden = false,
        string? id = null, string? platformGameId = null)
    {
        var gid = id ?? Id(Interlocked.Increment(ref _n) + 1000);
        var inst = new InstallationDto("e" + gid[1..], platform, platformGameId ?? gid[..8], title, installed ? "installed" : "notInstalled",
            null, null, null, false, "uri", null, null, null, false, "2026-01-01T00:00:00Z");
        return new GameDto(gid, title, title.ToLowerInvariant(), null, developer, null, release, genres ?? [], false, hidden, null, null, null, null, null,
            new ArtworkDto(null, null, null, null, null), [inst], [], trackedSeconds, sessions, lastPlayed, "2025-01-01T00:00:00Z", status);
    }

    public static SessionDto Session(GameDto g, string startIso, int seconds) =>
        new(Id(Interlocked.Increment(ref _n) + 5000), g.Id, g.Installations[0].Id, startIso, DateTimeOffset.Parse(startIso).AddSeconds(seconds).ToString("O"),
            seconds, "launched", null);
}
