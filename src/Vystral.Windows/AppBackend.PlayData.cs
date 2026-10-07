using Vystral.Core.Contracts;
using Vystral.Core.Insights;
using Vystral.Windows.Bridge;
using Vystral.Windows.Integrations;
using Vystral.Windows.Monitoring;
using Vystral.Windows.Services;
using static Vystral.Windows.Bridge.BridgeDispatcher;

namespace Vystral.Windows;

// Track Y parameter records.
public sealed record BatteryHistoryParams(int? Days);

/// <summary>
/// Track Y (play data and insights): the hardware a session started on (GPU driver, primary display mode),
/// the opt-in energy estimate and controller battery history. Everything is read from the local database
/// and read-only Windows APIs; nothing leaves the PC and nothing on the system is changed.
/// </summary>
public sealed partial class AppBackend
{
    private const string CpuKey = @"HARDWARE\DESCRIPTION\System\CentralProcessor\0";
    private ControllerBatteryService _battery = null!;
    private readonly Lazy<(string? Gpu, string? Cpu)> _machine = new(ReadMachine);

    private void RegisterPlayDataHandlers()
    {
        Sessions.DisplayIdentity = DisplayProbe.ForPrimary;

        _battery = new ControllerBatteryService(Repository, () => Settings.GetBool("controller.batteryHistory"));
        _battery.Start(_life.Token);

        Dispatcher.Register<OptionalGameIdParams>("insights.hardwareHistory", (p, _) =>
        {
            var gameId = p.GameId is null ? null : RequireId(p.GameId, "game");
            return Task.FromResult<object?>(HardwareHistory.Build(Repository.GetHardwareSessions(gameId)));
        });

        Dispatcher.Register<OptionalGameIdParams>("energy.report", (p, _) =>
        {
            var gameId = p.GameId is null ? null : RequireId(p.GameId, "game");
            return Task.FromResult<object?>(EnergyReport(gameId));
        });

        Dispatcher.Register<BatteryHistoryParams>("controller.batteryHistory", (p, _) =>
        {
            var days = p.Days ?? 7;
            if (days is < 1 or > 90) throw new BridgeException("invalid", "Days must be between 1 and 90.");
            return Task.FromResult<object?>(BatteryReport(days));
        });

        Dispatcher.Register("controller.clearBatteryHistory", _ =>
        {
            Repository.ClearBatteryReadings();
            _battery.Reset();
            return Task.FromResult<object?>(BatteryReport(7));
        });
    }

    private EnergyReportDto EnergyReport(string? gameId)
    {
        if (!Settings.GetBool("energy.enabled")) return EnergyModel.Disabled;
        var (gpu, cpu) = _machine.Value;
        var watts = Settings.GetNumber("energy.watts");
        var price = Settings.GetNumber("energy.price");
        return EnergyModel.Build(Repository.GetEnergySessions(gameId), gpu, cpu, watts > 0 ? watts : null,
            price > 0 ? price : null, Settings.GetString("energy.currency"), TimeZoneInfo.Local);
    }

    private BatteryHistoryDto BatteryReport(int days)
    {
        var now = DateTimeOffset.UtcNow;
        // The drain rate looks at two weeks even when the chart shows fewer days.
        var readings = Repository.GetBatteryReadings(now.AddDays(-Math.Max(days, 14)));
        return new BatteryHistoryDto(Settings.GetBool("controller.batteryHistory"), days, BatteryHistory.Build(readings, now.AddDays(-days)));
    }

    /// <summary>The usual drain of one pad (points per hour), for the pre-flight card.</summary>
    private double? BatteryDrainFor(string pad)
    {
        var readings = Repository.GetBatteryReadings(DateTimeOffset.UtcNow.AddDays(-14)).Where(r => r.Pad == pad).ToList();
        return BatteryHistory.DrainPerHour(readings);
    }

    /// <summary>This PC's main GPU and CPU names (read-only registry; once per run).</summary>
    private static (string? Gpu, string? Cpu) ReadMachine()
    {
        var registry = new WindowsRegistryReader();
        string? gpu = null, cpu = null;
        try { gpu = GpuDriverProbe.FromRegistry(registry)?.Name; }
        catch (Exception ex) { Log.Warn("energy", "GPU name unavailable", ex: ex); }
        try { cpu = registry.GetString(Hive.LocalMachine, CpuKey, "ProcessorNameString")?.Trim(); }
        catch (Exception ex) { Log.Warn("energy", "CPU name unavailable", ex: ex); }
        return (gpu, cpu is { Length: > 128 } ? cpu[..128] : cpu);
    }
}
