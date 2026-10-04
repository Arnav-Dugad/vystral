using System.Text;
using Vystral.Core.Parsing;
using Vystral.Tests.Support;
using Xunit;

namespace Vystral.Tests.Core;

public sealed class VdfTests
{
    [Fact]
    public void Parses_nested_objects_and_follows_paths()
    {
        var root = Vdf.Parse("""
            "Root"
            {
                "Child"
                {
                    "Leaf"    "value"
                    "Number"  "1234567890123"
                }
                "Sibling" "x"
            }
            """);

        Assert.True(root.IsObject);
        Assert.Equal("value", root.Path("Root", "Child", "Leaf")?.Value);
        Assert.Equal(1234567890123L, root.Path("Root", "Child")!.GetLong("Number"));
        Assert.Equal("x", root["Root"]!.GetString("Sibling"));
        Assert.Null(root.Path("Root", "Missing", "Leaf"));
        Assert.True(root.Path("Root", "Child")!.IsObject);
        Assert.False(root.Path("Root", "Sibling")!.IsObject);
    }

    [Fact]
    public void GetLong_returns_null_for_non_numeric_or_missing_values()
    {
        var root = Vdf.Parse("\"a\" \"abc\" \"b\" \"\"");
        Assert.Null(root.GetLong("a"));
        Assert.Null(root.GetLong("b"));
        Assert.Null(root.GetLong("missing"));
    }

    [Fact]
    public void Decodes_escape_sequences_in_quoted_strings()
    {
        var root = Vdf.Parse("""
            "path"   "C:\\Program Files (x86)\\Steam"
            "quote"  "say \"hi\""
            "lines"  "a\nb"
            "tab"    "a\tb"
            "other"  "\q"
            """);

        Assert.Equal(@"C:\Program Files (x86)\Steam", root.GetString("path"));
        Assert.Equal("say \"hi\"", root.GetString("quote"));
        Assert.Equal("a\nb", root.GetString("lines"));
        Assert.Equal("a\tb", root.GetString("tab"));
        Assert.Equal("q", root.GetString("other"));
    }

    [Fact]
    public void Skips_line_comments_but_not_slashes_inside_strings()
    {
        var root = Vdf.Parse("""
            // header comment
            "Root" // trailing comment
            {
                // "Hidden" "nope"
                "url" "http://example.com/a//b"
            }
            // final comment without newline
            """);

        Assert.Null(root["Root"]!["Hidden"]);
        Assert.Equal("http://example.com/a//b", root.Path("Root", "url")?.Value);
    }

    [Fact]
    public void Skips_platform_conditionals_after_values_and_objects()
    {
        var root = Vdf.Parse("""
            "Root"
            {
                "win"   "1"   [$WIN32]
                "osx"   "2"   [$OSX]
                "obj"
                {
                    "k" "v"
                } [$WINDOWS]
                "after" "3"
            }
            """);

        var r = root["Root"]!;
        Assert.Equal("1", r.GetString("win"));
        Assert.Equal("2", r.GetString("osx"));
        Assert.Equal("v", r.Path("obj", "k")?.Value);
        Assert.Equal("3", r.GetString("after"));
        Assert.Equal(["win", "osx", "obj", "after"], r.Children.Select(c => c.Key).ToArray());
    }

    [Fact]
    public void Duplicate_keys_first_wins_for_lookup_and_all_are_kept_in_order()
    {
        var root = Vdf.Parse("""
            "apps"
            {
                "dup" "first"
                "other" "x"
                "DUP" "second"
                "dup" "third"
            }
            """);

        var apps = root["apps"]!;
        Assert.Equal("first", apps.GetString("dup"));
        Assert.Equal(
            [("dup", "first"), ("other", "x"), ("DUP", "second"), ("dup", "third")],
            apps.Children.Select(c => (c.Key, c.Value.Value!)).ToArray());
    }

