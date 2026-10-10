using System.Collections.Concurrent;
using Vystral.Core.Contracts;
using Vystral.Core.Domain;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Storage;
using Xunit;
using static Vystral.Tests.Support.TestDb;
using PackageInfo = Vystral.Windows.Integrations.XboxAdapter.PackageInfo;
using ReadContext = Vystral.Windows.Integrations.XboxAdapter.ReadContext;

namespace Vystral.Tests.Integrations;

/// <summary>
/// Track C1: Xbox / Microsoft Store packages read thoroughly — localized names, publisher, version, install date,
/// the right app, better art, an honest last-played estimate from save data — and sizes for Storage Studio.
/// </summary>
public sealed class XboxPackageReadingTests : IDisposable
{
    private readonly TempDir _tmp = new();
    private static readonly DateTimeOffset Now = new(2026, 10, 10, 12, 0, 0, TimeSpan.Zero);

    public void Dispose() => _tmp.Dispose();

    private const string Forza = "Microsoft.SunriseBaseGame_8wekyb3d8bbwe";
    private const string ForzaFull = "Microsoft.SunriseBaseGame_1.478.564.2_x64__8wekyb3d8bbwe";

    /// <summary>Forza Horizon 4's shape on a real PC: a UWP package with ms-resource names and one app, "SunriseReleaseFinal".</summary>
    private static string UwpManifest(string apps = """
        <Application Id="SunriseReleaseFinal" Executable="ForzaHorizon4.exe" EntryPoint="Sunrise.App">
          <uap:VisualElements DisplayName="ms-resource:AppDisplayName" Square150x150Logo="Assets\Square150x150Logo.png"
                              Square44x44Logo="Assets\Square44x44Logo.png" Description="d" BackgroundColor="#000000">
            <uap:DefaultTile Wide310x150Logo="Assets\WideLogo.png" Square310x310Logo="Assets\LargeTile.png" />
            <uap:SplashScreen Image="Assets\SplashScreen.png" />
          </uap:VisualElements>
        </Application>
        """) => $$"""
        <?xml version="1.0" encoding="utf-8"?>
        <Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
                 xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10">
          <Identity Name="Microsoft.SunriseBaseGame" Publisher="CN=Microsoft" Version="1.478.564.2" />
          <Properties>
            <DisplayName>ms-resource:AppDisplayName</DisplayName>
            <PublisherDisplayName>ms-resource:PublisherName</PublisherDisplayName>
            <Logo>Assets\StoreLogo.png</Logo>
          </Properties>
          <Applications>
            {{apps}}
          </Applications>
        </Package>
        """;

    private string MakeForza(string? manifest = null)
    {
        var rel = $@"WindowsApps\{ForzaFull}";
        var dir = _tmp.Dir(rel);
        _tmp.Write($@"{rel}\AppxManifest.xml", manifest ?? UwpManifest());
        _tmp.Write($@"{rel}\xboxservices.config", "{}");
        return dir;
    }

    private static PackageInfo Pkg(string family, string? displayName, string location, string? full = ForzaFull, string? version = null,
        DateTimeOffset? installed = null, string? publisher = null) =>
        new(family, displayName, location, false, false, true, full, version, installed, publisher);

    /// <summary>A resolver standing in for SHLoadIndirectString: answers only the exact indirect strings it knows.</summary>
    private static Func<string, string?> Resources(params (string Source, string Text)[] known) =>
        source => known.FirstOrDefault(k => k.Source == source).Text;

    private ReadContext Context(Func<string, string?>? resolve = null, string? packagesRoot = null) => new(packagesRoot, resolve, () => Now);

    // ---------- Names ----------

    [Fact]
    public void Ms_resource_names_resolve_through_the_package_resources()
    {
        var dir = MakeForza();
        var resolve = Resources(
            ($"@{{{ForzaFull}? ms-resource://Microsoft.SunriseBaseGame/Resources/AppDisplayName}}", "Forza Horizon 4"),
            ($"@{{{ForzaFull}? ms-resource://Microsoft.SunriseBaseGame/Resources/PublisherName}}", "Microsoft Studios"));

        var game = Assert.Single(XboxAdapter.Discover([Pkg(Forza, "ms-resource:AppDisplayName", dir)], [], CancellationToken.None, Context(resolve)));

        Assert.Equal("Forza Horizon 4", game.Title);
        Assert.Equal("Microsoft Studios", game.Publisher);
        Assert.Equal("Microsoft.SunriseBaseGame_8wekyb3d8bbwe!SunriseReleaseFinal", game.Launch.Value);
        Assert.Equal(["ForzaHorizon4.exe"], game.ProcessHints);
    }

