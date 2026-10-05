using Dapper;
using Vystral.Core.Contracts;

namespace Vystral.Core.Data;

/// <summary>Launch timing and extended performance samples (schema v4).</summary>
public sealed partial class LibraryRepository
{
    /// <summary>Records how long the game took from "launch accepted" to "process detected".</summary>
    public void SetSessionDetectMs(string sessionId, int detectMs)
    {
        using var conn = db.Open();
        conn.Execute("UPDATE sessions SET detect_ms=@detectMs WHERE id=@sessionId", new { sessionId, detectMs = Math.Max(0, detectMs) });
    }

    /// <summary>Detection times of the most recent launches of an installation, newest first.</summary>
    public IReadOnlyList<int> GetRecentDetectMs(string installationId, int limit = 5)
    {
        using var conn = db.Open();
        return conn.Query<int>(
            "SELECT detect_ms FROM sessions WHERE installation_id=@installationId AND detect_ms IS NOT NULL ORDER BY start DESC LIMIT @limit",
            new { installationId, limit }).ToList();
    }

    /// <summary>
    /// Stores the v4 columns for samples. Must run after <see cref="AddPerfSamples"/> for the same
    /// samples, because that method replaces whole rows.
    /// </summary>
    public void AddInsightSamples(string sessionId, IEnumerable<InsightSampleDto> samples)
    {
        using var conn = db.Open();
        using var tx = conn.BeginTransaction();
        foreach (var s in samples)
        {
            conn.Execute("""
                INSERT INTO perf_samples(session_id, t_offset_ms, gpu_clock_mhz, throttle_flags, fps, frame_time_ms, frame_time_p99_ms)
                VALUES (@sessionId, @T, @GpuClockMhz, @ThrottleFlags, @Fps, @FrameTimeMs, @FrameTimeP99Ms)
                ON CONFLICT(session_id, t_offset_ms) DO UPDATE SET
                    gpu_clock_mhz = excluded.gpu_clock_mhz,
                    throttle_flags = excluded.throttle_flags,
                    fps = excluded.fps,
                    frame_time_ms = excluded.frame_time_ms,
                    frame_time_p99_ms = excluded.frame_time_p99_ms
                """, new { sessionId, s.T, s.GpuClockMhz, s.ThrottleFlags, s.Fps, s.FrameTimeMs, s.FrameTimeP99Ms }, tx);
        }
        tx.Commit();
    }

    public IReadOnlyList<InsightSampleDto> GetInsightSamples(string sessionId)
    {
        using var conn = db.Open();
        return conn.Query<(int T, double? Clock, long? Flags, double? Fps, double? Ft, double? Ft99)>("""
                SELECT t_offset_ms, gpu_clock_mhz, throttle_flags, fps, frame_time_ms, frame_time_p99_ms
                FROM perf_samples WHERE session_id=@sessionId ORDER BY t_offset_ms
                """, new { sessionId })
            .Where(r => r.Clock is not null || r.Flags is not null || r.Fps is not null || r.Ft is not null)
            .Select(r => new InsightSampleDto(r.T, r.Clock, r.Flags is null ? null : (int)r.Flags, r.Fps, r.Ft, r.Ft99))
            .ToList();
    }
}
