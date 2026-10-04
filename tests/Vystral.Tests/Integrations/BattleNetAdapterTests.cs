using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Xunit;

namespace Vystral.Tests.Integrations;

public sealed class BattleNetAdapterTests : IDisposable
{
    private const string Uninstall = @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
    private const string Uninstaller = @"""C:\ProgramData\Battle.net\Agent\Blizzard Uninstaller.exe"" --lang=enUS";

    private readonly TempDir _tmp = new();
    private readonly FakeRegistry _reg = new();

    public void Dispose() => _tmp.Dispose();

    private BattleNetAdapter Adapter => new(_reg);

    private string InstallClient()
    {
        var dir = _tmp.Dir("Battle.net");
        _tmp.Write(@"Battle.net\Battle.net.exe", "");
        Register("Battle.net", "Battle.net", dir, $"{Uninstaller} --uid=battle.net --displayname=\"Battle.net\"");
        return Path.Combine(dir, "Battle.net.exe");
    }

    private void Register(string key, string name, string dir, string uninstall) =>
        _reg.Set(Hive.LocalMachine, $@"{Uninstall}\{key}", "DisplayName", name)
            .Set(Hive.LocalMachine, $@"{Uninstall}\{key}", "InstallLocation", dir)
            .Set(Hive.LocalMachine, $@"{Uninstall}\{key}", "UninstallString", uninstall);

    [Fact]
    public void Discover_MapsUidToProductCode_AndLaunchesThroughClient()
    {
        var client = InstallClient();
        var ow = _tmp.Dir("Overwatch");
        Register("Overwatch", "Overwatch", ow, $"{Uninstaller} --uid=prometheus --displayname=\"Overwatch\"");

        var game = Assert.Single(Adapter.Discover(CancellationToken.None));

        Assert.Equal("Pro", game.PlatformGameId);
        Assert.Equal("Overwatch", game.Title);
        Assert.Equal(ow, game.InstallPath);
        Assert.Equal(new LaunchTarget(LaunchKind.Executable, client, "--exec=\"launch Pro\"", Path.GetDirectoryName(client)), game.Launch);
        Assert.True(game.ClientRequired);
    }

    [Fact]
    public void Discover_SkipsTestRealms_UnknownProducts_MissingFolders_AndDuplicates()
    {
        InstallClient();
        Register("Overwatch Test", "Overwatch Test", _tmp.Dir("OWTest"), $"{Uninstaller} --uid=prometheus_test --displayname=\"Overwatch Test\"");
        Register("Mystery", "Mystery Game", _tmp.Dir("Mystery"), $"{Uninstaller} --uid=zzunknown");
        Register("Gone", "Diablo IV", Path.Combine(_tmp.Path, "removed"), $"{Uninstaller} --uid=fenris");
        Register("Diablo IV", "Diablo IV", _tmp.Dir("D4"), $"{Uninstaller} --uid=fenris --displayname=\"Diablo IV\"");
        Register("Diablo IV copy", "Diablo IV", _tmp.Dir("D4b"), $"{Uninstaller} --uid=fenris");

        var games = Adapter.Discover(CancellationToken.None);

        var d4 = Assert.Single(games);
        Assert.Equal("Fen", d4.PlatformGameId);
    }

    [Fact]
    public void Discover_ReturnsNothingWithoutClient()
    {
        Register("Overwatch", "Overwatch", _tmp.Dir("Overwatch"), $"{Uninstaller} --uid=prometheus");
        Assert.Empty(Adapter.Discover(CancellationToken.None));
        Assert.Equal(ClientStatus.NotInstalled, Adapter.GetStatus().Status);
    }

    [Theory]
    [InlineData("prometheus", "Pro")]
    [InlineData("wow", "WoW")]
    [InlineData("wow_beta", "WoW")]
    [InlineData("w1r", "W1R")]
    [InlineData("w1", "W1")]
    [InlineData("s2", "S2")]
    [InlineData("hs_beta", "WTCG")]
    [InlineData("unknown", null)]
    public void MapUid_LongestPrefixWins(string uid, string? code) => Assert.Equal(code, BattleNetAdapter.MapUid(uid));

    [Fact]
    public void Status_FallsBackToDefaultFolder()
    {
        var env = new AdapterEnvironment(_tmp.Dir("PD"), _tmp.Dir("LAD"), _tmp.Dir("PF"), _tmp.Dir("PF86"));
        _tmp.Write(@"PF86\Battle.net\Battle.net.exe", "");
        var status = new BattleNetAdapter(new FakeRegistry(), env).GetStatus();
        Assert.Equal(ClientStatus.Available, status.Status);
        Assert.EndsWith(@"PF86\Battle.net\Battle.net.exe", status.ClientPath);
    }
}
