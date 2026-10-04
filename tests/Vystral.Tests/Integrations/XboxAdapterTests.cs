using System.Text;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Xunit;
using PackageInfo = Vystral.Windows.Integrations.XboxAdapter.PackageInfo;

namespace Vystral.Tests.Integrations;

public sealed class XboxAdapterTests : IDisposable
{
    private readonly TempDir _tmp = new();

    public void Dispose() => _tmp.Dispose();

    // Exact bytes of C:\.GamingRoot observed on a real PC: "RGBX", uint32 1, UTF-16LE "XboxGames\0".
    private static readonly byte[] RealGamingRoot =
    [
        0x52, 0x47, 0x42, 0x58, 0x01, 0x00, 0x00, 0x00, 0x58, 0x00, 0x62, 0x00, 0x6F, 0x00, 0x78, 0x00,
        0x47, 0x00, 0x61, 0x00, 0x6D, 0x00, 0x65, 0x00, 0x73, 0x00, 0x00, 0x00,
    ];

    private static string AppxManifest(string displayName, string executable = "GameLaunchHelper.exe", string logo = @"Assets\Square150x150Logo.png") => $$"""
        <?xml version="1.0" encoding="utf-8"?>
        <Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
                 xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10">
          <Identity Name="Publisher.Game" Publisher="CN=Test" Version="1.0.0.0" />
          <Properties>
            <DisplayName>{{displayName}}</DisplayName>
            <PublisherDisplayName>Test</PublisherDisplayName>
            <Logo>Assets\StoreLogo.png</Logo>
          </Properties>
          <Applications>
            <Application Id="Game" Executable="{{executable}}" EntryPoint="Windows.FullTrustApplication">
              <uap:VisualElements DisplayName="{{displayName}}" Square150x150Logo="{{logo}}" Square44x44Logo="Assets\Square44x44Logo.png"
                                  Description="d" BackgroundColor="transparent" />
            </Application>
          </Applications>
        </Package>
        """;

    private const string GameConfig = """
        <?xml version="1.0" encoding="utf-8"?>
        <Game configVersion="1">
          <Identity Name="Publisher.Game" Publisher="CN=Test" Version="1.0.0.0" />
          <ExecutableList>
            <Executable Name="Binaries\Win64\Game-Win64-Shipping.exe" Id="Game" TargetDeviceFamily="PC" />
            <Executable Name="Launcher.exe" Id="Launcher" TargetDeviceFamily="PC" />
          </ExecutableList>
          <ShellVisuals DefaultDisplayName="Config Title" PublisherDisplayName="Test"
                        Square480x480Logo="Assets\Square480x480Logo.png" Square150x150Logo="Assets\Square150x150Logo.png"
                        Square44x44Logo="Assets\Square44x44Logo.png" StoreLogo="Assets\StoreLogo.png" />
        </Game>
        """;

    private string MakePackage(string relative, string displayName, bool withConfig, string? manifestDisplayName = null)
    {
        var dir = _tmp.Dir(relative);
        _tmp.Write(Path.Combine(relative, "AppxManifest.xml"), AppxManifest(manifestDisplayName ?? displayName));
        if (withConfig) _tmp.Write(Path.Combine(relative, "MicrosoftGame.config"), GameConfig);
        return dir;
    }

    private static PackageInfo Pkg(string family, string? displayName, string? location, bool framework = false, bool resource = false, bool store = true) =>
        new(family, displayName, location, framework, resource, store);

    [Fact]
    public void ParseGamingRoot_RealBytes()
    {
        Assert.Equal("XboxGames", XboxAdapter.ParseGamingRoot(RealGamingRoot));
    }

    [Fact]
    public void ParseGamingRoot_RejectsBadMagicTraversalAndShortInput()
    {
        var bad = (byte[])RealGamingRoot.Clone();
        bad[0] = (byte)'X';
        Assert.Null(XboxAdapter.ParseGamingRoot(bad));
        Assert.Null(XboxAdapter.ParseGamingRoot([0x52, 0x47]));
        Assert.Null(XboxAdapter.ParseGamingRoot(null));
        var traversal = Encoding.ASCII.GetBytes("RGBX").Concat(new byte[] { 1, 0, 0, 0 }).Concat(Encoding.Unicode.GetBytes(@"..\Windows" + "\0")).ToArray();
        Assert.Null(XboxAdapter.ParseGamingRoot(traversal));
        var absolute = Encoding.ASCII.GetBytes("RGBX").Concat(new byte[] { 1, 0, 0, 0 }).Concat(Encoding.Unicode.GetBytes(@"C:\Windows" + "\0")).ToArray();
        Assert.Null(XboxAdapter.ParseGamingRoot(absolute));
    }

    [Fact]
    public void FindGamingFolders_ReadsEachDriveRoot()
    {
        var driveA = _tmp.Dir("DriveA");
        var driveB = _tmp.Dir("DriveB");
        File.WriteAllBytes(Path.Combine(driveA, ".GamingRoot"), RealGamingRoot);

        var folders = XboxAdapter.FindGamingFolders([driveA, driveB]);

        Assert.Equal(new[] { Path.Combine(driveA, "XboxGames") }, folders);
    }

