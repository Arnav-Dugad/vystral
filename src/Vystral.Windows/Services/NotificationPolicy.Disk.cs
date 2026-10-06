using System.Text.Json;
using Vystral.Windows.Bridge;
using Vystral.Windows.Launch;

namespace Vystral.Windows.Services;

/// <summary>Track P: "An update won't fit on D:" from the update-space forecast (<c>disk.forecast</c> events).</summary>
public sealed partial class NotificationPolicy
{
    public const string DiskSpace = "notifications.diskSpace";

    /// <summary>
    /// One notification per drive per situation: the same pending updates in the same state never
    /// notify twice (in this run), however often the forecast is refreshed. Only "short" (won't fit)
    /// and "tight" (leaves under ~5 % free) drives notify.
    /// </summary>
    private void FromDiskForecast(JsonElement p, List<NotificationRequest> list)
    {
        if (!setting(DiskSpace) || !p.TryGetProperty("drives", out var drives) || drives.ValueKind != JsonValueKind.Array) return;
        foreach (var d in drives.EnumerateArray().Take(8))
        {
            if (d.ValueKind != JsonValueKind.Object) continue;
            var status = Str(d, "status");
            if (status is not ("short" or "tight")) continue;
            var drive = Clean(Str(d, "drive"));
            if (drive is null || !d.TryGetProperty("updates", out var updates) || updates.ValueKind != JsonValueKind.Array) continue;
            var items = updates.EnumerateArray().Where(u => u.ValueKind == JsonValueKind.Object).Take(50).ToList();
            if (items.Count == 0) continue;
            var ids = string.Join(',', items.Select(u => Str(u, "appId") ?? "?").Order(StringComparer.Ordinal));
            if (!Once($"disk:{drive}:{status}:{ids}")) continue;

            var free = Long(d, "freeBytes");
            var need = Long(d, "needBytes");
            var lead = items[0];
            var leadName = (Str(lead, "gameId") is { } gid && Hex32().IsMatch(gid) ? gameTitle(gid) : null) ?? Clean(Str(lead, "name")) ?? "A game";
            var route = Route("storage");
            if (status == "short")
            {
                var body = items.Count == 1
                    ? $"{leadName} needs {PreflightChecks.FormatBytes(need)} for its next update, and {drive} has {PreflightChecks.FormatBytes(free)} free. Open Storage Studio to make room."
                    : $"{items.Count} pending updates need {PreflightChecks.FormatBytes(need)} together, and {drive} has {PreflightChecks.FormatBytes(free)} free. Open Storage Studio to make room.";
                list.Add(new NotificationRequest("diskSpace", items.Count == 1 ? $"An update won’t fit on {drive}" : $"Updates won’t fit on {drive}", body, route,
                    Tag: $"disk-{Math.Abs(drive.GetHashCode()) % 100000}"));
            }
            else
            {
                var after = Math.Max(0, Long(d, "afterBytes"));
                var body = items.Count == 1
                    ? $"{leadName}’s next update needs {PreflightChecks.FormatBytes(need)}, leaving {PreflightChecks.FormatBytes(after)} free."
                    : $"{items.Count} pending updates need {PreflightChecks.FormatBytes(need)}, leaving {PreflightChecks.FormatBytes(after)} free.";
                list.Add(new NotificationRequest("diskSpace", $"{drive} is nearly full for updates", body, route,
                    Tag: $"disk-{Math.Abs(drive.GetHashCode()) % 100000}"));
            }
        }
    }

    private static long Long(JsonElement p, string name) =>
        p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;
}
