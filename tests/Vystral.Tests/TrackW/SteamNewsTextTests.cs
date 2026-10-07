using System.Diagnostics;
using System.Globalization;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.TrackW;

public sealed class SteamNewsTextTests
{
    private static string Text(IEnumerable<NewsBlock> blocks) => string.Join("\n", blocks.Select(b => string.Concat(b.Spans.Select(s => s.Text))));

    [Fact]
    public void Bbcode_becomes_typed_blocks()
    {
        var blocks = SteamNewsText.Parse("[h2]What's new[/h2][p]Fixed a crash when [b]loading[/b] saves.[/p][list][*]Faster menus[*]New map[/list]" +
                                         "[img src=\"{STEAM_CLAN_IMAGE}/123/abc.png\"][/img][hr][/hr][quote]Thanks, everyone[/quote][code]x = 1;[/code]");
        Assert.Equal(["h", "p", "li", "li", "img", "hr", "quote", "code"], blocks.Select(b => b.Kind));
        Assert.Equal("What's new", Text([blocks[0]]));
        Assert.Equal([new NewsSpan("Fixed a crash when "), new NewsSpan("loading", Bold: true), new NewsSpan(" saves.")], blocks[1].Spans);
        Assert.Equal("Faster menus", Text([blocks[2]]));
        Assert.Equal("https://clan.akamai.steamstatic.com/images/123/abc.png", blocks[4].Image);
        Assert.Equal("Thanks, everyone", Text([blocks[6]]));
        Assert.Equal("x = 1;", Text([blocks[7]]));
    }

    [Fact]
    public void Html_becomes_typed_blocks()
    {
        var blocks = SteamNewsText.Parse("<h1>Big <em>update</em></h1><p>Line one<br>line two</p><ul><li>One</li><li>Two</li></ul><blockquote>Quoted</blockquote><pre>a  b</pre>");
        Assert.Equal(["h", "p", "li", "li", "quote", "code"], blocks.Select(b => b.Kind));
        Assert.Equal([new NewsSpan("Big "), new NewsSpan("update", Italic: true)], blocks[0].Spans);
        Assert.Equal("Line one\nline two", Text([blocks[1]]));
        Assert.Equal("a  b", Text([blocks[5]]));                 // code keeps spacing
    }

    [Fact]
    public void Blank_lines_split_plain_text_into_paragraphs()
    {
        var blocks = SteamNewsText.Parse("First paragraph\nstill first\n\n\n\nSecond   paragraph\r\n\r\nThird");
        Assert.Equal(["First paragraph\nstill first", "Second paragraph", "Third"], blocks.Select(b => Text([b])));
    }

