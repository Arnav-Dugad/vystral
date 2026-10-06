using Vystral.Core.Cloud;
using Vystral.Tests.Support;
using Vystral.Windows.Cloud;
using Vystral.Windows.Integrations;
using Xunit;

namespace Vystral.Tests.Cloud;

/// <summary>Launch plans only: nothing is ever started by these tests.</summary>
public sealed class CloudLaunchTests
{
    private const string GfnApp = @"C:\Users\me\AppData\Local\NVIDIA Corporation\GeForceNOW\CEF\GeForceNOW.exe";
    private const string Edge = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
    private const string Profile = @"C:\Users\me\AppData\Local\VYSTRAL.Data\cloud-edge";

    private static readonly CloudCatalogEntry Hl2 = new(CloudServices.GeForceNow, "e5bd86f0-3f67-4bec-a505-d1315f3c0d50", "100885011", "Half-Life 2", CloudPlayTypes.Ready, false, []);
    private static readonly CloudCatalogEntry Resist = new(CloudServices.Xbox, "9NPDN9R45JX4", "9NPDN9R45JX4", "1000xRESIST: Director’s Cut!", CloudPlayTypes.Ready, false, []);

    [Fact]
    public void Gfn_app_gets_the_url_route_with_the_cms_id_as_one_argument()
    {
        var plan = CloudLauncher.Plan(Hl2, new CloudEnvironment(GfnApp, false, Edge), true, Profile);
        Assert.Equal(CloudSurfaces.GfnApp, plan.Surface);
        Assert.Equal(GfnApp, plan.FileName);
        Assert.Equal(["--url-route=#?cmsId=100885011&launchSource=External&shortName=game_gfn_pc&parentGameId="], plan.Arguments);
        Assert.False(plan.ShellExecute);
        Assert.Equal(CloudDetect.GfnStreamer, plan.Detect);
        var psi = CloudLauncher.ToStartInfo(plan);
        Assert.False(psi.UseShellExecute);
        Assert.Equal(plan.Arguments, psi.ArgumentList);
        Assert.Equal("", psi.Arguments);
    }

    [Fact]
    public void Gfn_without_the_app_opens_the_documented_deep_link_in_a_separate_edge_window()
    {
        var plan = CloudLauncher.Plan(Hl2, new CloudEnvironment(null, false, Edge), true, Profile);
        Assert.Equal(CloudSurfaces.Edge, plan.Surface);
        Assert.Equal(Edge, plan.FileName);
        Assert.Equal([
            "--app=https://play.geforcenow.com/games?game-id=e5bd86f0-3f67-4bec-a505-d1315f3c0d50&utm_source=vystral",
            $"--user-data-dir={Profile}", "--no-first-run", "--no-default-browser-check"], plan.Arguments);
        Assert.Equal(CloudDetect.OwnProcess, plan.Detect);
    }

    [Fact]
    public void Default_browser_setting_or_no_edge_uses_shell_execute_on_the_https_page()
    {
        foreach (var (env, useEdge) in new[] { (new CloudEnvironment(null, false, Edge), false), (new CloudEnvironment(null, false, null), true) })
        {
            var plan = CloudLauncher.Plan(Hl2, env, useEdge, Profile);
            Assert.Equal(CloudSurfaces.Browser, plan.Surface);
            Assert.True(plan.ShellExecute);
            Assert.Empty(plan.Arguments);
            Assert.Equal(CloudDetect.Manual, plan.Detect);
            Assert.True(CloudLauncher.ToStartInfo(plan).UseShellExecute);
        }
    }

    [Fact]
    public void Xbox_uses_the_documented_app_uri_or_xbox_com_play()
    {
        var app = CloudLauncher.Plan(Resist, new CloudEnvironment(null, true, Edge), true, Profile);
        Assert.Equal(CloudSurfaces.XboxApp, app.Surface);
        Assert.Equal("msxbox://game/?productId=9NPDN9R45JX4", app.FileName);
        Assert.True(app.ShellExecute);
        Assert.Equal(CloudDetect.XboxForeground, app.Detect);

        var web = CloudLauncher.Plan(Resist, new CloudEnvironment(null, false, Edge), true, Profile);
        Assert.Equal("--app=https://www.xbox.com/en-US/play/launch/1000xresist-director-s-cut/9NPDN9R45JX4", web.Arguments[0]);
    }

