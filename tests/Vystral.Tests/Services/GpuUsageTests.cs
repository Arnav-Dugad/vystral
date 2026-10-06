using Vystral.Windows.Monitoring;
using Xunit;

namespace Vystral.Tests.Services;

public sealed class GpuUsageTests
{
    private const long Second = 10_000_000; // 100 ns units
    private const long Dgpu = 0x16952, Igpu = 0x16516;

    /// <summary>Kernel statistics with hand-set running times and clock.</summary>
    private sealed class FakeStats : IGpuStats
    {
        public List<GpuAdapter> List = [];
        public readonly Dictionary<(long, uint), long> Running = [];
        public readonly Dictionary<long, long> Dedicated = [];
        public readonly HashSet<long> Failing = [];
        public long Clock = 1_000 * Second;
        public int Enumerations;

        public IReadOnlyList<GpuAdapter> Adapters() { Enumerations++; return List.ToList(); }
        public long? NodeRunningTime(long luid, uint node) => Failing.Contains(luid) ? null : Running.GetValueOrDefault((luid, node));
        public long? DedicatedBytes(GpuAdapter adapter) => Dedicated.TryGetValue(adapter.Luid, out var b) ? b : null;
        public long Now() => Clock;

        /// <summary>Advances the clock by <paramref name="seconds"/> with each adapter's node 0 busy the given share of it.</summary>
        public void Run(double seconds, params (long Luid, double Percent)[] busy)
        {
            var dt = (long)(seconds * Second);
            Clock += dt;
            foreach (var (luid, pct) in busy) Running[(luid, 0u)] = Running.GetValueOrDefault((luid, 0u)) + (long)(dt * pct / 100);
        }
    }

    private static FakeStats Hybrid()
    {
        var f = new FakeStats();
        f.List = [new GpuAdapter(Igpu, Integrated: true, [0], [0]), new GpuAdapter(Dgpu, Integrated: false, [0], [1])];
        f.Dedicated[Igpu] = 0;
        f.Dedicated[Dgpu] = 2048L * 1048576;
        return f;
    }

    // ---- utilisation math ----

    [Fact]
    public void Utilisation_is_running_time_growth_over_elapsed_time()
    {
        Assert.Equal(50, GpuMath.Utilisation(10 * Second, 11 * Second, 2 * Second));
        Assert.Equal(100, GpuMath.Utilisation(0, 2 * Second, 2 * Second));
        Assert.Equal(0, GpuMath.Utilisation(5 * Second, 5 * Second, 2 * Second));
    }

    [Fact]
    public void Utilisation_is_clamped_reset_counters_read_idle_and_short_intervals_give_nothing()
    {
        Assert.Equal(100, GpuMath.Utilisation(0, 3 * Second, 2 * Second)); // several engines folded into one node, rounding
        Assert.Equal(0, GpuMath.Utilisation(9 * Second, 1 * Second, 2 * Second)); // driver reset: counter went back
        Assert.Null(GpuMath.Utilisation(0, 1000, GpuMath.MinInterval100ns - 1));
        Assert.Null(GpuMath.Utilisation(0, 1000, -5));
    }

    // ---- kernel source ----

    [Fact]
    public void First_reading_sets_the_baseline_then_the_busy_gpu_is_reported_with_its_vram()
    {
        var f = Hybrid();
        using var src = KernelGpuSource.TryCreate(f)!;
        var first = src.Read()!.Value;
        Assert.Null(first.Util);
        Assert.Equal(2048, first.DedicatedMb); // no evidence yet: the discrete GPU

        f.Run(2, (Dgpu, 90), (Igpu, 12));
        var r = src.Read()!.Value;
        Assert.Equal(90, r.Util!.Value, 3);
        Assert.Equal(2048, r.DedicatedMb);
    }

    [Fact]
    public void A_game_on_the_integrated_gpu_is_reported_and_has_no_vram()
    {
        var f = Hybrid();
        using var src = KernelGpuSource.TryCreate(f)!;
        src.Read();
        f.Run(2, (Igpu, 70), (Dgpu, 0));
        var r = src.Read()!.Value;
        Assert.Equal(70, r.Util!.Value, 3);
        Assert.Null(r.DedicatedMb);
    }

