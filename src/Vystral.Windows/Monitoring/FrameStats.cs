using System.Globalization;
using System.Text;

namespace Vystral.Windows.Monitoring;

/// <summary>Whole-session frame statistics. All values are null-free: a summary only exists when frames were seen.</summary>
public sealed record FrameSummary(
    int Frames,
    double FpsAvg,
    double Fps1Low,
    double Fps01Low,
    double FrameTimeP50Ms,
    double FrameTimeP99Ms,
    int Stutters,
    IReadOnlyList<int> Histogram);

/// <summary>Frame statistics for one sampling window (about 2 s).</summary>
public readonly record struct FrameWindow(double Fps, double FrameTimeMs, double FrameTimeP99Ms);

/// <summary>
/// Streaming frame-time statistics with bounded memory: a 0.1 ms histogram up to 250 ms for
/// percentiles and lows, exact sums, a 32-frame ring for stutter detection, and a capped list
/// for the current sampling window. A 3-hour session at 240 fps uses the same memory as a
/// 1-minute one.
/// </summary>
public sealed class FrameStats
{
    /// <summary>Display histogram bucket upper edges (ms); the last bucket is everything above 100 ms.</summary>
    public static readonly double[] HistogramEdgesMs = [4, 6, 8, 10, 12, 14, 17, 20, 25, 33, 50, 100];

    private const double Resolution = 0.1;      // ms per fine bucket
    private const int FineBuckets = 2500;       // 0–250 ms
    private const double MaxFrameMs = 5000;     // longer gaps are pauses (alt-tab, loading), not frames
    private const int WindowCap = 20_000;
    private const int RingSize = 32;

    private readonly Lock _lock = new();
    private readonly int[] _fine = new int[FineBuckets];
    private readonly int[] _display = new int[HistogramEdgesMs.Length + 1];
    private readonly double[] _ring = new double[RingSize];
    private readonly List<double> _window = [];
    private int _ringCount, _ringPos;
    private long _frames;
    private double _sumMs;
    private long _overflowCount;
    private double _overflowSum;
    private int _stutters;

    public long Frames { get { lock (_lock) return _frames; } }

    /// <summary>Adds one frame time. Values outside (0, 5000] ms are ignored.</summary>
    public void Add(double frameTimeMs)
    {
        if (!(frameTimeMs > 0) || frameTimeMs > MaxFrameMs || double.IsNaN(frameTimeMs)) return;
        lock (_lock)
        {
            _frames++;
            _sumMs += frameTimeMs;
            var idx = (int)(frameTimeMs / Resolution);
            if (idx < FineBuckets) _fine[idx]++;
            else
            {
                _overflowCount++;
                _overflowSum += frameTimeMs;
            }
            _display[DisplayBucket(frameTimeMs)]++;

            if (IsStutter(frameTimeMs)) _stutters++;
            _ring[_ringPos] = frameTimeMs;
            _ringPos = (_ringPos + 1) % RingSize;
            if (_ringCount < RingSize) _ringCount++;

            if (_window.Count < WindowCap) _window.Add(frameTimeMs);
        }
    }

    /// <summary>
    /// A stutter is a frame that took more than twice as long as the recent average (last 32
    /// frames) and at least 8 ms longer, so tiny variations at very high frame rates don't count.
    /// </summary>
    private bool IsStutter(double ft)
    {
        if (_ringCount < 8) return false;
        double sum = 0;
        for (var i = 0; i < _ringCount; i++) sum += _ring[i];
        var mean = sum / _ringCount;
        return ft > 2 * mean && ft - mean >= 8;
    }

    private static int DisplayBucket(double ft)
    {
        for (var i = 0; i < HistogramEdgesMs.Length; i++)
            if (ft < HistogramEdgesMs[i]) return i;
        return HistogramEdgesMs.Length;
    }

