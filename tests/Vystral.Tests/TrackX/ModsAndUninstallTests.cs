using Vystral.Core.Files;
using Vystral.Tests.Support;
using Vystral.Windows.Storage;
using Xunit;

namespace Vystral.Tests.TrackX;

public sealed class ModManifestTests
{
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "TrackX", name));

    [Fact]
    public void App_workshop_manifest_lists_installed_items()
    {
        var m = ModManifests.ParseAppWorkshop(Fixture("appworkshop_255710.acf"));
        Assert.Equal("255710", m.AppId);
        Assert.Equal(734003200, m.SizeOnDisk);
        Assert.True(m.NeedsUpdate);
        Assert.Equal(2, m.Items.Count); // the item with a non-numeric id is skipped
        var item = Assert.Single(m.Items, i => i.ItemId == "1234567890");
        Assert.Equal(524288000, item.Size);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1700000000), item.Updated);
        Assert.Null(Assert.Single(m.Items, i => i.ItemId == "2234567890").Size); // negative size → unknown
    }

    [Theory]
    [InlineData("\"AppState\" { \"appid\" \"1\" }")]
    [InlineData("\"AppWorkshop\" { \"appid\" \"../1\" }")]
    [InlineData("\"AppWorkshop\" \"flat\"")]
    [InlineData("{{{")]
    public void Other_files_are_rejected(string text) => Assert.Throws<FormatException>(() => ModManifests.ParseAppWorkshop(text));

    [Fact]
    public void Mod_organizer_ini_and_modlist()
    {
        var ini = ModManifests.ParseMo2Ini("""
            [General]
            gameName=Skyrim Special Edition
            gamePath=@ByteArray(D:\\Games\\Skyrim Special Edition)
            selected_profile=@ByteArray(Default)

            [Settings]
            mod_directory=E:\\MO2\\mods
            """);
        Assert.Equal("Skyrim Special Edition", ini.GameName);
        Assert.Equal(@"D:\Games\Skyrim Special Edition", ini.GamePath);
        Assert.Equal("Default", ini.SelectedProfile);
        Assert.Equal(@"E:\MO2\mods", ini.ModsDirectory);

        // UNC, relative and traversal paths aren't followed.
        Assert.Null(ModManifests.ParseMo2Ini("[General]\ngamePath=\\\\\\\\server\\\\share").GamePath);
        Assert.Null(ModManifests.ParseMo2Ini("[General]\ngamePath=games\\x").GamePath);
        Assert.Null(ModManifests.ParseMo2Ini("[Settings]\nmod_directory=C:\\\\a\\\\..\\\\b").ModsDirectory);

        var list = ModManifests.ParseModlist("# This file was automatically generated\n+SkyUI\n-Old Patch\n*DLC: Dawnguard\n+SkyUI\n");
        Assert.True(list["SkyUI"]);
        Assert.False(list["Old Patch"]);
        Assert.False(list.ContainsKey("DLC: Dawnguard"));
    }

    [Fact]
    public void Published_file_details_are_validated_and_cleaned()
    {
        var titles = ModManifests.ParsePublishedFileDetails("""
            {"response":{"result":1,"resultcount":4,"publishedfiledetails":[
              {"publishedfileid":"1234567890","result":1,"title":"Better Roads\u202E evil","time_updated":1700000000},
              {"publishedfileid":"2234567890","result":9},
              {"publishedfileid":"../x","result":1,"title":"Nope"},
              {"publishedfileid":"3234567890","result":1,"title":"   "}
            ]}}
            """);
        var t = Assert.Single(titles);
        Assert.Equal(("1234567890", "Better Roads evil"), (t.ItemId, t.Title));
        Assert.Empty(ModManifests.ParsePublishedFileDetails("not json"));
        Assert.Empty(ModManifests.ParsePublishedFileDetails("""{"response":{"publishedfiledetails":"x"}}"""));
        Assert.Equal(120, ModManifests.CleanTitle(new string('a', 500)).Length);
    }
}

