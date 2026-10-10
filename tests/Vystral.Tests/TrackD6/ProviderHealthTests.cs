using System.Net;
using Vystral.Core.Providers;
using Vystral.Windows.DataSources;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.TrackD6;

/// <summary>Track D6: the shared provider health registry and the shared lane's reports.</summary>
public sealed class ProviderHealthTests
{
    private DateTimeOffset _now = new(2026, 10, 10, 9, 0, 0, TimeSpan.Zero);

    private ProviderHealthRegistry Registry() => new() { Clock = () => _now, TimeZone = TimeZoneInfo.Utc };

    private static ProviderDescriptor D(string id) => new(id, id.ToUpperInvariant(), "Group", null, "Purpose");

    [Fact]
    public void Tracks_success_errors_backoff_and_requests_today()
    {
        var reg = Registry();
        reg.Register(D("igdb"), () => ProviderAvailability.On(optIn: true), () => _now.AddHours(-3));
        Assert.Equal("idle", reg.Snapshot().Single().State);

        reg.Request("igdb");
        reg.Success("igdb");
        var e = reg.Snapshot().Single();
        Assert.Equal("ok", e.State);
        Assert.Equal(1, e.RequestsToday);
        Assert.Equal(_now.AddHours(-3), e.CacheUpdated);
        Assert.True(e.OptIn);

        _now = _now.AddMinutes(5);
        reg.Request("igdb");
        reg.Failure("igdb", "Timed out");
        e = reg.Snapshot().Single();
        Assert.Equal("error", e.State);
        Assert.Equal("Timed out", e.LastErrorText);
        Assert.Equal(2, e.RequestsToday);

        reg.BackOff("igdb", _now.AddMinutes(10), "Asked to slow down");
        Assert.Equal("backoff", reg.Snapshot().Single().State);
        _now = _now.AddMinutes(11);
        Assert.Equal("error", reg.Snapshot().Single().State); // the pause ended; the last thing that happened is still the error

        reg.Success("igdb");
        Assert.Equal("ok", reg.Snapshot().Single().State);
    }

    [Fact]
    public void Requests_today_reset_at_midnight()
    {
        var reg = Registry();
        reg.Register(D("rawg"));
        reg.Request("rawg");
        reg.Request("rawg");
        _now = new DateTimeOffset(2026, 10, 11, 0, 5, 0, TimeSpan.Zero);
        Assert.Equal(0, reg.Snapshot().Single().RequestsToday);
    }

    [Fact]
    public void Disabled_providers_say_why()
    {
        var reg = Registry();
        reg.Register(D("itad"), () => ProviderAvailability.Off("Needs your IsThereAnyDeal key"));
        var e = reg.Snapshot().Single();
        Assert.Equal("off", e.State);
        Assert.False(e.Enabled);
        Assert.Equal("Needs your IsThereAnyDeal key", e.DisabledReason);
    }

    [Fact]
    public void Reports_before_registration_are_kept_and_ids_are_validated()
    {
        var reg = Registry();
        reg.Request("late");
        reg.Success("late");
        Assert.Empty(reg.Snapshot());
        reg.Register(D("late"));
        Assert.Equal("ok", reg.Snapshot().Single().State);

        reg.Request("../evil");
        reg.Request("UPPER");
        Assert.Throws<ArgumentException>(() => reg.Register(D("Bad Id")));
        Assert.Single(reg.Snapshot());
    }

    [Fact]
    public void Error_text_is_cleaned_and_clipped()
    {
        Assert.Equal("a b c", ProviderHealthRegistry.Clean("a\u0000\n b‮\tc"));
        Assert.Null(ProviderHealthRegistry.Clean(" \n "));
        var long1 = ProviderHealthRegistry.Clean(new string('x', 500))!;
        Assert.True(long1.Length <= ProviderHealthRegistry.MaxReasonLength);
        Assert.EndsWith("…", long1);
    }

