using System.Diagnostics;
using Vystral.Core.Files;
using Vystral.Tests.Support;
using Xunit;

namespace Vystral.Tests.TrackD6;

/// <summary>Track D6: the cache viewer can only ever delete inside known cache locations under the data folder.</summary>
public sealed class CacheJanitorTests : IDisposable
{
    private readonly TempDir _root = new();
    private readonly TempDir _outside = new();

    public void Dispose()
    {
        _root.Dispose();
        _outside.Dispose();
    }

    [Fact]
    public void Clears_files_inside_an_allowed_folder_and_keeps_the_folder()
    {
        _root.Write(@"cache\news\730.json", "{\"a\":1}");
        _root.Write(@"cache\news\sub\440.json", "{}");
        var db = _root.Write("vystral.db", "user data");
        var m = CacheJanitor.Measure(_root.Path, @"cache\news");
        Assert.Equal(2, m.Files);
        Assert.Equal(9, m.Bytes);
        Assert.NotNull(m.Newest);

        var (bytes, files, failed) = CacheJanitor.Clear(_root.Path, @"cache\news");
        Assert.Equal((9L, 2, 0), (bytes, files, failed));
        Assert.True(Directory.Exists(Path.Combine(_root.Path, "cache", "news")));
        Assert.Empty(Directory.GetFiles(Path.Combine(_root.Path, "cache", "news"), "*", SearchOption.AllDirectories));
        Assert.True(File.Exists(db));
    }

    [Theory]
    [InlineData(@"..\vystral.db")]
    [InlineData(@"cache\..\vystral.db")]
    [InlineData(@"cache\news\..\..\vystral.db")]
    [InlineData(@"cache")]
    [InlineData(@"cache\art")]                    // mixes user-chosen art: only its own service clears it
    [InlineData(@"cache\wishlist.json")]          // holds the price history VYSTRAL recorded
    [InlineData(@"cache\game-pages\store-facts.json")]
    [InlineData(@"vystral.db")]
    [InlineData(@"backups")]
    [InlineData(@"C:\Windows")]
    [InlineData(@"\\server\share\cache\news")]
    [InlineData(@"cache/news")]                    // not the exact allow-listed spelling
    [InlineData(@"CACHE\NEWS")]
    [InlineData(@"cache\news:stream")]
    [InlineData(@"cache\news\")]
    [InlineData("")]
    [InlineData(" ")]
    public void Refuses_anything_not_on_the_allow_list(string relative)
    {
        _root.Write("vystral.db", "user data");
        _root.Write(@"cache\news\1.json", "{}");
        Assert.Null(CacheJanitor.Resolve(_root.Path, relative));
        Assert.Throws<ArgumentException>(() => CacheJanitor.Clear(_root.Path, relative));
        Assert.True(File.Exists(Path.Combine(_root.Path, "vystral.db")));
    }

    [Theory]
    [InlineData("relative\\root")]
    [InlineData(@"\\server\share\VYSTRAL.Data")]
    [InlineData("")]
    public void Refuses_a_data_folder_that_isnt_a_local_absolute_path(string root) =>
        Assert.Null(CacheJanitor.Resolve(root, @"cache\news"));

    [Fact]
    public void Measure_only_targets_can_be_measured_but_not_cleared()
    {
        _root.Write(@"cache\art\g1\cover-abc.jpg", "12345");
        _root.Write(@"cache\art\_thumbs\news\x.jpg", "1");
        var m = CacheJanitor.Measure(_root.Path, @"cache\art", ["_thumbs"]);
        Assert.Equal((5L, 1), (m.Bytes, m.Files));
        Assert.Throws<ArgumentException>(() => CacheJanitor.Clear(_root.Path, @"cache\art"));
        Assert.True(File.Exists(Path.Combine(_root.Path, @"cache\art\g1\cover-abc.jpg")));
    }

    [Fact]
    public void A_single_file_target_deletes_only_that_file()
    {
        var fp = _root.Write(@"ui-state\first-paint.json", "{}");
        var keep = _root.Write(@"ui-state\whatsnew.json", "{\"seen\":true}");
        var (_, files, _) = CacheJanitor.Clear(_root.Path, @"ui-state\first-paint.json");
        Assert.Equal(1, files);
        Assert.False(File.Exists(fp));
        Assert.True(File.Exists(keep));
    }

    [Fact]
    public void A_missing_cache_is_empty_not_an_error()
    {
        Assert.Equal(CacheMeasure.Empty, CacheJanitor.Measure(_root.Path, @"cache\live"));
        Assert.Equal((0L, 0, 0), CacheJanitor.Clear(_root.Path, @"cache\live"));
    }

    private static bool Junction(string link, string target)
    {
        // Junctions need no special rights (unlike symbolic links).
        var psi = new ProcessStartInfo("cmd.exe", ["/c", "mklink", "/J", link, target]) { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        using var p = Process.Start(psi)!;
        p.WaitForExit(10_000);
        return Directory.Exists(link);
    }

    [Fact]
    public void Never_follows_a_junction_inside_a_cache_to_files_outside()
    {
        var precious = _outside.Write("precious.txt", "user file");
        _root.Write(@"cache\news\1.json", "{}");
        if (!Junction(Path.Combine(_root.Path, @"cache\news\escape"), _outside.Path)) return; // junctions unavailable here
        var (_, files, _) = CacheJanitor.Clear(_root.Path, @"cache\news");
        Assert.Equal(1, files);
        Assert.True(File.Exists(precious));
        Assert.Equal(0, CacheJanitor.Measure(_root.Path, @"cache\news").Files); // the junction is skipped, never counted
        Assert.True(Directory.Exists(Path.Combine(_root.Path, @"cache\news\escape")));
    }

    [Fact]
    public void Refuses_a_cache_folder_that_is_itself_a_junction()
    {
        var precious = _outside.Write("precious.txt", "user file");
        Directory.CreateDirectory(Path.Combine(_root.Path, "cache"));
        if (!Junction(Path.Combine(_root.Path, @"cache\news"), _outside.Path)) return;
        Assert.Null(CacheJanitor.Resolve(_root.Path, @"cache\news"));
        Assert.Throws<ArgumentException>(() => CacheJanitor.Clear(_root.Path, @"cache\news"));
        Assert.True(File.Exists(precious));
    }

    [Fact]
    public void Refuses_when_a_parent_folder_is_a_junction()
    {
        var precious = _outside.Write(@"news\precious.txt", "user file");
        if (!Junction(Path.Combine(_root.Path, "cache"), _outside.Path)) return;
        Assert.Null(CacheJanitor.Resolve(_root.Path, @"cache\news"));
        Assert.True(File.Exists(precious));
    }

    [Fact]
    public void Every_allowed_target_stays_inside_the_data_folder()
    {
        foreach (var t in CacheJanitor.Targets.Concat(CacheJanitor.MeasureOnly))
        {
            var full = CacheJanitor.Resolve(_root.Path, t, measureOnly: true);
            Assert.NotNull(full);
            Assert.StartsWith(_root.Path + Path.DirectorySeparatorChar, full, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("..", t);
        }
    }
}
