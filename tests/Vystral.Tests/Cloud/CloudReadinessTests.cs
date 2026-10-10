using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using Vystral.Windows.Cloud;
using Vystral.Windows.Services.NetworkHealth;
using Xunit;

namespace Vystral.Tests.Cloud;

/// <summary>Track D5: the cloud readiness check — statistics, levels, honest tips, and what it connects to.</summary>
public sealed class CloudReadinessTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 10, 20, 0, 0, TimeSpan.Zero);
    private static readonly LinkInfo Ethernet = new("ethernet", 1000, null);

    private static CloudReadinessProbeDto Probe(string service, params int[] samples) => Lossy(service, 6, samples);

    private static CloudReadinessProbeDto Lossy(string service, int attempts, params int[] samples)
    {
        var (median, jitter, loss) = CloudReadinessClassifier.Stats(samples, attempts);
        return new CloudReadinessProbeDto(service, service == "gfn" ? "play.geforcenow.com" : "www.xbox.com", samples, attempts, median, jitter, loss, samples.Length == 0 ? "No answer within 3 s" : null);
    }

    [Fact]
    public void Stats_are_the_median_mean_successive_difference_and_loss()
    {
        Assert.Equal((20, 4, 0.0), CloudReadinessClassifier.Stats([18, 22, 20, 24, 16, 20], 6));
        Assert.Equal((21, null, 0.833), CloudReadinessClassifier.Stats([21], 6));
        Assert.Equal((null, null, 1.0), CloudReadinessClassifier.Stats([], 6));
        Assert.Equal((15, 10, 0.0), CloudReadinessClassifier.Stats([10, 20], 2)); // even count: the two middle values averaged
    }

    [Theory]
    [InlineData(new[] { 12, 13, 12, 14, 12, 13 }, "great")]
    [InlineData(new[] { 38, 40, 36, 42, 39, 41 }, "good")]
    [InlineData(new[] { 62, 70, 58, 75, 66, 61 }, "fair")]
    [InlineData(new[] { 95, 140, 90, 160, 99, 130 }, "poor")]
    public void Levels_follow_the_round_trip_and_its_steadiness(int[] samples, string level)
    {
        var r = CloudReadinessClassifier.Classify([Probe("gfn", samples)], Ethernet, false, Now);
        Assert.Equal(level, r.Level);
        Assert.Equal(Now.ToString("O"), r.CheckedAt);
        Assert.Contains("not your internet speed", r.Method); // always says what it measured
    }

    [Fact]
    public void The_best_service_decides_and_lost_attempts_are_counted_honestly()
    {
        var r = CloudReadinessClassifier.Classify([Lossy("gfn", 6, 70, 71, 69, 70, 72), Probe("xbox", 18, 19, 18, 18, 20, 19)], Ethernet, false, Now);
        Assert.Equal("great", r.Level);
        Assert.DoesNotContain(r.Tips, t => t.Contains("no answer")); // the faster service had no loss, but the other did
        var lossy = CloudReadinessClassifier.Classify([Lossy("gfn", 6, 30, 31, 30, 32)], Ethernet, false, Now);
        Assert.Equal("poor", lossy.Level); // a third of attempts lost is no basis for streaming
        Assert.Contains("2 of 6 attempts got no answer.", lossy.Tips);
    }

    [Fact]
    public void Nothing_answering_is_unknown_with_a_plain_reason()
    {
        var r = CloudReadinessClassifier.Classify([Probe("gfn"), Probe("xbox")], Ethernet, false, Now);
        Assert.Equal("unknown", r.Level);
        Assert.StartsWith("Neither service answered", r.Summary);
    }

    [Fact]
    public void Link_type_and_speed_cap_the_level_with_advice()
    {
        var fast = Probe("gfn", 10, 11, 10, 10, 11, 10);
        var wifi24 = CloudReadinessClassifier.Classify([fast], new LinkInfo("wifi", 144, "2.4"), false, Now);
        Assert.Equal("good", wifi24.Level);
        Assert.StartsWith("You’re on 2.4 GHz Wi-Fi", wifi24.Tips[0]);
        var cellular = CloudReadinessClassifier.Classify([fast], new LinkInfo("cellular", null, null), false, Now);
        Assert.Equal("fair", cellular.Level);
        var slow = CloudReadinessClassifier.Classify([fast], new LinkInfo("ethernet", 10, null), true, Now);
        Assert.Equal("fair", slow.Level);
        Assert.Contains(slow.Tips, t => t.Contains("10 Mbps") && t.Contains("25 Mbps"));
        Assert.Contains(slow.Tips, t => t.Contains("metered"));
    }

    private sealed class FakeIo : INetworkProbeIo
    {
        public List<(IPAddress Address, int Port)> Connects { get; } = [];
        public List<string> Resolved { get; } = [];
        public HashSet<string> Down { get; } = [];
        public int Fail { get; set; }

        public Task<IPAddress[]> ResolveAsync(string host, CancellationToken ct)
        {
            Resolved.Add(host);
            if (Down.Contains(host)) return Task.FromException<IPAddress[]>(new SocketException((int)SocketError.HostNotFound));
            return Task.FromResult(new[] { IPAddress.Parse("2001:db8::1"), IPAddress.Parse(host.Contains("xbox") ? "203.0.113.2" : "203.0.113.1") });
        }

        public async Task ConnectAsync(IPAddress address, int port, CancellationToken ct)
        {
            Connects.Add((address, port));
            if (Fail-- > 0) await Task.Delay(Timeout.Infinite, ct);
        }

        public Task<ProbeResponse> SendAsync(HttpMethod method, Uri url, CancellationToken ct) => throw new InvalidOperationException("The readiness check never sends a request.");
    }

    [Fact]
    public async Task The_check_only_opens_connections_to_the_fixed_public_hosts_and_keeps_the_result_for_a_day()
    {
        var io = new FakeIo();
        var clock = Now;
        var svc = new CloudReadinessService(io, () => clock) { Link = () => Ethernet, Pause = TimeSpan.FromMilliseconds(1) };
        Assert.Null(svc.Last);
        var r = await svc.RunAsync(["gfn"], metered: false, CancellationToken.None);
        Assert.Equal(["play.geforcenow.com"], io.Resolved);
        Assert.Equal(CloudReadinessService.Attempts, io.Connects.Count);
        Assert.All(io.Connects, c => Assert.Equal((IPAddress.Parse("203.0.113.1"), 443), c)); // IPv4 first, HTTPS port, no payload
        Assert.Equal(CloudReadinessService.Attempts, Assert.Single(r.Probes).Samples.Count);
        Assert.Same(r, svc.Last);
        clock = Now.AddHours(25);
        Assert.Null(svc.Last);

        // Both services when none is named; a host that doesn't resolve is reported, not thrown.
        io.Down.Add("www.xbox.com");
        var both = await svc.RunAsync([], metered: false, CancellationToken.None);
        Assert.Equal(["gfn", "xbox"], both.Probes.Select(p => p.Service));
        Assert.NotNull(both.Probes[1].Error);
        Assert.Equal(1, both.Probes[1].Loss);
    }

    [Fact]
    public async Task Attempts_that_time_out_count_as_loss()
    {
        var io = new FakeIo { Fail = 2 };
        var svc = new CloudReadinessService(io, () => Now) { Link = () => Ethernet, Pause = TimeSpan.FromMilliseconds(1), Timeout = TimeSpan.FromMilliseconds(150) };
        var r = await svc.RunAsync(["gfn"], metered: false, CancellationToken.None);
        var p = Assert.Single(r.Probes);
        Assert.Equal(4, p.Samples.Count);
        Assert.Equal(0.333, p.Loss);
    }
}
