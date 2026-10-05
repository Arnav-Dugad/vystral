using System.Text.Json;
using Vystral.Core.Contracts;
using Vystral.Windows.Monitoring;
using Xunit;

namespace Vystral.Tests.Insights;

public sealed class ThrottleTests
{
    [Theory]
    [InlineData(0x0UL, ThrottleFlags.None)]
    [InlineData(0x1UL, ThrottleFlags.None)]                                  // GPU idle is not throttling
    [InlineData(0x20UL, ThrottleFlags.ThermalSoftware)]
    [InlineData(0x48UL, ThrottleFlags.ThermalHardware)]                      // HW slowdown + HW thermal
    [InlineData(0x8UL, ThrottleFlags.ThermalHardware)]                       // legacy HW slowdown alone
    [InlineData(0x88UL, ThrottleFlags.PowerBrake)]                           // HW slowdown explained by power brake
    [InlineData(0x4UL, ThrottleFlags.PowerCap)]
    [InlineData(0x24UL, ThrottleFlags.ThermalSoftware | ThrottleFlags.PowerCap)]
    public void Nvml_reasons_decode(ulong nvml, ThrottleFlags expected) => Assert.Equal(expected, Throttle.FromNvml(nvml));

    private static InsightSampleDto X(int t, ThrottleFlags? f, double? clock = 1800) => new(t, clock, f is null ? null : (int)f, null, null, null);

    [Fact]
    public void Throttle_totals_use_sample_spacing_and_cap_gaps()
    {
        var extras = new[]
        {
            X(0, ThrottleFlags.None),
            X(2000, ThrottleFlags.ThermalSoftware),
            X(4000, ThrottleFlags.ThermalSoftware | ThrottleFlags.PowerCap),
            X(60_000, ThrottleFlags.ThermalHardware),   // gap: counts at most 5 s
            X(62_000, ThrottleFlags.PowerCap),
        };
        var (thermal, power, reasons) = PerfSampler.ThrottleTotals(extras);
        Assert.Equal(9, thermal);
        Assert.Equal(4, power);
        Assert.Equal(["thermal", "power"], reasons);
    }

    [Fact]
    public void No_throttle_data_stays_null()
    {
        var (thermal, power, reasons) = PerfSampler.ThrottleTotals([X(0, null), X(2000, null)]);
        Assert.Null(thermal);
        Assert.Null(power);
        Assert.Null(reasons);
        var (t2, _, r2) = PerfSampler.ThrottleTotals([X(0, ThrottleFlags.None), X(2000, ThrottleFlags.None)]);
        Assert.Equal(0, t2);
        Assert.Null(r2);
    }

    [Fact]
    public void Thirty_seconds_of_thermal_throttling_adds_a_note()
    {
        var samples = Enumerable.Range(0, 200).Select(i => new PerfSampleDto(i * 2000, 30, 90, 4000, 9000, i < 100 ? 70 : 86)).ToList();
        var extras = Enumerable.Range(0, 200).Select(i => X(i * 2000, i >= 74 ? ThrottleFlags.ThermalSoftware : ThrottleFlags.None)).ToList();
        var s = PerfSampler.Summarize(samples, extras, null, PerfSampler.FpsUnavailable);
        Assert.Equal(252, s.ThrottledSeconds);
        Assert.Equal(86, s.PeakTempC);
        Assert.Equal(1800, s.GpuClockAvgMhz);
        Assert.Equal("Your GPU got hot and slowed down for 4m 12s — check airflow, a laptop stand, or a lower power profile in your laptop's performance app (for example Armoury Crate).", s.ThermalNote);

        var shortThrottle = PerfSampler.Summarize(samples, extras.Select((e, i) => i is >= 10 and < 24 ? e with { ThrottleFlags = 1 } : e with { ThrottleFlags = 0 }).ToList(), null, "x");
        Assert.Equal(28, shortThrottle.ThrottledSeconds);
        Assert.Null(shortThrottle.ThermalNote);
    }

    [Fact]
    public void Frame_summary_flows_into_the_perf_summary_json()
    {
        var stats = new FrameStats();
        for (var i = 0; i < 500; i++) stats.Add(i % 100 == 0 ? 40 : 10);
        var s = PerfSampler.Summarize([new PerfSampleDto(0, 1, 1, 1, 1, null)], [], stats.Summarize(), "Measured.");
        Assert.NotNull(s.FpsAvg);
        Assert.Equal(500, s.FrameCount);
        Assert.Equal(13, s.FrameTimeHistogram!.Count);
        Assert.StartsWith("Intel PresentMon", s.FpsSource);
        using var doc = JsonDocument.Parse(PerfSampler.ToJson(s));
        Assert.True(doc.RootElement.TryGetProperty("fps1Low", out _));
        Assert.True(doc.RootElement.TryGetProperty("throttledSeconds", out var t) && t.ValueKind == JsonValueKind.Null);
        Assert.Equal("Measured.", doc.RootElement.GetProperty("fpsStatus").GetString());
    }

    [Theory]
    [InlineData(45, "45s")]
    [InlineData(252, "4m 12s")]
    [InlineData(3780, "1h 03m")]
    public void Durations_read_naturally(int seconds, string expected) => Assert.Equal(expected, Throttle.FormatDuration(seconds));
}