    [Fact]
    public void A_name_that_cant_be_resolved_skips_the_game_rather_than_showing_a_resource_key()
    {
        var dir = MakeForza();
        Assert.Empty(XboxAdapter.Discover([Pkg(Forza, null, dir)], [], CancellationToken.None, Context(_ => null)));
        // With Windows' own display name it's found as before.
        Assert.Equal("Forza Horizon 4", Assert.Single(XboxAdapter.Discover([Pkg(Forza, "Forza Horizon 4", dir)], [], CancellationToken.None, Context(_ => null))).Title);
    }

    [Theory]
    [InlineData("ms-resource:AppName", "ms-resource://Pkg.Name/Resources/AppName", "ms-resource:///Resources/AppName")]
    [InlineData("ms-resource:Strings/AppName", "ms-resource://Pkg.Name/Strings/AppName", null)]
    [InlineData("ms-resource:/Strings/AppName", "ms-resource://Pkg.Name/Strings/AppName", null)]
    [InlineData("ms-resource://Pkg.Name/Resources/AppName", "ms-resource://Pkg.Name/Resources/AppName", null)]
    public void Indirect_strings_cover_the_usual_reference_shapes(string reference, string first, string? second)
    {
        var candidates = XboxAdapter.IndirectStringCandidates("Pkg.Name_1.0.0.0_x64__abc", "Pkg.Name", reference);
        Assert.Equal($"@{{Pkg.Name_1.0.0.0_x64__abc? {first}}}", candidates[0]);
        if (second is null) Assert.Single(candidates);
        else Assert.Equal($"@{{Pkg.Name_1.0.0.0_x64__abc? {second}}}", candidates[1]);
    }

    [Theory]
    [InlineData("Bad}Name", "ms-resource:AppName")]
    [InlineData("Pkg_1", "ms-resource:App}Name")]
    [InlineData("Pkg_1", "ms-resource:App?Name")]
    [InlineData("Pkg_1", "ms-resource:")]
    [InlineData("Pkg_1", "AppName")]
    public void Indirect_strings_refuse_anything_unexpected(string fullName, string reference) =>
        Assert.Empty(XboxAdapter.IndirectStringCandidates(fullName, "Pkg", reference));

    [Fact]
    public void Resolved_text_is_validated()
    {
        string? Read(string? answer) => XboxAdapter.ReadableText("ms-resource:X", 50, "Pkg_1", "Pkg", _ => answer);
        Assert.Equal("Halo", Read("  Halo "));
        Assert.Null(Read("ms-resource:Still"));
        Assert.Null(Read("bad\u0001text"));
        Assert.Null(Read(new string('a', 51)));
        Assert.Null(Read(""));
    }

    // ---------- Details ----------

    [Fact]
    public void Version_and_install_date_come_from_the_package_with_the_manifest_as_fallback()
    {
        var dir = MakeForza();
        var installed = new DateTimeOffset(2025, 3, 12, 9, 30, 0, TimeSpan.Zero);
        var game = Assert.Single(XboxAdapter.Discover([Pkg(Forza, "Forza Horizon 4", dir, version: "1.478.564.2", installed: installed, publisher: "Microsoft Studios")],
            [], CancellationToken.None, Context()));
        Assert.Equal("1.478.564.2", game.Version);
        Assert.Equal(installed, game.InstalledAt);
        Assert.Equal("Microsoft Studios", game.Publisher);

        var fallback = Assert.Single(XboxAdapter.Discover([Pkg(Forza, "Forza Horizon 4", dir, installed: new DateTimeOffset(1601, 1, 1, 0, 0, 0, TimeSpan.Zero))],
            [], CancellationToken.None, Context()));
        Assert.Equal("1.478.564.2", fallback.Version); // manifest Identity Version
        Assert.Null(fallback.InstalledAt); // Windows' "no date" isn't a date
        Assert.Null(fallback.Publisher); // an unresolved ms-resource publisher is left out
    }

    // ---------- Several apps in one package ----------