    [Fact]
    public void Keys_are_case_insensitive()
    {
        var root = Vdf.Parse("\"AppState\" { \"InstallDir\" \"Game\" }");
        Assert.Equal("Game", root.Path("appstate", "INSTALLDIR")?.Value);
        Assert.Equal("Game", root["APPSTATE"]!.GetString("installdir"));
    }

    [Fact]
    public void Accepts_unquoted_tokens()
    {
        var root = Vdf.Parse("Root { key value number 42 }");
        Assert.Equal("value", root.Path("Root", "key")?.Value);
        Assert.Equal(42, root["Root"]!.GetLong("number"));
    }

    [Fact]
    public void Empty_and_whitespace_input_yield_an_empty_root()
    {
        Assert.Empty(Vdf.Parse("").Children);
        Assert.Empty(Vdf.Parse("  \r\n\t // only a comment\r\n").Children);
    }

    [Fact]
    public void Empty_object_and_empty_string_values_are_preserved()
    {
        var root = Vdf.Parse("\"a\" {} \"b\" \"\"");
        Assert.True(root["a"]!.IsObject);
        Assert.Empty(root["a"]!.Children);
        Assert.Equal("", root.GetString("b"));
    }

    [Fact]
    public void Handles_crlf_line_endings()
    {
        var root = Vdf.Parse("\"Root\"\r\n{\r\n\t\"k\"\t\t\"v\"\t[$WIN32]\r\n\t\"k2\"\t\"v2\"\r\n}\r\n");
        Assert.Equal("v", root.Path("Root", "k")?.Value);
        Assert.Equal("v2", root.Path("Root", "k2")?.Value);
    }

    [Theory]
    [InlineData("\"Root\" { \"k\" \"unterminated }")]
    [InlineData("\"unterminated")]
    [InlineData("\"k\" \"v\\")]
    public void Unterminated_string_throws_FormatException(string text) =>
        Assert.Throws<FormatException>(() => Vdf.Parse(text));

    [Theory]
    [InlineData("\"Root\" {")]
    [InlineData("\"Root\" { \"k\" \"v\"")]
    [InlineData("\"Root\" { \"Inner\" { \"k\" \"v\" }")]
    public void Unterminated_brace_throws_FormatException(string text) =>
        Assert.Throws<FormatException>(() => Vdf.Parse(text));

    [Theory]
    [InlineData("}")]
    [InlineData("\"k\" \"v\" }")]
    public void Stray_closing_brace_at_top_level_throws(string text) =>
        Assert.Throws<FormatException>(() => Vdf.Parse(text));

    [Fact]
    public void Key_without_value_throws()
    {
        Assert.Throws<FormatException>(() => Vdf.Parse("\"lonely\""));
        Assert.Throws<FormatException>(() => Vdf.Parse("\"Root\" { \"k\" }"));
    }

    [Fact]
    public void Brace_where_key_expected_throws()
    {
        Assert.Throws<FormatException>(() => Vdf.Parse("{ \"k\" \"v\" }"));
    }

