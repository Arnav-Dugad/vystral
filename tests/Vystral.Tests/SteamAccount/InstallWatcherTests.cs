using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using Xunit;
using static Vystral.Windows.Services.InstallWatcher;

namespace Vystral.Tests.SteamAccount;

public sealed class InstallWatcherTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private static string Manifest(string appId, long flags, long dl = 0, long toDl = 0, long staged = 0, long toStage = 0) => $$"""
        "AppState"
        {
            "appid"		"{{appId}}"
            "name"		"Test Game"
            "StateFlags"		"{{flags}}"
            "installdir"		"Test Game"
            "BytesToDownload"		"{{toDl}}"
            "BytesDownloaded"		"{{dl}}"
            "BytesToStage"		"{{toStage}}"
            "BytesStaged"		"{{staged}}"
        }
        """;

    private static ManifestState State(long flags, long dl = 0, long toDl = 0, long staged = 0, long toStage = 0) =>
        new("10", flags, dl, toDl, staged, toStage);

    // ---------- Parsing ----------

    [Fact]
    public void ParseManifest_reads_progress_fields()
    {
        var s = ParseManifest(Manifest("620", 1026, dl: 500, toDl: 2000, staged: 100, toStage: 1800));
        Assert.Equal(new ManifestState("620", 1026, 500, 2000, 100, 1800), s);
    }

    [Theory]
    [InlineData("")]
    [InlineData("\"AppState\" { \"appid\" \"abc\" }")]
    [InlineData("\"Other\" { \"appid\" \"10\" }")]
    [InlineData("\"AppState\" {")]
    public void ParseManifest_returns_null_for_unusable_files(string text) => Assert.Null(ParseManifest(text));

    [Fact]
    public void ParseManifest_clamps_negative_counters()
    {
        var s = ParseManifest(Manifest("620", 1026, dl: -5, toDl: 10))!;
        Assert.Equal(0, s.BytesDownloaded);
    }

    // ---------- Phase classification ----------

    [Fact]
    public void Classify_absent_manifest_is_queued() => Assert.Equal("queued", Classify(null, null));

    [Fact]
    public void Classify_fully_installed_without_pending_bits_is_installed() =>
        Assert.Equal("installed", Classify(null, State(FlagFullyInstalled)));

    [Theory]
    [InlineData(FlagUpdateRequired | FlagUpdateStarted | FlagUpdatePaused, "paused")]
    [InlineData(FlagUpdateRequired | FlagUpdateStarted | FlagDownloading, "downloading")]
    [InlineData(FlagUpdateRequired | FlagUpdateStarted | FlagStaging, "staging")]
    [InlineData(FlagUpdateRequired | FlagUpdateStarted | FlagCommitting, "staging")]
    [InlineData(FlagUpdateRequired | FlagUpdateStarted | FlagUpdateRunning, "downloading")]
    public void Classify_uses_runtime_bits_when_present(long flags, string phase) =>
        Assert.Equal(phase, Classify(null, State(flags, dl: 10, toDl: 100)));

    [Fact]
    public void Classify_detects_downloading_from_byte_movement()
    {
        const long flags = FlagUpdateRequired | FlagUpdateStarted; // 1026, what Steam usually persists
        Assert.Equal("downloading", Classify(State(flags, dl: 100, toDl: 1000), State(flags, dl: 300, toDl: 1000)));
        Assert.Equal("staging", Classify(State(flags, dl: 1000, toDl: 1000, staged: 10, toStage: 900), State(flags, dl: 1000, toDl: 1000, staged: 400, toStage: 900)));
    }

    [Fact]
    public void Classify_new_install_with_nothing_downloaded_is_queued() =>
        Assert.Equal("queued", Classify(null, State(FlagUpdateRequired | FlagUpdateStarted, dl: 0, toDl: 5000)));

    [Fact]
    public void Classify_keeps_previous_active_phase_when_there_is_no_evidence()
    {
        var s = State(FlagUpdateRequired | FlagUpdateStarted, dl: 400, toDl: 1000);
        Assert.Equal("downloading", Classify(s, s, "downloading"));
        Assert.Equal("paused", Classify(s, s, "paused"));
    }

    [Fact]
    public void Bytes_counts_staged_bytes_while_staging()
    {
        var s = State(1026, dl: 1000, toDl: 1000, staged: 250, toStage: 900);
        Assert.Equal((250L, 900L), Bytes(s, "staging"));
        Assert.Equal((1000L, 1000L), Bytes(s, "downloading"));
    }

    [Fact]
    public void IsUpdateActive_ignores_a_merely_pending_update()
    {
        Assert.False(IsUpdateActive(State(FlagFullyInstalled | FlagUpdateRequired)));
        Assert.True(IsUpdateActive(State(FlagFullyInstalled | FlagUpdateRequired | FlagUpdateStarted)));
        Assert.False(IsUpdateActive(State(FlagFullyInstalled)));
    }

    // ---------- Watching ----------

    private sealed class Events : IEventSink
    {
        public List<InstallProgressDto> Progress { get; } = [];
        public void Emit(string eventName, object? payload)
        {
            if (eventName == "install.progress" && payload is InstallProgressDto p) lock (Progress) Progress.Add(p);
        }
    }

    [Fact]
    public void Requested_install_moves_from_queued_to_installed_and_reports_completion()
    {
        var steamapps = _dir.Dir("Steam/steamapps");
        var events = new Events();
        var completed = new List<(string, string)>();
        var watcher = new InstallWatcher(() => Path.Combine(_dir.Path, "Steam"),
            () => new Dictionary<string, string> { ["620"] = "g1" }, events, () => false);
        watcher.Completed += (a, w) => completed.Add((a, w));

        watcher.Tick(); // baseline
        watcher.WatchInstall("620", "g1");
        Assert.Equal("queued", events.Progress[^1].Phase);
        Assert.True(events.Progress[^1].Watching);

        var file = Path.Combine(steamapps, "appmanifest_620.acf");
        File.WriteAllText(file, Manifest("620", 1026, dl: 100, toDl: 1000));
        watcher.Tick();
        var p = events.Progress[^1];
        Assert.Equal(("g1", "620", "install"), (p.GameId, p.AppId, p.Kind));
        Assert.Equal((100L, 1000L), (p.BytesDone, p.BytesTotal));

        File.WriteAllText(file, Manifest("620", 1026, dl: 600, toDl: 1000));
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddSeconds(5));
        watcher.Tick();
        Assert.Equal("downloading", events.Progress[^1].Phase);
        Assert.Equal(600, events.Progress[^1].BytesDone);

        File.WriteAllText(file, Manifest("620", 4, dl: 0, toDl: 0));
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddSeconds(10));
        watcher.Tick();
        Assert.Equal("installed", events.Progress[^1].Phase);
        Assert.False(events.Progress[^1].Watching);
        Assert.Contains(("620", "installed"), completed);
        Assert.Empty(watcher.Current());
    }

    [Fact]
    public void Uninstall_watch_reports_removed_when_the_manifest_disappears()
    {
        var steamapps = _dir.Dir("Steam/steamapps");
        var file = Path.Combine(steamapps, "appmanifest_70.acf");
        File.WriteAllText(file, Manifest("70", 4));
        var events = new Events();
        var completed = new List<(string, string)>();
        var watcher = new InstallWatcher(() => Path.Combine(_dir.Path, "Steam"),
            () => new Dictionary<string, string> { ["70"] = "g2" }, events, () => false);
        watcher.Completed += (a, w) => completed.Add((a, w));
        watcher.Tick();

        watcher.WatchUninstall("70", "g2");
        File.Delete(file);
        watcher.Tick();

        Assert.Equal("removed", events.Progress[^1].Phase);
        Assert.Equal("uninstall", events.Progress[^1].Kind);
        Assert.Contains(("70", "removed"), completed);
    }

    [Fact]
    public void Updates_in_progress_on_installed_games_are_reported_and_cleared()
    {
        var steamapps = _dir.Dir("Steam/steamapps");
        var file = Path.Combine(steamapps, "appmanifest_80.acf");
        File.WriteAllText(file, Manifest("80", 4));
        var events = new Events();
        var watcher = new InstallWatcher(() => Path.Combine(_dir.Path, "Steam"),
            () => new Dictionary<string, string> { ["80"] = "g3" }, events, () => false);
        watcher.Tick();
        Assert.Empty(events.Progress);

        File.WriteAllText(file, Manifest("80", 4 | 2 | 1024, dl: 50, toDl: 500));
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddSeconds(5));
        watcher.Tick();
        Assert.Equal("update", events.Progress[^1].Kind);
        Assert.True(events.Progress[^1].Watching);

        File.WriteAllText(file, Manifest("80", 4));
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddSeconds(10));
        watcher.Tick();
        watcher.Tick();
        Assert.Equal("installed", events.Progress[^1].Phase);
        Assert.False(events.Progress[^1].Watching);
    }

    [Fact]
    public void Unchanged_manifests_are_not_reparsed_or_reemitted()
    {
        var steamapps = _dir.Dir("Steam/steamapps");
        File.WriteAllText(Path.Combine(steamapps, "appmanifest_90.acf"), Manifest("90", 1026, dl: 10, toDl: 100));
        var events = new Events();
        var watcher = new InstallWatcher(() => Path.Combine(_dir.Path, "Steam"),
            () => new Dictionary<string, string> { ["90"] = "g4" }, events, () => false);
        watcher.Tick();
        var count = events.Progress.Count;
        watcher.Tick();
        watcher.Tick();
        Assert.Equal(count, events.Progress.Count);
    }
}