    [Fact]
    public void The_app_the_game_config_names_is_launched_not_a_bundled_tool()
    {
        var dir = _tmp.Dir(@"XboxGames\Big Game\Content");
        _tmp.Write(@"XboxGames\Big Game\Content\AppxManifest.xml", UwpManifest("""
            <Application Id="Settings" Executable="Settings.exe" EntryPoint="Windows.FullTrustApplication">
              <uap:VisualElements DisplayName="Settings" Square150x150Logo="a.png" Square44x44Logo="a.png" Description="d" BackgroundColor="#000000" />
            </Application>
            <Application Id="Game" Executable="GameLaunchHelper.exe" EntryPoint="Windows.FullTrustApplication">
              <uap:VisualElements DisplayName="Big Game" Square150x150Logo="a.png" Square44x44Logo="a.png" Description="d" BackgroundColor="#000000" />
            </Application>
            """));
        _tmp.Write(@"XboxGames\Big Game\Content\MicrosoftGame.config", """
            <Game configVersion="1"><ExecutableList><Executable Name="BigGame.exe" Id="Game" /></ExecutableList>
            <ShellVisuals DefaultDisplayName="Big Game" PublisherDisplayName="Big Studio" /></Game>
            """);

        var game = Assert.Single(XboxAdapter.Discover([Pkg("Big.Game_abc", "Big Game", dir, full: "Big.Game_1.0.0.0_x64__abc")], [], CancellationToken.None, Context()));
        Assert.Equal("Big.Game_abc!Game", game.Launch.Value);
        Assert.Equal(["BigGame.exe"], game.ProcessHints);
        Assert.Equal("Big Studio", game.Publisher);
    }

    [Fact]
    public void Apps_hidden_from_Start_are_passed_over()
    {
        var dir = MakeForza(UwpManifest("""
            <Application Id="Helper" Executable="Helper.exe" EntryPoint="x">
              <uap:VisualElements DisplayName="Helper" AppListEntry="none" Square150x150Logo="a.png" Square44x44Logo="a.png" Description="d" BackgroundColor="#000000" />
            </Application>
            <Application Id="SunriseReleaseFinal" Executable="ForzaHorizon4.exe" EntryPoint="Sunrise.App">
              <uap:VisualElements DisplayName="Forza Horizon 4" Square150x150Logo="a.png" Square44x44Logo="a.png" Description="d" BackgroundColor="#000000" />
            </Application>
            """));
        var game = Assert.Single(XboxAdapter.Discover([Pkg(Forza, null, dir)], [], CancellationToken.None, Context(_ => null)));
        Assert.Equal($"{Forza}!SunriseReleaseFinal", game.Launch.Value);
        Assert.Equal("Forza Horizon 4", game.Title); // the chosen app's own display name
    }

    // ---------- Artwork ----------

    [Fact]
    public void Art_uses_the_largest_variant_of_the_square_wide_and_splash_images()
    {
        var dir = MakeForza();
        var rel = $@"WindowsApps\{ForzaFull}\Assets";
        _tmp.Write($@"{rel}\LargeTile.scale-100.png", new string('a', 10));
        _tmp.Write($@"{rel}\LargeTile.scale-400.png", new string('a', 40));
        _tmp.Write($@"{rel}\WideLogo.scale-200.png", new string('a', 20));
        _tmp.Write($@"{rel}\WideLogo.scale-400.png", new string('a', 40));
        _tmp.Write($@"{rel}\SplashScreen.scale-400.png", new string('a', 40));

        var game = Assert.Single(XboxAdapter.Discover([Pkg(Forza, "Forza Horizon 4", dir)], [], CancellationToken.None, Context()));

        Assert.EndsWith("LargeTile.scale-400.png", game.LocalArtwork[ArtworkKind.Icon]);
        Assert.EndsWith("WideLogo.scale-400.png", game.LocalArtwork[ArtworkKind.Header]);
        // A UWP splash screen is a logo on a colour: never used as a full-bleed hero.
        Assert.False(game.LocalArtwork.ContainsKey(ArtworkKind.Hero));
    }

