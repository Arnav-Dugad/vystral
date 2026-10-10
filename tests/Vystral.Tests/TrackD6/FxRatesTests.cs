using System.Net;
using Vystral.Core.Money;
using Vystral.Tests.Support;
using Vystral.Windows.Bridge;
using Vystral.Windows.Services.Money;
using Xunit;

namespace Vystral.Tests.TrackD6;

/// <summary>Track D6: exchange-rate parsing (Frankfurter v2 and v1 shapes, hostile answers), conversion and the daily cache.</summary>
public sealed class FxRatesTests
{
    private static readonly DateTimeOffset At = new(2026, 10, 10, 12, 0, 0, TimeSpan.Zero);

    // The shape api.frankfurter.dev/v2/rates?base=EUR returned on 2026-10-10 (trimmed).
    private const string V2 = """
        [{"date":"2026-10-10","base":"EUR","quote":"AUD","rate":1.6103},{"date":"2026-10-09","base":"EUR","quote":"GBP","rate":0.84763},
         {"date":"2026-10-10","base":"EUR","quote":"INR","rate":108.3965},{"date":"2026-10-10","base":"EUR","quote":"JPY","rate":177.34},
         {"date":"2026-10-10","base":"EUR","quote":"USD","rate":1.1206}]
        """;

    private const string V1 = """{"amount":1.0,"base":"EUR","date":"2026-10-09","rates":{"AUD":1.6052,"GBP":0.84763,"INR":108.3965,"JPY":177.34,"USD":1.1206}}""";

    [Fact]
    public void Parses_the_v2_list_with_the_latest_date_and_the_base()
    {
        var fx = FxRates.Parse(V2, At)!;
        Assert.Equal("EUR", fx.Base);
        Assert.Equal("2026-10-10", fx.Date);
        Assert.Equal(1.0, fx.Rates["EUR"]);
        Assert.Equal(108.3965, fx.Rates["INR"]);
        Assert.Equal(6, fx.Rates.Count);
        Assert.Equal(At, fx.FetchedAt);
    }

    [Fact]
    public void Parses_the_v1_object()
    {
        var fx = FxRates.Parse(V1, At)!;
        Assert.Equal("2026-10-09", fx.Date);
        Assert.Equal(0.84763, fx.Rates["GBP"]);
    }

    [Theory]
    [InlineData("")]
    [InlineData("null")]
    [InlineData("42")]
    [InlineData("{\"base\":\"EUR\"}")]
    [InlineData("[{\"base\":\"EUR\",\"quote\":\"USD\",\"rate\":1.1,\"date\":\"2026-10-10\"}]")] // too few rates
    [InlineData("<html>Bad gateway</html>")]
    [InlineData("{\"base\":\"EUR\",\"date\":\"2026-10-09\",\"rates\":[1,2,3]}")]
    public void Rejects_answers_that_arent_a_rates_table(string json) => Assert.Null(FxRates.Parse(json, At));

    [Fact]
    public void Drops_hostile_rows_but_keeps_good_ones()
    {
        const string json = """
            [{"date":"2026-10-10","base":"EUR","quote":"usd","rate":1.1},
             {"date":"2026-10-10","base":"EUR","quote":"XSS<script>","rate":1.1},
             {"date":"2026-10-10","base":"EUR","quote":"NEG","rate":-3},
             {"date":"2026-10-10","base":"EUR","quote":"ZER","rate":0},
             {"date":"2026-10-10","base":"EUR","quote":"BIG","rate":1e300},
             {"date":"2026-10-10","base":"EUR","quote":"STR","rate":"1.2"},
             {"date":"2026-10-10","base":"USD","quote":"CAD","rate":1.37},
             {"date":"2026-10-10","base":"EUR","quote":"GBP","rate":0.85},
             {"date":"2026-10-10","base":"EUR","quote":"USD","rate":1.12},
             {"date":"2026-10-10","base":"EUR","quote":"INR","rate":108.4},
             {"date":"2026-10-10","base":"EUR","quote":"JPY","rate":177.3},
             {"date":"not a date","base":"EUR","quote":"AUD","rate":1.61}]
            """;
        var fx = FxRates.Parse(json, At)!;
        // The odd USD-based row can't change the base; a row without a date is dropped.
        Assert.Equal(["EUR", "GBP", "INR", "JPY", "USD"], fx.Rates.Keys.Order().ToArray());
        Assert.Equal("2026-10-10", fx.Date);
    }

