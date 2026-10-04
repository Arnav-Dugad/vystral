using System.Text.Json;
using Vystral.Core.Contracts;
using Vystral.Windows.Monitoring;
using Xunit;

namespace Vystral.Tests.Services;

public sealed class PerfSamplerTests
{
    private static PerfSampleDto S(int t, double? cpu = null, double? gpu = null, double? mem = null, double? ram = null, double? temp = null) =>
        new(t, cpu, gpu, mem, ram, temp);

    [Fact]
    public void Empty_samples_give_all_nulls_and_the_fps_notice()
    {
        var s = PerfSampler.Summarize([]);
        Assert.Equal(new PerfSummary(0, null, null, null, null, null, null, null, null, null, null, PerfSampler.FpsUnavailable), s);
    }

    [Fact]
    public void Single_sample_is_used_as_is()
    {
        var s = PerfSampler.Summarize([S(0, cpu: 40, ram: 8000)]);
        Assert.Equal(1, s.Samples);
        Assert.Equal(40, s.CpuAvg);
        Assert.Equal(40, s.CpuMax);
        Assert.Equal(8000, s.RamAvgMb);
    }

    [Fact]
    public void Two_samples_are_both_used()
    {
        var s = PerfSampler.Summarize([S(0, cpu: 10), S(1000, cpu: 20)]);
        Assert.Equal(2, s.Samples);
        Assert.Equal(15, s.CpuAvg);
        Assert.Equal(20, s.CpuMax);
    }

    [Fact]
    public void First_sample_is_skipped_when_more_than_two()
    {
        // The first counter reading has no baseline and is often a spike.
        var s = PerfSampler.Summarize([S(0, cpu: 100, gpu: 99), S(1000, cpu: 10, gpu: 30), S(2000, cpu: 20, gpu: 50)]);
        Assert.Equal(3, s.Samples);
        Assert.Equal(15, s.CpuAvg);
        Assert.Equal(20, s.CpuMax);
        Assert.Equal(40, s.GpuAvg);
        Assert.Equal(50, s.GpuMax);
    }

    [Fact]
    public void Null_readings_are_ignored()
    {
        var s = PerfSampler.Summarize([
            S(0, gpu: 1),
            S(1000, cpu: 30, gpu: 50, temp: null),
            S(2000, cpu: null, gpu: null, temp: 70),
            S(3000, cpu: 50, gpu: 70, temp: 80),
        ]);
        Assert.Equal(40, s.CpuAvg);
        Assert.Equal(60, s.GpuAvg);
        Assert.Equal(70, s.GpuMax);
        Assert.Equal(75, s.GpuTempAvgC);
        Assert.Equal(80, s.GpuTempMaxC);
    }

    [Fact]
    public void Metrics_never_measured_stay_null()
    {
        var s = PerfSampler.Summarize([S(0, cpu: 1, ram: 1), S(1000, cpu: 2, ram: 2), S(2000, cpu: 3, ram: 3)]);
        Assert.Null(s.GpuAvg);
        Assert.Null(s.GpuMax);
        Assert.Null(s.GpuMemAvgMb);
        Assert.Null(s.GpuMemMaxMb);
        Assert.Null(s.GpuTempAvgC);
        Assert.Null(s.GpuTempMaxC);
        Assert.Equal(2.5, s.RamAvgMb);
        Assert.Equal(3, s.RamMaxMb);
    }

    [Fact]
    public void Averages_are_rounded_to_one_decimal()
    {
        var s = PerfSampler.Summarize([S(0, mem: 0), S(1000, mem: 10), S(2000, mem: 10), S(3000, mem: 11)]);
        Assert.Equal(10.3, s.GpuMemAvgMb);
        Assert.Equal(11, s.GpuMemMaxMb);
    }

    [Fact]
    public void Fps_status_is_always_the_not_recorded_message()
    {
        var many = Enumerable.Range(0, 50).Select(i => S(i * 1000, cpu: i, gpu: i, mem: i, ram: i, temp: i)).ToList();
        var s = PerfSampler.Summarize(many);
        Assert.Equal(PerfSampler.FpsUnavailable, s.FpsStatus);
        Assert.Contains("not recorded", s.FpsStatus);
        Assert.Equal(50, s.Samples);
    }

    [Fact]
    public void ToJson_is_camel_case_and_round_trips()
    {
        var summary = PerfSampler.Summarize([S(0, cpu: 10), S(1000, cpu: 20)]);
        var json = PerfSampler.ToJson(summary);
        using var doc = JsonDocument.Parse(json);
        Assert.Equal(2, doc.RootElement.GetProperty("samples").GetInt32());
        Assert.Equal(15, doc.RootElement.GetProperty("cpuAvg").GetDouble());
        Assert.Equal(JsonValueKind.Null, doc.RootElement.GetProperty("gpuAvg").ValueKind);
        Assert.Equal(PerfSampler.FpsUnavailable, doc.RootElement.GetProperty("fpsStatus").GetString());
        Assert.Equal(summary, JsonSerializer.Deserialize<PerfSummary>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
    }
}