    [Fact]
    public void A_GDK_splash_image_becomes_the_hero_and_the_store_logo_is_the_last_icon_fallback()
    {
        var dir = _tmp.Dir(@"XboxGames\Gdk\Content");
        _tmp.Write(@"XboxGames\Gdk\Content\AppxManifest.xml", UwpManifest("""
            <Application Id="Game" Executable="GameLaunchHelper.exe" EntryPoint="Windows.FullTrustApplication">
              <uap:VisualElements DisplayName="Gdk" Square150x150Logo="Missing\a.png" Square44x44Logo="Missing\b.png" Description="d" BackgroundColor="#000000" />
            </Application>
            """));
        _tmp.Write(@"XboxGames\Gdk\Content\MicrosoftGame.config", """
            <Game configVersion="1"><ShellVisuals DefaultDisplayName="Gdk Game" SplashScreenImage="Art\Splash.png" StoreLogo="Art\StoreLogo.png" /></Game>
            """);
        _tmp.Write(@"XboxGames\Gdk\Content\Art\Splash.png", new string('s', 64));
        _tmp.Write(@"XboxGames\Gdk\Content\Art\StoreLogo.scale-400.png", new string('l', 8));

        var game = Assert.Single(XboxAdapter.Discover([Pkg("Gdk.Game_abc", "Gdk Game", dir, full: "Gdk.Game_1.0.0.0_x64__abc")], [], CancellationToken.None, Context()));
        Assert.EndsWith(@"Art\Splash.png", game.LocalArtwork[ArtworkKind.Hero]);
        Assert.EndsWith(@"Art\Splash.png", game.LocalArtwork[ArtworkKind.Header]);
        Assert.EndsWith("StoreLogo.scale-400.png", game.LocalArtwork[ArtworkKind.Icon]);
    }

    // ---------- Last played, estimated from save data ----------

    private string Packages => Path.Combine(_tmp.Path, "Packages");

    private void Touch(string relative, DateTime utc)
    {
        var full = _tmp.Write(Path.Combine("Packages", relative), "x");
        File.SetLastWriteTimeUtc(full, utc);
    }

    [Fact]
    public void Last_played_is_the_newest_write_in_the_save_data_folders()
    {
        Touch($@"{Forza}\SystemAppData\wgs\000901F\container.1", new DateTime(2026, 10, 9, 21, 15, 0, DateTimeKind.Utc));
        Touch($@"{Forza}\LocalState\settings.dat", new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc));
        Touch($@"{Forza}\AC\INetCache\x.dat", new DateTime(2026, 8, 1, 0, 0, 0, DateTimeKind.Utc));
        // Outside the save-data folders (Settings is Windows' own) and in the future: both ignored.
        Touch($@"{Forza}\Settings\settings.dat", new DateTime(2026, 10, 10, 11, 0, 0, DateTimeKind.Utc));
        Touch($@"{Forza}\TempState\clock-skew.tmp", new DateTime(2027, 1, 1, 0, 0, 0, DateTimeKind.Utc));

