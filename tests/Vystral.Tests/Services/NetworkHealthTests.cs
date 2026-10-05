using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Authentication;
using Vystral.Tests.Support;
using Vystral.Windows.Services;
using Vystral.Windows.Services.NetworkHealth;
using Xunit;

namespace Vystral.Tests.Services;

public sealed class HealthClassifierTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 5, 12, 0, 0, TimeSpan.Zero);

    private static AddressCheck Ok(string a, int ms = 30) => new(a, a.Contains(':') ? "IPv6" : "IPv4", true, ms, null);
    private static AddressCheck Bad(string a) => new(a, a.Contains(':') ? "IPv6" : "IPv4", false, null, "No answer within 3 s");

    private static HealthVerdict Classify(int? status = 200, int? ms = 120, AddressCheck[]? addresses = null, NetworkFailure? failure = null,
        Dictionary<string, string>? headers = null, string? dnsError = null, bool anyResponse = false) =>
        HealthClassifier.Classify(new HealthObservation
        {
            Host = "release-assets.githubusercontent.com",
            DnsError = dnsError,
            Addresses = addresses ?? [Ok("185.199.108.133"), Ok("185.199.109.133")],
            HttpStatus = status,
            HttpMs = status is null ? null : ms,
            HttpFailure = failure,
            Headers = headers ?? [],
            AnyResponseIsHealthy = anyResponse,
            Now = Now,
        });

    [Fact]
    public void Healthy_is_green_with_its_latency()
    {
        var v = Classify();
        Assert.Equal(("ok", "OK · 120 ms"), (v.Status, v.Summary));
    }

    [Fact]
    public void One_unreachable_address_is_named_and_explained()
    {
        var v = Classify(addresses: [Ok("185.199.108.133"), Bad("185.199.109.133"), Ok("185.199.110.133")]);
        Assert.Equal("warn", v.Status);
        Assert.Equal("One of release-assets.githubusercontent.com's addresses (185.199.109.133) isn't reachable from this network; VYSTRAL uses the others", v.Summary);
    }

    [Fact]
    public void Several_unreachable_addresses_are_counted()
    {
        var v = Classify(addresses: [Ok("1.1.1.1"), Bad("2.2.2.2"), Bad("3.3.3.3")]);
        Assert.StartsWith("2 of release-assets.githubusercontent.com's 3 addresses (2.2.2.2, 3.3.3.3) aren't reachable", v.Summary);
    }

    [Fact]
    public void A_network_without_IPv6_is_normal_not_a_warning()
    {
        var v = Classify(addresses: [Bad("2606:50c0:8000::154"), Ok("185.199.108.133"), Bad("2606:50c0:8001::154")]);
        Assert.Equal("ok", v.Status);
        Assert.Equal("This network has no IPv6; IPv4 works.", v.Detail);
    }

    [Fact]
    public void Slow_is_amber_with_seconds()
    {
        var v = Classify(ms: 1820);
        Assert.Equal(("warn", "Slow: 1.8 s"), (v.Status, v.Summary));
    }

    [Fact]
    public void Dns_failure_is_red()
    {
        var v = Classify(status: null, addresses: [], dnsError: "DNS failed: the address couldn't be looked up", failure: new("dns", "DNS failed"));
        Assert.Equal(("down", "DNS failed: release-assets.githubusercontent.com couldn't be looked up"), (v.Status, v.Summary));
    }

    [Fact]
    public void Every_address_unreachable_is_red()
    {
        var v = Classify(status: null, addresses: [Bad("1.1.1.1"), Bad("2.2.2.2")], failure: new("timeout", "x"));
        Assert.Equal(("down", "None of release-assets.githubusercontent.com's 2 addresses answered"), (v.Status, v.Summary));
    }

    [Fact]
    public void Tls_and_timeouts_say_so()
    {
        Assert.Equal("TLS error", Classify(status: null, failure: NetworkErrors.Describe(new HttpRequestException("x", new AuthenticationException()))).Summary);
        Assert.Equal("Timed out after 10 s", Classify(status: null, failure: new("timeout", "x")).Summary);
    }

    [Fact]
    public void Rate_limits_show_when_they_reset()
    {
        var reset = Now.AddMinutes(12).ToUnixTimeSeconds().ToString();
        var v = Classify(status: 429, headers: new() { ["X-RateLimit-Reset"] = reset });
        Assert.Equal(("warn", "Rate limited (HTTP 429) — resets in 12 min"), (v.Status, v.Summary));
        var gh = Classify(status: 403, headers: new() { ["x-ratelimit-remaining"] = "0", ["x-ratelimit-reset"] = reset });
        Assert.Equal("Rate limited (HTTP 403) — resets in 12 min", gh.Summary);
        Assert.Equal("Rate limited (HTTP 429) — resets in 40 s", Classify(status: 429, headers: new() { ["Retry-After"] = "40" }).Summary);
    }

    [Fact]
    public void Nearly_exhausted_github_quota_warns()
    {
        var v = Classify(headers: new() { ["X-RateLimit-Remaining"] = "4", ["X-RateLimit-Limit"] = "60", ["X-RateLimit-Reset"] = Now.AddMinutes(30).ToUnixTimeSeconds().ToString() });
        Assert.Equal(("warn", "Only 4 of 60 requests left this hour — resets in 30 min"), (v.Status, v.Summary));
    }

    [Fact]
    public void Server_errors_are_red_and_client_errors_amber_unless_any_answer_counts()
    {
        Assert.Equal(("down", "The service has a problem (HTTP 503)"), (Classify(status: 503).Status, Classify(status: 503).Summary));
        Assert.Equal("warn", Classify(status: 404).Status);
        Assert.Equal("ok", Classify(status: 404, anyResponse: true).Status);
    }

    [Theory]
    [InlineData(SocketError.HostNotFound, "dns")]
    [InlineData(SocketError.TimedOut, "timeout")]
    [InlineData(SocketError.ConnectionRefused, "refused")]
    [InlineData(SocketError.NetworkUnreachable, "unreachable")]
    [InlineData(SocketError.AccessDenied, "blocked")]
    public void Socket_errors_map_to_plain_reasons(SocketError code, string kind) =>
        Assert.Equal(kind, NetworkErrors.Describe(new HttpRequestException("x", new SocketException((int)code))).Kind);

    [Fact]
    public void Http_errors_map_to_plain_reasons()
    {
        Assert.Equal("dns", NetworkErrors.Describe(new HttpRequestException(HttpRequestError.NameResolutionError, "x")).Kind);
        Assert.Equal("tls", NetworkErrors.Describe(new HttpRequestException(HttpRequestError.SecureConnectionError, "x")).Kind);
        Assert.Equal("rateLimited", NetworkErrors.Describe(new HttpRequestException("x", null, HttpStatusCode.TooManyRequests)).Kind);
        Assert.Equal("timeout", NetworkErrors.Describe(new TimeoutException()).Kind);
        Assert.Equal("timeout", NetworkErrors.Describe(new TaskCanceledException("x", new TimeoutException())).Kind);
    }
}

