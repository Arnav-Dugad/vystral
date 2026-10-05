using Vystral.Core.Domain;
using Vystral.Core.Integrations;
using Vystral.Tests.Support;
using Vystral.Windows.Integrations;
using Xunit;

namespace Vystral.Tests.Integrations;

public sealed class SteamAdapterTests : IDisposable
{
    private readonly TempDir _tmp = new();
    private readonly string _steam;
    private readonly FakeRegistry _reg = new();

    public SteamAdapterTests()
    {
        _steam = _tmp.Dir("Steam");
        // Steam stores SteamPath with forward slashes.
        _reg.Set(Hive.CurrentUser, @"Software\Valve\Steam", "SteamPath", _steam.Replace('\\', '/'));
    }

    public void Dispose() => _tmp.Dispose();

    private static string Esc(string path) => path.Replace(@"\", @"\\");

    private void WriteManifest(string library, string appId, string name, string installDir, int flags, bool createDir = true,
        long lastPlayed = 0, long size = 1000)
    {
        _tmp.Write(Path.Combine(library, "steamapps", $"appmanifest_{appId}.acf"), $$"""
            "AppState"
            {
            	"appid"		"{{appId}}"
            	"name"		"{{name}}"
            	"StateFlags"		"{{flags}}"
            	"installdir"		"{{installDir}}"
            	"LastPlayed"		"{{lastPlayed}}"
            	"SizeOnDisk"		"{{size}}"
            }
            """);
        if (createDir) _tmp.Dir(Path.Combine(library, "steamapps", "common", installDir));
    }

    [Fact]
    public void LibraryFolders_NewFormat_ReadsPathKeys()
    {
        var second = _tmp.Dir("Lib2");
        _tmp.Write(@"Steam\steamapps\libraryfolders.vdf", $$"""
            "libraryfolders"
            {
            	"0"
            	{
            		"path"		"{{Esc(_steam)}}"
            		"label"		""
            		"apps" { "620" "123" }
            	}
            	"1"
            	{
            		"path"		"{{Esc(second)}}"
            	}
            }
            """);

        var folders = SteamAdapter.GetLibraryFolders(_steam);

        Assert.Equal(2, folders.Count);
        Assert.Contains(folders, f => string.Equals(f, second, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void LibraryFolders_LegacyFormat_ReadsValuesAndIgnoresMetadataKeys()
    {
        var second = _tmp.Dir("OldLib");
        _tmp.Write(@"Steam\steamapps\libraryfolders.vdf", $$"""
            "LibraryFolders"
            {
            	"TimeNextStatsReport"		"1234567"
            	"ContentStatsID"		"-123"
            	"1"		"{{Esc(second)}}"
            }
            """);

        var folders = SteamAdapter.GetLibraryFolders(_steam);

        Assert.Equal(new[] { _steam, second }, folders);
    }

    [Fact]
    public void LibraryFolders_CorruptFile_StillReturnsMainLibrary()
    {
        _tmp.Write(@"Steam\steamapps\libraryfolders.vdf", "\"libraryfolders\" { \"0\" { \"path\" ");
        Assert.Equal(new[] { _steam }, SteamAdapter.GetLibraryFolders(_steam));
    }

    [Fact]
    public void Discover_HonoursStateFlagsAndSkipsRedistAndMissingFolders()
    {
        WriteManifest("Steam", "620", "Portal 2", "Portal 2", flags: 4, size: 5000);
        WriteManifest("Steam", "570", "Updating Game", "Updating", flags: 4 | 2 | 1024);
        WriteManifest("Steam", "440", "Not Installed", "TF2", flags: 1 | 1024);
        WriteManifest("Steam", "228980", "Steamworks Common Redistributables", "Steamworks Shared", flags: 4);
        WriteManifest("Steam", "730", "Gone", "Gone", flags: 4, createDir: false);
        _tmp.Write(@"Steam\steamapps\appmanifest_999.acf", "\"AppState\" { \"appid\" ");

        var games = new SteamAdapter(_reg).Discover(_steam, CancellationToken.None);

        Assert.Equal(new[] { "570", "620" }, games.Select(g => g.PlatformGameId).Order());
        var portal = games.Single(g => g.PlatformGameId == "620");
        Assert.Equal("Portal 2", portal.Title);
        Assert.Equal(5000, portal.SizeBytes);
        Assert.Equal(new LaunchTarget(LaunchKind.Uri, "steam://rungameid/620"), portal.Launch);
        Assert.True(portal.ClientRequired);
        Assert.Equal("620", portal.SteamAppId);
        Assert.Equal(Path.Combine(_steam, "steamapps", "common", "Portal 2"), portal.InstallPath);
    }

    [Fact]
    public void Discover_FindsGamesInSecondaryLibrary_AndDedupesAppIds()
    {
        var lib2 = _tmp.Dir("Lib2");
        _tmp.Write(@"Steam\steamapps\libraryfolders.vdf", $$"""
            "libraryfolders" { "0" { "path" "{{Esc(_steam)}}" } "1" { "path" "{{Esc(lib2)}}" } }
            """);
        WriteManifest("Lib2", "620", "Portal 2", "Portal 2", flags: 4);
        WriteManifest("Steam", "620", "Portal 2", "Portal 2", flags: 4);

        var games = new SteamAdapter(_reg).Discover(_steam, CancellationToken.None);

        Assert.Single(games);
    }

    [Fact]
    public void LocalActivity_UsesMostRecentLoginUser_AndLargestDuplicatePlaytime()
    {
        // Two accounts: 76561197960265729 -> account 1, 76561197960265730 -> account 2 (MostRecent).
        _tmp.Write(@"Steam\config\loginusers.vdf", """
            "users"
            {
            	"76561197960265729" { "AccountName" "first" "MostRecent" "0" }
            	"76561197960265730" { "AccountName" "second" "MostRecent" "1" }
            }
            """);
        _tmp.Write(@"Steam\userdata\1\config\localconfig.vdf", """
            "UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "620" { "Playtime" "999" } } } } } }
            """);
        _tmp.Write(@"Steam\userdata\2\config\localconfig.vdf", """
            "UserLocalConfigStore"
            {
            	"Software"
            	{
            		"valve"
            		{
            			"Steam"
            			{
            				"apps"
            				{
            					"7" { "cloud" { "last_sync_state" "synchronized" } }
            					"620"
            					{
            						"cloud" { "quota_bytes" "1" }
            						"Playtime"		"1"
            						"Playtime2wks"		"175"
            						"Playtime"		"175"
            						"LastPlayed"		"1700000000"
            					}
            				}
            			}
            		}
            	}
            }
            """);

        Assert.Equal("2", SteamAdapter.FindMostRecentAccountId(_steam));
        var activity = SteamAdapter.ReadLocalActivity(_steam);

        Assert.Equal(175, activity["620"].Minutes);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1700000000), activity["620"].LastPlayed);
        Assert.Null(activity["7"].Minutes);
    }

    [Fact]
    public void Discover_MergesLastPlayedFromManifestAndLocalConfig()
    {
        _tmp.Write(@"Steam\config\loginusers.vdf", """ "users" { "76561197960265730" { "MostRecent" "1" } } """);
        _tmp.Write(@"Steam\userdata\2\config\localconfig.vdf", """
            "UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "620" { "Playtime" "60" "LastPlayed" "1600000000" } } } } } }
            """);
        WriteManifest("Steam", "620", "Portal 2", "Portal 2", flags: 4, lastPlayed: 1700000000);

        var game = Assert.Single(new SteamAdapter(_reg).Discover(_steam, CancellationToken.None));

        Assert.Equal(60, game.PlaytimeMinutes);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1700000000), game.LastPlayed);
    }

