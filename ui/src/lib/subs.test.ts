import { describe, expect, it } from 'vitest';
import type { CloudMap, CloudQueueSignal, SubsBadge } from '../bridge/types';
import {
  allowedCloudServices, badgeLabel, badgeText, defaultCurrency, FAMILIES, filterCloudMap, formatMoney, leavingLabel, parsePlans, PLAN, PLANS, queueText,
  serializePlans, togglePlan,
} from './subs';
import { SERVICE_MARKS } from './serviceMarks';

const badge = (over: Partial<SubsBadge> = {}): SubsBadge => ({ plan: 'gp-ultimate', planName: 'Game Pass Ultimate', family: 'gamepass', match: 'store', leaving: false, leavingEnd: null, ...over });

describe('subscription plans', () => {
  it('parses like the native side: known plans, picker order, one per family (higher tier wins)', () => {
    expect(parsePlans('ea-play,gp-ultimate,nonsense,,gp-ultimate')).toEqual(['gp-ultimate', 'ea-play']);
    expect(parsePlans('gp-essential,gp-premium')).toEqual(['gp-premium']);
    expect(parsePlans('')).toEqual([]);
    expect(parsePlans(null)).toEqual([]);
    expect(parsePlans('x'.repeat(500))).toEqual([]);
    expect(serializePlans(['ubi-classics', 'gp-pc'])).toBe('gp-pc,ubi-classics');
  });

  it('picking a tier replaces the family’s other tier; picking it again clears it', () => {
    let p = togglePlan([], 'gp-pc');
    expect(p).toEqual(['gp-pc']);
    p = togglePlan(p, 'gp-ultimate');
    expect(p).toEqual(['gp-ultimate']);
    p = togglePlan(p, 'ea-play');
    expect(p).toEqual(['gp-ultimate', 'ea-play']);
    p = togglePlan(p, 'gp-ultimate');
    expect(p).toEqual(['ea-play']);
  });

  it('every plan belongs to a family with a mark, and cloud gaming is Essential, Premium and Ultimate', () => {
    for (const f of FAMILIES) {
      expect(SERVICE_MARKS[f.mark], f.family).toBeDefined();
      for (const plan of f.plans) expect(PLAN[plan].family).toBe(f.family);
    }
    expect(PLANS.filter((p) => p.cloud).map((p) => p.id)).toEqual(['gp-essential', 'gp-premium', 'gp-ultimate']);
    expect(PLANS.filter((p) => !p.hasList).map((p) => p.id)).toEqual(['humble-choice', 'prime-gaming']);
  });
});

describe('cloud services you have', () => {
  const s = (over: Partial<Record<string, unknown>> = {}) => ({ 'subs.asked': true, 'subs.cloudShowAll': false, 'subs.owned': '', 'cloud.gfnPlan': 'none' as const, ...over }) as never;

  it('shows everything until you have answered, or when you ask to see all', () => {
    expect(allowedCloudServices(s({ 'subs.asked': false }))).toBeNull();
    expect(allowedCloudServices(s({ 'subs.cloudShowAll': true }))).toBeNull();
    expect(allowedCloudServices(null)).toBeNull();
  });

  it('offers GeForce NOW with a membership and Xbox Cloud Gaming with a cloud tier', () => {
    expect([...allowedCloudServices(s())!]).toEqual([]);
    expect([...allowedCloudServices(s({ 'cloud.gfnPlan': 'free' }))!]).toEqual(['gfn']);
    expect([...allowedCloudServices(s({ 'subs.owned': 'gp-pc' }))!]).toEqual([]); // PC Game Pass has no cloud gaming
    expect([...allowedCloudServices(s({ 'subs.owned': 'gp-essential', 'cloud.gfnPlan': 'ultimate' }))!].sort()).toEqual(['gfn', 'xbox']);
  });

  it('filters the cloud map without touching it when nothing is hidden', () => {
    const map: CloudMap = {
      a: [{ service: 'gfn', playType: 'ready', premium: false, match: 'store' }, { service: 'xbox', playType: 'ready', premium: false, match: 'store' }],
      b: [{ service: 'xbox', playType: 'ready', premium: false, match: 'title' }],
    };
    expect(filterCloudMap(map, null)).toBe(map);
    const only = filterCloudMap(map, new Set(['gfn']))!;
    expect(Object.keys(only)).toEqual(['a']);
    expect(only.a.map((x) => x.service)).toEqual(['gfn']);
    expect(filterCloudMap(null, new Set())).toBeNull();
  });
});