    /// <summary>Returns and clears the current window's statistics, or null if no frames arrived.</summary>
    public FrameWindow? DrainWindow()
    {
        double[] w;
        lock (_lock)
        {
            if (_window.Count == 0) return null;
            w = [.. _window];
            _window.Clear();
        }
        var sum = w.Sum();
        Array.Sort(w);
        var p99 = w[Math.Clamp((int)Math.Ceiling(0.99 * w.Length) - 1, 0, w.Length - 1)];
        return new FrameWindow(Math.Round(1000.0 * w.Length / sum, 1), Math.Round(sum / w.Length, 2), Math.Round(p99, 2));
    }

    /// <summary>Whole-session summary, or null when no frames were recorded.</summary>
    public FrameSummary? Summarize()
    {
        lock (_lock)
        {
            if (_frames == 0) return null;
            var avgFt = _sumMs / _frames;
            return new FrameSummary(
                (int)Math.Min(int.MaxValue, _frames),
                Math.Round(1000.0 / avgFt, 1),
                Math.Round(1000.0 / WorstMean(0.01), 1),
                Math.Round(1000.0 / WorstMean(0.001), 1),
                Math.Round(Percentile(0.50), 2),
                Math.Round(Percentile(0.99), 2),
                _stutters,
                [.. _display]);
        }
    }

    /// <summary>Nearest-rank percentile from the fine histogram (bucket midpoint, ±0.05 ms).</summary>
    private double Percentile(double p)
    {
        var rank = Math.Max(1, (long)Math.Ceiling(p * _frames));
        long seen = 0;
        for (var i = 0; i < FineBuckets; i++)
        {
            seen += _fine[i];
            if (seen >= rank) return (i + 0.5) * Resolution;
        }
        return _overflowCount > 0 ? _overflowSum / _overflowCount : FineBuckets * Resolution;
    }

    /// <summary>Mean frame time of the slowest <paramref name="fraction"/> of frames (at least one frame).</summary>
    private double WorstMean(double fraction)
    {
        var k = Math.Max(1, (long)Math.Ceiling(fraction * _frames));
        long taken = 0;
        double sum = 0;
        if (_overflowCount > 0)
        {
            var take = Math.Min(k, _overflowCount);
            sum += _overflowSum / _overflowCount * take;
            taken += take;
        }
        for (var i = FineBuckets - 1; i >= 0 && taken < k; i--)
        {
            if (_fine[i] == 0) continue;
            var take = Math.Min(k - taken, _fine[i]);
            sum += (i + 0.5) * Resolution * take;
            taken += take;
        }
        return sum / Math.Max(1, taken);
    }
}

/// <summary>
/// Parses PresentMon's CSV output line by line. Header-driven and tolerant: it understands the
/// 2.x default columns, --v2_metrics and --v1_metrics, ignores rows for other processes, and
/// locks onto the target's main swap chain so overlays and secondary windows don't skew results.
/// </summary>
public sealed class PresentMonCsvParser(int targetPid)
{
    // Frame time = time between successive Present() calls of the swap chain. It exists in every
    // PresentMon version (msBetweenPresents in 1.x) and is the figure most tools call "frame time".
    private static readonly string[] FrameTimeColumns = ["MsBetweenPresents", "msBetweenPresents", "MsBetweenAppStart", "FrameTime"];
    private const int LockInRows = 240;

    private string[]? _header;
    private int _appCol = -1, _pidCol = -1, _swapCol = -1, _ftCol = -1;
    private readonly Dictionary<string, int> _swapCounts = new(StringComparer.Ordinal);
    private int _lockInSeen;
    private string? _swapChain;

    public bool HasHeader => _header is not null;

    /// <summary>The lock-in phase is over (a main swap chain was chosen, or swap chains aren't reported).</summary>
    public bool Locked => _swapChain is not null || (_header is not null && _swapCol < 0);

