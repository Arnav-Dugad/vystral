using System.Text;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Xunit;

namespace Vystral.Tests.Integrations;

public sealed class EaAdapterTests : IDisposable
{
    private const string Uninstall = @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";

    private readonly TempDir _tmp = new();
    private readonly FakeRegistry _reg = new();
    private readonly AdapterEnvironment _env;

    public EaAdapterTests()
    {
        _env = new AdapterEnvironment(_tmp.Dir("ProgramData"), _tmp.Dir("LocalAppData"), _tmp.Dir("PF"), _tmp.Dir("PF86"));
    }

    public void Dispose() => _tmp.Dispose();

    private EaAdapter Adapter => new(_reg, _env);

    private const string DipManifest = """
        <?xml version="1.0" encoding="UTF-8"?>
        <DiPManifest version="4.0">
          <buildMetaData><featureFlags /></buildMetaData>
          <contentIDs>
            <contentID>1026023</contentID>
            <contentID>1026024</contentID>
          </contentIDs>
          <gameTitles>
            <gameTitle locale="de_DE">Spiel Titel</gameTitle>
            <gameTitle locale="en_US">Game Title</gameTitle>
          </gameTitles>
          <runtime>
            <launcher uid="0">
              <filePath>[HKEY_LOCAL_MACHINE\SOFTWARE\EA Games\Game Title\Install Dir]bin\GameTitle.exe</filePath>
              <trial>0</trial>
            </launcher>
          </runtime>
        </DiPManifest>
        """;

    private const string LegacyManifest = """
        <?xml version="1.0" encoding="UTF-16"?>
        <game manifestVersion="3.0">
          <metadata>
            <localeInfo locale="fr_FR"><title>Jeu Ancien</title></localeInfo>
            <localeInfo locale="en_US"><title>Old Game</title></localeInfo>
          </metadata>
          <contentIDs><contentID>71715</contentID></contentIDs>
        </game>
        """;

