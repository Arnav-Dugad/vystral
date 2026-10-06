using Windows.Gaming.Input;
using Windows.Networking.Connectivity;
using Windows.System.Power;

namespace Vystral.Windows.Services;

/// <summary>PC battery for the Immersive system bar; null when the PC has no battery.</summary>
public sealed record BatteryDto(int Percent, bool Charging, bool Saver);

/// <summary>Network for the system bar. Kind: wifi | ethernet | cellular | other | none. Bars: 0–5 (Wi-Fi/cellular only).</summary>
public sealed record NetworkDto(string Kind, int? Bars, bool Internet);

/// <summary>One Xbox-compatible controller. Battery 0–1, null when wired or unknown.</summary>
public sealed record ControllerDto(double? Battery, bool Charging, bool Wired);

public sealed record SystemStatusDto(BatteryDto? Battery, NetworkDto Network, IReadOnlyList<ControllerDto> Controllers);

/// <summary>
/// Track L: what the Immersive system bar shows — PC battery (Windows.System.Power), the internet
/// connection and its signal (Windows.Networking.Connectivity) and each controller's battery
/// (Windows.Gaming.Input). Read-only, cheap, cached for a few seconds; the mapping is pure and tested.
/// </summary>
public sealed class SystemStatusService
{
    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(5);
    private readonly Lock _lock = new();
    private SystemStatusDto? _cached;
    private DateTime _cachedAt;

    public SystemStatusDto Current
    {
        get
        {
            lock (_lock)
            {
                if (_cached is not null && DateTime.UtcNow - _cachedAt < CacheFor) return _cached;
            }
            var value = new SystemStatusDto(ReadBattery(), ReadNetwork(), ReadControllers());
            lock (_lock)
            {
                _cached = value;
                _cachedAt = DateTime.UtcNow;
            }
            return value;
        }
    }

    /// <summary>Remaining/full capacity as 0–1; null when either is unknown or nonsensical.</summary>
    public static double? Fraction(int? remaining, int? full)
    {
        if (remaining is not { } r || full is not { } f || f <= 0 || r < 0) return null;
        return Math.Round(Math.Clamp((double)r / f, 0, 1), 3);
    }

    /// <summary>Windows' 0–5 signal bars, clamped; null when not reported.</summary>
    public static int? Bars(byte? bars) => bars is { } b ? Math.Clamp((int)b, 0, 5) : null;

    /// <summary>The PC battery, or null when there is none (Windows reports NotPresent or no percentage).</summary>
    public static BatteryDto? Battery(string status, int percent, bool saver)
    {
        if (status == nameof(BatteryStatus.NotPresent) || percent is < 0 or > 100) return null;
        return new BatteryDto(percent, status == nameof(BatteryStatus.Charging), saver);
    }

    /// <summary>A controller's reading. Wired pads report no battery (or NotPresent); a full report gives 0–1.</summary>
    public static ControllerDto Controller(string? status, int? remaining, int? full)
    {
        if (status is null || status == nameof(BatteryStatus.NotPresent)) return new ControllerDto(null, false, true);
        return new ControllerDto(Fraction(remaining, full), status == nameof(BatteryStatus.Charging), false);
    }

    public static string Kind(bool wlan, bool wwan) => wlan ? "wifi" : wwan ? "cellular" : "ethernet";

    private static BatteryDto? ReadBattery()
    {
        try
        {
            var saver = PowerManager.EnergySaverStatus == EnergySaverStatus.On;
            return Battery(PowerManager.BatteryStatus.ToString(), PowerManager.RemainingChargePercent, saver);
        }
        catch (Exception ex)
        {
            Log.Warn("system", "Battery status unavailable", ex: ex);
            return null;
        }
    }

    private static NetworkDto ReadNetwork()
    {
        try
        {
            var profile = NetworkInformation.GetInternetConnectionProfile();
            if (profile is null) return new NetworkDto("none", null, false);
            var internet = profile.GetNetworkConnectivityLevel() == NetworkConnectivityLevel.InternetAccess;
            var wlan = profile.IsWlanConnectionProfile;
            var wwan = profile.IsWwanConnectionProfile;
            return new NetworkDto(Kind(wlan, wwan), wlan || wwan ? Bars(profile.GetSignalBars()) : null, internet);
        }
        catch (Exception ex)
        {
            Log.Warn("system", "Network status unavailable", ex: ex);
            return new NetworkDto("other", null, true);
        }
    }

    private static IReadOnlyList<ControllerDto> ReadControllers()
    {
        try
        {
            return Gamepad.Gamepads.Take(4).Select(pad =>
            {
                try
                {
                    var report = pad.TryGetBatteryReport();
                    return report is null
                        ? new ControllerDto(null, false, true)
                        : Controller(report.Status.ToString(), report.RemainingCapacityInMilliwattHours, report.FullChargeCapacityInMilliwattHours);
                }
                catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException or InvalidOperationException)
                {
                    return new ControllerDto(null, false, false); // unplugged while reading
                }
            }).ToList();
        }
        catch (Exception ex)
        {
            Log.Warn("system", "Controller status unavailable", ex: ex);
            return [];
        }
    }
}
