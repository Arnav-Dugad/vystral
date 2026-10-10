namespace Vystral.Windows.DataSources;

/// <summary>Track D4: RAWG's trailer list for a game (MP4 files, mostly relayed from Steam's CDN).</summary>
public sealed partial class RawgClient
{
    /// <summary>RAWG's raw answer for <c>/games/{id or slug}/movies</c> (see <see cref="ExternalTrailers.ParseRawgMovies"/>); an empty list when RAWG has no such game.</summary>
    public async Task<string> GetMoviesJsonAsync(string idOrSlug, CancellationToken ct)
    {
        if (!SlugOrId().IsMatch(idOrSlug)) return """{"results":[]}""";
        try { return await GetAsync($"games/{idOrSlug}/movies", ct); }
        catch (DataSourceException ex) when (ex.Message == NotFound) { return """{"results":[]}"""; }
    }
}
