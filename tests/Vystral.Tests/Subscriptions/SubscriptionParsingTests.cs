using Vystral.Core.Domain;
using Vystral.Core.Subscriptions;
using Vystral.Windows.DataSources;
using Vystral.Windows.Subscriptions;
using Xunit;

namespace Vystral.Tests.Subscriptions;

/// <summary>
/// Track V: plans, the public Game Pass answers, window-title queue parsing and the value maths. Files under
/// Fixtures/Subscriptions are small subsets of the live public answers captured on 2026-10-07 (US): the subscriptions
/// list, the "Leaving soon", "Recently added" and "Most popular" lists, and display-catalogue answers (full and browse).
/// </summary>
public sealed class SubscriptionParsingTests
{
    internal static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "Subscriptions", name));

    private static readonly DateTimeOffset Now = new(2026, 10, 7, 12, 0, 0, TimeSpan.Zero);

    // ---------------- plans ----------------

    [Fact]
    public void Parse_keeps_known_plans_in_picker_order_and_one_per_family()
    {
        Assert.Equal(["gp-ultimate", "ea-play"], SubscriptionPlans.Parse("ea-play,gp-ultimate,nonsense,,gp-ultimate"));
        // Two Game Pass tiers can't both be true: the higher one wins.
        Assert.Equal(["gp-premium"], SubscriptionPlans.Parse("gp-essential,gp-premium"));
        Assert.Equal(["ea-play-pro", "ubi-premium", "humble-choice", "prime-gaming"], SubscriptionPlans.Parse("prime-gaming,humble-choice,ubi-classics,ubi-premium,ea-play,ea-play-pro"));
        Assert.Empty(SubscriptionPlans.Parse(null));
        Assert.Empty(SubscriptionPlans.Parse(""));
        Assert.Empty(SubscriptionPlans.Parse(new string('a', 500)));
        Assert.Equal("gp-pc,ubi-classics", SubscriptionPlans.Serialize(["ubi-classics", "gp-pc", "bogus"]));
    }

    [Fact]
    public void Each_plan_maps_to_the_public_lists_it_includes()
    {
        Assert.Equal(["pc", "eaaccess"], SubscriptionPlans.CatalogKeysFor("gp-pc"));
        Assert.Equal(["gamepasscore"], SubscriptionPlans.CatalogKeysFor("gp-essential"));
        Assert.Equal(["gamepassstandard"], SubscriptionPlans.CatalogKeysFor("gp-premium"));
        Assert.Equal(["pc", "console", "ultimate", "eaaccess", "ubisoftplus"], SubscriptionPlans.CatalogKeysFor("gp-ultimate"));
        Assert.Equal(["eaaccess"], SubscriptionPlans.CatalogKeysFor("ea-play-pro"));
        Assert.Equal(["ubisoftplus"], SubscriptionPlans.CatalogKeysFor("ubi-classics"));
        Assert.Empty(SubscriptionPlans.CatalogKeysFor("humble-choice"));
        Assert.Empty(SubscriptionPlans.CatalogKeysFor("prime-gaming"));
        // Every key a plan uses is one VYSTRAL reads.
        Assert.All(SubscriptionPlans.All.SelectMany(SubscriptionPlans.CatalogKeysFor), k => Assert.Contains(k, SubscriptionPlans.CatalogKeys));
        // Cloud gaming: Essential, Premium and Ultimate; not PC Game Pass.
        Assert.Equal(["gp-essential", "gp-premium", "gp-ultimate"], SubscriptionPlans.All.Where(SubscriptionPlans.IncludesXboxCloud));
        Assert.Equal("Game Pass Ultimate", SubscriptionPlans.DisplayName("gp-ultimate"));
    }

    // ---------------- public lists ----------------

    [Fact]
    public void Lists_keep_only_known_arrays_and_valid_ids()
    {
        var lists = SubscriptionCatalogClient.ParseLists(Fixture("subs_lists.json"));
        Assert.Equal(SubscriptionPlans.CatalogKeys.Order(), lists.Keys.Order());
        Assert.DoesNotContain("gtaplus", lists.Keys);
        Assert.DoesNotContain("xgpp", lists.Keys);
        Assert.Contains("9PNKG0WBL61W", lists["pc"]); // Pacific Drive (leaving soon)
        Assert.All(lists.Values.SelectMany(v => v), id => Assert.Matches("^[0-9A-Z]{12}$", id));

        var messy = SubscriptionCatalogClient.ParseLists("""{"pc":["9PNKG0WBL61W","9PNKG0WBL61W","bad",12,null,"9pnkg0wbl61w"],"eaaccess":"nope","bogus":["9PNKG0WBL61W"]}""");
        Assert.Equal(["9PNKG0WBL61W"], messy["pc"]);
        Assert.False(messy.ContainsKey("eaaccess"));
        Assert.Throws<DataSourceException>(() => SubscriptionCatalogClient.ParseLists("[]"));
        Assert.Throws<DataSourceException>(() => SubscriptionCatalogClient.ParseLists("""{"other":[]}"""));
        Assert.Throws<DataSourceException>(() => SubscriptionCatalogClient.ParseLists("not json"));
        var huge = "{\"pc\":[" + string.Join(',', Enumerable.Range(0, 3100).Select(i => $"\"9N{i:D10}\"")) + "]}";
        Assert.Throws<DataSourceException>(() => SubscriptionCatalogClient.ParseLists(huge));
    }

    [Fact]
    public void Leaving_soon_list_reads_product_ids()
    {
        var ids = SubscriptionCatalogClient.ParseSigl(Fixture("sigl_leaving.json"));
        Assert.Equal(9, ids.Count);
        Assert.Contains("9PPT8K6GQHRZ", ids); // Clair Obscur: Expedition 33
        Assert.Equal(5, SubscriptionCatalogClient.ParseSigl(Fixture("sigl_recent.json")).Count);
        var ex = Assert.Throws<DataSourceException>(() => SubscriptionCatalogClient.ParseSigl("""[{"id":"9PPT8K6GQHRZ"}]""")); // no header
        Assert.Contains("Game Pass", ex.Message);
    }

    [Fact]
    public void Urls_are_built_only_from_validated_values()
    {
        Assert.Equal("https://catalog.gamepass.com/subscriptions?subscription=all&market=GB", SubscriptionCatalogClient.SubscriptionsUri("GB").AbsoluteUri);
        Assert.Throws<ArgumentException>(() => SubscriptionCatalogClient.SubscriptionsUri("gb&x=1"));
        Assert.Contains("id=cc7fc951-d00f-410e-9e02-5e4628e04163", SubscriptionCatalogClient.SiglUri(SubscriptionCatalogClient.LeavingSoonSigl, "US").AbsoluteUri);
        Assert.Throws<ArgumentException>(() => SubscriptionCatalogClient.SiglUri("29a81209-df6f-41fd-a528-2ae6b91f719c", "US"));
        Assert.EndsWith("&fieldsTemplate=browse", SubscriptionCatalogClient.ProductsUri(["9PPT8K6GQHRZ"], "US", browse: true).AbsoluteUri);
        Assert.DoesNotContain("fieldsTemplate", SubscriptionCatalogClient.ProductsUri(["9PPT8K6GQHRZ"], "US", browse: false).AbsoluteUri);
        Assert.Throws<ArgumentException>(() => SubscriptionCatalogClient.ProductsUri(["9PPT8K6GQHRZ,X"], "US", true));
        Assert.Throws<ArgumentException>(() => SubscriptionCatalogClient.ProductsUri([.. Enumerable.Repeat("9PPT8K6GQHRZ", 21)], "US", true));
    }

    [Fact]
    public void Full_product_answers_give_package_poster_and_game_pass_end()
    {
        var products = SubscriptionCatalogClient.ParseProducts(Fixture("dc_full_leaving.json"), Now);
        var pacific = Assert.Single(products, p => p.ProductId == "9PNKG0WBL61W");
        Assert.Equal("Pacific Drive", pacific.Title);
        Assert.Equal("KeplerInteractive.PacificDrive_ymj30pw7xe604", pacific.Pfn);
        Assert.StartsWith("https://store-images.s-microsoft.com/image/apps.", pacific.PosterUrl);
        Assert.DoesNotContain("?", pacific.PosterUrl);
        // The Game Pass offers end on 16 Oct; an earlier ended window (1 Oct) is in the past and ignored.
        Assert.Equal(new DateTimeOffset(2026, 10, 16, 9, 59, 59, TimeSpan.Zero), pacific.GamePassEnd);
        var crime = Assert.Single(products, p => p.ProductId == "9NGZ1M3N98P2");
        Assert.Equal(new DateTimeOffset(2026, 10, 7, 23, 59, 59, TimeSpan.Zero), crime.GamePassEnd);
        // Once that date has passed it's no longer shown.
        Assert.Null(SubscriptionCatalogClient.ParseProducts(Fixture("dc_full_leaving.json"), Now.AddDays(1)).Single(p => p.ProductId == "9NGZ1M3N98P2").GamePassEnd);
    }

    [Fact]
    public void Browse_answers_give_titles_without_package_or_dates()
    {
        var products = SubscriptionCatalogClient.ParseProducts(Fixture("dc_browse_recent.json"), Now);
        Assert.Equal(5, products.Count);
        Assert.Contains(products, p => p.Title == "Gears of War: E-Day");
        Assert.All(products, p => Assert.Null(p.Pfn));
        Assert.All(products, p => Assert.Null(p.GamePassEnd));
        Assert.All(products, p => Assert.NotNull(p.PosterUrl));
    }

    [Fact]
    public void A_game_pass_end_needs_a_subscription_upsell_and_a_real_date()
    {
        static string Product(string type, string bigId, string end) => $$"""
            {"Products":[{"ProductId":"9PPT8K6GQHRZ","DisplaySkuAvailabilities":[{"Availabilities":[
              {"Conditions":{"EndDate":"{{end}}"},"Remediations":[{"Type":"{{type}}","BigId":"{{bigId}}"}]}]}]}]}
            """;
        Assert.NotNull(SubscriptionCatalogClient.ParseProducts(Product("Upsell", "CFQ7TTC0K6L8", "2026-10-16T09:59:59Z"), Now)[0].GamePassEnd);
        Assert.Null(SubscriptionCatalogClient.ParseProducts(Product("Purchase", "CFQ7TTC0K6L8", "2026-10-16T09:59:59Z"), Now)[0].GamePassEnd);
        Assert.Null(SubscriptionCatalogClient.ParseProducts(Product("Upsell", "9NBLGGH4R2R6", "2026-10-16T09:59:59Z"), Now)[0].GamePassEnd);
        Assert.Null(SubscriptionCatalogClient.ParseProducts(Product("Upsell", "CFQ7TTC0K6L8", "9998-12-30T00:00:00Z"), Now)[0].GamePassEnd);
        Assert.Null(SubscriptionCatalogClient.ParseProducts(Product("Upsell", "CFQ7TTC0K6L8", "not a date"), Now)[0].GamePassEnd);
    }

    [Theory]
    [InlineData("//store-images.s-microsoft.com/image/apps.62003.13984747577958597.78ebdbe9-45c0-4d00-bbd6-0a52d99831d1.f956513a-d205-45ad-9925-64a87122cae3", true)]
    [InlineData("https://store-images.s-microsoft.com/image/apps.9487.14011542784181932.80ac6a3c-1234-4abc-9def-001122334455", true)]
    [InlineData("http://store-images.s-microsoft.com/image/apps.9487.14011542784181932.80ac6a3c-1234-4abc-9def-001122334455", false)]
    [InlineData("//evil.example/image/apps.9487.14011542784181932.80ac6a3c-1234-4abc-9def-001122334455", false)]
    [InlineData("//store-images.s-microsoft.com/image/apps.9487.1401.80ac6a3c-1234?w=999999", false)]
    [InlineData("//store-images.s-microsoft.com/image/../../etc/passwd", false)]
    [InlineData("//store-images.s-microsoft.com.evil.example/image/apps.9487.14011542784181932.80ac6a3c-1234-4abc", false)]
    public void Only_store_cdn_images_are_kept(string uri, bool ok) =>
        Assert.Equal(ok, SubscriptionCatalogClient.SafeImageUrl(uri) is not null);

    // ---------------- queue titles ----------------

    [Theory]
    [InlineData("GeForce NOW - Position in queue: 12", 12, null)]
    [InlineData("Queue position 3 · GeForce NOW", 3, null)]
    [InlineData("In queue: #1,204 — GeForce NOW", 1204, null)]
    [InlineData("You're #7 in the queue", 7, null)]
    [InlineData("GeForce NOW | 15th in line", 15, null)]
    [InlineData("Place in line: 42 | ETA 9 min", 42, 9)]
    [InlineData("Queue: 18 (Estimated wait: 1 h 5 min)", 18, 65)]
    [InlineData("GeForce NOW · ETA: 1h 5m", null, 65)]
    [InlineData("Estimated wait time ~3 mins", null, 3)]
    [InlineData("Wait time less than a minute", null, 1)]
    public void Queue_titles_are_read(string title, int? position, int? eta)
    {
        var r = GfnQueueTitle.Parse(title);
        Assert.NotNull(r);
        Assert.Equal(position, r.Position);
        Assert.Equal(eta, r.EtaMinutes);
    }

    [Theory]
    [InlineData("GeForce NOW")]
    [InlineData("Forza Horizon 5 - GeForce NOW")]
    [InlineData("Cyberpunk 2077")]
    [InlineData("Halo: The Master Chief Collection 343")]
    [InlineData("Queue")]
    [InlineData("Position in queue: 0")]
    [InlineData("Wait")]
    [InlineData("")]
    [InlineData(null)]
    public void Ordinary_titles_are_not_a_queue(string? title) => Assert.Null(GfnQueueTitle.Parse(title));

    [Fact]
    public void Absurd_values_and_long_titles_are_ignored()
    {
        Assert.Null(GfnQueueTitle.Parse("Position in queue: 99999999"));
        Assert.Null(GfnQueueTitle.Parse("Queue position 4 " + new string('x', 600)));
        Assert.Null(GfnQueueTitle.Parse("ETA 9999 min"));
    }

    // ---------------- value ----------------

    private static readonly string A = new('a', 32), B = new('b', 32), C = new('c', 32);
    private static readonly DateTimeOffset Month = new(2026, 10, 1, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Value_counts_plan_games_and_included_cloud_time_once()
    {
        var sessions = new[]
        {
            new ValueSession(A, SessionSources.Tracked, Month.AddDays(1), 3600),       // Game Pass game
            new ValueSession(A, SessionSources.Detected, Month.AddDays(2), 1800),
            new ValueSession(B, SessionSources.Tracked, Month.AddDays(3), 7200),       // in Game Pass and EA Play
            new ValueSession(C, SessionSources.Tracked, Month.AddDays(3), 9999),       // not in any plan
            new ValueSession(C, SessionSources.CloudXbox, Month.AddDays(4), 1200),     // Xbox Cloud: part of Ultimate
            new ValueSession(C, SessionSources.CloudGfn, Month.AddDays(5), 2400),      // GeForce NOW membership
            new ValueSession(A, SessionSources.Tracked, Month.AddDays(-1), 2 * 86400), // started last month: only October counts
        };
        var map = new Dictionary<string, IReadOnlyList<string>> { [A] = ["gp-ultimate"], [B] = ["gp-ultimate", "ea-play"] };
        var r = SubscriptionValue.Compute(sessions, map, ["gp-ultimate", "ea-play"], gfnMember: true, Month, Month.AddDays(10), price: 30);
        Assert.Equal(3600 + 1800 + 7200 + 1200 + 2400 + 86400, r.Seconds);
        Assert.Equal(3, r.Games);
        Assert.Equal(6, r.Sessions);
        Assert.Equal(["gp-ultimate", "ea-play", SubscriptionValue.GeForceNowRow], r.Plans.Select(p => p.Plan));
        Assert.Equal(3600 + 1800 + 7200 + 1200 + 86400, r.Plans[0].Seconds);
        Assert.Equal(7200, r.Plans[1].Seconds);
        Assert.Equal(A, r.Top[0].GameId);
        Assert.Equal(Math.Round(30 / (r.Seconds / 3600.0), 2), r.CostPerHour);
    }

    [Fact]
    public void Cost_per_hour_needs_a_price_and_an_hour()
    {
        var map = new Dictionary<string, IReadOnlyList<string>> { [A] = ["gp-pc"] };
        var little = new[] { new ValueSession(A, SessionSources.Tracked, Month.AddDays(1), 1200) };
        var noPrice = SubscriptionValue.Compute(little, map, ["gp-pc"], false, Month, Month.AddDays(5), 0);
        Assert.Null(noPrice.CostPerHour);
        Assert.Null(noPrice.CostNote);
        var under = SubscriptionValue.Compute(little, map, ["gp-pc"], false, Month, Month.AddDays(5), 12);
        Assert.Null(under.CostPerHour);
        Assert.Equal("underHour", under.CostNote);
        Assert.Equal("none", SubscriptionValue.Compute([], map, ["gp-pc"], false, Month, Month.AddDays(5), 12).CostNote);
        // PC Game Pass has no cloud gaming, and without a membership GeForce NOW time isn't counted.
        var cloud = new[] { new ValueSession(B, SessionSources.CloudXbox, Month.AddDays(1), 5000), new ValueSession(B, SessionSources.CloudGfn, Month.AddDays(1), 5000) };
        Assert.Equal(0, SubscriptionValue.Compute(cloud, map, ["gp-pc"], false, Month, Month.AddDays(5), 12).Seconds);
    }

    [Fact]
    public void Month_start_is_local_midnight_on_the_first()
    {
        var zone = TimeZoneInfo.CreateCustomTimeZone("plus2", TimeSpan.FromHours(2), "plus2", "plus2");
        var start = SubscriptionValue.MonthStart(new DateTimeOffset(2026, 9, 30, 23, 30, 0, TimeSpan.Zero), zone); // 1 Oct 01:30 local
        Assert.Equal(new DateTimeOffset(2026, 10, 1, 0, 0, 0, TimeSpan.FromHours(2)), start);
    }
}
