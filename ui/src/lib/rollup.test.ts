import { beforeEach, describe, expect, it } from 'vitest';
import { digitCount, markRolled, planRoll, resetRolled, rollDuration, ROLL_MAX_DIGITS, ROLL_STAGGER_MS, shouldRoll } from './rollup';

describe('planRoll', () => {
  it('rolls digits and keeps everything else still', () => {
    const t = planRoll('12h 30m');
    expect(t.map((x) => (x.kind === 'text' ? x.text : x.digit))).toEqual([1, 2, 'h ', 3, 0, 'm']);
  });

  it('spins the less significant digits more, landing left to right', () => {
    const digits = planRoll('1,284').filter((x) => x.kind === 'digit');
    expect(digits.map((d) => d.turns)).toEqual([0, 0, 1, 2]);
    expect(digits.map((d) => d.target)).toEqual([1, 2, 18, 24]);
    expect(digits.map((d) => d.delayMs)).toEqual([0, 1, 2, 3].map((i) => i * ROLL_STAGGER_MS));
    const ends = digits.map((d) => d.delayMs + d.durationMs);
    expect([...ends].sort((a, b) => a - b)).toEqual(ends);
    expect(rollDuration(planRoll('1,284'))).toBe(ends[3]);
  });

  it('handles text without digits', () => {
    expect(planRoll('—')).toEqual([{ kind: 'text', text: '—' }]);
    expect(rollDuration(planRoll('—'))).toBe(0);
    expect(digitCount('3 days')).toBe(1);
  });
});

describe('shouldRoll', () => {
  beforeEach(() => resetRolled());

  it('rolls once per id per session', () => {
    expect(shouldRoll('journal.time', '12h', false)).toBe(true);
    markRolled('journal.time');
    expect(shouldRoll('journal.time', '12h', false)).toBe(false);
    expect(shouldRoll('journal.sessions', '12', false)).toBe(true);
  });

  it('never rolls under reduced motion, without digits or with too many', () => {
    expect(shouldRoll('a', '12h', true)).toBe(false);
    expect(shouldRoll('b', 'Never', false)).toBe(false);
    expect(shouldRoll('c', '1'.repeat(ROLL_MAX_DIGITS + 1), false)).toBe(false);
  });
});
