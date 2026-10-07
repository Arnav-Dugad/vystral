using System.Globalization;
using System.Text.Json;
using Vystral.Windows.Bridge;

namespace Vystral.Windows.Services;

/// <summary>
/// Track V: "Pacific Drive leaves Game Pass around 16 Oct" (<c>subs.leaving</c>) and GeForce NOW queue alerts
/// (<c>cloud.queue</c>: "You're nearly through the queue", "Your stream is starting").
/// </summary>
public sealed partial class NotificationPolicy
{
    public const string SubsLeaving = "subs.leavingNotify";
    public const string CloudQueue = "cloud.queueAlerts";

    private void FromLeaving(JsonElement p, List<NotificationRequest> list)
    {
        if (!setting(SubsLeaving) || !p.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) return;
        var rows = items.EnumerateArray().Where(i => i.ValueKind == JsonValueKind.Object).Take(10).ToList();
        if (rows.Count == 0) return;
        var key = Clean(Str(p, "key")) ?? string.Join(',', rows.Select(r => Str(r, "gameId") ?? "?"));
        if (!Once($"leaving:{key}")) return;
        var count = p.TryGetProperty("count", out var c) && c.ValueKind == JsonValueKind.Number && c.TryGetInt32(out var n) ? Math.Max(n, rows.Count) : rows.Count;
        var first = rows[0];
        var gameId = Str(first, "gameId") is { } g && Hex32().IsMatch(g) ? g : null;
        var title = Clean(Str(first, "title")) ?? (gameId is null ? null : gameTitle(gameId)) ?? "A game in your library";
        var when = LeavingDate(Str(first, "end"));
        if (count == 1)
        {
            list.Add(new NotificationRequest("subsLeaving", when is null ? $"{title} is leaving Game Pass soon" : $"{title} leaves Game Pass around {when}",
                "Play it while it’s included, or check the Store for a member discount. Xbox sets the final date.",
                gameId is null ? Route("library") : Route("game", ("id", gameId)), Tag: $"leaving-{(key.GetHashCode() & 0x7fffffff) % 100000}"));
            return;
        }
        var names = rows.Take(3).Select(r => Clean(Str(r, "title"))).OfType<string>().ToList();
        var more = count > names.Count ? $" and {count - names.Count} more" : "";
        list.Add(new NotificationRequest("subsLeaving", $"{count} of your games are leaving Game Pass soon",
            $"{string.Join(", ", names)}{more}. Xbox sets the final dates.", Route("library"), Tag: $"leaving-{(key.GetHashCode() & 0x7fffffff) % 100000}"));
    }

    /// <summary>"16 Oct" in the user's format, from a round-trip date; null when missing or invalid.</summary>
    private static string? LeavingDate(string? iso) =>
        iso is not null && DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d)
            ? d.ToLocalTime().ToString("d MMM", CultureInfo.CurrentCulture) : null;

    private void FromQueue(JsonElement p, List<NotificationRequest> list)
    {
        if (!setting(CloudQueue)) return;
        var notify = Str(p, "notify");
        if (notify is not ("near" or "starting")) return;
        var key = Clean(Str(p, "key")) ?? "";
        if (!Once($"queue:{notify}:{key}")) return;
        var gameId = Str(p, "gameId") is { } g && Hex32().IsMatch(g) ? g : null;
        var title = Clean(Str(p, "title")) ?? (gameId is null ? null : gameTitle(gameId)) ?? "your game";
        var route = gameId is null ? Route("home") : Route("game", ("id", gameId));
        if (notify == "starting")
        {
            list.Add(new NotificationRequest("cloudQueue", "Your stream is starting", $"GeForce NOW is starting {title}. Head back to the GeForce NOW window.",
                route, Tag: $"queue-{(key.GetHashCode() & 0x7fffffff) % 100000}"));
            return;
        }
        var position = p.TryGetProperty("position", out var pos) && pos.ValueKind == JsonValueKind.Number && pos.TryGetInt32(out var x) ? x : (int?)null;
        var eta = p.TryGetProperty("etaMinutes", out var e) && e.ValueKind == JsonValueKind.Number && e.TryGetInt32(out var m) ? m : (int?)null;
        var where = position is { } n ? $"You’re number {n} in the queue for {title}" : $"{title} is nearly through the queue";
        var detail = eta is { } mins ? (mins <= 1 ? " About a minute to go." : $" About {mins} minutes to go.") : "";
        list.Add(new NotificationRequest("cloudQueue", "Almost your turn on GeForce NOW", $"{where}.{detail} As shown in the GeForce NOW window.",
            route, Tag: $"queue-{(key.GetHashCode() & 0x7fffffff) % 100000}"));
    }
}
