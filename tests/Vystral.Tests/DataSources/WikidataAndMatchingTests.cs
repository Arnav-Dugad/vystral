using Vystral.Core.Data;
using Vystral.Tests.SteamAccount;
using Vystral.Windows.DataSources;
using Xunit;

namespace Vystral.Tests.DataSources;

public sealed class WikidataAndMatchingTests
{
    [Fact]
    public void Query_batches_only_numeric_ids_and_reads_every_store_property()
    {
        var q = WikidataClient.BuildQuery("steam", ["620", "1245620", "620", "62\" } DELETE {", "abc"])!;
        Assert.Contains("VALUES ?key { \"620\" \"1245620\" }", q);
        Assert.Contains("wdt:P1733 ?key", q);
        foreach (var p in new[] { "P2725", "P12727", "P6278", "P5885", "P5794", "P6337", "P2816", "P12561", "P12570", "P9968", "P11688" })
            Assert.Contains($"wdt:{p} ", q);
        Assert.DoesNotContain("DELETE", q);
        Assert.Contains("GROUP BY ?key ?item", q);
        Assert.Contains("wdt:P12727 ?key", WikidataClient.BuildQuery("gog", ["1207658924"])!);
        Assert.Null(WikidataClient.BuildQuery("steam", ["x"]));
        Assert.Throws<ArgumentException>(() => WikidataClient.BuildQuery("epic", ["1"]));
        Assert.Equal(100, WikidataClient.BuildQuery("steam", Enumerable.Range(1, 250).Select(i => i.ToString()).ToList())!.Split("\" \"").Length);
    }

    [Fact]
    public void Parse_live_batch_answer_and_reports_missing_keys()
    {
        var ids = WikidataClient.Parse(ProviderParsingTests.Fixture("wikidata_steam_batch.json"), ["620", "1086940", "1245620", "3527290", "999"]);
        Assert.Equal(5, ids.Count);
        var bg3 = ids.Single(i => i.Key == "1086940");
        Assert.Equal("Q64441774", bg3.ItemId);
        Assert.Equal("Baldur's Gate 3", bg3.Label);
        Assert.Equal("game/baldurs_gate_iii", bg3.Ids["gog"]);
        Assert.Equal("9nd58lqtg09t", bg3.Ids["microsoft"]);
        Assert.Equal("baldurs-gate-iii", bg3.Ids["igdb"]);
        var missing = ids.Single(i => i.Key == "999");
        Assert.Null(missing.ItemId);
        Assert.Empty(missing.Ids);
    }

    [Fact]
    public void Parse_prefers_the_video_game_item_and_drops_malformed_values()
    {
        const string json = """
            {"head":{"vars":[]},"results":{"bindings":[
              {"key":{"type":"literal","value":"10"},"item":{"type":"uri","value":"http://www.wikidata.org/entity/Q1"},"v_epic":{"type":"literal","value":"a-b"}},
              {"key":{"type":"literal","value":"10"},"item":{"type":"uri","value":"http://www.wikidata.org/entity/Q2"},"game":{"type":"literal","value":"1"},
               "v_epic":{"type":"literal","value":"../../etc"},"v_microsoft":{"type":"literal","value":"9P3J32CTXLRZ"}},
              {"key":{"type":"literal","value":"11"},"item":{"type":"uri","value":"https://evil.example/Q3"}}
            ]}}
            """;
        var ids = WikidataClient.Parse(json, ["10", "11"]);
        var ten = ids.Single(i => i.Key == "10");
        Assert.Equal("Q2", ten.ItemId);
        Assert.False(ten.Ids.ContainsKey("epic"));
        Assert.Equal("9p3j32ctxlrz", ten.Ids["microsoft"]);
        Assert.Null(ids.Single(i => i.Key == "11").ItemId);
        Assert.Throws<DataSourceException>(() => WikidataClient.Parse("{}", ["1"]));
    }

    [Theory]
    [InlineData("gog", "game/baldurs_gate_iii", "https://www.gog.com/en/game/baldurs_gate_iii")]
    [InlineData("microsoft", "9p3j32ctxlrz", "https://apps.microsoft.com/detail/9P3J32CTXLRZ")]
    [InlineData("epic", "expedition-33-b3240d", "https://store.epicgames.com/p/expedition-33-b3240d")]
    [InlineData("pcgamingwiki", "Baldur's_Gate_3", "https://www.pcgamingwiki.com/wiki/Baldur%27s_Gate_3")]
    [InlineData("wikidata", "Q42", "https://www.wikidata.org/wiki/Q42")]
    [InlineData("epic", "javascript:alert(1)", null)]
    [InlineData("unknown", "1", null)]
    public void Page_urls_are_built_only_from_valid_ids(string name, string value, string? expected) =>
        Assert.Equal(expected, WikidataClient.PageUrl(name, value));

    // ---------- Matching confidence ----------

