using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Xunit;

namespace Vystral.Tests.Integrations;

public sealed class UbisoftAdapterTests : IDisposable
{
    private const string Launcher = @"SOFTWARE\WOW6432Node\Ubisoft\Launcher";
    private const string Uninstall = @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";

    private readonly TempDir _tmp = new();
    private readonly FakeRegistry _reg = new();
    private readonly string _client;

    public UbisoftAdapterTests()
    {
        _client = _tmp.Dir(@"Ubisoft\Ubisoft Game Launcher");
        _tmp.Write(@"Ubisoft\Ubisoft Game Launcher\UbisoftConnect.exe", "");
        _reg.Set(Hive.LocalMachine, Launcher, "InstallDir", _client + "\\");
    }

    public void Dispose() => _tmp.Dispose();

    private UbisoftAdapter Adapter => new(_reg);

    [Fact]
    public void Discover_ReadsInstalls_WithNamesFromUninstallEntries()
    {
        var siege = _tmp.Dir(@"Ubisoft\Ubisoft Game Launcher\games\Tom Clancy's Rainbow Six Siege");
        _reg.Set(Hive.LocalMachine, $@"{Launcher}\Installs\635", "InstallDir", siege.Replace('\\', '/') + "/");
        _reg.Set(Hive.LocalMachine, $@"{Uninstall}\Uplay Install 635", "DisplayName", "Tom Clancy's Rainbow Six® Siege");

        var other = _tmp.Dir(@"Games\Far Cry 6");
        _reg.Set(Hive.LocalMachine, $@"{Launcher}\Installs\5266", "InstallDir", other);

        var games = Adapter.Discover(CancellationToken.None).OrderBy(g => g.PlatformGameId).ToList();

        Assert.Equal(2, games.Count);
        var r6 = games.Single(g => g.PlatformGameId == "635");
        Assert.Equal("Tom Clancy's Rainbow Six® Siege", r6.Title);
        Assert.Equal(siege, r6.InstallPath);
        Assert.Equal(new LaunchTarget(LaunchKind.Uri, "uplay://launch/635/0"), r6.Launch);
        Assert.True(r6.ClientRequired);
        Assert.Equal("Far Cry 6", games.Single(g => g.PlatformGameId == "5266").Title);
    }

    [Fact]
    public void Discover_SkipsStaleKeys()
    {
        // Empty key (seen on a real PC), key pointing at the client folder, and a removed folder.
        _reg.CreateKey(Hive.LocalMachine, $@"{Launcher}\Installs\66088");
        _reg.Set(Hive.LocalMachine, $@"{Launcher}\Installs\1", "InstallDir", _client);
        _reg.Set(Hive.LocalMachine, $@"{Launcher}\Installs\2", "InstallDir", Path.Combine(_tmp.Path, "removed"));
        _reg.Set(Hive.LocalMachine, $@"{Launcher}\Installs\abc", "InstallDir", _tmp.Dir("NotNumeric"));

        Assert.Empty(Adapter.Discover(CancellationToken.None));
    }

    [Fact]
    public void Discover_DedupesSameFolderAcrossIds()
    {
        var dir = _tmp.Dir(@"Games\Shared");
        _reg.Set(Hive.LocalMachine, $@"{Launcher}\Installs\10", "InstallDir", dir);
        _reg.Set(Hive.LocalMachine, $@"{Launcher}\Installs\11", "InstallDir", dir + "\\");

        Assert.Single(Adapter.Discover(CancellationToken.None));
    }

    [Fact]
    public void Status_FindsClientFromRegistryOrUninstallEntry()
    {
        Assert.Equal(Path.Combine(_client, "UbisoftConnect.exe"), Adapter.GetStatus().ClientPath);

        var reg = new FakeRegistry()
            .Set(Hive.LocalMachine, $@"{Uninstall}\Uplay", "DisplayName", "Ubisoft Connect")
            .Set(Hive.LocalMachine, $@"{Uninstall}\Uplay", "InstallLocation", _client + "\\");
        Assert.Equal(ClientStatus.Available, new UbisoftAdapter(reg).GetStatus().Status);
        Assert.Equal(ClientStatus.NotInstalled, new UbisoftAdapter(new FakeRegistry()).GetStatus().Status);
    }
}
