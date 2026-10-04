using System.Text.Json;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Xunit;

namespace Vystral.Tests.Integrations;

public sealed class GogAdapterTests : IDisposable
{
    private const string Uninstall = @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
    private const string GogGames = @"SOFTWARE\WOW6432Node\GOG.com\Games";

    private readonly TempDir _tmp = new();
    private readonly FakeRegistry _reg = new();

    public void Dispose() => _tmp.Dispose();

    private GogAdapter Adapter => new(_reg);

    private string RegisterUninstall(string id, string name, string folder, string publisher = "GOG.com")
    {
        var dir = _tmp.Dir(folder);
        var key = $@"{Uninstall}\{id}_is1";
        _reg.Set(Hive.LocalMachine, key, "DisplayName", name)
            .Set(Hive.LocalMachine, key, "Publisher", publisher)
            .Set(Hive.LocalMachine, key, "InstallLocation", dir + "\\");
        return dir;
    }

    private void WriteInfo(string dir, string id, object info) =>
        File.WriteAllText(Path.Combine(dir, $"goggame-{id}.info"), JsonSerializer.Serialize(info));

    private static object PlayTask(bool primary, string type, string? path = null, string? workingDir = null, string? arguments = null, string? link = null) =>
        new { isPrimary = primary, type, path, workingDir, arguments, link, name = "Play" };

    [Fact]
    public void Discover_UsesPrimaryFileTask_AndRunsWithoutGalaxy()
    {
        var dir = RegisterUninstall("1207658924", "The Witcher 3 (registry)", @"GOG Games\Witcher 3");
        _tmp.Write(@"GOG Games\Witcher 3\bin\x64\witcher3.exe", "");
        _tmp.Write(@"GOG Games\Witcher 3\goggame-1207658924.ico", "");
        WriteInfo(dir, "1207658924", new
        {
            gameId = "1207658924",
            rootGameId = "1207658924",
            name = "The Witcher 3: Wild Hunt",
            playTasks = new object[]
            {
                PlayTask(false, "URLTask", link: "https://example.invalid/forum"),
                PlayTask(true, "FileTask", path: @"bin\x64\witcher3.exe", workingDir: @"bin\x64", arguments: "-debugscripts"),
            },
        });

        var game = Assert.Single(Adapter.Discover(CancellationToken.None));

        Assert.Equal("1207658924", game.PlatformGameId);
        Assert.Equal("The Witcher 3: Wild Hunt", game.Title);
        Assert.Equal(LaunchKind.Executable, game.Launch.Kind);
        Assert.Equal(Path.Combine(dir, "bin", "x64", "witcher3.exe"), game.Launch.Value);
        Assert.Equal("-debugscripts", game.Launch.Arguments);
        Assert.Equal(Path.Combine(dir, "bin", "x64"), game.Launch.WorkingDirectory);
        Assert.False(game.ClientRequired);
        Assert.Equal(new[] { "witcher3.exe" }, game.ProcessHints);
        Assert.EndsWith("goggame-1207658924.ico", game.LocalArtwork[ArtworkKind.Icon]);
    }

    [Fact]
    public void Discover_SkipsDlc_NonPrimary_UrlOnly_TraversalAndOtherPublishers()
    {
        var dlc = RegisterUninstall("1111", "Some DLC", "Dlc");
        WriteInfo(dlc, "1111", new { gameId = "1111", rootGameId = "2222", playTasks = new[] { PlayTask(true, "FileTask", path: "x.exe") } });
        _tmp.Write(@"Dlc\x.exe", "");

        var urlOnly = RegisterUninstall("3333", "URL only", "UrlOnly");
        WriteInfo(urlOnly, "3333", new { gameId = "3333", playTasks = new[] { PlayTask(true, "URLTask", link: "https://example.invalid") } });

        var noPrimary = RegisterUninstall("4444", "No primary", "NoPrimary");
        _tmp.Write(@"NoPrimary\game.exe", "");
        WriteInfo(noPrimary, "4444", new { gameId = "4444", playTasks = new[] { PlayTask(false, "FileTask", path: "game.exe") } });

        var escape = RegisterUninstall("5555", "Escapes", @"Deep\Escape");
        _tmp.Write("evil.exe", "");
        WriteInfo(escape, "5555", new { gameId = "5555", playTasks = new[] { PlayTask(true, "FileTask", path: @"..\..\evil.exe") } });

        var other = RegisterUninstall("6666", "Not GOG", "Other", publisher: "Someone Else");
        _tmp.Write(@"Other\game.exe", "");
        WriteInfo(other, "6666", new { gameId = "6666", playTasks = new[] { PlayTask(true, "FileTask", path: "game.exe") } });

        var broken = RegisterUninstall("7777", "Broken info", "Broken");
        File.WriteAllText(Path.Combine(broken, "goggame-7777.info"), "{ not json");

        Assert.Empty(Adapter.Discover(CancellationToken.None));
    }

