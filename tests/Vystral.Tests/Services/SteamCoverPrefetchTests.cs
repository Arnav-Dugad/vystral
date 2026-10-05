using System.Net;
using Vystral.Core.Domain;
using Vystral.Tests.SteamAccount;
using Vystral.Tests.Support;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Services;

public sealed class SteamCoverPrefetchTests : IDisposable
{
    private static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0];
    private static readonly byte[] RealCover = [.. Jpeg, .. new byte[40_000]];
    private const string Sha = "111acdc401454a19bc728b030bcc4b49769677e0";

    private readonly TestDb _t = new();

    public void Dispose() => _t.Dispose();

    private static string Index(string appId, string format, params (string Key, string Name)[] assets)
    {
        var fields = string.Concat(assets.Select(a => $",\"{a.Key}\":\"{a.Name}\""));
        return "{\"response\":{\"store_items\":[{\"appid\":" + appId + ",\"assets\":{\"asset_url_format\":\"" + format + "\"" + fields + "}}]}}";
    }

    // ---------- ParseAssetIndex ----------

    [Fact]
    public void Hashed_asset_names_under_a_sha1_folder_are_accepted()
    {
        var json = Index("3059520", "steam/apps/3059520/${FILENAME}?t=1786646076", ("library_capsule_2x", $"{Sha}/library_capsule_2x.jpg"), ("header", "header.jpg"));
        var map = ArtworkService.ParseAssetIndex(json, ["3059520"])["3059520"];
        Assert.Equal($"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3059520/{Sha}/library_capsule_2x.jpg?t=1786646076", map["library_capsule_2x"]);
        Assert.Equal("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3059520/header.jpg?t=1786646076", map["header"]);
    }

    [Theory]
    [InlineData("../../evil.jpg")]
    [InlineData("abc/def/library.jpg")]
    [InlineData("notasha/library.jpg")]
    [InlineData("library.exe")]
    [InlineData("library.jpg?x=1")]
    [InlineData("https://evil.example/a.jpg")]
    [InlineData("library .jpg")]
    public void Suspicious_file_names_are_dropped(string name)
    {
        var json = Index("620", "steam/apps/620/${FILENAME}", ("library_capsule", name));
        Assert.Empty(ArtworkService.ParseAssetIndex(json, ["620"])["620"]);
    }

    [Theory]
    [InlineData("steam/apps/999/${FILENAME}")]
    [InlineData("steam/apps/620/../999/${FILENAME}")]
    [InlineData("steam/apps/620/${FILENAME}?t=1&u=http://x")]
    [InlineData("steam/apps/620/${FILENAME}#x")]
    [InlineData("other/apps/620/${FILENAME}")]
    public void A_format_outside_the_apps_own_folder_is_ignored(string format) =>
        Assert.Empty(ArtworkService.ParseAssetIndex(Index("620", format, ("header", "header.jpg")), ["620"]));

    [Fact]
    public void Apps_that_were_not_requested_are_ignored() =>
        Assert.Empty(ArtworkService.ParseAssetIndex(Index("620", "steam/apps/620/${FILENAME}", ("header", "header.jpg")), ["70"]));

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"response":{}}""")]
    [InlineData("""{"response":{"store_items":{}}}""")]
    [InlineData("""{"response":{"store_items":[{"appid":"620"}]}}""")]
    public void Odd_shapes_return_nothing(string json) => Assert.Empty(ArtworkService.ParseAssetIndex(json, ["620"]));

    // ---------- Repository ----------

    [Fact]
    public void Missing_cover_query_lists_only_steam_games_without_a_cover()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam,
            TestDb.Install(PlatformId.Steam, "620", "Portal 2", steamAppId: "620"),
            TestDb.Install(PlatformId.Steam, "70", "Half-Life", steamAppId: "70"))]);
        _t.Repo.AddManualGame("Manual", @"C:\Games\m\m.exe", null);
        var withCover = _t.Repo.LoadSnapshot((_, _) => null).Games.Single(g => g.Title == "Half-Life").Id;
        _t.Repo.SetArtwork(withCover, ArtworkKind.Cover, "x/cover.jpg", "test", false);

        Assert.Equal([("620")], _t.Repo.SteamGamesMissingCover(10).Select(g => g.AppId));
    }

    // ---------- Prefetch ----------

    [Fact]
    public async Task Prefetch_downloads_classic_covers_and_falls_back_to_the_hashed_index_in_one_batch()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam,
            TestDb.Install(PlatformId.Steam, "620", "Classic", steamAppId: "620"),
            TestDb.Install(PlatformId.Steam, "3059520", "Hashed", steamAppId: "3059520"),
            TestDb.Install(PlatformId.Steam, "404", "Nothing", steamAppId: "404"))]);
        var indexRequests = 0;
        using var http = new HttpClient(new FakeHandler(req =>
        {
            var url = req.RequestUri!.AbsoluteUri;
            if (url.Contains("IStoreBrowseService", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref indexRequests);
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(Index("3059520", "steam/apps/3059520/${FILENAME}?t=1", ("library_capsule_2x", $"{Sha}/library_capsule_2x.jpg"))),
                };
            }
            if (url.Contains("/apps/620/library_600x900_2x.jpg", StringComparison.Ordinal) || url.Contains(Sha, StringComparison.Ordinal))
            {
                var ok = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(RealCover) };
                ok.Content.Headers.ContentType = new("image/jpeg");
                return ok;
            }
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }));
        var art = new ArtworkService(new AppPaths(Path.Combine(_t.Dir.Path, "data")), _t.Repo, http);
        var callbacks = 0;

        var landed = await art.PrefetchSteamCoversAsync(_t.Repo.SteamGamesMissingCover(10), () => Interlocked.Increment(ref callbacks), TestContext.Current.CancellationToken);

        Assert.Equal(2, landed);
        Assert.Equal(2, callbacks);
        Assert.Equal(1, indexRequests);
        Assert.Equal(["404"], _t.Repo.SteamGamesMissingCover(10).Select(g => g.AppId));
    }

    [Fact]
    public async Task Prefetch_does_nothing_in_data_saver()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "620", "Classic", steamAppId: "620"))]);
        var requests = 0;
        using var http = new HttpClient(new FakeHandler(_ => { Interlocked.Increment(ref requests); return new HttpResponseMessage(HttpStatusCode.NotFound); }));
        var art = new ArtworkService(new AppPaths(Path.Combine(_t.Dir.Path, "data")), _t.Repo, http) { SkipDownloads = () => true };

        Assert.Equal(0, await art.PrefetchSteamCoversAsync(_t.Repo.SteamGamesMissingCover(10), () => { }, TestContext.Current.CancellationToken));
        Assert.Equal(0, requests);
    }

    [Fact]
    public async Task A_flat_grey_placeholder_counts_as_missing_and_the_real_cover_is_found()
    {
        _t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "2807960", "Placeholder", steamAppId: "2807960"))]);
        var placeholder = Jpeg.Concat(new byte[4500]).ToArray();
        var real = Jpeg.Concat(new byte[40_000]).ToArray();
        using var http = new HttpClient(new FakeHandler(req =>
        {
            var url = req.RequestUri!.AbsoluteUri;
            if (url.Contains("IStoreBrowseService", StringComparison.Ordinal))
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(Index("2807960", "steam/apps/2807960/${FILENAME}", ("library_capsule_2x", $"{Sha}/library_capsule_2x.jpg"))),
                };
            var ok = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(url.Contains(Sha, StringComparison.Ordinal) ? real : placeholder) };
            ok.Content.Headers.ContentType = new("image/jpeg");
            return ok;
        }));
        var art = new ArtworkService(new AppPaths(Path.Combine(_t.Dir.Path, "data")), _t.Repo, http);

        Assert.Equal(1, await art.PrefetchSteamCoversAsync(_t.Repo.SteamGamesMissingCover(10), () => { }, TestContext.Current.CancellationToken));
        var game = _t.Repo.LoadSnapshot((_, _) => null).Games.Single();
        Assert.Contains("cover", _t.Repo.GetArtwork(game.Id).Keys);
        Assert.Equal(0, art.ForgetPlaceholders());
    }

    [Theory]
    [InlineData(ArtworkKind.Cover, 4584, true)]
    [InlineData(ArtworkKind.Hero, 5000, true)]
    [InlineData(ArtworkKind.Cover, 14_498, false)]
    [InlineData(ArtworkKind.Logo, 3000, false)]
    [InlineData(ArtworkKind.Header, 3000, false)]
    public void Placeholder_threshold(ArtworkKind kind, long bytes, bool placeholder) => Assert.Equal(placeholder, ArtworkService.IsPlaceholder(kind, bytes));
}
