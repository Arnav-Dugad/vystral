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
            catch (Exception ex) when (ex is (InvalidOperationException and not ObjectDisposedException) or KeyNotFoundException or FormatException)
            {
                // An answer of an unexpected shape: skip this game for good instead of stopping every later run on it.
                Log.Warn("metadata", "Steam's answer for this game couldn't be read", new { gameId }, ex);
                try { repo.MarkMetadataAttempted(gameId); }
                catch (Microsoft.Data.Sqlite.SqliteException e) { Log.Warn("metadata", "Couldn't mark the game as looked up", new { gameId }, e); }
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
        return await Reported(() => http.GetStringAsync(
            $"https://store.steampowered.com/api/appdetails?appids={Uri.EscapeDataString(appId)}&l=english", ct), ct);
    }

    /// <summary>Track D6: these direct store requests report to the Steam store health row like the shared lane does.</summary>
    private static async Task<string> Reported(Func<Task<string>> get, CancellationToken ct)
    {
        const string id = "steam.store";
        ProviderHealthHub.Sent(id);
        try
        {
            var body = await get();
            ProviderHealthHub.Answered(id);
            return body;
        }
        catch (HttpRequestException ex) when (ex.StatusCode is { } status)
        {
            if (status == HttpStatusCode.TooManyRequests || status == HttpStatusCode.Forbidden)
                ProviderHealthHub.Failed(id, "Steam asked VYSTRAL to slow down; details are paused until the next run");
            else ProviderHealthHub.Status(id, status, "Steam");
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            ProviderHealthHub.Failed(id, ex);
            throw;
        }
    }

    private void CaptureTrailer(string gameId, string appId, string json)
    {
        try { repo.SetTrailer(gameId, appId, Vystral.Core.Media.SteamTrailers.Select(appId, json)); }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            Log.Warn("metadata", "Trailer details couldn't be recorded", new { gameId }, ex);
        }
    }

    /// <summary>
    /// Reads appdetails. Steam's answer is untrusted: any shape other than the expected one (null, arrays,
    /// wrongly-typed fields) yields null or skips the field, never an exception. Invalid JSON still throws
    /// <see cref="JsonException"/> (usually an error page: network trouble, retried on a later run).
    /// </summary>
    internal static SteamDetails? ParseDetails(string appId, string json)
    {
        using var doc = JsonDocument.Parse(json);
        if (DataSources.JsonRead.Obj(doc.RootElement, appId) is not { } entry ||
            !entry.TryGetProperty("success", out var ok) || ok.ValueKind != JsonValueKind.True ||
            DataSources.JsonRead.Obj(entry, "data") is not { } data)
            return null;

        static IReadOnlyList<string> Strings(JsonElement e, string name) =>
            DataSources.JsonRead.Arr(e, name).Where(x => x.ValueKind == JsonValueKind.String)
                .Select(x => Clean(x.GetString()!, 120)).Where(s => s.Length > 0).Take(5).ToList();

        var genres = DataSources.JsonRead.Arr(data, "genres")
            .Select(x => DataSources.JsonRead.Str(x, "description", 40) ?? "")
            .Where(s => s.Length > 0).Distinct().Take(8).ToList();
        var description = DataSources.JsonRead.Str(data, "short_description", 1200);
        var release = DataSources.JsonRead.Obj(data, "release_date") is { } rd ? DataSources.JsonRead.Str(rd, "date", 40) : null;
        var name = DataSources.JsonRead.Str(data, "name", 200) ?? "";

        return new SteamDetails(name, description, Strings(data, "developers"), Strings(data, "publishers"), genres, release);
    }

    private async Task<string?> FindExactSteamMatchAsync(string title, CancellationToken ct)
    {
        await ThrottleAsync(ct);
        var json = await Reported(() => http.GetStringAsync(
            $"https://store.steampowered.com/api/storesearch/?term={Uri.EscapeDataString(title)}&l=english&cc=US", ct), ct);
        return PickExactMatch(title, json);
    }

    internal static string? PickExactMatch(string title, string searchJson)
    {
        using var doc = JsonDocument.Parse(searchJson);
        var target = TitleNormalizer.Normalize(title).Full;
        // Untrusted answer: items that aren't objects, or lack a string type/name or a numeric id, are skipped.
        var matches = DataSources.JsonRead.Arr(doc.RootElement, "items")
            .Where(i => i.ValueKind == JsonValueKind.Object)
            .Where(i => i.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String && t.GetString() == "app")
            .Where(i => i.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String && TitleNormalizer.Normalize(n.GetString()!).Full == target)
            .Select(i => i.TryGetProperty("id", out var id) ? id.ValueKind switch
            {
                JsonValueKind.Number => id.GetRawText(),
                JsonValueKind.String => id.GetString(),
                _ => null,
            } : null)
            .Where(id => id is { Length: > 0 and <= 10 } && id.All(char.IsAsciiDigit))
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