    [Fact]
    public void Discover_RegistryGamesKey_FallbackUsesOnlyRegisteredExeInsideFolder()
    {
        var ok = _tmp.Dir("OldGame");
        _tmp.Write(@"OldGame\run.exe", "");
        _reg.Set(Hive.LocalMachine, $@"{GogGames}\8888", "path", ok)
            .Set(Hive.LocalMachine, $@"{GogGames}\8888", "gameName", "Old Game")
            .Set(Hive.LocalMachine, $@"{GogGames}\8888", "exe", Path.Combine(ok, "run.exe"))
            .Set(Hive.LocalMachine, $@"{GogGames}\8888", "launchParam", "-windowed");

        var outside = _tmp.Dir("Outside");
        _tmp.Write("elsewhere.exe", "");
        _reg.Set(Hive.LocalMachine, $@"{GogGames}\9999", "path", outside)
            .Set(Hive.LocalMachine, $@"{GogGames}\9999", "gameName", "Outside")
            .Set(Hive.LocalMachine, $@"{GogGames}\9999", "exe", Path.Combine(_tmp.Path, "elsewhere.exe"));

        _reg.Set(Hive.LocalMachine, $@"{GogGames}\7000", "path", _tmp.Dir("NoExe"))
            .Set(Hive.LocalMachine, $@"{GogGames}\7000", "gameName", "No exe");

        var game = Assert.Single(Adapter.Discover(CancellationToken.None));

        Assert.Equal("8888", game.PlatformGameId);
        Assert.Equal("Old Game", game.Title);
        Assert.Equal(Path.Combine(ok, "run.exe"), game.Launch.Value);
        Assert.Equal("-windowed", game.Launch.Arguments);
        Assert.Equal(ok, game.Launch.WorkingDirectory);
    }

    [Fact]
    public void Discover_DedupesUninstallAndGamesKeyForSameId()
    {
        var dir = RegisterUninstall("1000", "Dup", "Dup");
        _tmp.Write(@"Dup\game.exe", "");
        WriteInfo(dir, "1000", new { gameId = "1000", name = "Dup Game", playTasks = new[] { PlayTask(true, "FileTask", path: "game.exe") } });
        _reg.Set(Hive.LocalMachine, $@"{GogGames}\1000", "path", dir).Set(Hive.LocalMachine, $@"{GogGames}\1000", "gameName", "Dup");

        var game = Assert.Single(Adapter.Discover(CancellationToken.None));
        Assert.Equal("Dup Game", game.Title);
        Assert.Equal(Path.Combine(dir, "game.exe"), game.Launch.Value);
        Assert.Equal(dir, game.Launch.WorkingDirectory);
    }

    [Fact]
    public void Status_AndClientPage_DependOnGalaxy()
    {
        Assert.Equal(ClientStatus.NotInstalled, Adapter.GetStatus().Status);
        Assert.Null(Adapter.GetClientPageUri("1207658924"));

        RegisterUninstall("1000", "Offline", "Offline");
        var offline = Adapter.GetStatus();
        Assert.Equal(ClientStatus.Available, offline.Status);
        Assert.Null(offline.ClientPath);

        var galaxy = _tmp.Dir("Galaxy");
        _tmp.Write(@"Galaxy\GalaxyClient.exe", "");
        _reg.Set(Hive.LocalMachine, @"SOFTWARE\WOW6432Node\GOG.com\GalaxyClient\paths", "client", galaxy);
        Assert.Equal(Path.Combine(galaxy, "GalaxyClient.exe"), Adapter.GetStatus().ClientPath);
        Assert.Equal("goggalaxy://openGameView/1207658924", Adapter.GetClientPageUri("1207658924"));
        Assert.Null(Adapter.GetClientPageUri("../x"));
    }
}
