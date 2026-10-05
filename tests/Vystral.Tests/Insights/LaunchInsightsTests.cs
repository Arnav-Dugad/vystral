using Vystral.Core.Contracts;
using Vystral.Core.Data;
using Vystral.Core.Domain;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Launch;
using Xunit;

namespace Vystral.Tests.Insights;

public sealed class LaunchInsightsTests
{
    // ---------------- launch timing ----------------

    [Fact]
    public void Expected_detect_time_needs_three_launches()
    {
        Assert.Null(LaunchTiming.Expected([]));
        Assert.Null(LaunchTiming.Expected([4000, 5000]));
        Assert.Equal(5000, LaunchTiming.Expected([4000, 9000, 5000]));
    }

    [Fact]
    public void Expected_detect_time_is_the_median_of_the_last_five()
    {
        Assert.Equal(4500, LaunchTiming.Expected([4000, 5000, 3000, 6000]));
        // Newest first: only the first five count, so the old 60 s outlier is ignored.
        Assert.Equal(5000, LaunchTiming.Expected([5000, 5100, 4900, 5200, 4800, 60_000, 60_000]));
        Assert.Equal(5000, LaunchTiming.Expected([0, 5000, 5000, 5000]));
    }

    [Fact]
    public void Migration_4_stores_detect_times_and_insight_samples()
    {
        using var t = new TestDb();
        Assert.True(Database.LatestVersion >= 4);
        t.Repo.ApplyScan([TestDb.Ok(PlatformId.Steam, TestDb.Install(PlatformId.Steam, "10", "Nebula"))]);
        var inst = t.Repo.GetInstallationsByPlatformId(PlatformId.Steam, "10")!;
        var now = DateTimeOffset.UtcNow;
        foreach (var (ms, ago) in new[] { (7000, 40), (5000, 30), (6000, 20), (5500, 10) })
        {
            var id = t.Repo.StartSession(inst.GameId, inst.Id, now.AddMinutes(-ago));
            t.Repo.SetSessionDetectMs(id, ms);
            t.Repo.EndSession(id, now.AddMinutes(-ago + 5), 300, null);
        }
        t.Repo.StartSession(inst.GameId, inst.Id, now); // no detect time recorded
        var recent = t.Repo.GetRecentDetectMs(inst.Id, 5);
        Assert.Equal([5500, 6000, 5000, 7000], recent);
        Assert.Equal(5750, LaunchTiming.Expected(recent));

        var session = t.Repo.StartSession(inst.GameId, inst.Id, now);
        t.Repo.AddPerfSamples(session, [new PerfSampleDto(0, 10, 20, 30, 40, 50), new PerfSampleDto(2000, 11, 21, 31, 41, 51)]);
        t.Repo.AddInsightSamples(session, [new InsightSampleDto(2000, 1650, 1, 143.5, 6.97, 9.4)]);
        var extras = t.Repo.GetInsightSamples(session);
        Assert.Equal([new InsightSampleDto(2000, 1650, 1, 143.5, 6.97, 9.4)], extras);
        // The base sample columns are untouched by the upsert.
        Assert.Equal(21, t.Repo.GetPerfSamples(session)[1].Gpu);
    }

    // ---------------- one-click fixes ----------------

    private sealed class RecordingRunner : ILaunchFixRunner
    {
        public List<string> Calls { get; } = [];
        public Task RescanPlatformAsync(PlatformId platform) { Calls.Add($"rescan:{platform}"); return Task.CompletedTask; }
        public void OpenUri(Uri uri) => Calls.Add($"uri:{uri}");
        public void StartClient(string exePath) => Calls.Add($"start:{exePath}");
        public void OpenFolder(string path) => Calls.Add($"folder:{path}");
    }

    private const string Ticket = "0123456789abcdef0123456789abcdef";

