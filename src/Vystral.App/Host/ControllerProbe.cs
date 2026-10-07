using Vystral.Windows.Bridge;
using Vystral.Windows.Services;
using Windows.Gaming.Input;

namespace Vystral.App.Host;

/// <summary>Connected controllers and their battery level (Windows.Gaming.Input; read-only).</summary>
internal static class ControllerProbe
{
    public static IReadOnlyList<ControllerInfo> Get()
    {
        var list = new List<ControllerInfo>();
        try
        {
            foreach (var raw in RawGameController.RawGameControllers)
            {
                string name;
                bool wireless;
                try
                {
                    name = string.IsNullOrWhiteSpace(raw.DisplayName) ? "Controller" : raw.DisplayName.Trim();
                    wireless = raw.IsWireless;
                }
                catch (Exception) { name = "Controller"; wireless = false; }

                int? percent = null;
                bool? charging = null;
                try
                {
                    var report = raw.TryGetBatteryReport();
                    if (report is not null && report.Status != global::Windows.System.Power.BatteryStatus.NotPresent &&
                        report.RemainingCapacityInMilliwattHours is int remaining && report.FullChargeCapacityInMilliwattHours is int full && full > 0)
                    {
                        percent = Math.Clamp((int)Math.Round(100.0 * remaining / full), 0, 100);
                        charging = report.Status == global::Windows.System.Power.BatteryStatus.Charging;
                    }
                }
                catch (Exception) { }

                name = name.Length > 60 ? name[..60] : name;
                string? key = null;
                try { key = ControllerKeys.For(raw.NonRoamableId, name); } catch (Exception) { } // Track Y: matches the battery history
                list.Add(new ControllerInfo(name, percent, charging, wireless, key));
            }
        }
        catch (Exception ex)
        {
            Log.Warn("controller", "Controller query failed", ex: ex);
        }
        return list;
    }
}
