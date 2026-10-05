using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Data;
using Vystral.Core.Matching;

namespace Vystral.Windows.Services;

/// <summary>
/// Optional enrichment from Steam's public store pages (no account, no key). Games without a
/// Steam appid are only matched when their normalized title is identical to a store result;
/// anything less certain is left alone rather than showing the wrong game's data.
/// </summary>
public sealed partial class MetadataService(LibraryRepository repo, ArtworkService artwork, HttpClient http)
{
    private static readonly TimeSpan RequestSpacing = TimeSpan.FromMilliseconds(1600);
    private DateTime _nextRequest = DateTime.MinValue;

    public sealed record SteamDetails(string Name, string? Description, IReadOnlyList<string> Developers,
        IReadOnlyList<string> Publishers, IReadOnlyList<string> Genres, string? ReleaseDate);

    /// <param name="shouldPause">Polled between requests; enrichment waits while it returns true (e.g. during gameplay).</param>
    public async Task<int> EnrichAsync(int maxGames, bool fetchArtwork, Func<bool> shouldPause, CancellationToken ct)
    {
        var done = 0;
        foreach (var (gameId, title, steamAppId) in repo.GamesNeedingMetadata(maxGames))
        {
            while (shouldPause()) await Task.Delay(5000, ct);
            ct.ThrowIfCancellationRequested();
            // Data saver: stop this run without marking anything, so artwork is fetched on a later run.
            if (fetchArtwork && artwork.SkipDownloads?.Invoke() == true) break;
            try
            {
                var appId = steamAppId ?? await FindExactSteamMatchAsync(title, ct);
                if (appId is null)
                {
                    repo.MarkMetadataAttempted(gameId);
                    continue;
                }
                var json = await GetDetailsJsonAsync(appId, ct);
                var details = ParseDetails(appId, json);
                // Trailers are recorded only for an exact Steam appid (never for a title match).
                if (details is not null && steamAppId is not null) CaptureTrailer(gameId, appId, json);
                if (details is null)
                {
                    repo.MarkMetadataAttempted(gameId);
                    continue;
                }
                var source = steamAppId is null ? $"Steam Store (exact title match, app {appId})" : $"Steam Store (app {appId})";
                repo.SetMetadata(gameId, source, details.Description, details.Developers.FirstOrDefault(),
                    details.Publishers.FirstOrDefault(), details.ReleaseDate, details.Genres);
                if (fetchArtwork) await artwork.FetchSteamArtworkAsync(gameId, appId, ct);
                done++;
            }
            catch (HttpRequestException ex) when (ex.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.Forbidden)
            {
                Log.Warn("metadata", "Steam store rate limit reached; pausing enrichment for this run.");
                break;
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                Log.Warn("metadata", "Metadata lookup failed", new { gameId }, ex);
                // Network trouble: stop this run quietly and retry next time (do not mark attempted).
                break;
            }
        }
        return done;
    }

    public async Task<SteamDetails?> GetDetailsAsync(string appId, CancellationToken ct) =>
        ParseDetails(appId, await GetDetailsJsonAsync(appId, ct));

    private async Task<string> GetDetailsJsonAsync(string appId, CancellationToken ct)
    {
        await ThrottleAsync(ct);
        return await http.GetStringAsync(
            $"https://store.steampowered.com/api/appdetails?appids={Uri.EscapeDataString(appId)}&l=english", ct);
    }

    private void CaptureTrailer(string gameId, string appId, string json)
    {
        try { repo.SetTrailer(gameId, appId, Vystral.Core.Media.SteamTrailers.Select(appId, json)); }
        catch (Exception ex) when (ex is JsonException or Microsoft.Data.Sqlite.SqliteException)
        {
            Log.Warn("metadata", "Trailer details couldn't be recorded", new { gameId }, ex);
        }
    }

    internal static SteamDetails? ParseDetails(string appId, string json)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty(appId, out var entry) ||
            !entry.TryGetProperty("success", out var ok) || ok.ValueKind != JsonValueKind.True ||
            !entry.TryGetProperty("data", out var data))
            return null;

        static IReadOnlyList<string> Strings(JsonElement e, string name) =>
            e.TryGetProperty(name, out var arr) && arr.ValueKind == JsonValueKind.Array
                ? arr.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => Clean(x.GetString()!, 120)).Where(s => s.Length > 0).Take(5).ToList()
                : [];

        var genres = data.TryGetProperty("genres", out var g) && g.ValueKind == JsonValueKind.Array
            ? g.EnumerateArray().Select(x => x.TryGetProperty("description", out var d) ? Clean(d.GetString() ?? "", 40) : "")
                .Where(s => s.Length > 0).Distinct().Take(8).ToList()
            : [];
        var description = data.TryGetProperty("short_description", out var sd) ? Clean(sd.GetString() ?? "", 1200) : null;
        var release = data.TryGetProperty("release_date", out var rd) && rd.TryGetProperty("date", out var date)
            ? Clean(date.GetString() ?? "", 40) : null;
        var name = data.TryGetProperty("name", out var n) ? Clean(n.GetString() ?? "", 200) : "";

        return new SteamDetails(name, string.IsNullOrEmpty(description) ? null : description,
            Strings(data, "developers"), Strings(data, "publishers"), genres, string.IsNullOrEmpty(release) ? null : release);
    }

    private async Task<string?> FindExactSteamMatchAsync(string title, CancellationToken ct)
    {
        await ThrottleAsync(ct);
        var json = await http.GetStringAsync(
            $"https://store.steampowered.com/api/storesearch/?term={Uri.EscapeDataString(title)}&l=english&cc=US", ct);
        return PickExactMatch(title, json);
    }

    internal static string? PickExactMatch(string title, string searchJson)
    {
        using var doc = JsonDocument.Parse(searchJson);
        if (!doc.RootElement.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) return null;
        var target = TitleNormalizer.Normalize(title).Full;
        var matches = items.EnumerateArray()
            .Where(i => i.TryGetProperty("type", out var t) && t.GetString() == "app")
            .Where(i => i.TryGetProperty("name", out var n) && TitleNormalizer.Normalize(n.GetString() ?? "").Full == target)
            .Select(i => i.GetProperty("id").ToString())
            .Distinct()
            .ToList();
        // Ambiguity (two different apps with the same normalized title) means we can't be sure.
        return matches.Count == 1 ? matches[0] : null;
    }

    private async Task ThrottleAsync(CancellationToken ct)
    {
        var wait = _nextRequest - DateTime.UtcNow;
        if (wait > TimeSpan.Zero) await Task.Delay(wait, ct);
        _nextRequest = DateTime.UtcNow + RequestSpacing;
    }

    /// <summary>Strips markup and decodes entities; the UI additionally renders these as plain text.</summary>
    internal static string Clean(string s, int max)
    {
        var text = WebUtility.HtmlDecode(Tags().Replace(s, " "));
        text = Spaces().Replace(text, " ").Trim();
        return text.Length > max ? text[..max].TrimEnd() + "…" : text;
    }

    [GeneratedRegex("<[^>]*>")]
    private static partial Regex Tags();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();
}