    [Fact]
    public async Task Fix_runs_only_the_action_attached_to_that_ticket()
    {
        var registry = new LaunchFixRegistry();
        registry.Attach(Ticket, [
            new LaunchFixPlan(LaunchFixes.RescanPlatform, PlatformId.Epic),
            new LaunchFixPlan(LaunchFixes.OpenStore, PlatformId.Epic, Uri: new Uri("com.epicgames.launcher://store/p/x")),
        ]);
        var runner = new RecordingRunner();

        Assert.Equal("Rescanned Epic Games.", await LaunchFixes.ExecuteAsync(registry, Ticket, LaunchFixes.RescanPlatform, runner));
        await LaunchFixes.ExecuteAsync(registry, Ticket, LaunchFixes.OpenStore, runner);
        Assert.Equal(["rescan:Epic", "uri:com.epicgames.launcher://store/p/x"], runner.Calls);

        // Valid action ids that weren't attached to this failure are refused.
        var ex = await Assert.ThrowsAsync<BridgeException>(() => LaunchFixes.ExecuteAsync(registry, Ticket, LaunchFixes.InstallClient, runner));
        Assert.Equal("forbidden", ex.Code);
        ex = await Assert.ThrowsAsync<BridgeException>(() => LaunchFixes.ExecuteAsync(registry, "ffffffffffffffffffffffffffffffff", LaunchFixes.RescanPlatform, runner));
        Assert.Equal("forbidden", ex.Code);
        ex = await Assert.ThrowsAsync<BridgeException>(() => LaunchFixes.ExecuteAsync(registry, Ticket, "runAnything", runner));
        Assert.Equal("invalid", ex.Code);
        Assert.Equal(2, runner.Calls.Count);
    }

    [Fact]
    public async Task Start_client_and_open_folder_revalidate_paths()
    {
        using var dir = new TempDir();
        var exe = dir.Write("Client/client.exe", "MZ");
        var registry = new LaunchFixRegistry();
        registry.Attach(Ticket, [
            new LaunchFixPlan(LaunchFixes.StartClient, PlatformId.Ea, ExePath: exe),
            new LaunchFixPlan(LaunchFixes.OpenFolder, PlatformId.Ea, Folder: Path.Combine(dir.Path, "gone")),
        ]);
        var runner = new RecordingRunner();
        await LaunchFixes.ExecuteAsync(registry, Ticket, LaunchFixes.StartClient, runner);
        Assert.Equal([$"start:{exe}"], runner.Calls);

        File.Delete(exe);
        await Assert.ThrowsAsync<BridgeException>(() => LaunchFixes.ExecuteAsync(registry, Ticket, LaunchFixes.StartClient, runner));
        await Assert.ThrowsAsync<BridgeException>(() => LaunchFixes.ExecuteAsync(registry, Ticket, LaunchFixes.OpenFolder, runner));
        Assert.Single(runner.Calls);

        Assert.False(LaunchFixes.IsSafeClientExe(@"\\server\share\client.exe"));
        Assert.False(LaunchFixes.IsSafeClientExe("client.exe"));
    }

    [Fact]
    public void Registry_is_bounded_and_labels_are_plain()
    {
        var registry = new LaunchFixRegistry();
        for (var i = 0; i < 20; i++) registry.Attach($"{i:x32}", [new LaunchFixPlan(LaunchFixes.RescanPlatform, PlatformId.Steam)]);
        Assert.Null(registry.Get($"{0:x32}", LaunchFixes.RescanPlatform));
        Assert.NotNull(registry.Get($"{19:x32}", LaunchFixes.RescanPlatform));

        var dto = LaunchFixes.ToDto(new LaunchFixPlan(LaunchFixes.InstallClient, PlatformId.BattleNet, Uri: LaunchFixes.DownloadPage(PlatformId.BattleNet)));
        Assert.Equal(new LaunchFixDto("installClient", "Get Battle.net", "battlenet"), dto);
        foreach (var p in Enum.GetValues<PlatformId>().Where(p => p != PlatformId.Manual))
        {
            var page = LaunchFixes.DownloadPage(p)!;
            Assert.True(page.Scheme is "https" or "ms-windows-store", $"{p}: {page}");
        }
    }

    [Fact]
    public void Launch_state_additions_are_appended_with_defaults()
    {
        var s = new LaunchStateDto("t", "g", "i", "steam", "waiting", null);
        Assert.Null(s.ExpectedDetectMs);
        Assert.Null(s.Actions);
        Assert.Null(s.AcceptedAt);
        var json = System.Text.Json.JsonSerializer.Serialize(s with { ExpectedDetectMs = 4200, Actions = [new("openFolder", "Open install folder")] }, BridgeDispatcher.Json);
        Assert.Contains("\"expectedDetectMs\":4200", json);
        Assert.Contains("\"actions\":[{\"id\":\"openFolder\"", json);
    }
}
