using Vystral.Core.Domain;
using Vystral.Tests.Support;
using Vystral.Windows.Launch;
using Xunit;

namespace Vystral.Tests.Services;

public sealed class LaunchValidatorTests : IDisposable
{
    private readonly TempDir _tmp = new();

    public void Dispose() => _tmp.Dispose();

    private static Installation Inst(PlatformId platform, LaunchKind kind, string value, string? installPath = null, string? workDir = null) => new()
    {
        Id = "i",
        GameId = "g",
        Platform = platform,
        PlatformGameId = "p",
        Title = "T",
        State = InstallState.Installed,
        InstallPath = installPath,
        Launch = new LaunchTarget(kind, value, null, workDir),
    };

    private static ValidationResult Uri(PlatformId platform, string value, string? userArgs = null) =>
        LaunchValidator.Validate(Inst(platform, LaunchKind.Uri, value), userArgs);

    // ---------- URI ----------

    [Theory]
    [InlineData(PlatformId.Steam, "steam://rungameid/1145360")]
    [InlineData(PlatformId.Steam, "STEAM://rungameid/1")]
    [InlineData(PlatformId.Epic, "com.epicgames.launcher://apps/Fortnite?action=launch&silent=true")]
    [InlineData(PlatformId.Ea, "origin2://game/launch?offerIds=OFB-EAST:109552677")]
    [InlineData(PlatformId.Ea, "link2ea://launchgame/1234")]
    [InlineData(PlatformId.Ubisoft, "uplay://launch/635/0")]
    [InlineData(PlatformId.Gog, "goggalaxy://openGameView/1207664663")]
    [InlineData(PlatformId.BattleNet, "battlenet://Pro")]
    public void Allowed_scheme_for_platform_is_valid(PlatformId platform, string value)
    {
        var r = Uri(platform, value);
        Assert.True(r.Ok, r.Problem);
        Assert.Null(r.Problem);
    }

    [Theory]
    [InlineData(PlatformId.Epic, "steam://rungameid/1")]
    [InlineData(PlatformId.Steam, "com.epicgames.launcher://apps/x")]
    [InlineData(PlatformId.Gog, "uplay://launch/1")]
    [InlineData(PlatformId.Xbox, "steam://rungameid/1")]
    [InlineData(PlatformId.Manual, "steam://rungameid/1")]
    public void Scheme_of_another_platform_is_rejected(PlatformId platform, string value)
    {
        var r = Uri(platform, value);
        Assert.False(r.Ok);
        Assert.Contains(platform.DisplayName(), r.Problem);
    }

    [Theory]
    [InlineData("javascript:alert(1)")]
    [InlineData("file:///C:/Windows/System32/calc.exe")]
    [InlineData("http://evil.example/steam")]
    [InlineData("https://store.steampowered.com/app/1")]
    [InlineData("ms-settings:privacy")]
    [InlineData("steam2://rungameid/1")]
    [InlineData("C:/Windows/System32/cmd.exe")]
    public void Dangerous_or_foreign_schemes_are_rejected_for_steam(string value) =>
        Assert.False(Uri(PlatformId.Steam, value).Ok);

    [Theory]
    [InlineData("steam://rungameid/1 -console")]
    [InlineData("steam://rungameid/1\t")]
    [InlineData(" steam://rungameid/1")]
    [InlineData("steam://rungameid/1\n")]
    [InlineData("steam://rungameid/1\0")]
    [InlineData("steam://run\u0007gameid/1")]
    public void Whitespace_and_control_characters_are_rejected(string value)
    {
        var r = Uri(PlatformId.Steam, value);
        Assert.False(r.Ok);
        Assert.Equal("The store launch link is malformed.", r.Problem);
    }

    [Theory]
    [InlineData("")]
    [InlineData("rungameid/1")]
    [InlineData("://nothing")]
    public void Malformed_uri_is_rejected(string value) => Assert.False(Uri(PlatformId.Steam, value).Ok);

    [Fact]
    public void Overlong_uri_is_rejected()
    {
        Assert.True(Uri(PlatformId.Steam, "steam://rungameid/" + new string('1', 2048 - 18)).Ok);
        Assert.False(Uri(PlatformId.Steam, "steam://rungameid/" + new string('1', 2048)).Ok);
    }

    // ---------- Packaged apps ----------

    [Theory]
    [InlineData("Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App")]
    [InlineData("Microsoft.624F8B84B80_8wekyb3d8bbwe!Forzahorizon5")]
    [InlineData("abc_0123456789abc!A")]
    [InlineData("Some-Publisher.Game_abcdefghijklm!App-1.2")]
    public void Valid_aumid_is_accepted(string aumid) =>
        Assert.True(LaunchValidator.Validate(Inst(PlatformId.Xbox, LaunchKind.PackagedApp, aumid), null).Ok);

