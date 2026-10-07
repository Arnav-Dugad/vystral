using System.Text.Json;
using Vystral.Windows.Bridge;

namespace Vystral.Windows.Services;

/// <summary>Track W: "Starfall Tactics is out now" and "lowest price ever" from wishlist refreshes (<c>wishlist.alerts</c>).</summary>
public sealed partial class NotificationPolicy
{
    public const string Wishlist = "notifications.wishlist";

    /// <summary>
    /// One notification per refresh: a single game gets its own message, several are summed up. Each game and
    /// moment notifies once (the wishlist service also remembers this across restarts).
    /// </summary>
    private void FromWishlist(JsonElement p, List<NotificationRequest> list)
    {
        if (!setting(Wishlist) || !p.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) return;
        var fresh = new List<(string Kind, string Name, string? Price)>();
        foreach (var i in items.EnumerateArray().Take(6))
        {
            if (i.ValueKind != JsonValueKind.Object) continue;
            var kind = Str(i, "kind");
            var appId = Str(i, "appId");
            var name = Clean(Str(i, "name"));
            if (kind is not ("released" or "newLow" or "atLow") || appId is not { Length: > 0 and <= 10 } || !appId.All(char.IsAsciiDigit) || name is null) continue;
            var price = Clean(Str(i, "price"));
            if (price is { Length: > 24 }) price = null;
            if (Once($"wishlist:{kind}:{appId}:{price}")) fresh.Add((kind, name, price));
        }
        if (fresh.Count == 0) return;
        var route = Route("wishlist");
        if (fresh.Count == 1)
        {
            var (kind, name, price) = fresh[0];
            list.Add(kind == "released"
                ? new NotificationRequest("wishlist", $"{name} is out now", "A game on your Steam wishlist was just released.", route, Tag: "wishlist")
                : new NotificationRequest("wishlist", kind == "newLow" ? $"{name}: lowest price ever" : $"{name} is at its lowest price",
                    price is null ? "A game on your Steam wishlist dropped to its lowest recorded price." : $"Now {price} on Steam, the lowest price recorded for it.",
                    route, Tag: "wishlist"));
            return;
        }
        var released = fresh.Count(f => f.Kind == "released");
        var lows = fresh.Count - released;
        var title = released > 0 && lows > 0 ? "Wishlist news" : released > 0 ? $"{released} wishlist games are out now" : $"{lows} wishlist games at their lowest price";
        list.Add(new NotificationRequest("wishlist", title, string.Join(", ", fresh.Take(3).Select(f => f.Name)) + (fresh.Count > 3 ? $" and {fresh.Count - 3} more" : ""),
            route, Tag: "wishlist"));
    }
}
