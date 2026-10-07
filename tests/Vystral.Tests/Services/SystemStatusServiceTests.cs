using System.Text.Json;
using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Services;

/// <summary>Track L: the Immersive system bar's readings (pure mapping; the Windows reads are thin wrappers).</summary>
public sealed class SystemStatusServiceTests
{
    [Theory]
    [InlineData(5000, 10000, 0.5)]
    [InlineData(12000, 10000, 1.0)]
    [InlineData(0, 10000, 0.0)]
    public void Fraction_is_clamped_to_0_1(int remaining, int full, double expected) =>
        Assert.Equal(expected, SystemStatusService.Fraction(remaining, full));

    [Theory]
    [InlineData(null, 10000)]
    [InlineData(5000, null)]
    [InlineData(5000, 0)]
    [InlineData(-1, 10000)]
    public void Fraction_is_null_when_unknown(int? remaining, int? full) => Assert.Null(SystemStatusService.Fraction(remaining, full));

    [Fact]
    public void Bars_are_clamped_and_optional()
    {
        Assert.Equal(3, SystemStatusService.Bars(3));
        Assert.Equal(5, SystemStatusService.Bars(9));
        Assert.Null(SystemStatusService.Bars(null));
    }

    [Fact]
    public void A_pc_without_a_battery_reports_none()
    {
        Assert.Null(SystemStatusService.Battery("NotPresent", 100, false));
        Assert.Null(SystemStatusService.Battery("Discharging", 255, false));
        Assert.Equal(new BatteryDto(42, false, true), SystemStatusService.Battery("Discharging", 42, true));
        Assert.Equal(new BatteryDto(80, true, false), SystemStatusService.Battery("Charging", 80, false));
        Assert.Equal(new BatteryDto(100, false, false), SystemStatusService.Battery("Idle", 100, false));
    }

    [Fact]
    public void Controllers_report_wired_or_a_battery_level()
    {
        Assert.Equal(new ControllerDto(null, false, true), SystemStatusService.Controller(null, null, null));
        Assert.Equal(new ControllerDto(null, false, true), SystemStatusService.Controller("NotPresent", null, null));
        Assert.Equal(new ControllerDto(0.25, false, false), SystemStatusService.Controller("Discharging", 250, 1000));
        Assert.Equal(new ControllerDto(0.9, true, false), SystemStatusService.Controller("Charging", 900, 1000));
        Assert.Equal(new ControllerDto(null, false, false), SystemStatusService.Controller("Discharging", null, null));
    }

    [Fact]
    public void Network_kind()
    {
        Assert.Equal("wifi", SystemStatusService.Kind(true, false));
        Assert.Equal("cellular", SystemStatusService.Kind(false, true));
        Assert.Equal("ethernet", SystemStatusService.Kind(false, false));
    }

    [Fact]
    public void Serializes_in_the_shape_the_UI_expects()
    {
        var dto = new SystemStatusDto(new BatteryDto(76, false, false), new NetworkDto("wifi", 3, true), [new ControllerDto(0.62, false, false)], Clock24h: true);
        var json = JsonSerializer.Serialize(dto, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal("""{"battery":{"percent":76,"charging":false,"saver":false},"network":{"kind":"wifi","bars":3,"internet":true},"controllers":[{"battery":0.62,"charging":false,"wired":false}],"clock24h":true}""", json);
    }

    [Theory]
    [InlineData("HH:mm", true)]
    [InlineData("H:mm", true)]
    [InlineData("H.mm", true)]
    [InlineData("HH' h 'mm", true)]
    [InlineData("h:mm tt", false)]
    [InlineData("hh:mm tt", false)]
    [InlineData("tt h:mm", false)]
    [InlineData("'H'h:mm tt", false)] // a quoted literal H is not the hour
    [InlineData("\\Hh:mm", false)]     // nor is an escaped one
    public void Is24Hour_reads_the_regional_time_pattern(string pattern, bool expected) => Assert.Equal(expected, SystemStatusService.Is24Hour(pattern));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("mm:ss")]
    public void Is24Hour_is_unknown_without_an_hour(string? pattern) => Assert.Null(SystemStatusService.Is24Hour(pattern));

    [Fact]
    public void Reading_the_real_system_never_throws()
    {
        var status = new SystemStatusService().Current;
        Assert.NotNull(status.Network);
        Assert.NotNull(status.Controllers);
        Assert.Contains(status.Network.Kind, new[] { "wifi", "ethernet", "cellular", "other", "none" });
    }
}
