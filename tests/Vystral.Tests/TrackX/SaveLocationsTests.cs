using Vystral.Core.Files;
using Vystral.Tests.Support;
using Vystral.Windows.DataSources;
using Vystral.Windows.Storage;
using Xunit;

namespace Vystral.Tests.TrackX;

public sealed class SaveLocationsTests
{
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "TrackX", name));

    [Fact]
    public void Wikitext_save_templates_are_read_per_platform()
    {
        var list = SaveLocations.ParseWikitext(Fixture("pcgw_wikitext.txt"));
        Assert.Contains(new WikiSaveLocation("windows", @"{{p|userprofile\Documents}}\Saved Games\Lumen Garden"), list);
        Assert.Contains(new WikiSaveLocation("microsoftStore", @"{{P|localappdata}}\Packages\ExampleStudio.LumenGarden_q53c1yqmx7pha\SystemAppData\wgs"), list);
        Assert.Contains(new WikiSaveLocation("steam", @"{{p|steam}}\userdata\{{p|uid}}\1145360\remote"), list);
        // Second path in one template, with a reference and a note removed.
        Assert.Contains(new WikiSaveLocation("windows", @"{{p|appdata}}\Example Studio\Lumen Garden\Profiles"), list);
        // macOS, Linux, config templates and commented-out lines are ignored.
        Assert.DoesNotContain(list, l => l.Raw.Contains("osxhome") || l.Raw.Contains("linuxhome") || l.Raw.Contains("config.ini") || l.Raw.Contains("Commented"));
        Assert.Equal(4, list.Count);
    }

    [Fact]
    public void Hostile_wikitext_is_capped_and_never_throws()
    {
        Assert.Empty(SaveLocations.ParseWikitext(null));
        Assert.Empty(SaveLocations.ParseWikitext("{{Game data/saves|Windows|{{p|appdata}}\\unterminated"));
        var many = string.Concat(Enumerable.Repeat("{{Game data/saves|Windows|{{p|appdata}}\\A|{{p|appdata}}\\B|{{p|appdata}}\\C}}\n", 200));
        var list = SaveLocations.ParseWikitext(many);
        Assert.True(list.Count <= SaveLocations.MaxLocations);
        Assert.Equal(3, list.Count); // duplicates collapse
        var huge = "{{Game data/saves|Windows|" + new string('a', 5000) + "}}";
        Assert.Empty(SaveLocations.ParseWikitext(huge));
        var deep = "{{Game data/saves|Windows|" + string.Concat(Enumerable.Repeat("{{x|", 3000)) + "}}";
        Assert.Empty(SaveLocations.ParseWikitext(deep));
    }

    [Theory]
    [InlineData(@"{{p|appdata}}\Supergiant Games\Hades", "appdata", @"Supergiant Games|Hades", false)]
    [InlineData(@"{{P|LocalAppData}}\Game\Saved\SaveGames", "localappdata", @"Game|Saved|SaveGames", false)]
    [InlineData(@"{{p|userprofile\Documents}}\My Games\Game", "documents", @"My Games|Game", false)]
    [InlineData(@"{{p|userprofile}}\Documents\My Games\Game", "documents", @"My Games|Game", false)]
    [InlineData(@"{{p|userprofile}}\Saved Games\Game", "savedgames", @"Game", false)]
    [InlineData(@"{{p|userprofile\appdata\locallow}}\Studio\Game", "locallow", @"Studio|Game", false)]
    [InlineData(@"%USERPROFILE%\AppData\Roaming\Game", "userprofile", @"AppData|Roaming|Game", false)]
    [InlineData(@"%LOCALAPPDATA%\Game", "localappdata", @"Game", false)]
    [InlineData(@"{{p|steam}}\userdata\{{p|uid}}\620\remote", "steam", @"userdata|*|620|remote", true)]
    [InlineData(@"{{p|game}}\save\<user-id>\*.sav", "game", @"save|*|*.sav", true)]
    [InlineData(@"{{p|programdata}}\Game/Saves/", "programdata", @"Game|Saves", false)]
    public void Safe_paths_expand_to_a_root_and_plain_segments(string raw, string kind, string segments, bool wildcard)
    {
        var p = SaveLocations.Expand(raw);
        Assert.NotNull(p);
        Assert.Equal(kind, p!.Kind);
        Assert.Equal(segments.Split('|'), p.Segments);
        Assert.Equal(wildcard, p.HasWildcard);
    }

    [Theory]
    [InlineData(@"C:\Games\Saves")]                                // literal drive paths
    [InlineData(@"\\server\share\saves")]                          // UNC
    [InlineData(@"{{p|appdata}}\..\..\Windows\System32")]          // traversal
    [InlineData(@"{{p|appdata}}\Game\..")]
    [InlineData(@"{{p|hkcu}}\Software\Game")]                      // registry
    [InlineData(@"{{p|hklm}}\Software\Game")]
    [InlineData(@"{{p|osxhome}}/Library/Game")]                    // other systems
    [InlineData(@"{{p|linuxhome}}/.local/share/Game")]
    [InlineData(@"%WINDIR%\System32")]                             // unknown environment variables
    [InlineData(@"%APPDATA%\%TEMP%\x")]
    [InlineData(@"{{p|appdata}}\Game:stream")]                     // alternate data streams, reserved characters
    [InlineData(@"{{p|appdata}}\Ga""me")]
    [InlineData(@"{{p|appdata}}\Game|x")]
    [InlineData(@"{{p|appdata}}\Game?")]
    [InlineData(@"{{p|appdata}}\{{p|game}}")]                      // a second root token
    [InlineData(@"{{p|appdata}}\{{unknown}}")]
    [InlineData("{{p|appdata}}\\Game\u0000x")]                    // control characters
    [InlineData("relative\\path")]
    [InlineData("")]
    public void Hostile_or_unsupported_paths_are_refused(string raw) => Assert.Null(SaveLocations.Expand(raw));

    [Fact]
    public void Very_long_paths_are_refused() =>
        Assert.Null(SaveLocations.Expand("{{p|appdata}}\\" + string.Join("\\", Enumerable.Repeat("a", 40))));

    [Theory]
    [InlineData("*", "anything", true)]
    [InlineData("*.sav", "slot1.SAV", true)]
    [InlineData("*.sav", "slot1.sav.bak", false)]
    [InlineData("Profile*", "Profile2", true)]
    [InlineData("Profile*", "MyProfile", false)]
    [InlineData("a*c", "abc", true)]
    public void Wildcards_match_one_name(string pattern, string name, bool ok) => Assert.Equal(ok, SaveLocations.Matches(pattern, name));

    [Fact]
    public void Resolve_stays_under_the_root_and_caps_wildcards()
    {
        using var dir = new TempDir();
        var root = dir.Dir("appdata");
        dir.Dir(Path.Combine("appdata", "Game", "Saves", "111"));
        dir.Dir(Path.Combine("appdata", "Game", "Saves", "222"));
        dir.Write(Path.Combine("appdata", "Game", "Saves", "222", "slot.sav"), "x");
        dir.Write(Path.Combine("outside", "secret.sav"), "x");

        var hits = SaveLocator.Resolve(root, ["Game", "Saves", "*", "*.sav"]).ToList();
        Assert.Equal([Path.Combine(root, "Game", "Saves", "222", "slot.sav")], hits);
        Assert.Equal(2, SaveLocator.Resolve(root, ["Game", "Saves", "*"]).Count());
        Assert.Empty(SaveLocator.Resolve(root, ["Missing"]));
        // Even if a ".." slipped through, the result can't leave the root.
        Assert.Empty(SaveLocator.Resolve(root, ["..", "outside"]));
    }

    [Fact]
    public void Locator_checks_existence_and_sizes_from_a_cached_answer()
    {
        using var dir = new TempDir();
        var appdata = dir.Dir("appdata");
        dir.Write(Path.Combine("appdata", "Supergiant Games", "Hades", "Profile1.sav"), "12345");
        var game = dir.Dir("game");
        var locator = new SaveLocator(Path.Combine(dir.Path, "cache")) { KnownFolder = k => k == "appdata" ? appdata : null };
        var entry = new SaveLocator.CacheEntry("Hades",
        [
            new("windows", @"{{p|appdata}}\Supergiant Games\Hades"),
            new("windows", @"{{p|documents}}\Nope"),
            new("windows", @"{{p|hkcu}}\Software\Hades"),
            new("windows", @"{{p|game}}\Saves"),
        ], DateTimeOffset.UtcNow.ToString("O"));
        var list = locator.Check("0123456789abcdef0123456789abcdef", entry, [game], null, null);

        var found = list[0];
        Assert.True(found.Exists);
        Assert.Equal(5, found.Bytes);
        Assert.Equal(1, found.Files);
        Assert.Equal(Path.Combine(appdata, "Supergiant Games", "Hades"), locator.FolderFor("0123456789abcdef0123456789abcdef", found.Id));
        Assert.Contains(list, l => l.Problem == "unsupported" && l.Raw.Contains("hkcu"));
        Assert.Contains(list, l => !l.Exists && l.Path == Path.Combine(game, "Saves"));
        Assert.Null(locator.FolderFor("0123456789abcdef0123456789abcdef", "s99"));
    }

    // ---------- PCGamingWiki answers ----------

    [Fact]
    public void Cargo_answers_name_one_article_or_are_denied()
    {
        Assert.Equal(("Portal 2", false), PcGamingWikiClient.ParseCargo("""{"cargoquery":[{"title":{"Page":"Portal 2"}}]}"""));
        Assert.Equal((null, false), PcGamingWikiClient.ParseCargo("""{"cargoquery":[{"title":{"Page":"A"}},{"title":{"Page":"B"}}]}"""));
        Assert.Equal((null, false), PcGamingWikiClient.ParseCargo("""{"cargoquery":[]}"""));
        Assert.Equal((null, true), PcGamingWikiClient.ParseCargo("""{"error":{"code":"permissiondenied","info":"no"}}"""));
        Assert.Equal((null, false), PcGamingWikiClient.ParseCargo("""{"cargoquery":[{"title":{"Page":"Evil|{{x}}"}}]}"""));
    }

    [Theory]
    [InlineData("https://www.pcgamingwiki.com/wiki/Portal_2", "Portal 2")]
    [InlineData("https://www.pcgamingwiki.com/wiki/Hades_II", "Hades II")]
    [InlineData("https://www.pcgamingwiki.com/wiki/S.T.A.L.K.E.R.%3A_Shadow_of_Chernobyl", "S.T.A.L.K.E.R.: Shadow of Chernobyl")]
    [InlineData("https://www.pcgamingwiki.com/wiki/File:Cover.png", null)]
    [InlineData("/wiki/Portal_2", "Portal 2")]
    [InlineData("https://evil.example/wiki/Portal_2", null)]
    [InlineData("http://www.pcgamingwiki.com/wiki/Portal_2", null)]
    [InlineData("https://www.pcgamingwiki.com/wiki/Special:Search", null)]
    [InlineData("https://www.pcgamingwiki.com/w/index.php?title=Portal_2", null)]
    [InlineData("https://www.pcgamingwiki.com:8443/wiki/Portal_2", null)]
    public void Redirects_are_read_only_from_the_wiki_itself(string location, string? title) =>
        Assert.Equal(title, PcGamingWikiClient.TitleFromRedirect(new Uri(location, UriKind.RelativeOrAbsolute)));

    [Fact]
    public void Parse_answers_give_the_title_and_wikitext()
    {
        var r = PcGamingWikiClient.ParseWikitext("""{"parse":{"title":"Hades","pageid":1,"wikitext":"{{Game data/saves|Windows|{{p|appdata}}\\Hades}}"}}""");
        Assert.Equal("Hades", r!.Value.Title);
        Assert.Single(SaveLocations.ParseWikitext(r.Value.Wikitext));
        Assert.Null(PcGamingWikiClient.ParseWikitext("""{"error":{"code":"missingtitle"}}"""));
        Assert.Equal("https://www.pcgamingwiki.com/wiki/Portal_2", PcGamingWikiClient.ArticleUrl("Portal 2").AbsoluteUri);
    }
}