    [Fact]
    public void A_short_burst_on_the_other_gpu_does_not_flip_the_choice()
    {
        var f = Hybrid();
        using var src = KernelGpuSource.TryCreate(f)!;
        src.Read();
        for (var i = 0; i < 30; i++)
        {
            f.Run(2, (Dgpu, 95), (Igpu, 10));
            src.Read();
        }
        // Loading screen: the game's GPU idles while the desktop GPU plays a video.
        for (var i = 0; i < 5; i++)
        {
            f.Run(2, (Dgpu, 1), (Igpu, 40));
            Assert.Equal(1, src.Read()!.Value.Util!.Value, 3);
        }
    }

    [Fact]
    public void The_busiest_3d_engine_of_an_adapter_counts()
    {
        var f = new FakeStats { List = [new GpuAdapter(Dgpu, false, [0, 3], [1])] };
        f.Dedicated[Dgpu] = 0;
        using var src = KernelGpuSource.TryCreate(f)!;
        src.Read();
        f.Clock += 2 * Second;
        f.Running[(Dgpu, 0)] = (long)(0.4 * Second);
        f.Running[(Dgpu, 3)] = (long)(1.6 * Second);
        Assert.Equal(80, src.Read()!.Value.Util!.Value, 3);
    }

    [Fact]
    public void No_adapter_means_no_kernel_source()
    {
        Assert.Null(KernelGpuSource.TryCreate(new FakeStats()));
    }

    [Fact]
    public void Failing_queries_relist_adapters_and_hand_over_after_three_silent_readings()
    {
        var f = Hybrid();
        using var src = KernelGpuSource.TryCreate(f)!;
        src.Read();
        f.Failing.Add(Dgpu);
        f.Failing.Add(Igpu);
        f.Run(2);
        Assert.NotNull(src.Read());
        f.Run(2);
        Assert.NotNull(src.Read());
        f.Run(2);
        Assert.Null(src.Read());
        Assert.True(f.Enumerations >= 3);
    }

    [Fact]
    public void An_adapter_that_disappears_is_dropped_when_relisted()
    {
        var f = Hybrid();
        using var src = KernelGpuSource.TryCreate(f)!;
        src.Read();
        f.Run(2, (Dgpu, 60));
        src.Read();
        // The discrete GPU goes away (driver update); the integrated one keeps answering.
        f.Failing.Add(Dgpu);
        f.List = [f.List[0]];
        f.Run(31, (Igpu, 20));
        src.Read(); // fails for the dGPU, relists
        f.Run(2, (Igpu, 20));
        var r = src.Read()!.Value;
        Assert.Equal(20, r.Util!.Value, 3);
        Assert.Null(r.DedicatedMb);
    }

    // ---- adapter choice ----

    [Fact]
    public void Without_evidence_a_discrete_gpu_is_preferred()
    {
        var c = new AdapterChooser();
        Assert.Equal(Dgpu, c.Choose([(Igpu, 8, true), (Dgpu, 2, false)], 2));
    }

    [Fact]
    public void The_gpu_with_the_most_3d_work_wins()
    {
        var c = new AdapterChooser();
        c.Choose([(Igpu, 10, true), (Dgpu, 0, false)], 2);
        c.Choose([(Igpu, 10, true), (Dgpu, 0, false)], 2);
        c.Choose([(Igpu, 10, true), (Dgpu, 0, false)], 2);
        Assert.Equal(Igpu, c.Chosen); // 60 %·s of work on the iGPU, none on the dGPU
        for (var i = 0; i < 3; i++) c.Choose([(Igpu, 10, true), (Dgpu, 80, false)], 2);
        Assert.Equal(Dgpu, c.Chosen);
    }

    [Fact]
    public void A_single_adapter_is_always_chosen_and_no_loads_keep_the_choice()
    {
        var c = new AdapterChooser();
        Assert.Equal(Igpu, c.Choose([(Igpu, 0, true)], 2));
        Assert.Equal(Igpu, c.Choose([], 2));
    }

