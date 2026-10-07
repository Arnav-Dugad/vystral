using System.Security.Cryptography;
using System.Text;
using Vystral.Core.Data;
using Vystral.Core.Insights;
using Windows.Gaming.Input;

namespace Vystral.Windows.Services;

/// <summary>Opaque, stable keys for controllers: the battery history never stores a device id.</summary>
public static class ControllerKeys
{
    /// <summary>First 16 hex digits of SHA-256 over the device's non-roamable id (else its name).</summary>
    public static string For(string? deviceId, string name)
    {
        var source = string.IsNullOrWhiteSpace(deviceId) ? $"name:{name}" : $"id:{deviceId}";
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(source)))[..16];
    }
}

/// <summary>
/// Track Y: controller battery history. Reads each wireless controller's battery (Windows.Gaming.Input,
/// read-only) once a minute and keeps a reading about every 10 minutes while it stays connected, plus
/// whenever the level moves by 5 points or charging starts or stops (<see cref="BatteryHistory.ShouldRecord"/>).
/// Readings stay on this PC and are pruned after 90 days. Runs in the app only (not the background tracker).
/// </summary>
public sealed class ControllerBatteryService(LibraryRepository repo, Func<bool> enabled, Func<DateTimeOffset>? clock = null)
{
    public static readonly TimeSpan Poll = TimeSpan.FromMinutes(1);
    private readonly Lock _lock = new();
    private readonly Func<DateTimeOffset> _clock = clock ?? (() => DateTimeOffset.UtcNow);
    private Dictionary<string, BatteryReading>? _last;

    public void Start(CancellationToken ct) => _ = Task.Run(async () =>
    {
        try
        {
            repo.PruneBatteryReadings(_clock() - BatteryHistory.Keep);
            using var timer = new PeriodicTimer(Poll);
            do
            {
                if (enabled()) Observe(ReadPads(_clock()));
            } while (await timer.WaitForNextTickAsync(ct));
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { Log.Warn("controller", "Battery history stopped", ex: ex); }
    }, ct);

    /// <summary>Stores the readings worth keeping; returns how many were stored.</summary>
    public int Observe(IEnumerable<BatteryReading> readings)
    {
        var stored = 0;
        lock (_lock)
        {
            _last ??= Safe(repo.GetLatestBatteryReadings) ?? new Dictionary<string, BatteryReading>(StringComparer.Ordinal);
            foreach (var r in readings)
            {
                _last.TryGetValue(r.Pad, out var last);
                if (!BatteryHistory.ShouldRecord(last, r)) continue;
                try
                {
                    repo.AddBatteryReading(r);
                    _last[r.Pad] = r;
                    stored++;
                }
                catch (Exception ex) { Log.Warn("controller", "Couldn't store a battery reading", ex: ex); }
            }
        }
        return stored;
    }

    /// <summary>Forget the cached last readings (after the history is cleared).</summary>
    public void Reset()
    {
        lock (_lock) _last = null;
    }

    private static Dictionary<string, BatteryReading>? Safe(Func<IReadOnlyDictionary<string, BatteryReading>> read)
    {
        try { return new Dictionary<string, BatteryReading>(read(), StringComparer.Ordinal); }
        catch (Exception ex) { Log.Warn("controller", "Battery history unreadable", ex: ex); return null; }
    }

    /// <summary>Wireless controllers that report a battery level right now.</summary>
    public static IReadOnlyList<BatteryReading> ReadPads(DateTimeOffset now)
    {
        var list = new List<BatteryReading>();
        try
        {
            foreach (var raw in RawGameController.RawGameControllers.Take(8))
            {
                try
                {
                    var report = raw.TryGetBatteryReport();
                    if (report is null || report.Status == global::Windows.System.Power.BatteryStatus.NotPresent ||
                        report.RemainingCapacityInMilliwattHours is not int remaining || report.FullChargeCapacityInMilliwattHours is not int full || full <= 0)
                        continue;
                    var name = string.IsNullOrWhiteSpace(raw.DisplayName) ? "Controller" : raw.DisplayName.Trim();
                    if (name.Length > 60) name = name[..60];
                    var percent = Math.Clamp((int)Math.Round(100.0 * remaining / full), 0, 100);
                    var charging = report.Status == global::Windows.System.Power.BatteryStatus.Charging;
                    list.Add(new BatteryReading(ControllerKeys.For(raw.NonRoamableId, name), name, percent, charging, now));
                }
                catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException or InvalidOperationException) { } // unplugged while reading
            }
        }
        catch (Exception ex) { Log.Warn("controller", "Controller battery query failed", ex: ex); }
        return list;
    }
}
