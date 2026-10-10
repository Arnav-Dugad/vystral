using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Core.Data;
using Vystral.Windows.Services;

namespace Vystral.Windows.DataSources;

// ---------- Bridge DTOs (camelCase; mirrored in ui/src/bridge/types.identity.ts) ----------

/// <param name="Image">An art-host URL once the image is cached (ask <c>freebies.image</c> for it), else null.</param>
public sealed record FreebieDto(string Id, string Source, string Title, string Store, IReadOnlyList<string> Platforms, string Kind, string Status,
    string? Worth, string? StartsAt, string? EndsAt, string? Description, string? Image, bool HasImage);

/// <param name="Error">The last refresh failed: a plain sentence (cached items, if any, are still listed and marked stale).</param>
public sealed record FreebieSourceDto(string Id, string Name, bool Enabled, string? FetchedAt, bool Stale, string? Error, string Attribution);

/// <param name="Reason">off (both sources off) | offline | null.</param>
public sealed record FreebiesDto(IReadOnlyList<FreebieDto> Items, IReadOnlyList<FreebieSourceDto> Sources, string? Reason);

/// <summary>
/// Track D4: free games to claim, from GamerPower (all stores) and Epic's own free-games feed, merged and cached
/// (3 hours) in provider_cache. Each source has its own switch; Offline mode and a running game never fetch; a failed
/// refresh keeps showing what was saved, marked stale. Track D5's "Free this week" shelf consumes this through
/// <c>freebies.get</c>, <c>freebies.image</c> and <c>freebies.open</c> (the page never sends a URL).
/// </summary>
public sealed partial class FreebiesService(LibraryRepository repo, SettingsService settings, DataSourcesService sources, ArtworkService artwork)
{
    public static readonly TimeSpan Ttl = TimeSpan.FromHours(3);
    internal const int MaxItems = 80;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public Func<bool> IsGameActive { get; set; } = () => false;

    private bool LocalOnly => settings.GetBool("privacy.localOnly");

    public async Task<FreebiesDto> GetAsync(bool refresh, CancellationToken ct)
    {
        var gp = settings.GetBool("dataSources.gamerpower");
        var epic = settings.GetBool("dataSources.epicFreeGames");
        if (!gp && !epic) return new FreebiesDto([], [Source("gamerpower", false, null, null), Source("epicfree", false, null, null)], "off");
        var all = new List<Freebie>();
        var states = new List<FreebieSourceDto>();
        await _gate.WaitAsync(ct);
        try
        {
            var (gpItems, gpState) = gp ? await LoadAsync("gamerpower", "pc", refresh, () => sources.GamerPower.GetPcGiveawaysAsync(ct)) : ([], Source("gamerpower", false, null, null));
            var country = sources.Country;
            var (epicItems, epicState) = epic ? await LoadAsync("epicfree", country, refresh, () => sources.EpicFreeGames.GetAsync(country, ct)) : ([], Source("epicfree", false, null, null));
            all.AddRange(epicItems);
            all.AddRange(gpItems);
            states.Add(gpState);
            states.Add(epicState);
        }
        finally
        {
            _gate.Release();
        }
        var items = Dedupe(all).Take(MaxItems).Select(f => new FreebieDto(f.Id, f.Source, f.Title, f.Store, f.Platforms, f.Kind, f.Status, f.Worth, f.StartsAt, f.EndsAt,
            f.Description, CachedImage(f), f.ImageUrl is not null)).ToList();
        return new FreebiesDto(items, states, LocalOnly && states.All(s => s.FetchedAt is null) ? "offline" : null);
    }