    // ---- fallback chain ----

    private sealed class FakeSource(string name, Func<GpuReading?> read) : IGpuSource
    {
        public bool Disposed;
        public int Reads;
        public string Name => name;
        public GpuReading? Read() { Reads++; return read(); }
        public void Dispose() => Disposed = true;
    }

    [Fact]
    public void A_source_that_cannot_be_created_is_skipped()
    {
        var pdh = new FakeSource("PDH", () => new GpuReading(40, 1000));
        using var meter = new GpuMeter([() => throw new DllNotFoundException("gdi32"), () => null, () => pdh]);
        Assert.Equal("PDH", meter.Source);
        Assert.Equal(new GpuReading(40, 1000), meter.Read());
    }

    [Fact]
    public void A_source_that_throws_or_stops_hands_over_to_the_next()
    {
        var calls = 0;
        var kmt = new FakeSource("D3DKMT", () => ++calls < 3 ? new GpuReading(10, 1) : throw new InvalidOperationException("driver"));
        var pdh = new FakeSource("PDH", () => new GpuReading(20, 2));
        using var meter = new GpuMeter([() => kmt, () => pdh]);
        Assert.Equal(new GpuReading(10, 1), meter.Read()); // the constructor's baseline read was call 1
        Assert.Equal(new GpuReading(20, 2), meter.Read());
        Assert.True(kmt.Disposed);
        Assert.Equal("PDH", meter.Source);
    }

    [Fact]
    public void With_no_working_source_readings_are_empty_and_nothing_throws()
    {
        var dead = new FakeSource("D3DKMT", () => null);
        using var meter = new GpuMeter([() => dead]);
        Assert.Null(meter.Source);
        Assert.Equal(new GpuReading(null, null), meter.Read());
        Assert.Equal(new GpuReading(null, null), meter.Read());
        Assert.True(dead.Disposed);
        Assert.Equal(1, dead.Reads);
    }

    [Fact]
    public void Disposing_the_meter_disposes_its_source()
    {
        var src = new FakeSource("D3DKMT", () => new GpuReading(1, 1));
        var meter = new GpuMeter([() => src]);
        meter.Dispose();
        Assert.True(src.Disposed);
        Assert.Equal(new GpuReading(null, null), meter.Read());
    }

    [Fact]
    public void Sampler_reports_the_meters_reading()
    {
        var src = new FakeSource("D3DKMT", () => new GpuReading(87.26, 5480.04));
        using var sampler = new PerfSampler(new GpuMeter([() => src]));
        var s = sampler.Sample(2000);
        Assert.Equal(87.3, s.Gpu);
        Assert.Equal(5480, s.GpuMemMb);
        Assert.Equal("D3DKMT", sampler.GpuSource);
    }

    // ---- PDH instance names (fallback source) ----

    [Fact]
    public void Pdh_instance_names_parse_into_luid_and_engine()
    {
        Assert.Equal((0x16952L, 0, true), PdhGpuSource.ParseEngine("pid_29528_luid_0x00000000_0x00016952_phys_0_eng_0_engtype_3D"));
        Assert.Equal((0x1_0000D1B4L, 4, false), PdhGpuSource.ParseEngine("pid_1_luid_0x00000001_0x0000D1B4_phys_0_eng_4_engtype_Copy"));
        Assert.Null(PdhGpuSource.ParseEngine("pid_1_luid_0xZZ_phys_0_eng_0_engtype_3D"));
        Assert.Null(PdhGpuSource.ParseEngine("_Total"));
        Assert.Equal(0x16516L, PdhGpuSource.ParseLuid("luid_0x00000000_0x00016516_phys_0", 0));
        Assert.Null(PdhGpuSource.ParseLuid("luid_0x0000_0x1", 0));
    }

    [Fact]
    public void Real_kernel_statistics_never_throw()
    {
        // Whatever this machine has (CI runners usually have only the basic display adapter): no exception.
        using var meter = GpuMeter.CreateDefault();
        var r = meter.Read();
        Assert.True(r.Util is null or >= 0 and <= 100);
        Assert.True(r.DedicatedMb is null or >= 0);
    }
}
