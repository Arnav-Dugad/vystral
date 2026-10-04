using System.Text.Json;
using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Xunit;

namespace Vystral.Tests.Integrations;

public sealed class EpicAdapterTests : IDisposable
{
    private readonly TempDir _tmp = new();
    private readonly AdapterEnvironment _env;
    private readonly FakeRegistry _reg = new();

    public EpicAdapterTests()
    {
        _env = new AdapterEnvironment(_tmp.Dir("ProgramData"), _tmp.Dir("LocalAppData"), _tmp.Dir("PF"), _tmp.Dir("PF86"));
    }

    public void Dispose() => _tmp.Dispose();

    private EpicAdapter Adapter => new(_reg, _env);

    private const string Manifests = @"ProgramData\Epic\EpicGamesLauncher\Data\Manifests";

    private void WriteManifest(string file, object manifest) =>
        _tmp.Write($@"{Manifests}\{file}.item", JsonSerializer.Serialize(manifest));

    private object Game(string appName, string displayName, string installDir, string[]? categories = null,
        string? mainGame = null, string launchExe = "Binaries/Win64/Game.exe", string ns = "ns1", string item = "item1") => new
    {
        FormatVersion = 0,
        AppName = appName,
        CatalogNamespace = ns,
        CatalogItemId = item,
        DisplayName = displayName,
        InstallLocation = installDir,
        LaunchExecutable = launchExe,
        AppCategories = categories ?? new[] { "public", "games", "applications" },
        MainGameAppName = mainGame ?? appName,
        InstallSize = 123456,
        CompatibleApps = Array.Empty<string>(),
        TechnicalType = "games,applications",
    };

    [Fact]
    public void Discover_ReadsGame_WithExactLaunchUri()
    {
        var dir = _tmp.Dir(@"Games\Fortnite");
        WriteManifest("A1", Game("Fortnite", "Fortnite", dir, ns: "fn", item: "4fe75bbc5a674f4f9b356b5c90567da5"));

        var game = Assert.Single(Adapter.Discover(CancellationToken.None));

        Assert.Equal("Fortnite", game.PlatformGameId);
        Assert.Equal("Fortnite", game.Title);
        Assert.Equal(dir, game.InstallPath);
        Assert.Equal(123456, game.SizeBytes);
        Assert.Equal(LaunchKind.Uri, game.Launch.Kind);
        Assert.Equal("com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true", game.Launch.Value);
        Assert.True(game.ClientRequired);
        Assert.Equal(new[] { "Game.exe" }, game.ProcessHints);
    }

    [Fact]
    public void Discover_FiltersDlcPluginsAndBrokenManifests()
    {
        var dir = _tmp.Dir(@"Games\Base");
        WriteManifest("base", Game("Base", "Base Game", dir));
        WriteManifest("dlc", Game("BaseDlc", "Base DLC", _tmp.Dir(@"Games\Dlc"), categories: new[] { "public", "addons" }, mainGame: "Base"));
        WriteManifest("launchable", Game("Spinoff", "Launchable Addon", _tmp.Dir(@"Games\Spinoff"),
            categories: new[] { "addons", "addons/launchable" }, mainGame: "Base"));
        WriteManifest("plugin", Game("UEPlugin", "Some Plugin", _tmp.Dir(@"Games\Plugin"), categories: new[] { "plugins", "plugins/engine" }));
        WriteManifest("nons", Game("NoNamespace", "No Namespace", _tmp.Dir(@"Games\NoNs"), ns: ""));
        WriteManifest("missingdir", Game("Missing", "Missing", Path.Combine(_tmp.Path, "nope")));
        _tmp.Write($@"{Manifests}\broken.item", "{ \"AppName\": ");
        _tmp.Write($@"{Manifests}\empty.item", "");

        var games = Adapter.Discover(CancellationToken.None);

        Assert.Equal(new[] { "Base", "Spinoff" }, games.Select(g => g.PlatformGameId).Order());
    }

    [Fact]
    public void Discover_FallsBackToLauncherInstalledLocation_WhenManifestPathIsStale()
    {
        var real = _tmp.Dir(@"Moved\Game");
        WriteManifest("g", Game("Moved", "Moved Game", @"D:\does\not\exist"));
        _tmp.Write(@"ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat", JsonSerializer.Serialize(new
        {
            InstallationList = new[] { new { InstallLocation = real.Replace('\\', '/'), AppName = "Moved", AppID = 0, AppVersion = "1" } },
        }));

        var game = Assert.Single(Adapter.Discover(CancellationToken.None));

        Assert.Equal(real, game.InstallPath);
    }

    [Fact]
    public void Discover_DuplicateManifests_PreferTheOneMatchingLauncherInstalled()
    {
        var oldDir = _tmp.Dir(@"Old\Game");
        var newDir = _tmp.Dir(@"New\Game");
        WriteManifest("1", Game("Dup", "Dup", oldDir));
        WriteManifest("2", Game("Dup", "Dup", newDir));
        _tmp.Write(@"ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat",
            JsonSerializer.Serialize(new { InstallationList = new[] { new { InstallLocation = newDir, AppName = "Dup" } } }));

        var game = Assert.Single(Adapter.Discover(CancellationToken.None));

        Assert.Equal(newDir, game.InstallPath);
    }

    [Fact]
    public void Status_ReflectsLauncherPresence()
    {
        Assert.Equal(ClientStatus.NotInstalled, Adapter.GetStatus().Status);

        _tmp.Dir(Manifests);
        Assert.Equal(ClientStatus.Error, Adapter.GetStatus().Status);

        var root = _tmp.Dir(@"Custom\Epic Games");
        _tmp.Write(@"Custom\Epic Games\Launcher\Portal\Binaries\Win32\EpicGamesLauncher.exe", "");
        _reg.Set(Hive.LocalMachine, @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{EPIC}", "DisplayName", "Epic Games Launcher")
            .Set(Hive.LocalMachine, @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{EPIC}", "InstallLocation", root + "\\");
        var status = Adapter.GetStatus();
        Assert.Equal(ClientStatus.Available, status.Status);
        Assert.EndsWith(@"Win32\EpicGamesLauncher.exe", status.ClientPath);
        Assert.Equal(EpicAdapter.LibraryUri, Adapter.GetClientPageUri("Fortnite"));
    }
}