public sealed class ModFoldersTests : IDisposable
{
    private readonly TempDir _dir = new();
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "TrackX", name));
    private const string GameId = "0123456789abcdef0123456789abcdef";

    public void Dispose() => _dir.Dispose();

    private ModFolders Folders() => new(() => Path.Combine(_dir.Path, "steam"), Path.Combine(_dir.Path, "cache"))
    {
        RoamingAppData = () => Path.Combine(_dir.Path, "roaming"),
        LocalAppData = () => Path.Combine(_dir.Path, "local"),
    };

    [Fact]
    public void Workshop_items_come_from_the_manifest_and_the_content_folder()
    {
        _dir.Write(Path.Combine("steam", "steamapps", "workshop", "appworkshop_255710.acf"), Fixture("appworkshop_255710.acf"));
        _dir.Write(Path.Combine("steam", "steamapps", "workshop", "content", "255710", "1234567890", "mod.dat"), "1234");
        _dir.Write(Path.Combine("steam", "steamapps", "workshop", "content", "255710", "9999", "extra.dat"), "123456");
        _dir.Dir(Path.Combine("steam", "steamapps", "workshop", "content", "255710", "not-an-id"));
        var mods = Folders();

        var dto = mods.List(GameId, "255710", [], "Cities", _ => "off");
        var source = Assert.Single(dto.Sources);
        Assert.Equal(("workshop", 3), (source.Kind, source.Count)); // 2 in the manifest + 1 only on disk
        Assert.Equal(734003200, source.Bytes); // Steam's own total
        Assert.Equal(6, source.Items.Single(i => i.Id == "9999").Bytes); // measured
        Assert.False(source.Items.Single(i => i.Id == "2234567890").Present);
        Assert.Equal("off", dto.Titles);
        Assert.Equal(3, dto.MissingTitles);
        Assert.NotNull(mods.FolderFor(GameId, "workshop", "9999"));
        Assert.Null(mods.FolderFor(GameId, "workshop", "2234567890")); // not on disk: nothing to open
        Assert.Null(mods.FolderFor("ffffffffffffffffffffffffffffffff", "workshop", null));

        mods.SaveTitles([new WorkshopTitle("9999", "Extra Parks", null)]);
        var again = mods.List(GameId, "255710", [], "Cities", n => n == 0 ? "done" : "ready");
        Assert.Equal("Extra Parks", again.Sources[0].Items.Single(i => i.Id == "9999").Title);
        Assert.Equal("ready", again.Titles);
        Assert.DoesNotContain("9999", mods.UntitledWorkshopItems(GameId));
    }

    [Fact]
    public void Vortex_and_mod_organizer_folders_are_found_in_their_default_places()
    {
        var game = _dir.Dir(Path.Combine("games", "Skyrim Special Edition"));
        _dir.Write(Path.Combine("roaming", "Vortex", "skyrimse", "mods", "SkyUI-12604", "SkyUI.esp"), "12345678");
        _dir.Write(Path.Combine("local", "ModOrganizer", "Skyrim SE", "ModOrganizer.ini"),
            $"[General]\ngameName=Skyrim Special Edition\ngamePath=@ByteArray({game.Replace("\\", "\\\\")})\nselected_profile=@ByteArray(Default)\n");
        _dir.Write(Path.Combine("local", "ModOrganizer", "Skyrim SE", "mods", "Alpha", "a.esp"), "1");
        _dir.Write(Path.Combine("local", "ModOrganizer", "Skyrim SE", "mods", "Beta", "b.esp"), "22");
        _dir.Write(Path.Combine("local", "ModOrganizer", "Skyrim SE", "profiles", "Default", "modlist.txt"), "+Alpha\n-Beta\n");
        // Another instance for a different game is ignored.
        _dir.Write(Path.Combine("local", "ModOrganizer", "Fallout", "ModOrganizer.ini"), "[General]\ngameName=Fallout 4\ngamePath=@ByteArray(C:\\\\Other)\n");

        var dto = Folders().List(GameId, "489830", [game], "The Elder Scrolls V: Skyrim Special Edition", _ => "none");
        var vortex = Assert.Single(dto.Sources, s => s.Kind == "vortex");
        Assert.Equal((1, 8L), (vortex.Count, vortex.Bytes));
        var mo2 = Assert.Single(dto.Sources, s => s.Kind == "mo2");
        Assert.Equal(2, mo2.Count);
        Assert.True(mo2.Items.Single(i => i.Name == "Alpha").Enabled);
        Assert.False(mo2.Items.Single(i => i.Name == "Beta").Enabled);
        Assert.Contains("1 of 2 on", mo2.Detail);
        Assert.Matches("^[0-9a-f]{16}$", mo2.Items[0].Id);
    }

    [Fact]
    public void Nothing_found_is_an_empty_list()
    {
        var dto = Folders().List(GameId, null, [], "Something", _ => "off");
        Assert.Empty(dto.Sources);
        Assert.Equal("notSteam", dto.Titles);
    }
}

public sealed class UninstallFactsTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Steam_cloud_comes_from_remotecache_or_the_remote_folder()
    {
        var steam = _dir.Dir("steam");
        _dir.Write(Path.Combine("steam", "userdata", "42", "620", "remotecache.vdf"), """
            "620"
            {
                "ChangeNumber" "12"
                "save1.sav" { "root" "0" "size" "1000" "time" "1700000000" }
                "save2.sav" { "root" "0" "size" "500" "remotetime" "1700000500" }
            }
            """);
        var cloud = UninstallFacts.SteamCloud(steam, "42", "620");
        Assert.Equal(("steamCloud", 2, 1500L), (cloud.State, cloud.Files, cloud.Bytes));
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1700000500).ToString("O"), cloud.LastSync);

        _dir.Write(Path.Combine("steam", "userdata", "42", "440", "remote", "cfg", "config.cfg"), "abc");
        Assert.Equal(("steamCloud", 1), (UninstallFacts.SteamCloud(steam, "42", "440").State, UninstallFacts.SteamCloud(steam, "42", "440").Files));
        Assert.Equal("localOnly", UninstallFacts.SteamCloud(steam, "42", "570").State);
        Assert.Equal("unknown", UninstallFacts.SteamCloud(null, "42", "570").State);
        Assert.Equal("unknown", UninstallFacts.SteamCloud(steam, "..\\..", "570").State);
        Assert.Equal("unknown", UninstallFacts.SteamCloud(steam, "42", "../570").State);
    }

    [Fact]
    public void Redownload_size_is_read_from_the_app_manifest()
    {
        var steam = _dir.Dir("steam");
        _dir.Write(Path.Combine("steam", "steamapps", "appmanifest_620.acf"), "\"AppState\" { \"appid\" \"620\" \"SizeOnDisk\" \"13000000000\" }");
        Assert.Equal(13000000000, UninstallFacts.SteamSizeOnDisk(steam, "620"));
        Assert.Null(UninstallFacts.SteamSizeOnDisk(steam, "440"));
        Assert.Null(UninstallFacts.SteamSizeOnDisk(steam, "62x"));
    }
}
