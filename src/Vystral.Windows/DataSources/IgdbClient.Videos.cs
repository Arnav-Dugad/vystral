using System.Globalization;

namespace Vystral.Windows.DataSources;

/// <summary>Track D4: a game's videos on IGDB (YouTube IDs only; IGDB hosts no video files).</summary>
public sealed partial class IgdbClient
{
    /// <summary>The game's videos as IGDB's raw answer (see <see cref="ExternalTrailers.ParseIgdbVideos"/>).</summary>
    public async Task<string> GetVideosJsonAsync(long gameId, CancellationToken ct)
    {
        if (gameId is not (> 0 and < 1_000_000_000_000)) return "[]";
        return await QueryAsync("game_videos", $"fields video_id,name; where game = {gameId.ToString(CultureInfo.InvariantCulture)}; limit 20;", ct);
    }
}