    [Fact]
    public void Counters_survive_a_restart_on_the_same_day_only()
    {
        var reg = Registry();
        reg.Register(D("wikidata"));
        reg.Request("wikidata");
        reg.Failure("wikidata", "DNS failed");
        var saved = reg.Export();

        var next = Registry();
        next.Register(D("wikidata"));
        next.Import(saved);
        var e = next.Snapshot().Single();
        Assert.Equal(1, e.RequestsToday);
        Assert.Equal("DNS failed", e.LastErrorText);

        _now = _now.AddDays(2);
        var later = Registry();
        later.Register(D("wikidata"));
        later.Import(saved);
        Assert.Equal(0, later.Snapshot().Single().RequestsToday);
        Assert.NotNull(later.Snapshot().Single().LastError);

        later.Import([new ProviderCounters("../x", "2026-10-12", 5, null, null, null), null!]);
        Assert.Single(later.Snapshot());
    }

    [Fact]
    public void A_throwing_availability_callback_doesnt_break_the_page()
    {
        var reg = Registry();
        reg.Register(D("cheapshark"), () => throw new InvalidOperationException("boom"));
        Assert.Equal("idle", reg.Snapshot().Single().State);
    }

    private sealed class Handler(HttpStatusCode code, TimeSpan? retryAfter = null) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var r = new HttpResponseMessage(code) { Content = new StringContent("{}") };
            if (retryAfter is { } d) r.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(d);
            return Task.FromResult(r);
        }
    }

    [Fact]
    public async Task The_shared_lane_reports_requests_answers_and_pauses()
    {
        var previous = ProviderHealthHub.Registry;
        var reg = Registry();
        try
        {
            ProviderHealthHub.Registry = reg;
            // Lane names only this test uses: other tests' lanes may report to the shared hub while this one runs.
            reg.Register(D("d6test.lane"));
            var ok = new ProviderTransport(new HttpClient(new Handler(HttpStatusCode.OK)), "d6test.lane", "Steam", TimeSpan.Zero);
            await ok.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, "https://store.steampowered.com/x"), CancellationToken.None);
            var e = reg.Snapshot().Single(x => x.Id == "d6test.lane");
            Assert.Equal(("ok", 1), (e.State, e.RequestsToday));

            var limited = new ProviderTransport(new HttpClient(new Handler(HttpStatusCode.TooManyRequests, TimeSpan.FromMinutes(2))), "d6test.lane", "Steam", TimeSpan.Zero);
            await Assert.ThrowsAsync<DataSourceException>(() => limited.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, "https://store.steampowered.com/x"), CancellationToken.None));
            e = reg.Snapshot().Single(x => x.Id == "d6test.lane");
            Assert.Equal("backoff", e.State);
            Assert.NotNull(e.BackoffUntil);

            reg.Register(D("d6test.key"));
            var refused = new ProviderTransport(new HttpClient(new Handler(HttpStatusCode.Unauthorized)), "d6test.key", "IGDB", TimeSpan.Zero);
            await refused.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, "https://api.igdb.com/v4/games"), CancellationToken.None);
            Assert.Contains("didn’t accept the key", reg.Snapshot().Single(x => x.Id == "d6test.key").LastErrorText);
        }
        finally { ProviderHealthHub.Registry = previous; }
    }

    [Theory]
    [InlineData("steamdeck", "steam.store")]
    [InlineData("workshop", "steam.store")]
    [InlineData("cloud.gfnStatus", "gfn.status")]
    [InlineData("subs.gamepass", "gamepass.catalog")]
    [InlineData("subs.msstore", "msstore")]
    [InlineData("ai-anthropic", "ai-anthropic")]
    [InlineData("itad", "itad")]
    public void Lane_names_map_to_health_rows(string lane, string id)
    {
        Assert.Equal(id, ProviderHealthHub.IdForLane(lane));
        Assert.True(ProviderHealthRegistry.IsId(id));
    }
}
