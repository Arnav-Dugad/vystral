import { describe, expect, it } from 'vitest';
import { DOCKED_AT, dockDistance, dockProgress, dockVars, LIFT_AT, LIFT_SCALE } from './heroDock';

// Track Z: the game page's fluid header — the lengths its scroll-driven keyframes use.

const num = (v: string | undefined) => parseFloat(v ?? 'NaN');

describe('docking distance and progress', () => {
  it('docks once the hero has scrolled up to the bar', () => {
    expect(dockDistance(620, 72)).toBe(548);
    expect(dockDistance(100, 72)).toBe(80); // never a degenerate, instant dock
  });

  it('progress is clamped 0–1 along the distance', () => {
    expect(dockProgress(0, 548)).toBe(0);
    expect(dockProgress(274, 548)).toBe(0.5);
    expect(dockProgress(9000, 548)).toBe(1);
    expect(dockProgress(-30, 548)).toBe(0);
    expect(dockProgress(10, 0)).toBe(1);
  });

  it('docks (the bar gets its Play) by the time the hero Play has faded, so one is always there', () => {
    // detail.css: the hero facts and actions fade over 30–55 %; the bar's Play slides in from 50 %.
    expect(DOCKED_AT).toBeGreaterThanOrEqual(0.3);
    expect(DOCKED_AT).toBeLessThanOrEqual(0.5);
  });
});

describe('cover flight', () => {
  const input = {
    heroH: 620,
    barH: 72,
    cover: { x: 48, y: 290, w: 200, h: 300 },
    coverSlot: { x: 140, y: 12, w: 32, h: 48 },
    title: { x: 280, y: 330, w: 420, h: 120 },
    titleSlot: { x: 188, y: 25, w: 300, h: 22 },
  };
  const v = dockVars(input);
  const d = dockDistance(620, 72);

  it('starts exactly on the hero cover (so the hand-over is invisible)', () => {
    // The bar sits at the top of the page at scroll 0: its slot + this offset = the hero cover.
    expect(num(v['--dk-cx0'])).toBe(48 - 140);
    expect(num(v['--dk-cy0'])).toBe(290 - 12);
    expect(num(v['--dk-cw'])).toBe(200);
    expect(num(v['--dk-ch'])).toBe(300);
  });

  it('still rides with the page while it lifts (grown about its centre)', () => {
    const grow = (LIFT_SCALE - 1) / 2;
    // At the lift point the page has scrolled LIFT_AT × distance: the cover moved up by exactly that.
    expect(num(v['--dk-cyl'])).toBeCloseTo(290 - 12 - LIFT_AT * d - 300 * grow, 1);
    expect(num(v['--dk-cxl'])).toBeCloseTo(48 - 140 - 200 * grow, 1);
  });

  it('lands at the slot at the bar size', () => {
    expect(num(v['--dk-k'])).toBeCloseTo(32 / 200, 4);
    expect(num(v['--dk-end'])).toBe(d);
  });

  it('leaves the cover out when the hero shows none (narrow windows)', () => {
    const w = dockVars({ ...input, cover: null });
    expect(w['--dk-cx0']).toBeUndefined();
    expect(w['--dk-k']).toBeUndefined();
    expect(w['--dk-end']).toBe(`${d}px`);
  });
});

describe('title curve', () => {
  const base = { heroH: 620, barH: 72, cover: null, coverSlot: { x: 140, y: 12, w: 32, h: 48 }, titleSlot: { x: 188, y: 25, w: 300, h: 22 } };

  it('travels from the hero title to the bar title slot (relative to where scrolling took it)', () => {
    const v = dockVars({ ...base, title: { x: 280, y: 330, w: 420, h: 120 } });
    const d = dockDistance(620, 72);
    expect(num(v['--dk-tx'])).toBe(188 - 280);
    // At full progress the page has scrolled d: title top at 330 − d on screen; it must end at 25.
    expect(num(v['--dk-ty'])).toBe(25 - (330 - d));
    expect(num(v['--dk-kt'])).toBeCloseTo(22 / 120, 4);
  });

  it('never shrinks below a readable fraction or grows', () => {
    expect(num(dockVars({ ...base, title: { x: 0, y: 0, w: 10, h: 10 } })['--dk-kt'])).toBe(1);
    expect(num(dockVars({ ...base, title: { x: 0, y: 0, w: 10, h: 2000 } })['--dk-kt'])).toBe(0.12);
  });
});
