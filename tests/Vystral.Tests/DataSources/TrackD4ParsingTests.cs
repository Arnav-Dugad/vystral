using Vystral.Windows.DataSources;
using Vystral.Windows.DataSources.Identity;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.DataSources;

/// <summary>
/// Track D4: parsers for the new sources and the trailer/YouTube allow-lists. Files under Fixtures/D4 were captured
/// from the live services on 2026-10-10 (trimmed); everything else is hostile input written by hand.
/// </summary>
public sealed class TrackD4ParsingTests
{
    internal static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "D4", name));

    // ---------- GamerPower ----------

    [Fact]
    public void GamerPower_giveaways_parse_with_clean_titles_stores_and_safe_links()
    {
        var items = GamerPowerClient.Parse(Fixture("gamerpower_giveaways.json"));
        Assert.Equal(6, items.Count);
        var first = items[0];
        Assert.Equal("gp-3810", first.Id);
        Assert.Equal("Fireside Feelings", first.Title);
        Assert.Equal("steam", first.Store);
        Assert.Equal("game", first.Kind);
        Assert.Equal("now", first.Status);
        Assert.Equal("$7.99", first.Worth);
        Assert.Equal("2026-10-12T23:59:00", first.EndsAt);
        Assert.StartsWith("https://www.gamerpower.com/", first.Url);
        Assert.StartsWith("https://www.gamerpower.com/offers/", first.ImageUrl);
        Assert.All(items, i => Assert.Matches(@"\Agp-[0-9]+\z", i.Id));
    }

    [Fact]
    public void GamerPower_rejects_foreign_links_images_bad_ids_and_inactive_items()
    {
        var items = GamerPowerClient.Parse("""
            [{"id":1,"title":"Evil (Steam) Giveaway","gamerpower_url":"https://evil.example/x","status":"Active","platforms":"PC, Steam"},
             {"id":2,"title":"Fine (Epic Games Store) Giveaway","gamerpower_url":"https://www.gamerpower.com/fine","image":"https://evil.example/a.jpg","status":"Active","platforms":"PC, Epic Games Store","type":"Game","end_date":"N/A","worth":"N/A"},
             {"id":-3,"title":"Bad id","gamerpower_url":"https://www.gamerpower.com/x","status":"Active"},
             {"id":4,"title":"Over","gamerpower_url":"https://www.gamerpower.com/over","status":"Expired"},
             {"id":5,"title":"Http","gamerpower_url":"http://www.gamerpower.com/x","status":"Active"},
             "nonsense", 42, null]
            """);
        var only = Assert.Single(items);
        Assert.Equal("Fine", only.Title);
        Assert.Equal("epic", only.Store);
        Assert.Null(only.ImageUrl);
        Assert.Null(only.EndsAt);
        Assert.Null(only.Worth);
        Assert.Empty(GamerPowerClient.Parse("""{"status":0,"status_message":"No active giveaways"}"""));
    }

    // ---------- Epic free games ----------

    [Fact]
    public void Epic_feed_lists_free_now_and_upcoming_only_with_store_links()
    {
        var now = DateTimeOffset.Parse("2026-10-10T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var items = EpicFreeGamesClient.Parse(Fixture("epic_free_games.json"), now);
        Assert.Equal(["Out of Sight", "TerraScape", "Bad Cheese", "Agent A: A puzzle in disguise"], items.Select(i => i.Title));
        Assert.Equal(["now", "now", "upcoming", "upcoming"], items.Select(i => i.Status));
        var out0 = items[0];
        Assert.Equal("https://store.epicgames.com/en-US/p/out-of-sight-b96ca8", out0.Url);
        Assert.Equal("2026-10-15T15:00:00Z", out0.EndsAt);
        Assert.Equal("$14.99", out0.Worth);
        Assert.StartsWith("https://cdn1.epicgames.com/", out0.ImageUrl);
        // A week later the "now" ones are over and the upcoming ones are current.
        var later = EpicFreeGamesClient.Parse(Fixture("epic_free_games.json"), now.AddDays(6));
        Assert.Equal(["Bad Cheese", "Agent A: A puzzle in disguise"], later.Select(i => i.Title));
        Assert.All(later, i => Assert.Equal("now", i.Status));
    }

    [Fact]
    public void Epic_feed_tolerates_garbage()
    {
        Assert.Empty(EpicFreeGamesClient.Parse("""{"data":{"Catalog":{"searchStore":{"elements":[{"title":"x","id":"not hex"},{"promotions":null},7]}}}}""", DateTimeOffset.UtcNow));
        Assert.Empty(EpicFreeGamesClient.Parse("""{"errors":["nope"]}""", DateTimeOffset.UtcNow));
    }

    // ---------- GOG ----------

    [Fact]
    public void Gog_catalogue_search_and_product_videos_parse()
    {
        var hits = GogCatalogClient.ParseSearch(Fixture("gog_catalog_cyberpunk.json"));
        Assert.Equal(2, hits.Count);
        Assert.Contains(hits, h => h.Id == "2093619782" && h.Title == "Cyberpunk 2077" && h.Year == 2020 && h.ProductType == "pack");
        var videos = GogCatalogClient.ParseVideos(Fixture("gog_v2_game.json"));
        Assert.Equal(["nBT2SP21f3Q", "glo7AzNq8YY", "1-l29HlKkXU"], videos.Select(v => v.YouTubeId));
        Assert.Empty(GogCatalogClient.ParseVideos("""{"_embedded":{"videos":[{"provider":"vimeo","videoId":"123"},{"provider":"youtube","videoId":"bad id with spaces"}]}}"""));
    }

    [Fact]
    public void Gog_title_search_without_the_game_finds_no_exact_match()
    {
        var hits = GogCatalogClient.ParseSearch(Fixture("gog_catalog_hades.json"));
        Assert.NotEmpty(hits);
        Assert.Null(IdentityMerge.PickByTitle("Hades", 2020, hits, h => h.Title, h => h.Year));
        var cp = GogCatalogClient.ParseSearch(Fixture("gog_catalog_cyberpunk.json"));
        var pick = IdentityMerge.PickByTitle("Cyberpunk 2077", 2020, cp, h => h.Title, h => h.Year);
        Assert.NotNull(pick);
        Assert.Equal("2093619782", cp[pick.Value.Index].Id);
        Assert.Equal("exactTitleYear", pick.Value.Method);
    }

    // ---------- ProtonDB ----------

    [Fact]
    public void ProtonDb_summary_parses_and_rejects_unknown_tiers()
    {
        var s = ProtonDbClient.Parse("1245620", Fixture("protondb_summary.json"));
        Assert.NotNull(s);
        Assert.Equal("gold", s.Tier);
        Assert.Equal("platinum", s.BestReported);
        Assert.Equal("strong", s.Confidence);
        Assert.Equal(2105, s.Total);
        Assert.Null(ProtonDbClient.Parse("1", """{"tier":"<script>","total":5}"""));
        Assert.Null(ProtonDbClient.Parse("1", """{"tier":"gold","confidence":"<b>","total":-4,"score":7}""")!.Confidence);
    }

    // ---------- Trailers from other sources ----------

    [Fact]
    public void Rawg_movies_pick_an_allow_listed_mp4_max_quality_first()
    {
        var t = ExternalTrailers.ParseRawgMovies("""
            {"count":2,"results":[
              {"id":1,"name":"Evil","data":{"max":"https://evil.example/movie.mp4","480":"http://steamcdn-a.akamaihd.net/steam/apps/1/movie480.mp4"}},
              {"id":2,"name":"Launch Trailer","data":{"480":"https://steamcdn-a.akamaihd.net/steam/apps/256693661/movie480.mp4","max":"https://steamcdn-a.akamaihd.net/steam/apps/256693661/movie_max.mp4"}}]}
            """);
        Assert.NotNull(t);
        Assert.Equal(("rawg", "file", "Launch Trailer"), (t.Source, t.Kind, t.Name));
        Assert.Equal("https://steamcdn-a.akamaihd.net/steam/apps/256693661/movie_max.mp4", t.Url);
        Assert.Null(ExternalTrailers.ParseRawgMovies("""{"results":[]}"""));
    }

    [Theory]
    [InlineData("https://media.rawg.io/media/stories/abc/clip.mp4", true)]
    [InlineData("https://steamcdn-a.akamaihd.net/steam/apps/1/movie_max.mp4", true)]
    [InlineData("http://media.rawg.io/media/clip.mp4", false)]
    [InlineData("https://media.rawg.io/media/clip.mp4?x=1", false)]
    [InlineData("https://media.rawg.io:8443/media/clip.mp4", false)]
    [InlineData("https://user@media.rawg.io/media/clip.mp4", false)]
    [InlineData("https://media.rawg.io.evil.example/clip.mp4", false)]
    [InlineData("https://media.rawg.io/media/clip.m3u8", false)]
    [InlineData("https://media.rawg.io/media/a%20b.mp4", false)]
    [InlineData("https://www.youtube.com/watch.mp4", false)]
    public void External_file_trailers_are_allow_listed(string url, bool ok) => Assert.Equal(ok, ExternalTrailers.IsAllowedFile(url, out _));

    [Fact]
    public void Proxy_serves_only_the_fixed_entry_of_an_alternative_file()
    {
        var t = new ExternalTrailer("rawg", "file", "https://media.rawg.io/media/clip.mp4", null, null);
        Assert.Equal("https://media.rawg.io/media/clip.mp4", ExternalTrailers.ResolveUpstream(t, "video")?.AbsoluteUri);
        Assert.Null(ExternalTrailers.ResolveUpstream(t, "hls_264_master.m3u8"));
        Assert.Null(ExternalTrailers.ResolveUpstream(t with { Url = "https://evil.example/clip.mp4" }, "video"));
        Assert.Null(ExternalTrailers.ResolveUpstream(new ExternalTrailer("igdb", "youtube", null, "dQw4w9WgXcQ", null), "video"));
    }

    [Fact]
    public void Igdb_videos_prefer_a_trailer_and_validate_youtube_ids()
    {
        var t = ExternalTrailers.ParseIgdbVideos("""
            [{"id":1,"video_id":"<iframe>","name":"Trailer"},{"id":2,"video_id":"aaaaaaaaaaa","name":"Gameplay walkthrough"},
             {"id":3,"video_id":"bbbbbbbbbbb","name":"Launch Trailer"}]
            """);
        Assert.Equal(("igdb", "youtube", "bbbbbbbbbbb"), (t!.Source, t.Kind, t.YouTubeId));
        Assert.Equal("aaaaaaaaaaa", ExternalTrailers.ParseIgdbVideos("""[{"video_id":"aaaaaaaaaaa","name":"Gameplay"}]""")!.YouTubeId);
        Assert.Null(ExternalTrailers.ParseIgdbVideos("""{"not":"an array"}"""));
    }

    [Fact]
    public void Cached_trailers_are_validated_again()
    {
        Assert.Null(ExternalTrailers.Validate(new ExternalTrailer("evil", "file", "https://media.rawg.io/a.mp4", null, null)));
        Assert.Null(ExternalTrailers.Validate(new ExternalTrailer("rawg", "file", "https://evil.example/a.mp4", null, null)));
        Assert.Null(ExternalTrailers.Validate(new ExternalTrailer("gog", "youtube", null, "short", null)));
        var ok = ExternalTrailers.Validate(new ExternalTrailer("gog", "youtube", "https://ignored.example", "nBT2SP21f3Q", "Name‮"));
        Assert.Equal((null, "nBT2SP21f3Q", "Name"), (ok!.Url, ok.YouTubeId, ok.Name));
    }

    // ---------- YouTube frames ----------

    [Theory]
    [InlineData("https://www.youtube-nocookie.com/embed/nBT2SP21f3Q", true, true)]
    [InlineData("https://www.youtube-nocookie.com/embed/nBT2SP21f3Q?autoplay=1&mute=1&playsinline=1&rel=0&controls=0&enablejsapi=1", true, true)]
    [InlineData("https://www.youtube-nocookie.com/embed/nBT2SP21f3Q?origin=https%3A%2F%2Fapp.vystral.example&enablejsapi=1", true, true)]
    [InlineData("https://www.youtube-nocookie.com/embed/nBT2SP21f3Q", false, false)]
    [InlineData("https://www.youtube.com/embed/nBT2SP21f3Q", true, false)]
    [InlineData("http://www.youtube-nocookie.com/embed/nBT2SP21f3Q", true, false)]
    [InlineData("https://www.youtube-nocookie.com/watch?v=nBT2SP21f3Q", true, false)]
    [InlineData("https://www.youtube-nocookie.com/embed/nBT2SP21f3Q/../x", true, false)]
    [InlineData("https://www.youtube-nocookie.com/embed/nBT2SP21f3Q?list=PL123", true, false)]
    [InlineData("https://www.youtube-nocookie.com/embed/nBT2SP21f3Q?autoplay=1&autoplay=1", true, false)]
    [InlineData("https://www.youtube-nocookie.com/embed/nBT2SP21f3Q?origin=https%3A%2F%2Fevil.example", true, false)]
    [InlineData("https://accounts.google.com/ServiceLogin", true, false)]
    [InlineData("about:blank", true, false)]
    [InlineData("https://www.youtube-nocookie.com:444/embed/nBT2SP21f3Q", true, false)]
    public void Only_single_video_nocookie_embeds_may_load_and_only_when_allowed(string uri, bool enabled, bool ok) =>
        Assert.Equal(ok, YouTubeEmbed.IsAllowedFrame(uri, enabled));
}