    [Theory]
    [InlineData("100885011x")]
    [InlineData("1 --evil")]
    [InlineData("0123")]
    [InlineData("")]
    [InlineData(null)]
    public void Invalid_cms_ids_are_refused(string? cms) =>
        Assert.Throws<ArgumentException>(() => CloudLauncher.Plan(Hl2 with { LaunchKey = cms }, new CloudEnvironment(GfnApp, false, Edge), true, Profile));

    [Theory]
    [InlineData("e5bd86f0-3f67-4bec-a505-d1315f3c0d5")]
    [InlineData("E5BD86F0-3F67-4BEC-A505-D1315F3C0D50")]
    [InlineData("e5bd86f0-3f67-4bec-a505-d1315f3c0d50&x=\"")]
    public void Invalid_gfn_game_ids_are_refused(string id) =>
        Assert.Throws<ArgumentException>(() => CloudLauncher.Plan(Hl2 with { EntryId = id }, new CloudEnvironment(null, false, Edge), true, Profile));

    [Theory]
    [InlineData("9npdn9r45jx4")]
    [InlineData("9NPDN9R45JX")]
    [InlineData("9NPDN9R45JX4/../x")]
    public void Invalid_product_ids_are_refused(string id) =>
        Assert.Throws<ArgumentException>(() => CloudLauncher.Plan(Resist with { EntryId = id }, new CloudEnvironment(null, true, Edge), true, Profile));

    [Fact]
    public void Only_vendor_pages_and_the_xbox_scheme_reach_the_shell()
    {
        Assert.Throws<ArgumentException>(() => CloudLauncher.Browser("https://evil.example/", new CloudEnvironment(null, false, Edge), true, Profile));
        Assert.Throws<ArgumentException>(() => CloudLauncher.Browser("http://play.geforcenow.com/games", new CloudEnvironment(null, false, Edge), true, Profile));
        Assert.Throws<ArgumentException>(() => CloudLauncher.ToStartInfo(new CloudLaunchPlan("browser", "file:///C:/Windows/system32/calc.exe", [], true, null, CloudDetect.Manual)));
        Assert.Throws<ArgumentException>(() => CloudLauncher.ToStartInfo(new CloudLaunchPlan("browser", "https://www.xbox.com/", ["--x"], true, null, CloudDetect.Manual)));
    }

    [Theory]
    [InlineData(@"\\server\share\GeForceNOW.exe", false)]
    [InlineData(@"GeForceNOW.exe", false)]
    [InlineData(@"C:\x\..\GeForceNOW.exe", false)]
    [InlineData(@"C:\x\Other.exe", false)]
    [InlineData(GfnApp, true)]
    public void Executables_must_be_local_absolute_and_expected(string path, bool ok) => Assert.Equal(ok, CloudLauncher.IsSafeExe(path, "GeForceNOW.exe"));

    [Fact]
    public void An_unsafe_edge_path_falls_back_to_the_default_browser()
    {
        var plan = CloudLauncher.Plan(Hl2, new CloudEnvironment(null, false, @"\\evil\msedge.exe"), true, Profile);
        Assert.Equal(CloudSurfaces.Browser, plan.Surface);
    }

    [Fact]
    public void Slugs_are_ascii_and_never_empty()
    {
        Assert.Equal("game", CloudLauncher.Slug("™®"));
        Assert.Equal("forza-horizon-5", CloudLauncher.Slug("Forza Horizon 5"));
        Assert.True(CloudLauncher.Slug(new string('a', 200)).Length <= 60);
    }

    [Fact]
    public void Environment_is_found_read_only_from_files_and_the_registry()
    {
        var reg = new FakeRegistry();
        var env = CloudLauncher.Detect(reg, _ => false);
        Assert.Equal(new CloudEnvironment(null, false, null), env);

        reg.Set(Hive.CurrentUser, @"Software\Classes\msxbox", "URL Protocol", "")
           .Set(Hive.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe", "", $"\"{Edge}\"");
        var found = CloudLauncher.Detect(reg, p => p == Edge);
        Assert.True(found.XboxApp);
        Assert.Equal(Edge, found.EdgePath);
        Assert.Null(found.GfnAppPath);

        // A registry value pointing somewhere unexpected is ignored.
        reg.Set(Hive.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe", "", @"\\evil\share\msedge.exe");
        Assert.NotEqual(@"\\evil\share\msedge.exe", CloudLauncher.Detect(reg, _ => true).EdgePath);
    }
}