        Assert.Equal(new DateTimeOffset(2026, 10, 9, 21, 15, 0, TimeSpan.Zero), XboxAdapter.EstimateLastPlayed(Packages, Forza, Now));
    }

    [Fact]
    public void No_save_data_means_no_estimate()
    {
        Assert.Null(XboxAdapter.EstimateLastPlayed(Packages, Forza, Now));
        _tmp.Dir($@"Packages\{Forza}\LocalState");
        Assert.Null(XboxAdapter.EstimateLastPlayed(Packages, Forza, Now));
        Assert.Null(XboxAdapter.EstimateLastPlayed(null, Forza, Now));
        Assert.Null(XboxAdapter.EstimateLastPlayed(Packages, @"..\..\Windows", Now));
    }

    [Fact]
    public void The_scan_reports_the_estimate_labelled_as_save_data()
    {
        var dir = MakeForza();
        Touch($@"{Forza}\LocalState\save.dat", new DateTime(2026, 10, 9, 21, 15, 0, DateTimeKind.Utc));
        var game = Assert.Single(XboxAdapter.Discover([Pkg(Forza, "Forza Horizon 4", dir)], [], CancellationToken.None, Context(packagesRoot: Packages)));
        Assert.Equal(new DateTimeOffset(2026, 10, 9, 21, 15, 0, TimeSpan.Zero), game.LastPlayed);
        Assert.Equal(LastPlayedSources.SaveData, game.LastPlayedSource);
    }

    // ---------- Other drives, non-games ----------

    [Fact]
    public void A_drive_with_an_XboxGames_folder_but_no_marker_file_still_counts()
    {
        var drive = _tmp.Dir("DriveE");
        var folder = _tmp.Dir(@"DriveE\XboxGames");
        Assert.Equal([folder], XboxAdapter.FindGamingFolders([drive]));

        var gameDir = _tmp.Dir(@"DriveE\XboxGames\Older\Content");
        _tmp.Write(@"DriveE\XboxGames\Older\Content\AppxManifest.xml", UwpManifest("""
            <Application Id="App" Executable="Older.exe" EntryPoint="x">
              <uap:VisualElements DisplayName="Older Game" Square150x150Logo="a.png" Square44x44Logo="a.png" Description="d" BackgroundColor="#000000" />
            </Application>
            """));
        var game = Assert.Single(XboxAdapter.Discover([Pkg("Older.Game_abc", "Older Game", gameDir, full: "Older.Game_1.0.0.0_x64__abc")],
            XboxAdapter.FindGamingFolders([drive]), CancellationToken.None, Context()));
        Assert.Equal("Older Game", game.Title);
    }

    [Fact]
    public void Microsofts_Xbox_apps_are_still_excluded_even_inside_a_games_folder()
    {
        var root = _tmp.Dir(@"DriveF\XboxGames");
        var overlay = _tmp.Dir(@"DriveF\XboxGames\Overlay");
        _tmp.Write(@"DriveF\XboxGames\Overlay\AppxManifest.xml", UwpManifest("""
            <Application Id="App" Executable="GameBar.exe" EntryPoint="x">
              <uap:VisualElements DisplayName="Game Bar" Square150x150Logo="a.png" Square44x44Logo="a.png" Description="d" BackgroundColor="#000000" />
            </Application>
            """));
        var app = _tmp.Dir(@"WindowsApps\GamingApp");
        _tmp.Write(@"WindowsApps\GamingApp\AppxManifest.xml", UwpManifest());
        _tmp.Write(@"WindowsApps\GamingApp\xboxservices.config", "{}");

        Assert.Empty(XboxAdapter.Discover(
            [Pkg("Microsoft.XboxGamingOverlay_8wekyb3d8bbwe", "Game Bar", overlay), Pkg("Microsoft.GamingApp_8wekyb3d8bbwe", "Xbox", app)],
            [root], CancellationToken.None, Context()));
    }

    // ---------- Sizes ----------

    [Fact]
    public void MeasureFolder_adds_up_every_file_below_the_folder()
    {
        _tmp.Write(@"Pkg\a.bin", new string('a', 1000));
        _tmp.Write(@"Pkg\Sub\b.bin", new string('b', 2500));
        _tmp.Write(@"Pkg\Sub\Deeper\c.bin", new string('c', 500));
        _tmp.Write(@"Other\d.bin", new string('d', 9999));

        Assert.Equal(4000, PackageSizeService.MeasureFolder(Path.Combine(_tmp.Path, "Pkg"), CancellationToken.None));
        Assert.Null(PackageSizeService.MeasureFolder(Path.Combine(_tmp.Path, "Nope"), CancellationToken.None));
        Assert.Null(PackageSizeService.MeasureFolder(Path.Combine(_tmp.Path, "Pkg"), CancellationToken.None, maxEntries: 2)); // implausibly many entries
    }

    private sealed class Events : IEventSink
    {
        public readonly ConcurrentQueue<(string Name, object? Payload)> Seen = new();
        public void Emit(string eventName, object? payload) => Seen.Enqueue((eventName, payload));
    }

    private static DiscoveredInstallation XboxInstall(string path, string? version, DateTimeOffset? lastPlayed = null) =>
        Install(PlatformId.Xbox, "Microsoft.SunriseBaseGame", "Forza Horizon 4", path) with
        {
            Version = version,
            InstalledAt = new DateTimeOffset(2025, 3, 12, 9, 30, 0, TimeSpan.Zero),
            Publisher = "Microsoft Studios",
            LastPlayed = lastPlayed,
            LastPlayedSource = lastPlayed is null ? null : LastPlayedSources.SaveData,
        };

    [Fact]
    public async Task Sizes_are_measured_once_per_package_version_and_kept_across_scans()
    {
        using var t = new TestDb();
        const string path = @"C:\Program Files\WindowsApps\Microsoft.SunriseBaseGame_1.478.564.2_x64__8wekyb3d8bbwe";
        t.Repo.ApplyScan([Ok(PlatformId.Xbox, XboxInstall(path, "1.478.564.2"))]);
        var events = new Events();
        var measured = new List<string>();
        var service = new PackageSizeService(t.Repo, events, () => false)
        {
            Measure = (p, _) => { measured.Add(p); return 85_266_000_000L; },
        };

        Assert.Equal(1, await service.RunAsync(CancellationToken.None));
        Assert.Contains(events.Seen, e => e.Name == "library.changed");
        var inst = Snap(t).Installations.Single();
        Assert.Equal(85_266_000_000L, inst.SizeBytes);
        Assert.Equal("C:", inst.Drive); // WindowsApps lives on a drive Storage Studio knows

        // Rescans don't report a size: the measured one stays, and nothing is measured again.
        t.Repo.ApplyScan([Ok(PlatformId.Xbox, XboxInstall(path, "1.478.564.2"))]);
        Assert.Equal(85_266_000_000L, Snap(t).Installations.Single().SizeBytes);
        Assert.Equal(0, await service.RunAsync(CancellationToken.None));
        Assert.Single(measured);

        // An update changes the version: measured again.
        t.Repo.ApplyScan([Ok(PlatformId.Xbox, XboxInstall(path, "1.479.000.0"))]);
        Assert.Equal(1, await service.RunAsync(CancellationToken.None));
        Assert.Equal(2, measured.Count);
    }

    [Fact]
    public async Task Measuring_waits_while_a_game_runs()
    {
        using var t = new TestDb();
        t.Repo.ApplyScan([Ok(PlatformId.Xbox, XboxInstall(@"D:\XboxGames\Forza\Content", "1.0.0.0"))]);
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        var service = new PackageSizeService(t.Repo, NullEventSink.Instance, () => true) { Measure = (_, _) => 1 };
        Assert.Equal(0, await service.RunAsync(cts.Token));
        Assert.Null(Snap(t).Installations.Single().SizeBytes);
    }

    private static GameDto Snap(TestDb t) => t.Repo.LoadSnapshot((g, f) => $"art://{g}/{f}").Games.Single();

    [Fact]
    public void Package_details_and_the_estimate_reach_the_library_honestly_labelled()
    {
        using var t = new TestDb();
        var estimate = new DateTimeOffset(2026, 10, 9, 21, 15, 0, TimeSpan.Zero);
        t.Repo.ApplyScan([Ok(PlatformId.Xbox, XboxInstall(@"C:\Program Files\WindowsApps\Forza", "1.478.564.2", estimate))]);

        var game = Snap(t);
        var inst = game.Installations.Single();
        Assert.Equal("Microsoft Studios", game.Publisher);
        Assert.Equal("1.478.564.2", inst.Version);
        Assert.Equal(new DateTimeOffset(2025, 3, 12, 9, 30, 0, TimeSpan.Zero), DateTimeOffset.Parse(inst.InstalledAt!));
        Assert.Equal(estimate, DateTimeOffset.Parse(inst.ImportedLastPlayed!));
        Assert.Equal("saveData", inst.LastPlayedSource);

        // An older estimate never replaces a newer one; the label follows the value that's kept.
        t.Repo.ApplyScan([Ok(PlatformId.Xbox, XboxInstall(@"C:\Program Files\WindowsApps\Forza", "1.478.564.2", estimate.AddDays(-3)))]);
        Assert.Equal(estimate, DateTimeOffset.Parse(Snap(t).Installations.Single().ImportedLastPlayed!));
        Assert.Equal("saveData", Snap(t).Installations.Single().LastPlayedSource);
    }

    [Fact]
    public void The_package_publisher_only_fills_an_empty_field()
    {
        using var t = new TestDb();
        t.Repo.ApplyScan([Ok(PlatformId.Xbox, XboxInstall(@"C:\X", "1.0.0.0"))]);
        var id = Snap(t).Id;
        t.Repo.SetMetadata(id, "steam", null, null, "Playground Games", null, []);
        t.Repo.ApplyScan([Ok(PlatformId.Xbox, XboxInstall(@"C:\X", "1.0.0.0"))]);
        Assert.Equal("Playground Games", Snap(t).Publisher);
    }
}
