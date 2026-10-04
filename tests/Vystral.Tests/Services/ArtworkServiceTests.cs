using System.Text;
using Vystral.Core.Domain;
using Vystral.Tests.Support;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Services;

public sealed class ArtworkServiceTests : IDisposable
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52, 1, 2, 3];
    private static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0];
    private static readonly byte[] Webp = [.. "RIFF"u8, 0x24, 0, 0, 0, .. "WEBPVP8 "u8, 0, 0, 0, 0];

    private readonly TestDb _t = new();
    private readonly AppPaths _paths;
    private readonly ArtworkService _art;
    private readonly HttpClient _http = new();
    private readonly string _gameId;

    public ArtworkServiceTests()
    {
        _paths = new AppPaths(Path.Combine(_t.Dir.Path, "data"));
        _art = new ArtworkService(_paths, _t.Repo, _http);
        _gameId = _t.Repo.AddManualGame("Game", @"C:\Games\g\g.exe", null);
    }

    public void Dispose()
    {
        _http.Dispose();
        _t.Dispose();
    }

    private string Source(string name, byte[] bytes)
    {
        var path = Path.Combine(_t.Dir.Dir("source"), name);
        File.WriteAllBytes(path, bytes);
        return path;
    }

    // ---------- LooksLikeImage ----------

    [Fact]
    public void Recognizes_jpeg_png_and_webp_signatures()
    {
        Assert.True(ArtworkService.LooksLikeImage(Jpeg));
        Assert.True(ArtworkService.LooksLikeImage(Png));
        Assert.True(ArtworkService.LooksLikeImage(Webp));
    }

    [Theory]
    [InlineData("<!DOCTYPE html><html><body>Access denied</body></html>")]
    [InlineData("<html><head></head></html>")]
    [InlineData("{\"error\":\"not found\"}")]
    [InlineData("GIF89a............")]
    [InlineData("MZ..............PE")]
    [InlineData("RIFF....WAVEfmt ....")]
    [InlineData("")]
    public void Rejects_non_images(string content) =>
        Assert.False(ArtworkService.LooksLikeImage(Encoding.ASCII.GetBytes(content)));

    [Fact]
    public void Rejects_buffers_too_short_to_be_images()
    {
        Assert.False(ArtworkService.LooksLikeImage(Png.AsSpan(0, 12)));
        Assert.False(ArtworkService.LooksLikeImage(new byte[] { 0xFF, 0xD8, 0xFF }));
        Assert.False(ArtworkService.LooksLikeImage(ReadOnlySpan<byte>.Empty));
    }

    [Fact]
    public void Rejects_random_bytes()
    {
        var rng = new Random(1234);
        var bytes = new byte[256];
        rng.NextBytes(bytes);
        bytes[0] = 0x00;
        Assert.False(ArtworkService.LooksLikeImage(bytes));
    }

    // ---------- ImportLocal ----------

    [Fact]
    public void ImportLocal_copies_image_into_cache_and_records_artwork()
    {
        var src = Source("library_600x900.png", Png);

        Assert.True(_art.ImportLocal(_gameId, ArtworkKind.Cover, src, "steam-local"));

        var (file, isUser) = _t.Repo.GetArtwork(_gameId)["cover"];
        Assert.False(isUser);
        Assert.StartsWith(_gameId + Path.DirectorySeparatorChar + "cover-", file);
        Assert.EndsWith(".png", file);
        var dest = Path.Combine(_paths.ArtCache, file);
        Assert.Equal(Png, File.ReadAllBytes(dest));
        Assert.False(File.Exists(dest + ".tmp"));
        Assert.True(File.Exists(src)); // source untouched
        Assert.Equal($"https://{ArtworkService.ArtHost}/{file.Replace('\\', '/')}", ArtworkService.Url(_gameId, file));
    }

    [Fact]
    public void ImportLocal_with_user_source_marks_artwork_as_user_chosen()
    {
        Assert.True(_art.ImportLocal(_gameId, ArtworkKind.Hero, Source("mine.jpg", Jpeg), "user"));
        Assert.True(_t.Repo.GetArtwork(_gameId)["hero"].IsUser);

        // Automatic artwork can no longer replace it.
        Assert.True(_art.ImportLocal(_gameId, ArtworkKind.Hero, Source("auto.webp", Webp), "steam-local"));
        Assert.EndsWith(".jpg", _t.Repo.GetArtwork(_gameId)["hero"].File);
    }

    [Fact]
    public void ImportLocal_does_not_recopy_an_unchanged_file()
    {
        var src = Source("cover.jpg", Jpeg);
        Assert.True(_art.ImportLocal(_gameId, ArtworkKind.Cover, src, "steam-local"));
        var file = _t.Repo.GetArtwork(_gameId)["cover"].File;
        var dest = Path.Combine(_paths.ArtCache, file);

        // Tamper with the cached copy: an unchanged source must not be copied again.
        File.WriteAllBytes(dest, [1, 2, 3]);
        Assert.True(_art.ImportLocal(_gameId, ArtworkKind.Cover, src, "steam-local"));
        Assert.Equal(file, _t.Repo.GetArtwork(_gameId)["cover"].File);
        Assert.Equal([1, 2, 3], File.ReadAllBytes(dest));
        Assert.Single(Directory.GetFiles(Path.Combine(_paths.ArtCache, _gameId)));
    }

    [Fact]
    public void ImportLocal_copies_again_when_the_source_changes()
    {
        var src = Source("cover.jpg", Jpeg);
        Assert.True(_art.ImportLocal(_gameId, ArtworkKind.Cover, src, "steam-local"));
        var first = _t.Repo.GetArtwork(_gameId)["cover"].File;

        File.WriteAllBytes(src, [.. Jpeg, 9, 9, 9]);
        File.SetLastWriteTimeUtc(src, DateTime.UtcNow.AddMinutes(1));
        Assert.True(_art.ImportLocal(_gameId, ArtworkKind.Cover, src, "steam-local"));

        var second = _t.Repo.GetArtwork(_gameId)["cover"].File;
        Assert.NotEqual(first, second);
        Assert.Equal([.. Jpeg, 9, 9, 9], File.ReadAllBytes(Path.Combine(_paths.ArtCache, second)));
    }

    [Theory]
    [InlineData("cover.gif")]
    [InlineData("cover.txt")]
    [InlineData("cover.exe")]
    [InlineData("cover.svg")]
    [InlineData("cover")]
    public void ImportLocal_rejects_non_image_extensions_even_with_image_bytes(string name)
    {
        Assert.False(_art.ImportLocal(_gameId, ArtworkKind.Cover, Source(name, Png), "steam-local"));
        Assert.Empty(_t.Repo.GetArtwork(_gameId));
        Assert.False(Directory.Exists(Path.Combine(_paths.ArtCache, _gameId)));
    }

    [Fact]
    public void ImportLocal_rejects_files_whose_content_is_not_an_image()
    {
        var src = Source("cover.png", Encoding.ASCII.GetBytes("<html><body>not really a png</body></html>"));
        Assert.False(_art.ImportLocal(_gameId, ArtworkKind.Cover, src, "steam-local"));
        Assert.Empty(_t.Repo.GetArtwork(_gameId));
        Assert.Empty(Directory.EnumerateFiles(_paths.ArtCache, "*", SearchOption.AllDirectories));
    }

    [Fact]
    public void ImportLocal_rejects_missing_and_empty_files()
    {
        Assert.False(_art.ImportLocal(_gameId, ArtworkKind.Cover, Path.Combine(_t.Dir.Path, "missing.png"), "steam-local"));
        Assert.False(_art.ImportLocal(_gameId, ArtworkKind.Cover, Source("empty.png", []), "steam-local"));
        Assert.Empty(_t.Repo.GetArtwork(_gameId));
    }

    [Fact]
    public void ImportLocal_accepts_uppercase_extensions()
    {
        Assert.True(_art.ImportLocal(_gameId, ArtworkKind.Logo, Source("LOGO.PNG", Png), "steam-local"));
        Assert.EndsWith(".png", _t.Repo.GetArtwork(_gameId)["logo"].File);
    }

    [Fact]
    public void Cache_size_and_cleanup_only_remove_unreferenced_files()
    {
        Assert.True(_art.ImportLocal(_gameId, ArtworkKind.Cover, Source("a.png", Png), "steam-local"));
        Assert.True(_art.ImportLocal(_gameId, ArtworkKind.Hero, Source("b.jpg", Jpeg), "steam-local"));
        var art = _t.Repo.GetArtwork(_gameId);
        Assert.Equal(Png.Length + Jpeg.Length, _art.CacheSizeBytes());

        var freed = _art.ClearUnreferenced([art["cover"].File]);

        Assert.Equal(Jpeg.Length, freed);
        Assert.True(File.Exists(Path.Combine(_paths.ArtCache, art["cover"].File)));
        Assert.False(File.Exists(Path.Combine(_paths.ArtCache, art["hero"].File)));
        Assert.Equal(Png.Length, _art.CacheSizeBytes());
    }
}
