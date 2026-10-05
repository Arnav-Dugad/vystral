using System.Xml.Linq;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Shell;

/// <summary>In-memory HKCU\Software\Classes. Keys are case-insensitive like the real registry.</summary>
internal sealed class FakeClassesRegistry : IUserClassesRegistry
{
    public readonly Dictionary<string, Dictionary<string, string>> Keys = new(StringComparer.OrdinalIgnoreCase);
    public int Writes;

    public string? GetString(string subKey, string? name) =>
        Keys.TryGetValue(subKey, out var values) && values.TryGetValue(name ?? "", out var v) ? v : null;

    public void SetString(string subKey, string? name, string value)
    {
        if (!Keys.TryGetValue(subKey, out var values)) Keys[subKey] = values = new(StringComparer.OrdinalIgnoreCase);
        values[name ?? ""] = value;
        Writes++;
    }

    public void DeleteTree(string subKey)
    {
        foreach (var k in Keys.Keys.Where(k => k.Equals(subKey, StringComparison.OrdinalIgnoreCase) || k.StartsWith(subKey + "\\", StringComparison.OrdinalIgnoreCase)).ToList())
            Keys.Remove(k);
    }
}

public class ShellRegistrationTests
{
    private const string Exe = @"C:\Users\me\AppData\Local\Vystral\current\Vystral.exe";
    private const string Icon = @"C:\Users\me\AppData\Local\Vystral\current\Assets\vystral-256.png";

    private static ShellRegistration Make(FakeClassesRegistry reg, string exe = Exe, string aumid = "velopack.Vystral") =>
        new(reg, exe, aumid, "VYSTRAL", Icon);

    [Fact]
    public void Registers_the_uri_scheme_and_aumid_per_user()
    {
        var reg = new FakeClassesRegistry();
        Make(reg).EnsureRegistered();

        Assert.Equal("URL:VYSTRAL", reg.GetString("vystral", null));
        Assert.Equal("", reg.GetString("vystral", "URL Protocol"));
        Assert.Equal($"\"{Exe}\",0", reg.GetString(@"vystral\DefaultIcon", null));
        Assert.Equal($"\"{Exe}\" --uri \"%1\"", reg.GetString(@"vystral\shell\open\command", null));
        Assert.Equal("VYSTRAL", reg.GetString(@"AppUserModelId\velopack.Vystral", "DisplayName"));
        Assert.Equal(Icon, reg.GetString(@"AppUserModelId\velopack.Vystral", "IconUri"));
        // Nothing else: no COM server, no machine-wide keys.
        Assert.Equal(4, reg.Keys.Count);
    }

    [Fact]
    public void Command_puts_the_switch_first_so_a_uri_can_never_become_a_velopack_hook_argument()
    {
        var command = Make(new FakeClassesRegistry()).Command;
        Assert.StartsWith($"\"{Exe}\" --uri ", command);
        Assert.EndsWith("\"%1\"", command);
    }

    [Fact]
    public void Rewrites_only_what_changed()
    {
        var reg = new FakeClassesRegistry();
        Assert.Equal(6, Make(reg).EnsureRegistered());
        Assert.Equal(0, Make(reg).EnsureRegistered());
        Assert.Equal(6, reg.Writes);

        // The install folder moved (portable copy, dev build): the paths are repaired.
        const string moved = @"D:\Games\VYSTRAL\Vystral.exe";
        Assert.Equal(2, Make(reg, moved).EnsureRegistered());
        Assert.Equal($"\"{moved}\" --uri \"%1\"", reg.GetString(@"vystral\shell\open\command", null));
    }

    [Fact]
    public void Unregister_removes_its_keys()
    {
        var reg = new FakeClassesRegistry();
        Make(reg).EnsureRegistered();
        reg.SetString("unrelated", null, "keep");
        Make(reg).Unregister();
        Assert.Null(reg.GetString(@"vystral\shell\open\command", null));
        Assert.Null(reg.GetString("vystral", null));
        Assert.Null(reg.GetString(@"AppUserModelId\velopack.Vystral", "DisplayName"));
        Assert.Equal("keep", reg.GetString("unrelated", null));
    }