public sealed class NetworkHealthServiceTests
{
    private static readonly IPAddress A = IPAddress.Parse("185.199.108.133");
    private static readonly IPAddress B = IPAddress.Parse("185.199.109.133");

    private sealed class FakeIo : INetworkProbeIo
    {
        public Dictionary<string, IPAddress[]> Dns { get; } = [];
        public HashSet<IPAddress> Unreachable { get; } = [];
        public Func<Uri, ProbeResponse> Http { get; set; } = _ => new ProbeResponse(200, new Dictionary<string, string>());
        public List<Uri> Requests { get; } = [];

        public Task<IPAddress[]> ResolveAsync(string host, CancellationToken ct) =>
            Dns.TryGetValue(host, out var a) ? Task.FromResult(a) : Task.FromException<IPAddress[]>(new SocketException((int)SocketError.HostNotFound));

        public async Task ConnectAsync(IPAddress address, int port, CancellationToken ct)
        {
            if (Unreachable.Contains(address)) await Task.Delay(Timeout.Infinite, ct); // hangs until the per-address timeout
        }

        public Task<ProbeResponse> SendAsync(HttpMethod method, Uri url, CancellationToken ct)
        {
            lock (Requests) Requests.Add(url);
            return Task.FromResult(Http(url));
        }
    }

    private static Dictionary<string, bool> DefaultSettings() => new()
    {
        ["privacy.localOnly"] = false, ["library.fetchMetadata"] = true, ["library.fetchArtwork"] = true, ["dataSaver.enabled"] = false, ["ai.enabled"] = false,
    };

    private static NetworkHealthService Create(FakeIo io, Dictionary<string, bool>? settings = null, bool steamKey = false)
    {
        var s = settings ?? DefaultSettings();
        return new NetworkHealthService(io, () => new HealthContext(k => s.TryGetValue(k, out var v) && v, steamKey));
    }

    [Fact]
    public void Lists_the_built_in_services_and_hides_unconfigured_ones()
    {
        var ids = Create(new FakeIo()).List().Select(p => p.Id).ToList();
        Assert.Equal(["github.api", "github.download", "steam.store", "steam.cdn", "steam.video"], ids);
        var withKey = Create(new FakeIo(), steamKey: true).List().Select(p => p.Id);
        Assert.Contains("steam.webapi", withKey);
        var ai = DefaultSettings();
        ai["ai.enabled"] = true;
        Assert.Contains("ollama", Create(new FakeIo(), ai).List().Select(p => p.Id));
    }

