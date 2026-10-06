using Vystral.Core.Matching;

namespace Vystral.Core.Cloud;

/// <summary>One copy of a game in the library: its store key (<c>PlatformInfo.Key</c>) and the store's own ID for it.</summary>
public sealed record CloudLibraryCopy(string Platform, string PlatformGameId, string Title);

/// <summary>A library game as the matcher sees it.</summary>
public sealed record CloudLibraryGame(string GameId, string Title, string? SteamAppId, IReadOnlyList<CloudLibraryCopy> Copies);

/// <summary>How a library game was tied to a cloud entry. <see cref="Title"/> is a likely match and is labelled as one.</summary>
public enum CloudMatchKind { StoreId, Title }

/// <summary>A library game that a cloud catalogue says can be streamed. <paramref name="Store"/> is the copy that matched.</summary>
public sealed record CloudMatch(string GameId, string Service, CloudCatalogEntry Entry, CloudMatchKind Kind, string Store);

/// <summary>
/// Ties library games to cloud catalogue entries, conservatively:
/// <list type="bullet">
/// <item>Exact store IDs first: a Steam app ID, a GOG product ID, or an Xbox package family name (the catalogue's
/// Store product ID resolved through Microsoft's display catalogue). Those mappings are verified, so a copy on those
/// stores that isn't listed is simply not streamable; no title guess is made for it on GeForce NOW.</item>
/// <item>Epic, Ubisoft, EA and Battle.net copies (whose IDs don't verifiably match) fall back to the normalized title,
/// only when exactly one entry has that title and, on GeForce NOW, that entry lists the same store.</item>
/// <item>Xbox Cloud Gaming doesn't depend on where you bought a game (Game Pass), so any non-manual copy may match by
/// title there when its package family name doesn't.</item>
/// </list>
/// Games added by hand are never matched by title: they could be anything.
/// </summary>
public static class CloudMatcher
{
    /// <summary>Stores whose IDs GeForce NOW's catalogue carries in a verified form.</summary>
    private static readonly HashSet<string> GfnVerifiedStores = [CloudStores.Steam, CloudStores.Gog, CloudStores.Xbox];

    /// <param name="productPfn">Store product ID → package family name (from the display catalogue).</param>
    public static IReadOnlyList<CloudMatch> Match(string service, IReadOnlyList<CloudCatalogEntry> catalog, IReadOnlyList<CloudLibraryGame> games,
        IReadOnlyDictionary<string, string> productPfn)
    {
        var byStore = new Dictionary<(string Store, string Id), CloudCatalogEntry>();
        var byTitle = new Dictionary<string, List<(CloudCatalogEntry Entry, string Full)>>(StringComparer.Ordinal);
        foreach (var e in catalog)
        {
            if (e.Service != service) continue;
            foreach (var l in e.Links)
            {
                if (l.Store == CloudStores.Xbox)
                {
                    if (productPfn.TryGetValue(l.StoreId, out var pfn)) byStore.TryAdd((CloudStores.Xbox, pfn.ToLowerInvariant()), e);
                }
                else byStore.TryAdd((l.Store, l.StoreId), e);
            }
            var n = TitleNormalizer.Normalize(e.Title);
            if (n.Base.Length < 3) continue;
            if (!byTitle.TryGetValue(n.Base, out var list)) byTitle[n.Base] = list = [];
            if (!list.Any(x => x.Entry.EntryId == e.EntryId)) list.Add((e, n.Full));
        }

        var result = new List<CloudMatch>();
        foreach (var g in games)
        {
            var m = ByStore(service, g, byStore) ?? ByTitle(service, g, byTitle);
            if (m is not null) result.Add(m);
        }
        return result;
    }

    private static CloudMatch? ByStore(string service, CloudLibraryGame g, Dictionary<(string, string), CloudCatalogEntry> byStore)
    {
        foreach (var c in g.Copies)
        {
            var key = c.Platform switch
            {
                CloudStores.Steam when CloudIds.IsSteamAppId(c.PlatformGameId) => (CloudStores.Steam, c.PlatformGameId),
                CloudStores.Gog when CloudIds.IsGogId(c.PlatformGameId) => (CloudStores.Gog, c.PlatformGameId),
                CloudStores.Xbox when CloudIds.IsPackageFamilyName(c.PlatformGameId) => (CloudStores.Xbox, c.PlatformGameId.ToLowerInvariant()),
                _ => default((string, string)?),
            };
            if (key is { } k && byStore.TryGetValue(k, out var e)) return new CloudMatch(g.GameId, service, e, CloudMatchKind.StoreId, c.Platform);
        }
        // A Steam app ID the library knows from elsewhere (a merged entry, Steam Web API ownership).
        if (CloudIds.IsSteamAppId(g.SteamAppId) && byStore.TryGetValue((CloudStores.Steam, g.SteamAppId!), out var s))
            return new CloudMatch(g.GameId, service, s, CloudMatchKind.StoreId, CloudStores.Steam);
        return null;
    }

    private static CloudMatch? ByTitle(string service, CloudLibraryGame g, Dictionary<string, List<(CloudCatalogEntry Entry, string Full)>> byTitle)
    {
        foreach (var c in g.Copies)
        {
            if (c.Platform == "manual") continue;
            // On GeForce NOW a Steam, GOG or Xbox copy that isn't listed by ID isn't supported; don't guess.
            if (service == CloudServices.GeForceNow && GfnVerifiedStores.Contains(c.Platform)) continue;
            foreach (var title in new[] { g.Title, c.Title }.Distinct(StringComparer.Ordinal))
            {
                var n = TitleNormalizer.Normalize(title);
                if (n.Base.Length < 3 || !byTitle.TryGetValue(n.Base, out var candidates)) continue;
                var pool = service == CloudServices.GeForceNow
                    ? candidates.Where(x => x.Entry.Links.Any(l => l.Store == c.Platform)).ToList()
                    : candidates;
                if (pool.Count > 1) pool = pool.Where(x => x.Full == n.Full).ToList();
                if (pool.Count == 1) return new CloudMatch(g.GameId, service, pool[0].Entry, CloudMatchKind.Title, c.Platform);
            }
        }
        return null;
    }
}