    private string RegisterEaGame(string key, string name, string folder)
    {
        var dir = _tmp.Dir(folder);
        _reg.Set(Hive.LocalMachine, $@"{Uninstall}\{key}", "DisplayName", name)
            .Set(Hive.LocalMachine, $@"{Uninstall}\{key}", "Publisher", "Electronic Arts")
            .Set(Hive.LocalMachine, $@"{Uninstall}\{key}", "InstallLocation", dir)
            .Set(Hive.LocalMachine, $@"{Uninstall}\{key}", "UninstallString",
                $@"""C:\Program Files\Common Files\EAInstaller\{name}\Cleanup.exe"" uninstall_game -autologging");
        return dir;
    }

    [Fact]
    public void ReadInstallerData_DipManifest_PicksEnglishTitleFirstIdAndExe()
    {
        var path = _tmp.Write(@"G\__Installer\installerdata.xml", DipManifest);

        var data = EaAdapter.ReadInstallerData(path)!;

        Assert.Equal(new[] { "1026023", "1026024" }, data.ContentIds);
        Assert.Equal("Game Title", data.Title);
        Assert.Equal("GameTitle.exe", data.ExeName);
    }

    [Fact]
    public void ReadInstallerData_LegacyUtf16WithBom()
    {
        var path = Path.Combine(_tmp.Dir(@"L\__Installer"), "installerdata.xml");
        File.WriteAllText(path, LegacyManifest, new UnicodeEncoding(bigEndian: false, byteOrderMark: true));

        var data = EaAdapter.ReadInstallerData(path)!;

        Assert.Equal(new[] { "71715" }, data.ContentIds);
        Assert.Equal("Old Game", data.Title);
        Assert.Null(data.ExeName);
    }

    [Fact]
    public void ReadInstallerData_DeclaredUtf16ButActuallyUtf8_StillParses()
    {
        var path = _tmp.Write(@"M\__Installer\installerdata.xml", LegacyManifest);
        var data = EaAdapter.ReadInstallerData(path)!;
        Assert.Equal("Old Game", data.Title);
    }

    [Fact]
    public void ReadInstallerData_RejectsMalformedIdsAndBrokenXml()
    {
        var bad = _tmp.Write(@"B\__Installer\installerdata.xml", "<DiPManifest><contentIDs><contentID>../../x y</contentID></contentIDs></DiPManifest>");
        Assert.Empty(EaAdapter.ReadInstallerData(bad)!.ContentIds);

        var broken = _tmp.Write(@"C\__Installer\installerdata.xml", "<DiPManifest><contentIDs>");
        Assert.Null(EaAdapter.ReadInstallerData(broken));
    }

    [Fact]
    public void Discover_UninstallEntries_LaunchViaOrigin2()
    {
        var dir = RegisterEaGame("{GAME-1}", "Registry Name", @"EA\Game");
        _tmp.Write(@"EA\Game\__Installer\installerdata.xml", DipManifest);

        var game = Assert.Single(Adapter.Discover(CancellationToken.None));

        Assert.Equal("1026023", game.PlatformGameId);
        Assert.Equal("Game Title", game.Title);
        Assert.Equal(dir, game.InstallPath);
        Assert.Equal(new LaunchTarget(LaunchKind.Uri, "origin2://game/launch?offerIds=1026023&autoDownload=1"), game.Launch);
        Assert.True(game.ClientRequired);
        Assert.Equal(new[] { "GameTitle.exe" }, game.ProcessHints);
    }

    [Fact]
    public void Discover_ScansDefaultEaGamesFolder_AndDedupesWithUninstallEntry()
    {
        _tmp.Write(@"PF\EA Games\Battlefield\__Installer\installerdata.xml", DipManifest);
        var dir = Path.Combine(_env.ProgramFiles, "EA Games", "Battlefield");
        _reg.Set(Hive.LocalMachine, $@"{Uninstall}\{{BF}}", "InstallLocation", dir + "\\")
            .Set(Hive.LocalMachine, $@"{Uninstall}\{{BF}}", "UninstallString", @"C:\EAInstaller\Battlefield\Cleanup.exe uninstall_game");
        _tmp.Dir(@"PF\EA Games\NoInstallerData");

        var game = Assert.Single(Adapter.Discover(CancellationToken.None));

        Assert.Equal(dir, game.InstallPath);
    }

    [Fact]
    public void Discover_SkipsSteamInstalledEaGames_AndEntriesWithoutContentId()
    {
        // A Steam library registered through libraryfolders.vdf.
        var steam = _tmp.Dir("Steam");
        var lib = _tmp.Dir("SteamLib");
        _reg.Set(Hive.CurrentUser, @"Software\Valve\Steam", "SteamPath", steam);
        _tmp.Write(@"Steam\steamapps\libraryfolders.vdf",
            $"\"libraryfolders\" {{ \"1\" {{ \"path\" \"{lib.Replace(@"\", @"\\")}\" }} }}");

        RegisterEaGame("{FC}", "FC 26", @"SteamLib\steamapps\common\FC 26");
        _tmp.Write(@"SteamLib\steamapps\common\FC 26\__Installer\installerdata.xml", DipManifest);

        RegisterEaGame("{NOID}", "No Id", @"EA\NoId");
        _tmp.Write(@"EA\NoId\__Installer\installerdata.xml", "<DiPManifest><gameTitles><gameTitle locale=\"en_US\">x</gameTitle></gameTitles></DiPManifest>");

        RegisterEaGame("{NOFILE}", "No File", @"EA\NoFile");

        Assert.Empty(Adapter.Discover(CancellationToken.None));
        Assert.True(EaAdapter.IsSteamInstall(@"E:\Games\steamapps\common\X", []));
        Assert.True(EaAdapter.IsSteamInstall(Path.Combine(lib, "steamapps", "common", "Y"), [Path.Combine(lib, "steamapps")]));
        Assert.False(EaAdapter.IsSteamInstall(@"C:\Program Files\EA Games\Z", [Path.Combine(lib, "steamapps")]));
    }

    [Fact]
    public void Status_ReadsEaDesktopKey()
    {
        Assert.Equal(ClientStatus.NotInstalled, Adapter.GetStatus().Status);
        var exe = _tmp.Write(@"EA Desktop\EADesktop.exe", "");
        _reg.Set(Hive.LocalMachine, @"SOFTWARE\Electronic Arts\EA Desktop", "ClientPath", exe);
        Assert.Equal(new AdapterStatus(ClientStatus.Available, exe), Adapter.GetStatus());
        Assert.Null(((IPlatformAdapter)Adapter).GetClientPageUri("1026023"));
    }
}