    [Fact]
    public async Task Offline_mode_skips_everything_that_leaves_this_pc_without_any_request()
    {
        var io = new FakeIo();
        var s = DefaultSettings();
        s["privacy.localOnly"] = true;
        s["ai.enabled"] = true;
        var results = await Create(io, s).CheckAsync(null, TestContext.Current.CancellationToken);
        Assert.All(results.Where(r => r.Id != "ollama"), r => Assert.Equal(("skipped", "Skipped: Offline mode is on"), (r.Status, r.Summary)));
        Assert.DoesNotContain(io.Requests, u => u.Host != "127.0.0.1");
    }

    [Fact]
    public async Task Disabled_features_are_skipped_with_the_reason()
    {
        var s = DefaultSettings();
        s["library.fetchMetadata"] = false;
        var results = await Create(new FakeIo(), s).CheckAsync(null, TestContext.Current.CancellationToken);
        Assert.Equal("Not used: game details are off", results.Single(r => r.Id == "steam.store").Summary);
        Assert.Equal("skipped", results.Single(r => r.Id == "steam.video").Status);
    }

    [Fact]
    public async Task Tests_each_address_and_reports_the_unreachable_one()
    {
        var io = new FakeIo();
        io.Dns["release-assets.githubusercontent.com"] = [A, B];
        io.Unreachable.Add(B);
        var r = (await Create(io).CheckAsync("github.download", TestContext.Current.CancellationToken)).Single();
        Assert.Equal("warn", r.Status);
        Assert.Contains("(185.199.109.133) isn't reachable", r.Summary);
        Assert.Equal([true, false], r.Addresses.Select(a => a.Reachable));
        Assert.Single(io.Requests); // exactly one lightweight request per service
    }

    [Fact]
    public async Task Unknown_dns_is_red()
    {
        var io = new FakeIo { Http = _ => throw new HttpRequestException(HttpRequestError.NameResolutionError, "no such host") };
        var r = (await Create(io).CheckAsync("github.api", TestContext.Current.CancellationToken)).Single();
        Assert.Equal(("down", "DNS failed: api.github.com couldn't be looked up"), (r.Status, r.Summary));
    }

    [Fact]
    public async Task Other_features_can_register_a_probe()
    {
        var io = new FakeIo();
        io.Dns["example.org"] = [A];
        var health = Create(io);
        health.Register(new HealthProbe { Id = "provider.igdb", Label = "IGDB", Purpose = "Game details", Url = new Uri("https://example.org/") });
        Assert.Contains("provider.igdb", health.List().Select(p => p.Id));
        var r = (await health.CheckAsync("provider.igdb", TestContext.Current.CancellationToken)).Single();
        Assert.Equal("ok", r.Status);
        await Assert.ThrowsAsync<ArgumentException>(() => health.CheckAsync("nope", TestContext.Current.CancellationToken));
    }
}

public sealed class WhatsNewStoreTests
{
    [Fact]
    public void A_fresh_install_has_already_seen_the_current_version()
    {
        using var dir = new TempDir();
        var s = new WhatsNewStore(dir.Path).Get("0.4.0", onboardingCompleted: false);
        Assert.Equal(("0.4.0", "0.4.0"), (s.LastSeenVersion, s.FirstVersion));
    }

    [Fact]
    public void An_existing_install_without_state_gets_the_tour()
    {
        using var dir = new TempDir();
        var store = new WhatsNewStore(dir.Path);
        var s = store.Get("0.4.0", onboardingCompleted: true);
        Assert.Null(s.LastSeenVersion);
        Assert.Null(s.FirstVersion);
        store.MarkVersionSeen("0.4.0");
        Assert.Equal("0.4.0", new WhatsNewStore(dir.Path).Get("0.4.0", true).LastSeenVersion);
        store.MarkVersionSeen("0.3.1"); // never goes backwards
        Assert.Equal("0.4.0", store.Get("0.4.0", true).LastSeenVersion);
    }

    [Fact]
    public void Badge_keys_are_validated_and_persisted()
    {
        using var dir = new TempDir();
        var store = new WhatsNewStore(dir.Path);
        store.MarkBadgesSeen(["nav.journal", "settings.privacy.network-health"], DateTimeOffset.UnixEpoch);
        Assert.Equal(["nav.journal", "settings.privacy.network-health"], store.Get("0.4.0", true).SeenBadges.Keys.Order());
        Assert.Throws<ArgumentException>(() => store.MarkBadgesSeen(["../x"], DateTimeOffset.UnixEpoch));
        Assert.Throws<ArgumentException>(() => store.MarkBadgesSeen(Enumerable.Range(0, 51).Select(i => $"k{i}"), DateTimeOffset.UnixEpoch));
        Assert.Throws<ArgumentException>(() => store.MarkVersionSeen("not a version"));
    }

    [Fact]
    public void A_corrupt_file_starts_fresh()
    {
        using var dir = new TempDir();
        dir.Write(Path.Combine("ui-state", "whatsnew.json"), "{nope");
        Assert.Equal("0.4.0", new WhatsNewStore(dir.Path).Get("0.4.0", false).LastSeenVersion);
    }
}
