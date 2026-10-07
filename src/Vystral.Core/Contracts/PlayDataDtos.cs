namespace Vystral.Core.Contracts;

// Track Y (play data and insights) bridge DTOs. Mirrored in ui/src/bridge/types.playData.ts.

/// <summary>One finished session with the hardware it started on. Display fields are null when unknown.</summary>
public sealed record HardwareSessionDto(
    string SessionId, string GameId, string Start, int DurationSeconds,
    string? Driver, string? GpuName, int? Width, int? Height, int? RefreshHz, bool? Hdr);

/// <summary>
/// A change between two consecutive sessions that both knew the value. Kind: driver | gpu | display | hdr.
/// At is the start of the first session that ran on the new value.
/// </summary>
public sealed record HardwareChangeDto(string Kind, string At, string SessionId, string? From, string? To);

/// <summary>A stretch of sessions on one value (one driver, or one display mode). Lane: driver | display.</summary>
public sealed record HardwareSpanDto(string Lane, string Value, string From, string To, int Sessions);

public sealed record HardwareHistoryDto(
    IReadOnlyList<HardwareSessionDto> Sessions, IReadOnlyList<HardwareChangeDto> Changes, IReadOnlyList<HardwareSpanDto> Spans,
    int WithDriver, int WithDisplay);

/// <summary>How the energy estimate was made, shown verbatim in the method popover.</summary>
public sealed record EnergyMethodDto(
    string Source, string? GpuName, string GpuClass, double GpuWatts, bool GpuKnown,
    string? CpuName, double CpuWatts, bool CpuKnown, double BaseWatts, bool Laptop, double? ManualWatts, double TypicalLoad);

public sealed record EnergySessionDto(string SessionId, string GameId, string Start, int DurationSeconds, double KWh, double AvgWatts, bool Partial);
public sealed record EnergyGameDto(string GameId, double KWh, int Sessions, double Hours);
public sealed record EnergyMonthDto(string Month, double KWh, int Sessions, double Hours);

/// <summary>
/// Opt-in energy estimate. Enabled false means the user hasn't turned it on (everything else is empty).
/// Price is per kWh in the user's currency (null: no cost shown). Excluded counts sessions without load samples.
/// </summary>
public sealed record EnergyReportDto(
    bool Enabled, EnergyMethodDto? Method, double? Price, string? Currency,
    double TotalKWh, int Sessions, int Excluded, int Partial,
    IReadOnlyList<EnergySessionDto> SessionList, IReadOnlyList<EnergyGameDto> Games, IReadOnlyList<EnergyMonthDto> Months);

public sealed record BatteryPointDto(string At, int Percent, bool Charging);

/// <summary>One controller's battery readings for the chart, oldest first, with the usual drain rate when known.</summary>
public sealed record ControllerBatteryDto(
    string Pad, string Name, IReadOnlyList<BatteryPointDto> Points, int? Latest, bool? Charging, string? LastSeen,
    double? DrainPerHour, int? MinutesLeft);

public sealed record BatteryHistoryDto(bool Enabled, int Days, IReadOnlyList<ControllerBatteryDto> Pads);
