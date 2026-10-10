import { describe, expect, it } from 'vitest';
import type { CloudBadge, CloudMeter } from '../bridge/types';
import { bestWayToPlay, cloudInsights, linkText, meterForecast, preferredBadge, readinessFresh, trendText, type PlayWayInput } from './cloudPlus';

const GB = 1024 ** 3;
const gfn: CloudBadge = { service: 'gfn', playType: 'ready', premium: false, match: 'store' };
const xbox: CloudBadge = { service: 'xbox', playType: 'ready', premium: false, match: 'title' };
const base: PlayWayInput = { installed: false, sizeBytes: 60 * GB, freeBytes: [200 * GB], cloud: [gfn], readiness: null, meter: null, metered: false };

describe('preferred cloud badge', () => {
  it('verified store matches first, then ready-to-play GeForce NOW, then Xbox, then Install-to-Play', () => {
    expect(preferredBadge([xbox, gfn])).toBe(gfn);
    expect(preferredBadge([{ ...gfn, playType: 'install' }, { ...xbox, match: 'store' }])!.service).toBe('xbox');
    expect(preferredBadge([])).toBeNull();
    expect(preferredBadge(undefined)).toBeNull();
  });
});

describe('best way to play', () => {
  it('installed always wins, and names the cloud as the other option', () => {
    const a = bestWayToPlay({ ...base, installed: true });
    expect(a.way).toBe('installed');
    expect(a.alternative).toBe('or stream it with GeForce NOW on another device');
  });

  it('streams when nothing else stands in the way, saying what it saves', () => {
    const a = bestWayToPlay(base);
    expect(a).toMatchObject({ way: 'cloud', service: 'gfn', title: 'Stream it now', tone: 'ok' });
    expect(a.detail).toBe('No 60.0 GB download, and it’s ready in a minute or two.');
    expect(a.alternative).toBe('or install it for full quality: 60.0 GB');
  });

  it('streams when no drive has room for it', () => {
    const a = bestWayToPlay({ ...base, freeBytes: [20 * GB, 50 * GB] });
    expect(a.way).toBe('cloud');
    expect(a.detail).toMatch(/no drive has that much free/);
    expect(a.alternative).toBeNull();
  });

  it('suggests installing when the connection measured poor or the month’s hours are used up', () => {
    const poor = bestWayToPlay({ ...base, readiness: { level: 'poor', link: 'wifi', linkMbps: 72, wifiBand: null } });
    expect(poor).toMatchObject({ way: 'install', tone: 'warn' });
    expect(poor.alternative).toBe('or stream it with GeForce NOW anyway');
    const out = bestWayToPlay({ ...base, meter: { level: 'reached', leftSeconds: 0, plan: 'performance' } });
    expect(out.way).toBe('install');
    expect(out.detail).toMatch(/estimated from sessions VYSTRAL saw/);
    // …unless Xbox Cloud Gaming also lists it.
    const other = bestWayToPlay({ ...base, cloud: [gfn, xbox], meter: { level: 'reached', leftSeconds: 0, plan: 'performance' } });
    expect(other).toMatchObject({ way: 'cloud', service: 'xbox' });
  });

  it('warns gently about a metered network and few hours left', () => {
    const a = bestWayToPlay({ ...base, metered: true, meter: { level: 'near', leftSeconds: 9 * 3600, plan: 'performance' } });
    expect(a.tone).toBe('warn');
    expect(a.detail).toContain('About 9 h of GeForce NOW left this month.');
    expect(a.detail).toContain('metered connection');
  });

  it('without any cloud listing, it is just about installing', () => {
    expect(bestWayToPlay({ ...base, cloud: [] })).toMatchObject({ way: 'install', title: 'Install it to play' });
    expect(bestWayToPlay({ ...base, cloud: [], freeBytes: [1 * GB] })).toMatchObject({ way: 'install', title: 'Free up space to install it', tone: 'warn' });
    expect(bestWayToPlay({ ...base, cloud: [], sizeBytes: null }).detail).toBe('Install it from its store app.');
  });
});