    [Fact]
    public void Hostile_markup_never_survives()
    {
        var blocks = SteamNewsText.Parse(SteamExtrasParsingTests.Fixture("news_hostile.txt") + "\u0007 bell");
        // [code] shows its contents as text on purpose; everything else must be free of markup.
        var code = blocks.Single(b => b.Kind == "code");
        Assert.Equal("<script>alert(12)</script>", Text([code]));
        var all = Text(blocks.Where(b => b.Kind != "code"));
        foreach (var bad in new[] { "alert", "document.cookie", "evil.example", "javascript", "onerror", "onclick", "onmouseover", "display:none", "svg text", "fallback", "dQw4w9WgXcQ", "hidden.png", "<", ">" })
            Assert.DoesNotContain(bad, all, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(Text(blocks), c => char.IsControl(c) && c != '\n');
        Assert.DoesNotContain(Text(blocks), c => char.GetUnicodeCategory(c) == UnicodeCategory.Format);

        Assert.Equal("Update", Text([blocks[0]]));
        Assert.Contains("Click me", all);                         // link text kept, link dropped
        Assert.Contains("Also a link", all);
        Assert.Contains("Hover text", all);
        Assert.Contains("&lt;b&gt;double-encoded&lt;/b&gt;", all); // decoded exactly once
        Assert.Contains("styled", all);
        Assert.Contains("bold", all);
        Assert.Contains("bell", all);

        // Only HTTPS Steam CDN images, on the default port, without credentials, with an image extension.
        Assert.Equal(["https://clan.akamai.steamstatic.com/images/1/ok.png", "https://cdn.akamai.steamstatic.com/steam/apps/620/ss_1.jpg"],
            blocks.Where(b => b.Kind == "img").Select(b => b.Image));
    }

    [Fact]
    public void Escaped_script_is_shown_as_text_never_as_markup()
    {
        var blocks = SteamNewsText.Parse("<p>Hover &lt;script&gt;alert(9)&lt;/script&gt; text</p>");
        Assert.Equal("Hover <script>alert(9)</script> text", Text(blocks)); // React renders this as text
        Assert.Single(blocks);
    }

    [Theory]
    [InlineData("https://clan.akamai.steamstatic.com/images/1/a.png", true)]
    [InlineData("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/header.jpg", true)]
    [InlineData("https://steamcdn-a.akamaihd.net/steam/apps/1/ss.jpeg", true)]
    [InlineData("https://images.steamusercontent.com/ugc/1/a.webp", true)]
    [InlineData("{STEAM_CLAN_IMAGE}/42/b.jpg", true)]
    [InlineData("http://clan.akamai.steamstatic.com/images/1/a.png", false)]
    [InlineData("https://clan.akamai.steamstatic.com/images/1/a.gif", false)]
    [InlineData("https://clan.akamai.steamstatic.com/images/1/a.svg", false)]
    [InlineData("https://steamstatic.com.evil.example/a.png", false)]
    [InlineData("https://evilsteamstatic.com/a.png", false)]
    [InlineData("https://127.0.0.1/a.png", false)]
    [InlineData("https://u:p@clan.akamai.steamstatic.com/a.png", false)]
    [InlineData("https://clan.akamai.steamstatic.com:444/a.png", false)]
    [InlineData("javascript:alert(1)//.png", false)]
    [InlineData("data:image/png;base64,AAAA", false)]
    [InlineData("//clan.akamai.steamstatic.com/a.png", false)]
    public void Image_urls_are_restricted_to_steam_cdns(string url, bool ok) => Assert.Equal(ok, SteamNewsText.SafeImageUrl(url) is not null);

    [Fact]
    public void Sizes_are_capped()
    {
        var many = string.Concat(Enumerable.Range(0, 2000).Select(i => $"[p]Paragraph {i}[/p]"));
        Assert.Equal(SteamNewsText.MaxBlocks, SteamNewsText.Parse(many).Count);

        var long1 = SteamNewsText.Parse(new string('x', 100_000));
        Assert.True(Text(long1).Length <= SteamNewsText.MaxBlockChars);

        var images = string.Concat(Enumerable.Range(0, 50).Select(i => $"[img]https://clan.akamai.steamstatic.com/images/{i}.png[/img]"));
        Assert.Equal(SteamNewsText.MaxImages, SteamNewsText.Parse(images).Count(b => b.Kind == "img"));
    }

    [Theory]
    [InlineData("[img]")]
    [InlineData("<a ")]
    [InlineData("[url=")]
    [InlineData("<!-- ")]
    [InlineData("<script>")]
    [InlineData("[code]")]
    [InlineData("<p")]
    [InlineData("&#")]
    public void Pathological_input_stays_fast(string unit)
    {
        var input = string.Concat(Enumerable.Repeat(unit + "x", SteamNewsText.MaxInput / (unit.Length + 1)));
        var sw = Stopwatch.StartNew();
        _ = SteamNewsText.Parse(input);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(3), $"took {sw.Elapsed}");
    }

    [Fact]
    public void Unbalanced_and_empty_input_is_harmless()
    {
        Assert.Empty(SteamNewsText.Parse(null));
        Assert.Empty(SteamNewsText.Parse(""));
        Assert.Empty(SteamNewsText.Parse("[p][/p][hr][/hr]<p> </p>"));
        Assert.Equal("text", Text(SteamNewsText.Parse("[/b][/list][/quote]</div></p>text[/h1]")));
        Assert.Equal("ok", Text(SteamNewsText.Parse("<script>never closed</script>ok")));
        Assert.Empty(SteamNewsText.Parse("<script>never closed"));
        Assert.Equal("a", Text(SteamNewsText.Parse("a<!-- never closed")));
    }

    [Fact]
    public void Excerpt_is_plain_and_clipped_at_a_word()
    {
        var blocks = SteamNewsText.Parse("[h2]Title[/h2][p]" + string.Join(' ', Enumerable.Repeat("word", 100)) + "[/p]");
        var excerpt = SteamNewsText.Excerpt(blocks, 60);
        Assert.StartsWith("Title word word", excerpt);
        Assert.EndsWith("…", excerpt);
        Assert.True(excerpt.Length <= 61);
        Assert.EndsWith("word…", excerpt); // ends on a whole word
    }
}
