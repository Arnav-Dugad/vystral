using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Xunit;

namespace Vystral.Tests.TrackD1;

public sealed class VersionHistoryTests : IDisposable
{
    private readonly TestDb _t = new();
    private readonly TempDir _tmp = new();
    private static readonly DateTimeOffset T0 = new(2026, 5, 1, 10, 0, 0, TimeSpan.Zero);

    public void Dispose()
    {
        _t.Dispose();
        _tmp.Dispose();
    }

    private static DiscoveredInstallation Steam(string appId, string? build, DateTimeOffset? updated = null) =>
        TestDb.Install(PlatformId.Steam, appId, $"Game {appId}", steamAppId: appId) with { BuildId = build, BuildUpdated = updated };

    private static DiscoveredInstallation Xbox(string id, string? version) =>
        TestDb.Install(PlatformId.Xbox, id, $"Xbox {id}") with { Version = version, InstalledAt = T0 };

    private string GameIdOf(PlatformId p, string id) => _t.Repo.GetInstallationsByPlatformId(p, id)!.GameId;

    [Fact]
    public void Records_a_baseline_then_only_changes_and_reads_them_per_game()
    {
        var scan1 = new[] { TestDb.Ok(PlatformId.Steam, Steam("620", "1000", T0.AddDays(-9))), TestDb.Ok(PlatformId.Xbox, Xbox("Contoso.Racer", "1.2.3.0")) };
        _t.Repo.ApplyScan(scan1);
        Assert.Equal(2, _t.Repo.RecordVersions(ObservedVersions.From(scan1), T0));
        Assert.Equal(0, _t.Repo.RecordVersions(ObservedVersions.From(scan1), T0.AddHours(1))); // unchanged

        var scan2 = new[] { TestDb.Ok(PlatformId.Steam, Steam("620", "1042", T0.AddDays(2))) };
        Assert.Equal(1, _t.Repo.RecordVersions(ObservedVersions.From(scan2), T0.AddDays(3)));

        var steam = _t.Repo.GetVersionHistory(GameIdOf(PlatformId.Steam, "620"));
        Assert.Equal(["1000", "1042"], steam.Select(v => v.Value));
        Assert.True(steam[0].Baseline);
        Assert.False(steam[1].Baseline);
        Assert.All(steam, v => Assert.Equal(ObservedVersions.SteamBuild, v.Kind));
        Assert.Equal(T0.AddDays(2).ToString("O"), steam[1].StoreUpdated);
        Assert.Equal(T0.AddDays(3).ToString("O"), steam[1].Seen);

        var xbox = Assert.Single(_t.Repo.GetVersionHistory(GameIdOf(PlatformId.Xbox, "Contoso.Racer")));
        Assert.Equal((ObservedVersions.XboxPackage, "1.2.3.0", "xbox"), (xbox.Kind, xbox.Value, xbox.Platform));
    }

    [Theory]
    [InlineData("0", false)]
    [InlineData("12a", false)]
    [InlineData("123456789012345678901", false)]
    [InlineData("8812345", true)]
    public void Only_plausible_steam_builds_are_recorded(string build, bool kept) =>
        Assert.Equal(kept, ObservedVersions.From([TestDb.Ok(PlatformId.Steam, Steam("1", build))]).Count == 1);

    [Theory]
    [InlineData("1.2.3.4", true)]
    [InlineData("10.0", true)]
    [InlineData("1.2.3.4.5", false)]
    [InlineData("1.2-beta", false)]
    [InlineData("", false)]
    public void Only_plausible_package_versions_are_recorded(string version, bool kept) =>
        Assert.Equal(kept, ObservedVersions.From([TestDb.Ok(PlatformId.Xbox, Xbox("X", version))]).Count == 1);

    [Fact]
    public void Failed_scans_missing_copies_and_unknown_copies_record_nothing()
    {
        Assert.Empty(ObservedVersions.From([TestDb.Failed(PlatformId.Steam)]));
        Assert.Empty(ObservedVersions.From([TestDb.Ok(PlatformId.Steam, Steam("5", "77") with { State = InstallState.Missing })]));
        Assert.Equal(0, _t.Repo.RecordVersions(ObservedVersions.From([TestDb.Ok(PlatformId.Steam, Steam("404", "1"))]), T0));
    }

    [Fact]
    public void Keeps_the_newest_rows_per_copy()
    {
        var scan = TestDb.Ok(PlatformId.Steam, Steam("620", "1"));
        _t.Repo.ApplyScan([scan]);
        for (var i = 1; i <= ObservedVersions.KeepPerCopy + 5; i++)
            _t.Repo.RecordVersions(ObservedVersions.From([TestDb.Ok(PlatformId.Steam, Steam("620", i.ToString()))]), T0.AddMinutes(i));
        var history = _t.Repo.GetVersionHistory(GameIdOf(PlatformId.Steam, "620"));
        Assert.Equal(ObservedVersions.KeepPerCopy, history.Count);
        Assert.Equal((ObservedVersions.KeepPerCopy + 5).ToString(), history[^1].Value);
    }

    [Fact]
    public void Steam_adapter_reads_buildid_and_last_updated_from_the_manifest()
    {
        var steam = _tmp.Dir("Steam");
        var reg = new FakeRegistry();
        reg.Set(Hive.CurrentUser, @"Software\Valve\Steam", "SteamPath", steam.Replace('\\', '/'));
        _tmp.Write(@"Steam\steamapps\appmanifest_620.acf", """
            "AppState"
            {
            	"appid"		"620"
            	"name"		"Portal 2"
            	"StateFlags"		"4"
            	"installdir"		"Portal 2"
            	"buildid"		"8812345"
            	"LastUpdated"		"1757000000"
            }
            """);
        _tmp.Dir(@"Steam\steamapps\common\Portal 2");

        var game = Assert.Single(new SteamAdapter(reg).Discover(steam, CancellationToken.None));

        Assert.Equal("8812345", game.BuildId);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1757000000), game.BuildUpdated);
    }
}