    [Fact]
    public void Unregister_leaves_the_scheme_to_another_copy_that_owns_it()
    {
        var reg = new FakeClassesRegistry();
        Make(reg, @"D:\Other\Vystral.exe").EnsureRegistered();
        Make(reg).Unregister();
        Assert.Equal("\"D:\\Other\\Vystral.exe\" --uri \"%1\"", reg.GetString(@"vystral\shell\open\command", null));
    }

    [Theory]
    [InlineData("Vystral.exe")]                              // relative
    [InlineData(@"\\server\share\Vystral.exe")]              // UNC
    [InlineData("C:\\a\"b\\Vystral.exe")]                    // quote would break the command
    [InlineData(@"C:\%TEMP%\Vystral.exe")]                   // env expansion
    public void Refuses_unsafe_executable_paths(string exe)
    {
        var reg = new FakeClassesRegistry();
        Assert.Throws<ArgumentException>(() => Make(reg, exe).EnsureRegistered());
        Assert.Empty(reg.Keys);
    }

    [Theory]
    [InlineData("")]
    [InlineData(@"..\..\CLSID")]
    [InlineData("a b")]
    [InlineData("velopack.Vystral\\x")]
    public void Refuses_bad_aumids(string aumid) =>
        Assert.Throws<ArgumentException>(() => Make(new FakeClassesRegistry(), aumid: aumid).EnsureRegistered());
}

public class ToastXmlTests
{
    [Fact]
    public void Builds_a_protocol_activated_toast()
    {
        var xml = XElement.Parse(ToastXml.Build("Played Nebula Drift · 1h 02m", "Session saved to your journal.", "vystral://open?route=journal"));
        Assert.Equal("protocol", xml.Attribute("activationType")!.Value);
        Assert.Equal("vystral://open?route=journal", xml.Attribute("launch")!.Value);
        var texts = xml.Descendants("text").Select(t => t.Value).ToArray();
        Assert.Equal(["Played Nebula Drift · 1h 02m", "Session saved to your journal."], texts);
    }

    [Fact]
    public void Escapes_markup_in_titles()
    {
        var raw = ToastXml.Build("<b>Evil</b>\" & <image src=\"x\"/>", "a&b", "vystral://open?route=game&id=0123456789abcdef0123456789abcdef");
        var xml = XElement.Parse(raw);
        Assert.Empty(xml.Descendants("image"));
        Assert.Equal("<b>Evil</b>\" & <image src=\"x\"/>", xml.Descendants("text").First().Value);
        Assert.Contains("&amp;id=", raw);
    }

    [Fact]
    public void Without_a_link_the_toast_has_no_activation()
    {
        var xml = XElement.Parse(ToastXml.Build("t", "b", null));
        Assert.Null(xml.Attribute("activationType"));
        Assert.Null(xml.Attribute("launch"));
    }

    [Fact]
    public void Strips_control_characters_and_lone_surrogates_and_trims()
    {
        Assert.Equal("ab", ToastXml.Clean("a\u0000\u0007b\uD800", 10));
        Assert.Equal("😀", ToastXml.Clean("😀", 10));
        var long1 = ToastXml.Clean(new string('x', 300), ToastXml.MaxTitle);
        Assert.Equal(ToastXml.MaxTitle, long1.Length);
        Assert.EndsWith("…", long1);
        // Never splits a surrogate pair.
        var emoji = ToastXml.Clean(string.Concat(Enumerable.Repeat("😀", 100)), 11);
        Assert.False(char.IsHighSurrogate(emoji[^2]));
        _ = XElement.Parse(ToastXml.Build(emoji, "\uDFFF", null)); // still valid XML
    }
}
