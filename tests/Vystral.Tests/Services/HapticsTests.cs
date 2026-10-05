using Vystral.Windows.Services;
using Xunit;

namespace Vystral.Tests.Services;

public sealed class HapticsTests
{
    private long _now = 10_000;
    private bool _enabled = true;
    private bool _gameActive;

    private HapticGovernor Governor() => new(() => _enabled, () => _gameActive, () => _now);

    [Fact]
    public void Only_the_named_patterns_exist()
    {
        Assert.Equal(["confirm", "edge", "error", "hold", "tick"], HapticPatterns.Names.Order());
        Assert.True(HapticPatterns.IsKnown("stop"));
        foreach (var bad in new[] { null, "", "TICK", "tick ", "buzz", "stop2", "../tick" })
            Assert.False(HapticPatterns.IsKnown(bad));
    }

    [Fact]
    public void Every_pattern_is_short_gentle_and_well_formed()
    {
        foreach (var name in HapticPatterns.Names)
        {
            Assert.True(HapticPatterns.TryGet(name, out var steps));
            Assert.NotEmpty(steps);
            Assert.InRange(HapticPatterns.DurationOf(steps), 1, HapticPatterns.MaxDurationMs);
            foreach (var s in steps)
            {
                Assert.InRange(s.DurationMs, 1, HapticPatterns.MaxDurationMs);
                foreach (var level in new[] { s.LeftMotor, s.RightMotor, s.LeftTrigger, s.RightTrigger })
                    Assert.InRange(level, 0, HapticPatterns.MaxLevel);
            }
        }
    }

    [Fact]
    public void Tick_is_the_softest_and_confirm_is_stronger_than_edge()
    {
        static double Peak(string n) { HapticPatterns.TryGet(n, out var s); return s.Max(x => Math.Max(x.LeftMotor, x.RightMotor)); }
        Assert.True(Peak("tick") < Peak("edge"));
        Assert.True(Peak("edge") < Peak("confirm"));
        HapticPatterns.TryGet("tick", out var tick);
        Assert.True(HapticPatterns.DurationOf(tick) <= 30);
    }

    [Fact]
    public void Hold_ramps_up_monotonically_over_about_the_hold_duration()
    {
        HapticPatterns.TryGet("hold", out var hold);
        Assert.InRange(HapticPatterns.DurationOf(hold), 800, 1000);
        for (var i = 1; i < hold.Count; i++) Assert.True(hold[i].LeftMotor >= hold[i - 1].LeftMotor);
        Assert.True(hold[^1].LeftMotor > hold[0].LeftMotor * 4);
    }

    [Fact]
    public void Unknown_pattern_throws_and_stop_is_always_allowed()
    {
        _enabled = false;
        _gameActive = true;
        var g = Governor();
        Assert.Throws<ArgumentException>(() => g.Request("rumble-forever", out _));
        Assert.Equal(HapticOutcome.Stop, g.Request("stop", out var steps));
        Assert.Empty(steps);
    }

    [Fact]
    public void Respects_the_vibration_setting_and_never_plays_during_a_game()
    {
        var g = Governor();
        _enabled = false;
        Assert.Equal(HapticOutcome.Disabled, g.Request("tick", out var none));
        Assert.Empty(none);
        _enabled = true;
        _gameActive = true;
        Assert.Equal(HapticOutcome.GameActive, g.Request("confirm", out _));
        _gameActive = false;
        Assert.Equal(HapticOutcome.Play, g.Request("confirm", out var steps));
        Assert.NotEmpty(steps);
    }

    [Fact]
    public void Same_pattern_is_rate_limited_but_different_patterns_are_not()
    {
        var g = Governor();
        Assert.Equal(HapticOutcome.Play, g.Request("edge", out _));
        _now += 50;
        Assert.Equal(HapticOutcome.RateLimited, g.Request("edge", out _));
        Assert.Equal(HapticOutcome.Play, g.Request("tick", out _));
        _now += 200;
        Assert.Equal(HapticOutcome.Play, g.Request("edge", out _));
    }

    [Fact]
    public void Continuous_spam_is_capped_by_the_duty_budget()
    {
        var g = Governor();
        var played = 0;
        // Ask for a tick every frame for 4 seconds.
        for (var t = 0; t < HapticGovernor.WindowMs; t += 16)
        {
            _now = 10_000 + t;
            if (g.Request("tick", out var s) == HapticOutcome.Play) played += HapticPatterns.DurationOf(s);
        }
        Assert.InRange(played, 1, HapticGovernor.BudgetMs);
    }

    [Fact]
    public void Budget_refills_after_the_window()
    {
        var g = Governor();
        Assert.Equal(HapticOutcome.Play, g.Request("hold", out _));
        _now += 500;
        Assert.Equal(HapticOutcome.Play, g.Request("hold", out _));
        _now += 500;
        Assert.Equal(HapticOutcome.RateLimited, g.Request("hold", out _));   // 3 × 900 ms would exceed the budget
        Assert.Equal(HapticOutcome.Play, g.Request("confirm", out _));       // a small confirm still fits
        _now += HapticGovernor.WindowMs;
        Assert.Equal(HapticOutcome.Play, g.Request("hold", out _));
    }
}