    [Fact]
    public void LocalArtwork_FindsFlatAndHashedSubfolderFiles()
    {
        var cache = @"Steam\appcache\librarycache\620";
        _tmp.Write($@"{cache}\header.jpg", "h");
        _tmp.Write($@"{cache}\2de9fd7bd3e54f6300246e63d6187db97e72b5e4\library_600x900.jpg", "c");
        _tmp.Write($@"{cache}\56ea5142d370d5437ad6595ec87d16508a9893a2\library_hero.jpg", "x");
        _tmp.Write($@"{cache}\e596dc8576fb2ec7061173ab2499369d35777a7a\logo.png", "l");

        var art = SteamAdapter.FindLocalArtwork(_steam, "620");

        Assert.EndsWith(@"2de9fd7bd3e54f6300246e63d6187db97e72b5e4\library_600x900.jpg", art[ArtworkKind.Cover]);
        Assert.EndsWith("library_hero.jpg", art[ArtworkKind.Hero]);
        Assert.EndsWith("logo.png", art[ArtworkKind.Logo]);
        Assert.EndsWith("header.jpg", art[ArtworkKind.Header]);
    }

    [Fact]
    public void LocalArtwork_FindsStoreAssetNamedCoversForNewerApps()
    {
        var cache = @"Steam\appcache\librarycache\3059520";
        _tmp.Write($@"{cache}\660d69e1717e93fcabc23f85100d123892ace85c\library_capsule.jpg", "c");
        _tmp.Write($@"{cache}\acf774ad92979047362e1be3ca6bad2b6b090ac4.jpg", "unnamed");

        var art = SteamAdapter.FindLocalArtwork(_steam, "3059520");

        Assert.EndsWith(@"660d69e1717e93fcabc23f85100d123892ace85c\library_capsule.jpg", art[ArtworkKind.Cover]);
        Assert.Single(art);
    }

    [Fact]
    public void Status_AndClientPage()
    {
        var adapter = new SteamAdapter(_reg);
        Assert.Equal(ClientStatus.Error, adapter.GetStatus().Status);
        _tmp.Write(@"Steam\steam.exe", "");
        Assert.Equal(ClientStatus.Available, adapter.GetStatus().Status);
        Assert.Equal("steam://nav/games/details/620", adapter.GetClientPageUri("620"));
        Assert.Null(adapter.GetClientPageUri("not-an-id"));
        Assert.Equal(ClientStatus.NotInstalled, new SteamAdapter(new FakeRegistry()).GetStatus().Status);
    }
}