    [Theory]
    [InlineData("notanaumid")]
    [InlineData("Microsoft.GamingApp_8wekyb3d8bbwe")]
    [InlineData("Microsoft.GamingApp_8wekyb3d8bbwe!")]
    [InlineData("Microsoft.GamingApp_8WEKYB3D8BBWE!App")]
    [InlineData("Microsoft.GamingApp_8wekyb3d8bbw!App")]
    [InlineData("Microsoft.GamingApp_8wekyb3d8bbwe!App;calc")]
    [InlineData("Microsoft.GamingApp_8wekyb3d8bbwe!App calc")]
    [InlineData("Microsoft.GamingApp_8wekyb3d8bbwe!1App")]
    [InlineData("ab_8wekyb3d8bbwe!App")]
    [InlineData("..\\..\\cmd_8wekyb3d8bbwe!App")]
    [InlineData("C:\\Windows\\System32\\cmd.exe")]
    [InlineData("Microsoft.GamingApp_8wekyb3d8bbwe!App\n")]
    public void Invalid_aumid_is_rejected(string aumid)
    {
        var r = LaunchValidator.Validate(Inst(PlatformId.Xbox, LaunchKind.PackagedApp, aumid), null);
        Assert.False(r.Ok);
        Assert.Contains("malformed", r.Problem);
    }

    [Fact]
    public void Unknown_launch_kind_is_rejected()
    {
        var r = LaunchValidator.Validate(Inst(PlatformId.Steam, (LaunchKind)42, "steam://rungameid/1"), null);
        Assert.Equal(ValidationResult.Fail("Unknown launch type."), r);
    }

    // ---------- Executables ----------

    private string MakeExe(string relative) => _tmp.Write(relative, "MZ");

    private ValidationResult Exe(PlatformId platform, string exe, string? installPath = null, string? workDir = null, string? userArgs = null) =>
        LaunchValidator.Validate(Inst(platform, LaunchKind.Executable, exe, installPath, workDir), userArgs);

    [Fact]
    public void Executable_inside_install_folder_is_valid()
    {
        var install = _tmp.Dir("Game");
        var exe = MakeExe(@"Game\bin\game.exe");
        Assert.True(Exe(PlatformId.Steam, exe, install).Ok);
        Assert.True(Exe(PlatformId.Gog, exe, install + "\\").Ok);
    }

    [Fact]
    public void Executable_extension_check_is_case_insensitive()
    {
        var exe = MakeExe(@"Game\GAME.EXE");
        Assert.True(Exe(PlatformId.Manual, exe).Ok);
    }

    [Theory]
    [InlineData("game.exe")]
    [InlineData(@"Games\game.exe")]
    [InlineData(@"..\game.exe")]
    [InlineData(@"C:game.exe")]
    [InlineData(@"\Windows\notepad.exe")]
    public void Relative_path_is_rejected(string path)
    {
        var r = Exe(PlatformId.Manual, path);
        Assert.False(r.Ok);
        Assert.Contains("not a full path", r.Problem);
    }

    [Theory]
    [InlineData(@"\\server\share\game.exe")]
    [InlineData(@"\\?\UNC\server\share\game.exe")]
    [InlineData(@"\\127.0.0.1\c$\game.exe")]
    public void Network_path_is_rejected(string path)
    {
        var r = Exe(PlatformId.Manual, path);
        Assert.False(r.Ok);
        Assert.Contains("network", r.Problem);
    }

    [Theory]
    [InlineData("game.bat")]
    [InlineData("game.cmd")]
    [InlineData("game.lnk")]
    [InlineData("game.ps1")]
    [InlineData("game.exe.txt")]
    [InlineData("game")]
    public void Non_exe_is_rejected(string name)
    {
        var file = _tmp.Write(Path.Combine("Game", name), "x");
        var r = Exe(PlatformId.Manual, file);
        Assert.False(r.Ok);
        Assert.Equal("Only .exe programs can be launched.", r.Problem);
    }

    [Fact]
    public void Missing_file_is_rejected()
    {
        var r = Exe(PlatformId.Manual, Path.Combine(_tmp.Path, "nope", "game.exe"));
        Assert.False(r.Ok);
        Assert.Contains("wasn't found", r.Problem);
    }

    [Theory]
    [InlineData(PlatformId.Steam)]
    [InlineData(PlatformId.Epic)]
    [InlineData(PlatformId.Gog)]
    [InlineData(PlatformId.Ea)]
    [InlineData(PlatformId.Ubisoft)]
    [InlineData(PlatformId.Xbox)]
    public void Exe_outside_install_folder_is_rejected_for_store_platforms(PlatformId platform)
    {
        var install = _tmp.Dir("Game");
        var exe = MakeExe(@"Other\evil.exe");
        var r = Exe(platform, exe, install);
        Assert.False(r.Ok);
        Assert.Contains("outside its install folder", r.Problem);
    }