    private static string Nested(int depth)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < depth; i++) sb.Append("\"n").Append(i).Append("\" { ");
        sb.Append("\"leaf\" \"ok\" ");
        for (var i = 0; i < depth; i++) sb.Append("} ");
        return sb.ToString();
    }

    [Fact]
    public void Nesting_up_to_MaxDepth_is_accepted()
    {
        var root = Vdf.Parse(Nested(Vdf.MaxDepth));
        var node = root;
        for (var i = 0; i < Vdf.MaxDepth; i++) node = node[$"n{i}"]!;
        Assert.Equal("ok", node.GetString("leaf"));
    }

    [Fact]
    public void Nesting_beyond_MaxDepth_throws_instead_of_overflowing_the_stack()
    {
        Assert.Throws<FormatException>(() => Vdf.Parse(Nested(Vdf.MaxDepth + 1)));
        Assert.Throws<FormatException>(() => Vdf.Parse(Nested(10_000)));
    }

    [Fact]
    public void Leading_byte_order_mark_is_ignored_in_text()
    {
        var root = Vdf.Parse("\uFEFF\"Root\" { \"k\" \"v\" }");
        Assert.Equal("v", root.Path("Root", "k")?.Value);
        Assert.Equal(["Root"], root.Children.Select(c => c.Key).ToArray());
    }

    [Fact]
    public void ParseFile_reads_utf8_with_bom_and_non_ascii_values()
    {
        using var tmp = new TempDir();
        var path = Path.Combine(tmp.Path, "test.vdf");
        File.WriteAllText(path, "\"AppState\" { \"name\" \"Pokémon™ Ünïcode\" }", new UTF8Encoding(encoderShouldEmitUTF8Identifier: true));

        var root = Vdf.ParseFile(path);
        Assert.Equal("Pokémon™ Ünïcode", root.Path("AppState", "name")?.Value);
    }

    [Fact]
    public void Parses_real_shaped_libraryfolders_vdf()
    {
        var root = Vdf.Parse("""
            "libraryfolders"
            {
            	"0"
            	{
            		"path"		"C:\\Program Files (x86)\\Steam"
            		"label"		""
            		"contentid"		"6587345893485797"
            		"totalsize"		"0"
            		"update_clean_bytes_tally"		"79652431"
            		"time_last_update_verified"		"1700000000"
            		"apps"
            		{
            			"228980"		"235467210"
            			"1145360"		"15461272924"
            		}
            	}
            	"1"
            	{
            		"path"		"D:\\SteamLibrary"
            		"label"		"Games SSD"
            		"contentid"		"123"
            		"totalsize"		"1000204886016"
            		"apps"
            		{
            			"1091500"		"70122324565"
            		}
            	}
            }
            """);

        var folders = root["libraryfolders"]!.Children.ToList();
        Assert.Equal(2, folders.Count);
        Assert.Equal(@"C:\Program Files (x86)\Steam", folders[0].Value.GetString("path"));
        Assert.Equal(@"D:\SteamLibrary", folders[1].Value.GetString("path"));
        Assert.Equal("Games SSD", folders[1].Value.GetString("label"));
        Assert.Equal(["228980", "1145360"], folders[0].Value["apps"]!.Children.Select(c => c.Key).ToArray());
        Assert.Equal(70122324565L, folders[1].Value["apps"]!.GetLong("1091500"));
    }

    [Fact]
    public void Parses_real_shaped_appmanifest_acf()
    {
        var root = Vdf.Parse("""
            "AppState"
            {
            	"appid"		"1145360"
            	"universe"		"1"
            	"LauncherPath"		"C:\\Program Files (x86)\\Steam\\steam.exe"
            	"name"		"Hades"
            	"StateFlags"		"4"
            	"installdir"		"Hades"
            	"LastUpdated"		"1700000000"
            	"LastPlayed"		"1710000000"
            	"SizeOnDisk"		"15461272924"
            	"buildid"		"9876543"
            	"InstalledDepots"
            	{
            		"1145361"
            		{
            			"manifest"		"1234567890"
            			"size"		"15461272924"
            		}
            	}
            	"UserConfig"
            	{
            		"language"		"english"
            	}
            	"MountedConfig"
            	{
            		"language"		"english"
            	}
            }
            """);

        var app = root["AppState"]!;
        Assert.Equal("1145360", app.GetString("appid"));
        Assert.Equal("Hades", app.GetString("name"));
        Assert.Equal(4, app.GetLong("StateFlags"));
        Assert.Equal(15461272924L, app.GetLong("SizeOnDisk"));
        Assert.Equal(@"C:\Program Files (x86)\Steam\steam.exe", app.GetString("LauncherPath"));
        Assert.Equal("1234567890", app.Path("InstalledDepots", "1145361", "manifest")?.Value);
        Assert.Equal("english", app.Path("UserConfig", "language")?.Value);
    }
}
