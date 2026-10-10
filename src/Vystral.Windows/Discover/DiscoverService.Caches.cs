namespace Vystral.Windows.Discover;

// Track D6: the cache viewer clears Discover's downloaded answers.
public sealed partial class DiscoverService
{
    /// <summary>The database rows Discover keeps (store shelves, similar games, IGDB ids), all re-downloadable.</summary>
    public static readonly string[] CacheProviders = [FeaturedCacheProvider, SimilarCacheProvider, IgdbIdCacheProvider];

    /// <summary>Forgets searches, game details, cover addresses and genre pages kept in memory (pages already open keep working).</summary>
    public void ClearDownloadedCaches()
    {
        _searchCache.Clear();
        _details.Clear();
        _images.Clear();
        _assetIndex.Clear();
        _genrePages.Clear();
    }
}
