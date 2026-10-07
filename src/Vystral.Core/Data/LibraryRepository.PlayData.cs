using System.Globalization;
using Dapper;
using Vystral.Core.Insights;

namespace Vystral.Core.Data;

/// <summary>
/// Track Y (schema v8): the display each session started on, controller battery history, and read models for
/// the hardware timeline and the energy estimate.
/// </summary>
public sealed partial class LibraryRepository
{
    private const string ObservedFinished = "end IS NOT NULL AND source IN ('tracked','detected','background')";

    // ---------- Display per session ----------

    public void SetSessionDisplay(string sessionId, SessionDisplay display)
    {
        var d = SessionDisplay.Sanitize(display.Width, display.Height, display.RefreshHz, display.Hdr);
        using var conn = db.Open();
        conn.Execute("UPDATE sessions SET display_width=@Width, display_height=@Height, display_hz=@RefreshHz, display_hdr=@hdr WHERE id=@sessionId",
            new { sessionId, d.Width, d.Height, d.RefreshHz, hdr = d.Hdr is null ? (int?)null : d.Hdr.Value ? 1 : 0 });
    }

    /// <summary>Finished observed sessions with their GPU driver and display, oldest first.</summary>
    public IReadOnlyList<HardwareSessionRow> GetHardwareSessions(string? gameId = null)
    {
        using var conn = db.Open();
        return conn.Query<(string Id, string GameId, string Start, int Duration, string? Driver, string? Gpu, long? W, long? H, long? Hz, long? Hdr)>($"""
                SELECT id, game_id, start, duration_seconds, gpu_driver, gpu_name, display_width, display_height, display_hz, display_hdr
                FROM sessions WHERE {ObservedFinished} AND (@gameId IS NULL OR game_id=@gameId)
                ORDER BY start
                """, new { gameId })
            .Where(r => DateTimeOffset.TryParse(r.Start, CultureInfo.InvariantCulture, out _))
            .Select(r => new HardwareSessionRow(r.Id, r.GameId, DateTimeOffset.Parse(r.Start, CultureInfo.InvariantCulture), r.Duration, r.Driver, r.Gpu,
                (int?)r.W, (int?)r.H, (int?)r.Hz, r.Hdr is null ? null : r.Hdr == 1))
            .ToList();
    }

    // ---------- Energy ----------

    /// <summary>Finished observed sessions with their perf summary and GPU, for the energy estimate.</summary>
    public IReadOnlyList<EnergySessionRow> GetEnergySessions(string? gameId = null)
    {
        using var conn = db.Open();
        return conn.Query<(string Id, string GameId, string Start, int Duration, string? Perf, string? Gpu)>($"""
                SELECT id, game_id, start, duration_seconds, perf_summary_json, gpu_name
                FROM sessions WHERE {ObservedFinished} AND (@gameId IS NULL OR game_id=@gameId)
                """, new { gameId })
            .Where(r => DateTimeOffset.TryParse(r.Start, CultureInfo.InvariantCulture, out _))
            .Select(r => new EnergySessionRow(r.Id, r.GameId, DateTimeOffset.Parse(r.Start, CultureInfo.InvariantCulture), r.Duration, r.Perf, r.Gpu))
            .ToList();
    }

    // ---------- Controller battery ----------

    public void AddBatteryReading(BatteryReading r)
    {
        if (Clip(r.Pad, 64) is not { } pad) return;
        using var conn = db.Open();
        conn.Execute("""
            INSERT OR REPLACE INTO controller_battery(pad, at, name, percent, charging) VALUES (@pad, @at, @name, @percent, @charging)
            """, new { pad, at = Utc(r.At), name = Clip(r.Name, 60) ?? "Controller", percent = Math.Clamp(r.Percent, 0, 100), charging = r.Charging ? 1 : 0 });
    }

    /// <summary>Every reading at or after <paramref name="since"/>, oldest first.</summary>
    public IReadOnlyList<BatteryReading> GetBatteryReadings(DateTimeOffset since)
    {
        using var conn = db.Open();
        return conn.Query<(string Pad, string At, string Name, int Percent, long Charging)>(
                "SELECT pad, at, name, percent, charging FROM controller_battery WHERE at >= @since ORDER BY at", new { since = Utc(since) })
            .Where(r => DateTimeOffset.TryParse(r.At, CultureInfo.InvariantCulture, out _))
            .Select(r => new BatteryReading(r.Pad, r.Name, r.Percent, r.Charging == 1, DateTimeOffset.Parse(r.At, CultureInfo.InvariantCulture)))
            .ToList();
    }

    /// <summary>The newest reading per pad (used to decide whether a new one is worth keeping after a restart).</summary>
    public IReadOnlyDictionary<string, BatteryReading> GetLatestBatteryReadings()
    {
        using var conn = db.Open();
        return conn.Query<(string Pad, string At, string Name, int Percent, long Charging)>("""
                SELECT b.pad, b.at, b.name, b.percent, b.charging FROM controller_battery b
                WHERE b.at = (SELECT MAX(x.at) FROM controller_battery x WHERE x.pad = b.pad)
                """)
            .Where(r => DateTimeOffset.TryParse(r.At, CultureInfo.InvariantCulture, out _))
            .ToDictionary(r => r.Pad, r => new BatteryReading(r.Pad, r.Name, r.Percent, r.Charging == 1, DateTimeOffset.Parse(r.At, CultureInfo.InvariantCulture)), StringComparer.Ordinal);
    }

    public int PruneBatteryReadings(DateTimeOffset before)
    {
        using var conn = db.Open();
        return conn.Execute("DELETE FROM controller_battery WHERE at < @before", new { before = Utc(before) });
    }

    public int ClearBatteryReadings()
    {
        using var conn = db.Open();
        var n = conn.Execute("DELETE FROM controller_battery");
        Audit("controller.batteryHistory.clear", $"{n} readings");
        return n;
    }

    /// <summary>Fixed-width UTC timestamps, so text order is time order.</summary>
    private static string Utc(DateTimeOffset t) => t.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
}
