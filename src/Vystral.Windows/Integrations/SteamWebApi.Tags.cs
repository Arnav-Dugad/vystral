using System.Globalization;
using System.Text.Json;

namespace Vystral.Windows.Integrations;

/// <summary>One community tag on an app: Steam's tag id and its relative weight (how strongly players applied it; not a vote count).</summary>
public sealed record SteamAppTag(int Id, int Weight);

/// <summary>An app's community tags, strongest first.</summary>
public sealed record SteamAppTags(string AppId, IReadOnlyList<SteamAppTag> Tags);

/// <summary>Steam's tag vocabulary (id → English name) and the version Steam reports for it.</summary>
public sealed record SteamTagList(string? Version, IReadOnlyDictionary<int, string> Names);

/// <summary>
/// Track C4: Steam's community (user) tags. IStoreBrowseService/GetItems with <c>include_tag_count</c> gives each
/// app's tag ids and weights; IStoreService/GetTagList gives the names. Both are public Web API services (no key)
/// and go through this client's shared, spaced lane.
/// </summary>
public sealed partial class SteamWebApiClient
{
    /// <summary>Tags kept per app (Steam's store page shows about this many).</summary>
    public const int MaxTagsPerApp = 20;
    /// <summary>Steam's vocabulary is about 450 tags; anything far larger is clipped.</summary>
    public const int MaxTagNames = 2000;

    /// <summary>Community tags for up to <see cref="StoreItemsBatch"/> apps per request.</summary>
    public async Task<IReadOnlyList<SteamAppTags>> GetStoreTagsAsync(IReadOnlyList<string> appIds, CancellationToken ct)
    {
        var result = new List<SteamAppTags>();
        foreach (var batch in appIds.Where(IsAppId).Distinct(StringComparer.Ordinal).Chunk(StoreItemsBatch))
        {
            var input = JsonSerializer.Serialize(new
            {
                ids = batch.Select(a => new { appid = uint.Parse(a, CultureInfo.InvariantCulture) }),
                context = new { language = "english", country_code = "US" },
                data_request = new { include_tag_count = MaxTagsPerApp },
            });
            var (status, body) = await GetAsync($"IStoreBrowseService/GetItems/v1/?input_json={Uri.EscapeDataString(input)}", ct);
            EnsureOk(status);
            result.AddRange(ParseStoreTags(body, batch));
        }
        return result;
    }

    /// <summary>The names of every Steam tag, in English.</summary>
    public async Task<SteamTagList> GetTagListAsync(CancellationToken ct)
    {
        var (status, body) = await GetAsync("IStoreService/GetTagList/v1/?language=english", ct);
        EnsureOk(status);
        return ParseTagList(body);
    }

    // ---------- Parsing (pure, unit-tested) ----------

    /// <summary>
    /// <c>{"response":{"store_items":[{"appid":620,"tags":[{"tagid":4182,"weight":604},…]}]}}</c>. Only requested apps,
    /// each once; tags with a positive id and a non-negative weight, de-duplicated, strongest first, capped.
    /// </summary>
    internal static IReadOnlyList<SteamAppTags> ParseStoreTags(string json, IReadOnlyCollection<string> requested)
    {
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 32 });
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("response", out var response) ||
                response.ValueKind != JsonValueKind.Object)
                throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s tag answer couldn’t be read.");
            var result = new List<SteamAppTags>();
            if (!response.TryGetProperty("store_items", out var items) || items.ValueKind != JsonValueKind.Array) return result;
            var wanted = requested.ToHashSet(StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var i in items.EnumerateArray())
            {
                if (i.ValueKind != JsonValueKind.Object) continue;
                var appId = AppIdOf(i, "appid") ?? AppIdOf(i, "id");
                if (appId is null || !wanted.Contains(appId) || !seen.Add(appId)) continue;
                if (Long(i, "success") is { } ok && ok != 1) continue;
                var tags = new List<SteamAppTag>();
                var ids = new HashSet<int>();
                if (i.TryGetProperty("tags", out var arr) && arr.ValueKind == JsonValueKind.Array)
                    foreach (var t in arr.EnumerateArray())
                    {
                        if (Long(t, "tagid") is not ({ } id and > 0 and <= 100_000_000)) continue;
                        var weight = Long(t, "weight") is { } w and >= 0 ? (int)Math.Min(w, 1_000_000) : 0;
                        if (ids.Add((int)id)) tags.Add(new SteamAppTag((int)id, weight));
                    }
                result.Add(new SteamAppTags(appId, tags.OrderByDescending(t => t.Weight).Take(MaxTagsPerApp).ToList()));
            }
            return result;
        }
        catch (JsonException)
        {
            throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s tag answer couldn’t be read.");
        }
    }

    /// <summary><c>{"response":{"version_hash":"…","tags":[{"tagid":19,"name":"Action"},…]}}</c>. Names are cleaned and clipped.</summary>
    internal static SteamTagList ParseTagList(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("response", out var response) ||
                response.ValueKind != JsonValueKind.Object || !response.TryGetProperty("tags", out var tags) || tags.ValueKind != JsonValueKind.Array)
                throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s tag list couldn’t be read.");
            var names = new Dictionary<int, string>();
            foreach (var t in tags.EnumerateArray())
            {
                if (names.Count >= MaxTagNames) break;
                if (Long(t, "tagid") is not ({ } id and > 0 and <= 100_000_000)) continue;
                if (CleanText(Str(t, "name"), 40) is not { } name) continue;
                names.TryAdd((int)id, name);
            }
            var version = Str(response, "version_hash") is { Length: > 0 and <= 24 } v && v.All(char.IsAsciiLetterOrDigit) ? v : null;
            return new SteamTagList(version, names);
        }
        catch (JsonException)
        {
            throw new SteamApiException(SteamApiOutcome.Malformed, "Steam’s tag list couldn’t be read.");
        }
    }
}