    [Fact]
    public void Sibling_folder_sharing_a_prefix_is_not_inside_the_install_folder()
    {
        var install = _tmp.Dir("Game");
        var exe = MakeExe(@"GameEvil\game.exe");
        Assert.False(Exe(PlatformId.Steam, exe, install).Ok);
    }

    [Fact]
    public void Dot_dot_segments_cannot_escape_the_install_folder()
    {
        var install = _tmp.Dir("Game");
        MakeExe(@"Other\evil.exe");
        var sneaky = Path.Combine(install, "..", "Other", "evil.exe");
        Assert.False(Exe(PlatformId.Steam, sneaky, install).Ok);
    }

    [Theory]
    [InlineData(PlatformId.Manual)]
    [InlineData(PlatformId.BattleNet)]
    public void Exe_outside_install_folder_is_allowed_for_manual_and_battlenet(PlatformId platform)
    {
        var install = _tmp.Dir("Game");
        var exe = MakeExe(@"Other\launcher.exe");
        Assert.True(Exe(platform, exe, install).Ok);
    }

    [Fact]
    public void Working_directory_must_exist_and_be_absolute()
    {
        var exe = MakeExe(@"Game\game.exe");
        Assert.True(Exe(PlatformId.Manual, exe, workDir: Path.GetDirectoryName(exe)).Ok);
        Assert.False(Exe(PlatformId.Manual, exe, workDir: Path.Combine(_tmp.Path, "missing")).Ok);
        Assert.False(Exe(PlatformId.Manual, exe, workDir: "Game").Ok);
    }

    // ---------- User arguments ----------

    [Fact]
    public void User_args_at_limit_are_accepted_and_beyond_are_rejected()
    {
        Assert.True(Uri(PlatformId.Steam, "steam://rungameid/1", new string('a', LaunchValidator.MaxUserArgsLength)).Ok);
        var r = Uri(PlatformId.Steam, "steam://rungameid/1", new string('a', LaunchValidator.MaxUserArgsLength + 1));
        Assert.False(r.Ok);
        Assert.Contains("too long", r.Problem);
    }

    [Theory]
    [InlineData("-novid\n-console")]
    [InlineData("-a\r\n")]
    [InlineData("-a\t-b")]
    [InlineData("-a\0")]
    [InlineData("\u001b[31m")]
    public void User_args_with_control_characters_are_rejected(string args)
    {
        var r = Uri(PlatformId.Steam, "steam://rungameid/1", args);
        Assert.False(r.Ok);
        Assert.Contains("invalid characters", r.Problem);
    }

    [Fact]
    public void User_args_are_checked_before_the_target()
    {
        // Even an otherwise-invalid target reports the argument problem first.
        var r = Uri(PlatformId.Epic, "steam://x", new string('a', 5000));
        Assert.Contains("too long", r.Problem);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("-novid -high +fps_max 240 \"quoted arg\"")]
    public void Normal_user_args_are_accepted(string? args) =>
        Assert.True(Uri(PlatformId.Steam, "steam://rungameid/1", args).Ok);

    // ---------- SplitArguments ----------

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\t \t")]
    public void SplitArguments_of_blank_is_empty(string? args) => Assert.Empty(LaunchValidator.SplitArguments(args));

    [Fact]
    public void SplitArguments_splits_on_whitespace_runs()
    {
        Assert.Equal(["-novid", "-high", "+fps_max", "240"], LaunchValidator.SplitArguments("  -novid   -high\t+fps_max 240  "));
    }

    [Fact]
    public void SplitArguments_keeps_quoted_spaces_and_removes_quotes()
    {
        Assert.Equal([@"C:\Program Files\Mods", "-w"], LaunchValidator.SplitArguments("\"C:\\Program Files\\Mods\" -w"));
        Assert.Equal(["--name=John Doe", "-x"], LaunchValidator.SplitArguments("--name=\"John Doe\" -x"));
    }

    [Fact]
    public void SplitArguments_drops_empty_quoted_arguments()
    {
        Assert.Equal(["-a", "-b"], LaunchValidator.SplitArguments("-a \"\" -b"));
    }

    [Fact]
    public void SplitArguments_unterminated_quote_runs_to_end()
    {
        Assert.Equal(["-a", "b c d"], LaunchValidator.SplitArguments("-a \"b c d"));
    }

    [Fact]
    public void SplitArguments_does_not_interpret_shell_metacharacters()
    {
        Assert.Equal(["a&b", "|", "c>d", "%PATH%"], LaunchValidator.SplitArguments("a&b | c>d %PATH%"));
    }
}