    [Fact]
    public void Caps_the_number_of_rates_and_the_size()
    {
        var rows = string.Join(",", Enumerable.Range(0, 2000).Select(i => $"{{\"date\":\"2026-10-10\",\"base\":\"EUR\",\"quote\":\"{(char)('A' + i / 676 % 26)}{(char)('A' + i / 26 % 26)}{(char)('A' + i % 26)}\",\"rate\":1.5}}"));
        var json = $"[{rows}]";
        if (json.Length > FxRates.MaxBytes) Assert.Null(FxRates.Parse(json, At));
        else Assert.True(FxRates.Parse(json, At)!.Rates.Count <= FxRates.MaxEntries + 1);
        Assert.Null(FxRates.Parse(new string(' ', FxRates.MaxBytes + 1), At));
    }

    [Fact]
    public void Converts_through_the_base_and_never_guesses()
    {
        var fx = FxRates.Parse(V2, At)!;
        Assert.Equal(14.99 / 1.1206 * 108.3965, FxRates.Convert(14.99, "USD", "INR", fx)!.Value, 6);
        Assert.Equal(10, FxRates.Convert(10, "EUR", "EUR", null));          // same currency needs no rates
        Assert.Equal(10 * 0.84763, FxRates.Convert(10, "EUR", "GBP", fx)!.Value, 9);
        Assert.Null(FxRates.Convert(10, "USD", "BRL", fx));                // not in the table
        Assert.Null(FxRates.Convert(10, "USD", "INR", null));              // no table
        Assert.Null(FxRates.Convert(double.NaN, "USD", "INR", fx));
        Assert.Null(FxRates.Convert(10, "usd", "INR", fx));
    }

    [Fact]
    public void Serialized_cache_round_trips_and_is_validated_on_read()
    {
        var fx = FxRates.Parse(V2, At)!;
        var back = FxRates.Deserialize(FxRates.Serialize(fx))!;
        Assert.Equal(fx.Date, back.Date);
        Assert.Equal(fx.FetchedAt, back.FetchedAt);
        Assert.Equal(fx.Rates.OrderBy(p => p.Key), back.Rates.OrderBy(p => p.Key));
        Assert.Null(FxRates.Deserialize("""{"base":"EUR","date":"2026-10-10","rates":{"USD":1.1}}""")); // no fetchedAt
        Assert.Null(FxRates.Deserialize("garbage"));
    }

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Interlocked.Increment(ref Calls);
            return Task.FromResult(answer(request));
        }
    }

    [Fact]
    public async Task Service_fetches_once_a_day_caches_to_disk_and_works_offline()
    {
        using var dir = new TempDir();
        var offline = false;
        var handler = new Handler(r =>
        {
            Assert.Equal(FxService.Url, r.RequestUri!.AbsoluteUri);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(V2) };
        });
        var now = At;
        var svc = new FxService(new HttpClient(handler), dir.Path, () => offline, new NullEventSink()) { Clock = () => now };
        Assert.Equal("never", svc.Status().State);
        Assert.True(svc.Due(manual: false));
        var status = await svc.RefreshAsync(manual: false, CancellationToken.None);
        Assert.Equal("ok", status.State);
        Assert.Equal(108.3965, status.Rates!["INR"]);
        Assert.True(File.Exists(Path.Combine(dir.Path, "cache", "fx", "rates.json")));
        Assert.False(svc.Due(manual: false)); // fresh for a day

        // A new process reads the file; offline it keeps the table and sends nothing.
        offline = true;
        now = At.AddDays(5);
        var again = new FxService(new HttpClient(handler), dir.Path, () => offline, new NullEventSink()) { Clock = () => now };
        Assert.Equal("offline", again.Status().State);
        Assert.Equal("2026-10-10", again.Status().Date);
        Assert.False(again.Due(manual: false));
        await Assert.ThrowsAsync<BridgeException>(() => again.RefreshAsync(manual: true, CancellationToken.None));
        Assert.Equal(1, handler.Calls);

        offline = false;
        Assert.Equal("stale", again.Status().State);
        Assert.True(again.Due(manual: false));
    }

    [Fact]
    public async Task A_bad_answer_keeps_the_last_table()
    {
        using var dir = new TempDir();
        var body = V2;
        var handler = new Handler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) });
        var now = At;
        var svc = new FxService(new HttpClient(handler), dir.Path, () => false, new NullEventSink()) { Clock = () => now };
        await svc.RefreshAsync(false, CancellationToken.None);
        body = "<html>oops</html>";
        now = At.AddDays(2);
        var status = await svc.RefreshAsync(false, CancellationToken.None);
        Assert.Equal("2026-10-10", status.Date);
        Assert.NotNull(status.Error);
        await Assert.ThrowsAsync<BridgeException>(() => { now = now.AddHours(1); return svc.RefreshAsync(true, CancellationToken.None); });
    }
}