describe('hours forecast', () => {
  const DAY = 86_400_000;
  const start = Date.parse('2026-10-01T00:00:00Z');
  const meter = (used: number): Pick<CloudMeter, 'plan' | 'cycleStart' | 'nextReset' | 'usedSeconds' | 'limitSeconds'> => ({
    plan: 'performance', cycleStart: new Date(start).toISOString(), nextReset: new Date(start + 31 * DAY).toISOString(), usedSeconds: used * 3600, limitSeconds: 100 * 3600,
  });

  it('projects this month’s pace to the reset', () => {
    const f = meterForecast(meter(20), start + 10 * DAY, 'en-GB')!;
    expect(f.projectedSeconds).toBe(62 * 3600);
    expect(f.tone).toBe('ok');
    expect(f.text).toBe('At your pace you’ll use about 62 h of 100 h by 1 Nov.');
  });

  it('says when you would run out, and warns harder when that is close', () => {
    const f = meterForecast(meter(50), start + 10 * DAY, 'en-GB')!;
    expect(f.runsOutAt).toBe(new Date(start + 20 * DAY).toISOString());
    expect(f.tone).toBe('warn');
    expect(f.text).toBe('At your pace you’d run out around 21 Oct, before it resets on 1 Nov.');
    expect(meterForecast(meter(90), start + 10 * DAY)!.tone).toBe('danger');
    expect(meterForecast(meter(101), start + 10 * DAY)!.text).toBe('You’ve likely used this month’s hours already.');
  });

  it('stays quiet without enough to go on, or without a monthly limit', () => {
    expect(meterForecast(meter(20), start + DAY)).toBeNull();
    expect(meterForecast(meter(0.2), start + 10 * DAY)).toBeNull();
    expect(meterForecast({ ...meter(20), limitSeconds: null }, start + 10 * DAY)).toBeNull();
    expect(meterForecast({ ...meter(20), plan: 'none' }, start + 10 * DAY)).toBeNull();
  });
});

describe('cloud session insights', () => {
  const NOW = Date.parse('2026-10-10T12:00:00Z');
  const s = (daysAgo: number, minutes: number, source: 'cloud-gfn' | 'cloud-xbox' | 'tracked', gameId = 'a') =>
    ({ gameId, start: new Date(NOW - daysAgo * 86_400_000).toISOString(), durationSeconds: minutes * 60, source });

  it('counts only cloud sessions, by service and game, with a trend', () => {
    const ins = cloudInsights([s(1, 60, 'cloud-gfn'), s(3, 120, 'cloud-gfn', 'b'), s(5, 90, 'cloud-xbox'), s(2, 600, 'tracked'), s(40, 30, 'cloud-gfn')], NOW)!;
    expect(ins.sessions).toBe(4);
    expect(ins.seconds).toBe(300 * 60);
    expect(ins.longestSeconds).toBe(120 * 60);
    expect(ins.typicalSeconds).toBe(75 * 60);
    expect(ins.byService.map((b) => b.service)).toEqual(['gfn', 'xbox']);
    expect(ins.topGames[0]).toEqual({ gameId: 'a', seconds: 180 * 60, sessions: 3 });
    expect(ins.last30).toBe(270 * 60);
    expect(ins.prev30).toBe(30 * 60);
    expect(cloudInsights([s(1, 60, 'tracked')], NOW)).toBeNull();
  });

  it('describes the trend only when there is something to compare', () => {
    expect(trendText(600, 0)).toBeNull();
    expect(trendText(7200, 600)).toBe('New this month: hardly any cloud play the 30 days before');
    expect(trendText(14_000, 10_000)).toBe('Up 40% on the 30 days before');
    expect(trendText(9_000, 10_000)).toBe('About the same as the 30 days before');
  });
});

describe('readiness words', () => {
  it('names the link honestly and keeps a result for a day', () => {
    expect(linkText({ link: 'ethernet', linkMbps: 1000, wifiBand: null })).toBe('Ethernet · 1 Gbps link');
    expect(linkText({ link: 'wifi', linkMbps: 866, wifiBand: '5' })).toBe('Wi-Fi 5 GHz · 866 Mbps link');
    expect(linkText({ link: 'unknown', linkMbps: null, wifiBand: null })).toBe('Network');
    const now = Date.parse('2026-10-10T12:00:00Z');
    expect(readinessFresh({ checkedAt: '2026-10-10T01:00:00Z' }, now)).toBe(true);
    expect(readinessFresh({ checkedAt: '2026-10-09T01:00:00Z' }, now)).toBe(false);
    expect(readinessFresh(null, now)).toBe(false);
  });
});