    [Fact]
    public void Discover_GdkGame_UsesConfigForTitleHintsAndLargestLogo()
    {
        var dir = MakePackage(@"Drive\XboxGames\Forza\Content", "ms-resource:AppDisplayName", withConfig: true);
        _tmp.Write(@"Drive\XboxGames\Forza\Content\Assets\Square480x480Logo.scale-100.png", new string('a', 10));
        _tmp.Write(@"Drive\XboxGames\Forza\Content\Assets\Square480x480Logo.scale-400.png", new string('a', 40));
        _tmp.Write(@"Drive\XboxGames\Forza\Content\Assets\Square480x480Logo.scale-200.png", new string('a', 20));
        _tmp.Write(@"Drive\XboxGames\Forza\Content\Assets\Square480x480Logo.scale-400_contrast-black.png", new string('a', 99));

        var games = XboxAdapter.Discover([Pkg("Publisher.Game_8wekyb3d8bbwe", "ms-resource:x", dir)], [], CancellationToken.None);

        var game = Assert.Single(games);
        Assert.Equal("Publisher.Game_8wekyb3d8bbwe", game.PlatformGameId);
        Assert.Equal("Config Title", game.Title);
        Assert.Equal(new LaunchTarget(LaunchKind.PackagedApp, "Publisher.Game_8wekyb3d8bbwe!Game"), game.Launch);
        Assert.False(game.ClientRequired);
        Assert.Equal(new[] { "Game-Win64-Shipping.exe", "Launcher.exe" }, game.ProcessHints);
        Assert.EndsWith("Square480x480Logo.scale-400.png", game.LocalArtwork[ArtworkKind.Icon]);
        Assert.False(game.LocalArtwork.ContainsKey(ArtworkKind.Cover));
    }

    [Fact]
    public void Discover_GamingRootPackageWithoutConfig_IsIncluded_PlainAppsAreNot()
    {
        var root = _tmp.Dir(@"Drive\XboxGames");
        var game = MakePackage(@"Drive\XboxGames\Older Game\Content", "Older Game", withConfig: false);
        _tmp.Write(@"Drive\XboxGames\Older Game\Content\Assets\Square150x150Logo.png", "x");
        var app = MakePackage(@"WindowsApps\Calculator", "Calculator", withConfig: false);

        var games = XboxAdapter.Discover(
            [Pkg("Older.Game_abc", "Older Game", game), Pkg("Microsoft.WindowsCalculator_8wekyb3d8bbwe", "Calculator", app)],
            [root], CancellationToken.None);

        var found = Assert.Single(games);
        Assert.Equal("Older Game", found.Title);
        Assert.Empty(found.ProcessHints);
        Assert.EndsWith("Square150x150Logo.png", found.LocalArtwork[ArtworkKind.Icon]);
    }

    [Fact]
    public void Discover_SkipsFrameworkResourceSideloadedMissingAndManifestless()
    {
        var a = MakePackage("A", "A", withConfig: true);
        var b = MakePackage("B", "B", withConfig: true);
        var c = MakePackage("C", "C", withConfig: true);
        var d = _tmp.Dir("D");
        _tmp.Write(@"D\MicrosoftGame.config", GameConfig);

        var games = XboxAdapter.Discover(
        [
            Pkg("Fw_1", "A", a, framework: true),
            Pkg("Res_1", "B", b, resource: true),
            Pkg("Side_1", "C", c, store: false),
            Pkg("Missing_1", "Missing", Path.Combine(_tmp.Path, "nope")),
            Pkg("NoLocation_1", "None", null),
            Pkg("NoManifest_1", "D", d),
        ], [], CancellationToken.None);

        Assert.Empty(games);
    }

    [Fact]
    public void Discover_DedupesFamilies_AndUsesManifestNameWhenOthersAreResources()
    {
        var dir = MakePackage("E", "Manifest Name", withConfig: false);
        var games = XboxAdapter.Discover(
            [Pkg("Same_1", null, dir), Pkg("Same_1", null, dir)], [Path.Combine(_tmp.Path, "E")], CancellationToken.None);

        var game = Assert.Single(games);
        Assert.Equal("Manifest Name", game.Title);
    }

    [Fact]
    public void ClientPage_And_Status()
    {
        var adapter = new XboxAdapter(new FakeRegistry());
        Assert.Equal("ms-windows-store://pdp/?PFN=Publisher.Game_8wekyb3d8bbwe", adapter.GetClientPageUri("Publisher.Game_8wekyb3d8bbwe"));
        Assert.NotNull(adapter.GetStatus().Detail);
        var reg = new FakeRegistry().Set(Hive.LocalMachine, @"SOFTWARE\Microsoft\GamingServices", "CurrentVersion", "2814751477605605");
        Assert.Equal(new AdapterStatus(ClientStatus.Available, null), new XboxAdapter(reg).GetStatus());
    }
}
