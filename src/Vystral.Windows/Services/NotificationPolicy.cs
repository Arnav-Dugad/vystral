using System.Text.Json;
using System.Text.RegularExpressions;
using Vystral.Windows.Bridge;

namespace Vystral.Windows.Services;

/// <summary>
/// Decides which Windows notifications to show, from the same events the UI receives. It reads
/// a handful of event types (launch.state, update.state, install.progress) and never anything
/// else, respects the per-category settings and "only when VYSTRAL is in the background", and
/// shows each item once. Focus Assist / Do Not Disturb is applied by Windows itself.
/// </summary>
public sealed partial class NotificationPolicy(Func<string, bool> setting, Func<string, string?> gameTitle)
{
    public const string Enabled = "notifications.enabled";
    public const string Sessions = "notifications.sessions";
    public const string Updates = "notifications.updates";
    public const string Installs = "notifications.installs";
    public const string Thermal = "notifications.thermal";
    public const string OnlyInBackground = "notifications.onlyInBackground";

    private readonly HashSet<string> _shown = new(StringComparer.Ordinal);
    private readonly Lock _lock = new();

    public IReadOnlyList<NotificationRequest> Evaluate(string eventName, JsonElement payload, bool foreground)
    {
        if (eventName is not ("launch.state" or "update.state" or "install.progress")) return [];
        if (payload.ValueKind != JsonValueKind.Object || !setting(Enabled)) return [];
        if (foreground && setting(OnlyInBackground)) return [];

        var list = new List<NotificationRequest>(2);
        try
        {
            switch (eventName)
            {
                case "launch.state": FromLaunch(payload, list); break;
                case "update.state": FromUpdate(payload, list); break;
                case "install.progress": FromInstall(payload, list); break;
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or JsonException or FormatException)
        {
            Log.Warn("notify", $"Ignored malformed {eventName} payload", ex: ex);
        }
        return list;
    }

    private void FromLaunch(JsonElement p, List<NotificationRequest> list)
    {
        if (Str(p, "phase") != "ended" || Str(p, "sessionId") is not { } sessionId || !Hex32().IsMatch(sessionId)) return;
        if (!p.TryGetProperty("durationSeconds", out var d) || d.ValueKind != JsonValueKind.Number) return;
        var title = (Str(p, "gameId") is { } gid ? gameTitle(gid) : null) ?? "your game";

        if (setting(Sessions) && Once($"session:{sessionId}"))
            list.Add(new NotificationRequest("session", $"Played {title} · {FormatPlaytime(d.GetInt32())}", "Session saved to your journal.",
                Route("journal"), Tag: $"session-{sessionId[..8]}"));

        if (setting(Thermal) && Str(p, "perfSummary") is { } json)
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("throttledSeconds", out var t) && t.ValueKind == JsonValueKind.Number &&
                t.GetInt32() >= Monitoring.Throttle.NoteThresholdSeconds && Once($"thermal:{sessionId}"))
            {
                list.Add(new NotificationRequest("thermal", $"Your GPU ran hot in {title}",
                    $"It slowed down for {Monitoring.Throttle.FormatDuration(t.GetInt32())}. Better airflow or a lower power profile can help.",
                    Route("performance", ("sessionId", sessionId)), Tag: $"thermal-{sessionId[..8]}"));
            }
        }
    }

    private void FromUpdate(JsonElement p, List<NotificationRequest> list)
    {
        if (!setting(Updates) || Str(p, "phase") != "ready") return;
        var version = Str(p, "newVersion") ?? "";
        if (version.Length > 40 || !Once($"update:{version}")) return;
        list.Add(new NotificationRequest("update", version.Length > 0 ? $"VYSTRAL {version} is ready" : "A VYSTRAL update is ready",
            "Restart VYSTRAL to finish updating. It also installs when you close VYSTRAL.", Route("settings", ("section", "updates")), Tag: "update"));
    }

    private void FromInstall(JsonElement p, List<NotificationRequest> list)
    {
        if (!setting(Installs) || Str(p, "phase") != "installed") return;
        if (Str(p, "kind") is { } kind && kind != "install") return; // updates finishing aren't news
        var gameId = Str(p, "gameId") is { } g && Hex32().IsMatch(g) ? g : null;
        var title = Clean(Str(p, "title")) ?? (gameId is null ? null : gameTitle(gameId)) ?? "Your game";
        var key = gameId ?? Str(p, "installationId") ?? Str(p, "appId") ?? title;
        if (!Once($"install:{key}")) return;
        list.Add(new NotificationRequest("install", $"{title} is installed", "It's ready to play.",
            gameId is null ? Route("library") : Route("game", ("id", gameId)), Tag: $"install-{Math.Abs(key.GetHashCode()) % 100000}"));
    }

    private bool Once(string key)
    {
        lock (_lock)
        {
            if (_shown.Count > 500) _shown.Clear();
            return _shown.Add(key);
        }
    }

    public static string FormatPlaytime(int seconds)
    {
        if (seconds >= 3600) return $"{seconds / 3600}h {seconds % 3600 / 60:00}m";
        if (seconds >= 60) return $"{seconds / 60}m";
        return "under a minute";
    }

    /// <summary>A UI Route object (see ui/src/state/store.ts) as JSON.</summary>
    public static string Route(string name, params (string Key, string Value)[] extra)
    {
        var o = new Dictionary<string, string> { ["name"] = name };
        foreach (var (k, v) in extra) o[k] = v;
        return JsonSerializer.Serialize(o);
    }

    private static string? Str(JsonElement p, string name) =>
        p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string? Clean(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = new string(s.Where(c => !char.IsControl(c)).ToArray()).Trim();
        return s.Length == 0 ? null : s.Length > 80 ? s[..80] + "…" : s;
    }

    [GeneratedRegex("^[0-9a-f]{32}$")]
    private static partial Regex Hex32();
}