describe('wording', () => {
  const now = new Date(2026, 9, 7, 12, 0, 0).getTime();

  it('says “leaving soon” without a date and “around” with one', () => {
    expect(leavingLabel(null, now)).toBe('Leaving soon');
    expect(leavingLabel('not a date', now)).toBe('Leaving soon');
    expect(leavingLabel(new Date(2026, 9, 6).toISOString(), now)).toBe('Leaving soon'); // already past
    expect(leavingLabel(new Date(2026, 9, 7, 22).toISOString(), now)).toBe('Leaves today');
    expect(leavingLabel(new Date(2026, 9, 8, 9).toISOString(), now)).toBe('Leaves tomorrow');
    expect(leavingLabel(new Date(2026, 9, 16, 10).toISOString(), now, 'en-GB')).toBe('Leaves around 16 Oct');
    expect(leavingLabel(new Date(2026, 9, 16, 10).toISOString(), now, 'en-GB', 'Game Pass')).toBe('Leaves Game Pass around 16 Oct');
    expect(leavingLabel(null, now, undefined, 'Game Pass')).toBe('Leaving Game Pass soon');
  });

  it('names the plans honestly, and likely matches as likely', () => {
    expect(badgeText([])).toBeNull();
    expect(badgeText([badge()])!.long).toBe('Included with your Game Pass Ultimate');
    expect(badgeText([badge()])!.short).toBe('Game Pass');
    const two = badgeText([badge({ match: 'title' }), badge({ plan: 'ea-play', planName: 'EA Play', family: 'eaplay', match: 'title' })])!;
    expect(two.long).toBe('Also in your Game Pass Ultimate and EA Play (likely: matched by name)');
    expect(two.likely).toBe(true);
    expect(badgeLabel([badge({ leaving: true })], now)).toBe('Included with your Game Pass Ultimate. Leaving Game Pass soon');
  });

  it('formats money in the chosen currency, or the region’s', () => {
    expect(formatMoney(2.4, 'GBP', 'en-GB')).toBe('£2.40');
    expect(formatMoney(2.4, '', 'en-US')).toBe('$2.40');
    expect(defaultCurrency('de-DE')).toBe('EUR');
    expect(defaultCurrency('en-GB')).toBe('GBP');
    expect(defaultCurrency('ja-JP')).toBe('JPY');
    expect(defaultCurrency('xx')).toBe('USD');
  });

  it('turns queue signals into a short line, and says nothing when the title said nothing', () => {
    const q = (over: Partial<CloudQueueSignal>): CloudQueueSignal => ({ gameId: 'g', title: 'T', phase: 'queue', position: null, etaMinutes: null, notify: null, key: 'k', ...over });
    expect(queueText(null)).toBeNull();
    expect(queueText(q({}))).toBeNull();
    expect(queueText(q({ phase: 'none' }))).toBeNull();
    expect(queueText(q({ position: 1204 }))).toBe(`Number ${(1204).toLocaleString()} in the queue`);
    expect(queueText(q({ position: 4, etaMinutes: 3 }))).toBe('Number 4 in the queue · about 3 min');
    expect(queueText(q({ etaMinutes: 1 }))).toBe('In the queue · about a minute');
    expect(queueText(q({ phase: 'starting' }))).toBe('Your stream is starting');
  });
});
