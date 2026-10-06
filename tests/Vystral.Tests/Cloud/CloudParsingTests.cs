using Vystral.Core.Cloud;
using Vystral.Windows.Cloud;
using Vystral.Windows.DataSources;
using Xunit;

namespace Vystral.Tests.Cloud;

/// <summary>
/// Parsing of the cloud catalogues. Files under Fixtures/Cloud are small subsets of the live public answers captured on
/// 2026-10-06 (trimmed to a handful of entries and the fields VYSTRAL reads); they are test inputs, not shipped data.
/// </summary>
public sealed class CloudParsingTests
{
    internal static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "Cloud", name));

    [Fact]
    public void Gfn_page_keeps_valid_entries_with_their_store_ids_and_play_type()
    {
        var page = GfnCatalogClient.ParsePage(Fixture("gfn_page1.json"));
        Assert.Equal("NzUw", page.NextCursor);
        Assert.Equal(9, page.Items.Count);

        var hl2 = page.Items.Single(i => i.EntryId == "e5bd86f0-3f67-4bec-a505-d1315f3c0d50");
        Assert.Equal("100885011", hl2.LaunchKey);
        Assert.Equal(CloudPlayTypes.Ready, hl2.PlayType);
        Assert.False(hl2.Premium);
        Assert.Equal([new CloudStoreLink("steam", "220")], hl2.Links);

        var wolf = page.Items.Single(i => i.LaunchKey == "100884311");
        Assert.Contains(new CloudStoreLink("xbox", "9P75CBJ9WT9W"), wolf.Links);
        Assert.Contains(new CloudStoreLink("epic", "283080ad58e64fd084d30413888a571c"), wolf.Links);
        Assert.Contains(new CloudStoreLink("steam", "201810"), wolf.Links);

        var witcher = page.Items.Single(i => i.LaunchKey == "100883811");
        Assert.True(witcher.Premium);
        Assert.Contains(new CloudStoreLink("gog", "1207664643"), witcher.Links);
        Assert.Contains(new CloudStoreLink("battlenet", "1431458625"), witcher.Links);

        var ea = page.Items.Single(i => i.LaunchKey == "101929211");
        Assert.Contains(new CloudStoreLink("ea", "Origin.OFR.50.0003798"), ea.Links);

        var itp = page.Items.Single(i => i.Title == "Tomb Raider: Anniversary");
        Assert.Equal(CloudPlayTypes.InstallToPlay, itp.PlayType);
        Assert.True(itp.Premium);
        Assert.All(page.Items, i => Assert.Equal(CloudServices.GeForceNow, i.Service));
    }

    [Fact]
    public void Gfn_last_page_has_no_cursor()
    {
        var page = GfnCatalogClient.ParsePage(Fixture("gfn_page_last.json"));
        Assert.Null(page.NextCursor);
        Assert.Equal(2, page.Items.Count);
    }

    [Fact]
    public void Gfn_drops_entries_with_unsafe_ids_and_ignores_unknown_stores()
    {
        const string json = """
            {"data":{"apps":{"numberReturned":5,"pageInfo":{"endCursor":"","hasNextPage":false},"items":[
              {"id":"not-a-uuid","cmsId":123,"title":"Bad id","gfn":{"playType":"READY_TO_PLAY"},"variants":[]},
              {"id":"e5bd86f0-3f67-4bec-a505-d1315f3c0d51","cmsId":"12a; calc.exe","title":"Bad cms","variants":[]},
              {"id":"e5bd86f0-3f67-4bec-a505-d1315f3c0d52","cmsId":77,"title":"","variants":[]},
              {"id":"e5bd86f0-3f67-4bec-a505-d1315f3c0d53","cmsId":78,"title":"<b>Good</b> game","gfn":{"playType":"SOMETHING_NEW"},
               "variants":[{"appStore":"STEAM","storeId":"12x"},{"appStore":"NV_BUNDLE","storeId":"1"},{"appStore":"STEAM","storeId":"440"},{"appStore":"XBOX","storeId":"lowercase0001"}]},
              "junk"]}}}
            """;
        var page = GfnCatalogClient.ParsePage(json);
        var only = Assert.Single(page.Items);
        Assert.Equal("78", only.LaunchKey);
        Assert.Equal("Good game", only.Title);
        Assert.Null(only.PlayType);
        Assert.Equal([new CloudStoreLink("steam", "440")], only.Links);
    }

    [Theory]
    [InlineData("""{"errors":[{"message":"bad"}]}""")]
    [InlineData("""not json""")]
    [InlineData("""{"data":{"apps":{"items":[],"pageInfo":{"hasNextPage":true,"endCursor":"\"}) { evil }"}}}}""")]
    public void Gfn_rejects_unreadable_answers(string json) =>
        Assert.Equal(DataSourceOutcome.Malformed, Assert.Throws<DataSourceException>(() => GfnCatalogClient.ParsePage(json)).Outcome);

    [Fact]
    public void Gfn_query_only_takes_validated_country_and_cursor()
    {
        var q = GfnCatalogClient.Query("GB", "MTUwMA==");
        Assert.Contains("country:\"GB\"", q);
        Assert.Contains("after:\"MTUwMA==\"", q);
        Assert.Throws<ArgumentException>(() => GfnCatalogClient.Query("gb", ""));
        Assert.Throws<ArgumentException>(() => GfnCatalogClient.Query("G\"B", ""));
        Assert.Throws<ArgumentException>(() => GfnCatalogClient.Query("US", "x\" ) { __schema }"));
    }

    [Fact]
    public void Sigl_lists_product_ids_after_its_header()
    {
        var ids = XboxCloudCatalogClient.ParseSigl(Fixture("xbox_sigl_allcloud.json"));
        Assert.Equal(24, ids.Count);
        Assert.Equal("9NPDN9R45JX4", ids[0]);
        Assert.All(ids, id => Assert.True(CloudIds.IsProductId(id)));
    }

    [Theory]
    [InlineData("""[{"id":"9NPDN9R45JX4"}]""")]
    [InlineData("""{"id":"9NPDN9R45JX4"}""")]
    public void Sigl_without_a_header_is_rejected(string json) =>
        Assert.Throws<DataSourceException>(() => XboxCloudCatalogClient.ParseSigl(json));

    [Fact]
    public void Sigl_skips_malformed_ids()
    {
        var ids = XboxCloudCatalogClient.ParseSigl("""[{"siglId":"x","title":"All games"},{"id":"9npdn9r45jx4"},{"id":"9NPDN9R45JX4&x=1"},{"id":"9NPDN9R45JX4"},{"id":"9NPDN9R45JX4"}]""");
        Assert.Equal(["9NPDN9R45JX4"], ids);
    }

    [Fact]
    public void Display_catalogue_gives_package_family_names_and_titles()
    {
        var products = XboxCloudCatalogClient.ParseProducts(Fixture("xbox_displaycatalog.json"));
        Assert.Equal(3, products.Count);
        Assert.Contains(("9NPDN9R45JX4", "SurpriseAttackPtyLtd.1000xResist_8k24hnfn3vvj0", "1000xRESIST"), products);
        Assert.Contains(("9NG07QJNK38J", "Innersloth.AmongUs_fw5x688tam7rm", "Among Us"), products);
        // A console-only product has no package family name.
        Assert.Contains(("9N42SSSX2MTG", (string?)null, "Age of Empires II: Definitive Edition"), products);
    }

    [Fact]
    public void Display_and_sigl_urls_are_built_from_validated_ids()
    {
        Assert.Equal("https://catalog.gamepass.com/sigls/v2?id=29a81209-df6f-41fd-a528-2ae6b91f719c&market=DE&language=en-US",
            XboxCloudCatalogClient.SiglUri("DE").AbsoluteUri);
        Assert.Equal("https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=9NPDN9R45JX4,9NG07QJNK38J&market=US&languages=en-us",
            XboxCloudCatalogClient.DisplayUri(["9NPDN9R45JX4", "9NG07QJNK38J"], "US").AbsoluteUri);
        Assert.Throws<ArgumentException>(() => XboxCloudCatalogClient.DisplayUri(["9NPDN9R45JX4&x"], "US"));
        Assert.Throws<ArgumentException>(() => XboxCloudCatalogClient.DisplayUri(Enumerable.Repeat("9NPDN9R45JX4", 21).ToList(), "US"));
        Assert.Throws<ArgumentException>(() => XboxCloudCatalogClient.SiglUri("USA"));
    }

    [Fact]
    public void Gfn_status_summary_counts_degraded_locations_and_lists_incidents()
    {
        var s = GfnStatusClient.Parse(Fixture("gfn_status_summary.json"), DateTimeOffset.UnixEpoch);
        Assert.Equal("maintenance", s.Indicator);
        Assert.Equal("Service Under Maintenance", s.Description);
        Assert.Equal(7, s.Components); // groups aren't locations
        Assert.Equal(1, s.Degraded); // the location under maintenance (its group is not counted again)
        Assert.Equal(["Wuthering Waves in maintenance", "S.T.A.L.K.E.R. 2: Heart of Chornobyl maintenance"], s.Incidents);
    }

    [Theory]
    [InlineData("SurpriseAttackPtyLtd.1000xResist_8k24hnfn3vvj0", true)]
    [InlineData("Microsoft.Cardinal_8wekyb3d8bbwe", true)]
    [InlineData("DONTNODEntertainment.Pioneer-P10_1t8sv8k1cftdw", true)]
    [InlineData("NoHash", false)]
    [InlineData("a b_8wekyb3d8bbwe", false)]
    [InlineData("x_8WEKYB3D8BBWE", false)]
    public void Package_family_names_are_validated(string pfn, bool ok) => Assert.Equal(ok, CloudIds.IsPackageFamilyName(pfn));
}