    [Fact]
    public void Igdb_title_fallback_needs_a_unique_exact_title_and_matching_year()
    {
        IReadOnlyList<IgdbSearchHit> hits = [new(1, "Hollow Lantern", 2019), new(2, "Hollow Lantern: Embers", 2021)];
        Assert.Equal((1L, 0.85), IgdbClient.PickExactTitle("Hollow Lantern™", 2020, hits));
        Assert.Equal((1L, 0.75), IgdbClient.PickExactTitle("Hollow Lantern", null, hits));
        Assert.Null(IgdbClient.PickExactTitle("Hollow Lantern", 2015, hits)); // year disagrees
        Assert.Null(IgdbClient.PickExactTitle("Hollow", null, hits));
        Assert.Null(IgdbClient.PickExactTitle("Doom", null, [new(1, "DOOM", 1993), new(2, "Doom", 2016)])); // ambiguous
    }

    [Fact]
    public void Rawg_title_fallback_has_the_same_rules()
    {
        IReadOnlyList<RawgHit> hits = [new(5, "quiet-harbor", "Quiet Harbor", 2022)];
        Assert.Equal(0.85, RawgClient.PickExactTitle("Quiet Harbor", 2022, hits)!.Value.Confidence);
        Assert.Null(RawgClient.PickExactTitle("Quiet Harbor", 2010, hits));
    }

    [Theory]
    [InlineData("Feb 24, 2022", 2022)]
    [InlineData("2011-04-18", 2011)]
    [InlineData("Coming soon", null)]
    [InlineData(null, null)]
    public void Release_years_are_read_from_store_dates(string? date, int? year) => Assert.Equal(year, EnrichmentService.YearOf(date));

    [Fact]
    public void Library_value_date_is_the_earliest_honest_evidence()
    {
        var added = DateTimeOffset.Parse("2026-03-01T00:00:00Z");
        var s = new LibraryValueSource("g", "T", false, "620", ["steam"], added, DateTimeOffset.Parse("2026-04-01T00:00:00Z"),
            DateTimeOffset.Parse("2021-06-01T00:00:00Z"), DateTimeOffset.Parse("2024-01-01T00:00:00Z"));
        Assert.Equal((DateTimeOffset.Parse("2021-06-01T00:00:00Z"), "firstAchievement"), DataSourcesService.Since(s));
        Assert.Equal((added, "firstSeen"), DataSourcesService.Since(s with { FirstAchievement = null, StoreLastPlayed = null, FirstSession = null }));
        Assert.Equal("storeLastPlayed", DataSourcesService.Since(s with { FirstAchievement = null }).Source);
    }

    // ---------- Keys ----------

    [Fact]
    public void Keys_live_only_in_their_own_credentials_and_are_masked()
    {
        var store = new FakeSecretStore();
        var keys = new DataSourceKeyStore(store);
        Assert.False(keys.IsConfigured(KeyedProvider.SteamGridDb));
        Assert.True(keys.SetKey(KeyedProvider.SteamGridDb, "0123456789abcdef0123456789abcdef"));
        Assert.True(keys.SetTwitch("abcdefghijklmnopqrstuvwxyz0123", "zyxwvutsrqponmlkjihgfedcba9876"));
        Assert.Equal("0123456789abcdef0123456789abcdef", store.Items["VYSTRAL/SteamGridDB"]);
        Assert.Equal("abcdefghijklmnopqrstuvwxyz0123\nzyxwvutsrqponmlkjihgfedcba9876", store.Items["VYSTRAL/IGDB"]);
        Assert.Equal("••••cdef", keys.Masked(KeyedProvider.SteamGridDb));
        Assert.Equal("••••0123", keys.Masked(KeyedProvider.Igdb)); // client ID suffix; the secret is never shown
        Assert.Null(keys.GetKey(KeyedProvider.Rawg));
        keys.Clear(KeyedProvider.SteamGridDb);
        Assert.False(store.Items.ContainsKey("VYSTRAL/SteamGridDB"));
        Assert.True(keys.IsConfigured(KeyedProvider.Igdb));
    }

    [Theory]
    [InlineData(KeyedProvider.Rawg, "  0123456789abcdef0123456789abcdef  ", "0123456789abcdef0123456789abcdef")]
    [InlineData(KeyedProvider.Rawg, "short", null)]
    [InlineData(KeyedProvider.Rawg, "has space 0123456789abcdef0123", null)]
    [InlineData(KeyedProvider.IsThereAnyDeal, "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d", "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d")]
    [InlineData(KeyedProvider.SteamGridDb, "key\nwith-newline-0123456789", null)]
    public void Pasted_keys_are_trimmed_and_checked(KeyedProvider p, string pasted, string? expected) =>
        Assert.Equal(expected, DataSourceKeyStore.NormalizeKey(p, pasted));

    [Fact]
    public void Corrupt_stored_values_are_ignored()
    {
        var store = new FakeSecretStore();
        store.Items["VYSTRAL/IGDB"] = "only-one-part";
        store.Items["VYSTRAL/RAWG"] = "bad key!";
        var keys = new DataSourceKeyStore(store);
        Assert.Null(keys.GetTwitch());
        Assert.Null(keys.GetKey(KeyedProvider.Rawg));
        Assert.Throws<ArgumentException>(() => keys.SetKey(KeyedProvider.Rawg, "x"));
        Assert.Throws<ArgumentException>(() => keys.SetTwitch("same0123456789abcdef", "same0123456789abcdef"));
    }
}