    /// <summary>Returns the frame time in ms for a row that belongs to the target, otherwise null.</summary>
    public double? ParseLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line) || line.Length > 4096) return null;
        var fields = line.TrimEnd('\r').Split(',');
        if (_header is null)
        {
            if (TrySetHeader(fields)) return null;
            return null;
        }

        // Only the Application (exe name) column is free text; if it contained commas, shift the rest.
        var shift = fields.Length - _header.Length;
        if (shift < 0) return null;
        int Col(int c) => c < 0 ? -1 : (shift > 0 && c > _appCol && _appCol >= 0 ? c + shift : c);

        if (_pidCol >= 0)
        {
            if (!int.TryParse(fields[Col(_pidCol)], NumberStyles.Integer, CultureInfo.InvariantCulture, out var pid) || pid != targetPid)
                return null;
        }

        if (_ftCol < 0 || !double.TryParse(fields[Col(_ftCol)], NumberStyles.Float, CultureInfo.InvariantCulture, out var ft)) return null;

        if (_swapCol >= 0)
        {
            var swap = fields[Col(_swapCol)];
            if (_swapChain is null)
            {
                _swapCounts[swap] = _swapCounts.GetValueOrDefault(swap) + 1;
                if (++_lockInSeen < LockInRows) return null;
                _swapChain = _swapCounts.MaxBy(kv => kv.Value).Key;
                _swapCounts.Clear();
                return null;
            }
            if (!string.Equals(swap, _swapChain, StringComparison.Ordinal)) return null;
        }
        return ft;
    }

    private bool TrySetHeader(string[] fields)
    {
        var ft = -1;
        foreach (var name in FrameTimeColumns)
        {
            ft = Array.FindIndex(fields, f => string.Equals(f.Trim(), name, StringComparison.OrdinalIgnoreCase));
            if (ft >= 0) break;
        }
        if (ft < 0) return false;
        _header = fields.Select(f => f.Trim()).ToArray();
        _ftCol = ft;
        _appCol = Index("Application");
        _pidCol = Index("ProcessID");
        _swapCol = Index("SwapChainAddress");
        return true;
    }

    private int Index(string name) => Array.FindIndex(_header!, f => string.Equals(f, name, StringComparison.OrdinalIgnoreCase));
}

/// <summary>
/// Splits a byte stream into text lines, choosing UTF-16LE or UTF-8 from the first bytes
/// (PresentMon writes UTF-16 when its output is a console or file, narrow text to a pipe).
/// Lines are capped so a malformed stream can't grow memory without bound.
/// </summary>
public sealed class OutputLineReader
{
    private const int MaxLine = 8192;
    private Decoder? _decoder;
    private readonly StringBuilder _line = new();
    private bool _skipping;

    public IEnumerable<string> Feed(ReadOnlySpan<byte> bytes) => FeedCore(bytes.ToArray());

    private IEnumerable<string> FeedCore(byte[] bytes)
    {
        var offset = 0;
        if (_decoder is null)
        {
            if (bytes.Length == 0) yield break;
            var utf16 = (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE) || (bytes.Length >= 2 && bytes[1] == 0 && bytes[0] != 0);
            if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE) offset = 2;
            else if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) offset = 3;
            _decoder = (utf16 ? Encoding.Unicode : Encoding.UTF8).GetDecoder();
        }
        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length - offset + 4)];
        var n = _decoder.GetChars(bytes, offset, bytes.Length - offset, chars, 0);
        for (var i = 0; i < n; i++)
        {
            var c = chars[i];
            if (c == '\n')
            {
                if (!_skipping) yield return _line.ToString().TrimEnd('\r');
                _line.Clear();
                _skipping = false;
            }
            else if (!_skipping)
            {
                if (c == '﻿' && _line.Length == 0) continue;
                _line.Append(c);
                if (_line.Length > MaxLine)
                {
                    _line.Clear();
                    _skipping = true;
                }
            }
        }
    }
}
