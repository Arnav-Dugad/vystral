import { describe, expect, it } from 'vitest';
import { LOGO_DRAW_MS, LOGO_FILL_DELAY_MS, logoMotion, subpathCount, TRACE_MAX_SUBPATHS } from './logoMotion';
import { STORE_MARKS } from './storeMarks';

describe('store logo motion', () => {
  it('only marks inside interactive controls move, and never in High contrast', () => {
    expect(logoMotion(STORE_MARKS.steam, { interactive: false })).toBe('none');
    expect(logoMotion(STORE_MARKS.steam, { interactive: true, highContrast: true })).toBe('none');
    expect(logoMotion(STORE_MARKS.steam, { interactive: true })).not.toBe('none');
  });

  it('stroked marks draw, simple filled marks trace, busy ones sweep', () => {
    expect(logoMotion(STORE_MARKS.xbox, { interactive: true })).toBe('trace');
    expect(logoMotion(STORE_MARKS.manual, { interactive: true })).toBe('draw');
    expect(logoMotion(STORE_MARKS.steam, { interactive: true })).toBe('trace');
    expect(logoMotion(STORE_MARKS.ea, { interactive: true })).toBe('trace');
    // Epic's mark carries lettering; GOG's is many small boxes: a traced outline would be noise at 14 px.
    expect(logoMotion(STORE_MARKS.epic, { interactive: true })).toBe('sweep');
    expect(logoMotion(STORE_MARKS.gog, { interactive: true })).toBe('sweep');
  });

  it('counts sub-paths', () => {
    expect(subpathCount('M0 0L1 1zm2 2l1 1zM5 5h1')).toBe(3);
    expect(subpathCount('')).toBe(0);
    expect(TRACE_MAX_SUBPATHS).toBeGreaterThan(subpathCount((STORE_MARKS.steam as { path: string }).path));
  });

  it('draws within the 400–600 ms the design system allows', () => {
    expect(LOGO_DRAW_MS).toBeGreaterThanOrEqual(400);
    expect(LOGO_DRAW_MS).toBeLessThanOrEqual(600);
    expect(LOGO_FILL_DELAY_MS + 280).toBeLessThanOrEqual(600);
  });
});
