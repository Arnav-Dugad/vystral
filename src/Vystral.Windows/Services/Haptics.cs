using System.Collections.Frozen;

namespace Vystral.Windows.Services;

/// <summary>One step of a vibration pattern: motor levels (0–1) held for <see cref="DurationMs"/>.</summary>
public readonly record struct HapticStep(int DurationMs, double LeftMotor, double RightMotor, double LeftTrigger = 0, double RightTrigger = 0);

/// <summary>
/// The only vibrations VYSTRAL can play. The UI asks for a pattern by name; it can never pass
/// strengths or durations, so every buzz is short, gentle and ends with the motors off.
/// </summary>
public static class HapticPatterns
{
    /// <summary>Stops any pattern immediately. Always allowed, never rate-limited.</summary>
    public const string Stop = "stop";

    /// <summary>No motor is ever driven above this (Xbox motors are loud and draining at full power).</summary>
    public const double MaxLevel = 0.6;

    /// <summary>Upper bound on any single pattern.</summary>
    public const int MaxDurationMs = 1000;

    // Left = low-frequency "thump" motor, Right = high-frequency "buzz" motor; triggers are
    // the impulse-trigger motors (silently ignored by pads without them).
    private static readonly FrozenDictionary<string, HapticStep[]> Table = new Dictionary<string, HapticStep[]>(StringComparer.Ordinal)
    {
        // A barely-there click for tab switches and selections.
        ["tick"] = [new(16, 0, 0.12)],
        // A soft, round bump when focus runs into the end of a row or list.
        ["edge"] = [new(26, 0.2, 0.05), new(18, 0.08, 0)],
        // The Play moment: a firm pulse with a short decaying tail.
        ["confirm"] = [new(60, 0.42, 0.5, 0, 0.18), new(50, 0.18, 0.2), new(60, 0.06, 0.06)],
        // Hold-to-confirm: rises gently over ~900 ms; the UI stops it on early release.
        ["hold"] = Ramp(9, 100, 0.03, 0.3, 0.01, 0.16, 0.22),
        // Two short low buzzes: "that didn't work".
        ["error"] = [new(55, 0.34, 0.1), new(55, 0, 0), new(55, 0.34, 0.1)],
    }.ToFrozenDictionary(StringComparer.Ordinal);

    /// <summary>Minimum gap before the same pattern may play again.</summary>
    private static readonly FrozenDictionary<string, int> MinGapMs = new Dictionary<string, int>(StringComparer.Ordinal)
    {
        ["tick"] = 45,
        ["edge"] = 140,
        ["confirm"] = 400,
        ["hold"] = 450,
        ["error"] = 500,
    }.ToFrozenDictionary(StringComparer.Ordinal);

    public static IReadOnlyCollection<string> Names => Table.Keys;

    public static bool IsKnown(string? name) => name is not null && (name == Stop || Table.ContainsKey(name));

    public static bool TryGet(string? name, out IReadOnlyList<HapticStep> steps)
    {
        if (name is not null && Table.TryGetValue(name, out var s))
        {
            steps = s;
            return true;
        }
        steps = [];
        return false;
    }

    public static int DurationOf(IReadOnlyList<HapticStep> steps) => steps.Sum(s => s.DurationMs);

    internal static int MinGap(string name) => MinGapMs.GetValueOrDefault(name, 100);

    private static HapticStep[] Ramp(int steps, int stepMs, double left0, double left1, double right0, double right1, double trigger1) =>
        Enumerable.Range(0, steps).Select(i =>
        {
            // Ease-in so the ramp is felt most near the end, like the ring filling.
            var t = steps == 1 ? 1 : (double)i / (steps - 1);
            var e = t * t;
            return new HapticStep(stepMs, left0 + (left1 - left0) * e, right0 + (right1 - right0) * e, 0, trigger1 * e);
        }).ToArray();
}

/// <summary>Why a vibration request did not play (or <see cref="Play"/> when it should).</summary>
public enum HapticOutcome { Play, Stop, Disabled, GameActive, RateLimited }

/// <summary>
/// Gatekeeper between the bridge and the controller motors: respects the vibration setting,
/// never vibrates while a game is running (Performance Mode), and rate-limits so the UI cannot
/// buzz continuously — each pattern has a minimum gap, and total vibration is capped to a duty
/// budget over a sliding window. Pure logic (clock injected) so it is unit-testable.
/// </summary>
public sealed class HapticGovernor(Func<bool> enabled, Func<bool> gameActive, Func<long>? clockMs = null)
{
    /// <summary>At most this many milliseconds of vibration may start within <see cref="WindowMs"/>.</summary>
    public const int BudgetMs = 2000;
    public const int WindowMs = 4000;

    private readonly Func<long> _clock = clockMs ?? (() => Environment.TickCount64);
    private readonly Dictionary<string, long> _last = new(StringComparer.Ordinal);
    private readonly Queue<(long At, int Ms)> _recent = new();
    private readonly Lock _lock = new();

    /// <summary>Decides whether <paramref name="pattern"/> may play now. Unknown names throw.</summary>
    public HapticOutcome Request(string pattern, out IReadOnlyList<HapticStep> steps)
    {
        steps = [];
        if (pattern == HapticPatterns.Stop) return HapticOutcome.Stop;
        if (!HapticPatterns.TryGet(pattern, out var found)) throw new ArgumentException("Unknown vibration pattern.", nameof(pattern));
        if (!enabled()) return HapticOutcome.Disabled;
        if (gameActive()) return HapticOutcome.GameActive;

        var duration = HapticPatterns.DurationOf(found);
        lock (_lock)
        {
            var now = _clock();
            if (_last.TryGetValue(pattern, out var at) && now - at < HapticPatterns.MinGap(pattern)) return HapticOutcome.RateLimited;
            while (_recent.Count > 0 && now - _recent.Peek().At >= WindowMs) _recent.Dequeue();
            if (_recent.Sum(r => r.Ms) + duration > BudgetMs) return HapticOutcome.RateLimited;
            _last[pattern] = now;
            _recent.Enqueue((now, duration));
        }
        steps = found;
        return HapticOutcome.Play;
    }
}