    /// <summary>Epic's own entry wins over GamerPower's for the same Epic game (it has exact dates); "now" before "upcoming", soonest end first.</summary>
    internal static IReadOnlyList<Freebie> Dedupe(IEnumerable<Freebie> items)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var list = new List<Freebie>();
        foreach (var f in items)
        {
            var key = $"{f.Store}|{Vystral.Core.Matching.TitleNormalizer.Normalize(f.Title).Full}";
            if (seen.Add(key) && seen.Add(f.Id)) list.Add(f);
        }
        return list.OrderBy(f => f.Status == "now" ? 0 : 1).ThenBy(f => f.Kind == "game" ? 0 : 1).ThenBy(f => f.EndsAt ?? "9999", StringComparer.Ordinal).ToList();
    }

    private async Task<(IReadOnlyList<Freebie>, FreebieSourceDto)> LoadAsync(string id, string key, bool refresh, Func<Task<IReadOnlyList<Freebie>>> fetch)
    {
        var provider = $"freebies-{id}";
        var cached = repo.GetProviderCache(provider, key);
        var saved = cached is { } c ? Read(c.Body) : [];
        if (cached is { Fresh: true } && !refresh) return (saved, Source(id, true, cached.Value.Fetched, null));
        if (LocalOnly || IsGameActive()) return (saved, Source(id, true, cached?.Fetched, null, stale: cached is not null));
        try
        {
            var items = (await fetch()).Select(Validate).OfType<Freebie>().Take(MaxItems).ToList();
            repo.SetProviderCache(provider, key, JsonSerializer.Serialize(items, JsonFileCache.Options), Ttl);
            return (items, Source(id, true, DateTimeOffset.UtcNow, null));
        }
        catch (DataSourceException ex)
        {
            return (saved, Source(id, true, cached?.Fetched, ex.Message, stale: cached is not null));
        }
    }

    private static FreebieSourceDto Source(string id, bool enabled, DateTimeOffset? fetched, string? error, bool stale = false) => id == "gamerpower"
        ? new FreebieSourceDto(id, "GamerPower", enabled, fetched?.ToString("O"), stale, error, "Giveaways from GamerPower.com")
        : new FreebieSourceDto(id, "Epic Games Store", enabled, fetched?.ToString("O"), stale, error, "Free games from the Epic Games Store");

    /// <summary>The page's opaque ID → the item it was shown (from the cache only).</summary>
    public Freebie? Find(string id)
    {
        if (!ItemId().IsMatch(id)) return null;
        var provider = id.StartsWith("gp-", StringComparison.Ordinal) ? "freebies-gamerpower" : "freebies-epicfree";
        foreach (var (_, c) in repo.GetProviderCacheAll(provider, 50))
            if (Read(c.Body).FirstOrDefault(f => f.Id == id) is { } f) return f;
        return null;
    }

    /// <summary>Caches one item's image through the artwork pipeline (validated host, size, type and magic bytes) and returns its art-host URL.</summary>
    public async Task<string?> ImageAsync(string id, CancellationToken ct)
    {
        if (Find(id) is not { ImageUrl: { } url } f) return null;
        if (CachedImage(f) is { } done) return done;
        if (LocalOnly || artwork.SkipDownloads?.Invoke() == true) return null;
        var rel = await artwork.CacheThumbAsync(url, "freebies", ct);
        return rel is null ? null : ArtworkService.Url("", rel);
    }

    private string? CachedImage(Freebie f)
    {
        if (f.ImageUrl is null) return null;
        var hash = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(new Uri(f.ImageUrl).AbsoluteUri)))[..12];
        foreach (var ext in new[] { ".jpg", ".png", ".webp" })
        {
            var rel = $"_thumbs/freebies/{hash}{ext}";
            if (artwork.CachedFileExists(rel)) return ArtworkService.Url("", rel);
        }
        return null;
    }

    internal static IReadOnlyList<Freebie> Read(string body)
    {
        try
        {
            if (body.Length > 1024 * 1024) return [];
            return (JsonSerializer.Deserialize<List<Freebie>>(body, JsonFileCache.Options) ?? []).Select(Validate).OfType<Freebie>().Take(MaxItems).ToList();
        }
        catch (JsonException) { return []; }
    }

    /// <summary>Every field checked again (fresh answers and the cache alike): IDs, hosts, lengths, known words.</summary>
    internal static Freebie? Validate(Freebie? f)
    {
        if (f is null || f.Id is null || !ItemId().IsMatch(f.Id) || f.Source is not ("gamerpower" or "epic") || string.IsNullOrWhiteSpace(f.Title)) return null;
        var url = f.Source == "gamerpower" ? JsonRead.SafeUrl(f.Url, "gamerpower.com") : JsonRead.SafeUrl(f.Url, "store.epicgames.com");
        if (url is null) return null;
        var image = f.ImageUrl is null ? null : JsonRead.SafeUrl(f.ImageUrl, f.Source == "gamerpower" ? GamerPowerClient.ImageHosts : EpicFreeGamesClient.ImageHosts);
        static string? Clip(string? s, int n) => s is null ? null : s.Length > n ? s[..n] : s;
        return f with
        {
            Title = Clip(MetadataService.Clean(f.Title, 160), 160)!,
            Store = f.Store is "steam" or "epic" or "gog" or "itch" or "xbox" or "ubisoft" or "ea" or "battlenet" ? f.Store : "other",
            Platforms = (f.Platforms ?? []).Where(p => p is { Length: > 0 and <= 30 }).Take(8).ToList(),
            Kind = f.Kind is "game" or "loot" or "beta" ? f.Kind : "loot",
            Status = f.Status is "now" or "upcoming" ? f.Status : "now",
            Worth = f.Worth is { Length: <= 16 } ? f.Worth : null,
            StartsAt = IsoDate(f.StartsAt),
            EndsAt = IsoDate(f.EndsAt),
            Description = f.Description is null ? null : MetadataService.Clean(f.Description, 400),
            ImageUrl = image,
            Url = url,
        };
    }

    private static string? IsoDate(string? s) =>
        s is { Length: <= 25 } && DateTimeOffset.TryParse(s, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out _) ? s : null;

    [GeneratedRegex(@"\A(gp-[0-9]{1,9}|epic-[0-9a-f]{16,32})\z")]
    internal static partial Regex ItemId();
}
