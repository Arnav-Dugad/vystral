using System.Text.Json.Nodes;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Services;

public sealed class MediaServiceTests : IDisposable
{
    private readonly TestDb _t = new();
    private readonly SettingsService _settings;
    private readonly MediaService _media;
    private readonly string _root;
    private readonly string _folderId;

    public MediaServiceTests()
    {
        _settings = new SettingsService(_t.Repo);
        Assert.Null(_settings.Set("moments.enabled", JsonValue.Create(true)));
        // An empty registry means no Steam install, so only the folders created here are in play.
        _media = new MediaService(_t.Repo, _settings, new SteamAdapter(new FakeRegistry()));

        _root = _t.Dir.Dir("media");
        _t.Dir.Write(@"media\shot.png", "png");
        _t.Dir.Write(@"media\clips\run 1.mp4", "mp4");
        _t.Dir.Write(@"media\Photo.JPG", "jpg");
        _t.Dir.Write(@"media\notes.txt", "text");
        _t.Dir.Write(@"media\game.exe", "MZ");
        _t.Dir.Write("secret.png", "outside");
        _t.Dir.Write("secret.txt", "outside");
        _t.Dir.Write(@"media2\sibling.png", "sibling");
        _t.Repo.AddMediaFolder(_root);
        _folderId = _t.Repo.GetMediaFolders().Single().Id;
    }

    public void Dispose() => _t.Dispose();

    private (string Path, bool Thumbnail, string ContentType)? Resolve(string relative) => _media.Resolve($"f/{_folderId}/{relative}");

    [Fact]
    public void Resolves_a_valid_image()
    {
        var r = Resolve("shot.png");
        Assert.NotNull(r);
        Assert.Equal(Path.Combine(_root, "shot.png"), r.Value.Path);
        Assert.False(r.Value.Thumbnail);
        Assert.Equal("image/png", r.Value.ContentType);
    }

    [Fact]
    public void Thumbnail_prefix_is_reported()
    {
        var r = _media.Resolve($"t/{_folderId}/shot.png");
        Assert.True(r!.Value.Thumbnail);
    }

    [Fact]
    public void Leading_slash_is_tolerated()
    {
        Assert.NotNull(_media.Resolve($"/f/{_folderId}/shot.png"));
    }

    [Fact]
    public void Resolves_nested_escaped_paths_and_maps_content_types()
    {
        var clip = Resolve("clips/run%201.mp4");
        Assert.Equal(Path.Combine(_root, "clips", "run 1.mp4"), clip!.Value.Path);
        Assert.Equal("video/mp4", clip.Value.ContentType);
        Assert.Equal("image/jpeg", Resolve("Photo.JPG")!.Value.ContentType);
    }

    [Theory]
    [InlineData("..%2F..%2Fsecret.png")]
    [InlineData("..%2Fsecret.png")]
    [InlineData("../secret.png")]
    [InlineData("clips/../../secret.png")]
    [InlineData("..%5Csecret.png")]
    [InlineData("%2E%2E%2Fsecret.png")]
    [InlineData("..%2Fmedia2%2Fsibling.png")]
    [InlineData("../media2/sibling.png")]
    public void Path_traversal_is_rejected(string relative) => Assert.Null(Resolve(relative));

    [Fact]
    public void Absolute_path_injection_is_rejected()
    {
        var secret = Uri.EscapeDataString(Path.Combine(_t.Dir.Path, "secret.png"));
        Assert.Null(Resolve(secret));
        Assert.Null(Resolve(Uri.EscapeDataString(@"C:\Windows\win.ini")));
        Assert.Null(Resolve(Uri.EscapeDataString(@"\\server\share\x.png")));
    }

    [Theory]
    [InlineData("notes.txt")]
    [InlineData("game.exe")]
    [InlineData("..%2F..%2Fsecret.txt")]
    public void Non_media_files_are_rejected(string relative) => Assert.Null(Resolve(relative));

    [Fact]
    public void Missing_file_is_rejected() => Assert.Null(Resolve("nope.png"));

    [Theory]
    [InlineData("")]
    [InlineData("f")]
    [InlineData("f/onlyfolder")]
    [InlineData("x/{0}/shot.png")]
    [InlineData("F/{0}/shot.png")]
    [InlineData("f/unknownfolder/shot.png")]
    [InlineData("f//shot.png")]
    public void Malformed_or_unknown_urls_are_rejected(string pattern) =>
        Assert.Null(_media.Resolve(string.Format(pattern, _folderId)));

    [Fact]
    public void Nothing_resolves_when_moments_are_disabled()
    {
        Assert.Null(_settings.Set("moments.enabled", JsonValue.Create(false)));
        Assert.Null(Resolve("shot.png"));
    }

    [Fact]
    public void Removed_folder_stops_resolving_after_refresh()
    {
        Assert.NotNull(Resolve("shot.png"));
        Assert.True(_t.Repo.RemoveMediaFolder(_folderId));
        _media.GetFolders();
        Assert.Null(Resolve("shot.png"));
    }

    [Fact]
    public void GetFolders_lists_user_folders_with_existence()
    {
        var missing = Path.Combine(_t.Dir.Path, "gone");
        _t.Repo.AddMediaFolder(missing);

        var folders = _media.GetFolders();

        Assert.DoesNotContain(folders, f => f.Id == "steam");
        Assert.Contains(folders, f => f.Id == "gamebar" && f.Automatic);
        var mine = folders.Single(f => f.Id == _folderId);
        Assert.Equal(("media", true, false), (mine.Label, mine.Exists, mine.Automatic));
        Assert.False(folders.Single(f => f.Path == missing).Exists);
    }

    [Fact]
    public void List_returns_only_media_files_with_matching_urls()
    {
        var items = _media.List(_ => null, []).Where(i => i.FolderId == _folderId).ToList();

        Assert.Equal(["Photo.JPG", "run 1.mp4", "shot.png"], items.Select(i => i.Name).Order(StringComparer.Ordinal).ToArray());
        var clip = items.Single(i => i.Name == "run 1.mp4");
        Assert.Equal("video", clip.Kind);
        Assert.Equal("", clip.ThumbUrl);
        Assert.Equal($"https://{MediaService.MediaHost}/f/{_folderId}/clips/run%201.mp4", clip.Url);

        // Every listed URL resolves back to the same file.
        foreach (var item in items)
        {
            var path = item.Url[$"https://{MediaService.MediaHost}/".Length..];
            Assert.NotNull(_media.Resolve(path));
        }
    }

    [Fact]
    public void List_matches_files_to_games_by_filename()
    {
        _t.Dir.Write(@"media\Hades 2024-01-01 12-00-00.png", "png");
        var items = _media.List(_ => null, [("g1", "Hades™"), ("g2", "Celeste")]).Where(i => i.FolderId == _folderId).ToList();
        var hit = items.Single(i => i.Name.StartsWith("Hades", StringComparison.Ordinal));
        Assert.Equal(("g1", "filename"), (hit.GameId, hit.MatchedBy));
        Assert.Null(items.Single(i => i.Name == "shot.png").GameId);
    }

    [Fact]
    public void List_is_empty_when_moments_are_disabled()
    {
        _settings.Set("moments.enabled", JsonValue.Create(false));
        Assert.Empty(_media.List(_ => null, []));
    }
}
