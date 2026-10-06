import { describe, expect, it } from 'vitest';
import type { CloudMeter, CloudOption } from '../bridge/types';
import { badgeLabel, clock, formatHours, healthTone, meterSummary, preferredOption, resetLabel, sessionLeft } from './cloud';
import { isCloud, isObserved, sessionOrigin } from './sessions';

const meter = (over: Partial<CloudMeter> = {}): CloudMeter => ({
  plan: 'performance', planLabel: 'Performance', cycleStart: '2026-10-01T00:00:00Z', nextReset: '2026-11-01T00:00:00Z', usedSeconds: 38 * 3600,
  limitSeconds: 100 * 3600, leftSeconds: 62 * 3600, fraction: 0.38, level: 'ok', rolloverHours: 15, sessionLimitSeconds: 6 * 3600, sessionLeftSeconds: null,
  sessionLevel: 'none', sessions: 7, xboxSeconds: 0, xboxSessions: 0, resetDay: 1, planNote: '', asOf: '2026-10-05', ...over,
});

const option = (over: Partial<CloudOption>): CloudOption => ({
  service: 'gfn', serviceName: 'GeForce NOW', entryTitle: 'X', playType: 'ready', premium: false, match: 'store', matchStore: 'steam', surface: 'gfnApp',
  surfaceLabel: 'GeForce NOW app', headline: '', requirement: '', note: null, ...over,
});

describe('cloud hours meter wording', () => {
  it('formats hours honestly', () => {
    expect(formatHours(45 * 60)).toBe('45 min');
    expect(formatHours(1.25 * 3600)).toBe('1.3 h');
    expect(formatHours(62 * 3600)).toBe('62 h');
    expect(formatHours(-5)).toBe('0 min');
  });

  it('says hours left, and never claims to be NVIDIA’s balance', () => {
    const ok = meterSummary(meter());
    expect(ok.tone).toBe('ok');
    expect(ok.title).toBe('About 62 h left');
    expect(ok.detail).toContain('38 h of 100 h');
    expect(ok.detail).toContain('roll over');
    const near = meterSummary(meter({ usedSeconds: 86 * 3600, leftSeconds: 14 * 3600, fraction: 0.86, level: 'near' }));
    expect(near.tone).toBe('warn');
    expect(near.title).toBe('About 14 h left');
    expect(near.detail).toContain('GeForce NOW app');
    const reached = meterSummary(meter({ usedSeconds: 101 * 3600, leftSeconds: 0, fraction: 1, level: 'reached' }));
    expect(reached.tone).toBe('danger');
    expect(reached.title).toContain('100 h');
    expect(reached.detail).toContain('real balance');
  });

  it('has no meter without a membership or a monthly limit', () => {
    expect(meterSummary(meter({ plan: 'none' })).fraction).toBeNull();
    const free = meterSummary(meter({ plan: 'free', planLabel: 'Free', limitSeconds: null, leftSeconds: null, fraction: null, level: 'none', sessionLimitSeconds: 3600, usedSeconds: 5400 }));
    expect(free.fraction).toBeNull();
    expect(free.title).toBe('1.5 h played this month');
    expect(free.detail).toContain('Sessions end after 1 h');
  });

  it('warns gently as a session nears its end', () => {
    expect(sessionLeft({ sessionLeftSeconds: null, sessionLevel: 'none' })).toBeNull();
    expect(sessionLeft({ sessionLeftSeconds: 600, sessionLevel: 'near' })).toEqual({ tone: 'warn', text: '10 min left in this session' });
    expect(sessionLeft({ sessionLeftSeconds: 0, sessionLevel: 'reached' })?.tone).toBe('danger');
  });

  it('names the reset date', () => {
    expect(resetLabel(meter(), 'en-GB')).toMatch(/^Resets 1 Nov$/);
  });
});

describe('cloud options', () => {
  it('starts verified matches first, then ready GeForce NOW, then Xbox, then Install-to-Play', () => {
    const itp = option({ playType: 'install' });
    const xbox = option({ service: 'xbox' });
    const likely = option({ match: 'title' });
    expect(preferredOption([itp, xbox])).toBe(xbox);
    expect(preferredOption([likely, itp])).toBe(itp);
    expect(preferredOption([xbox, option({})])?.service).toBe('gfn');
    expect(preferredOption([])).toBeNull();
  });

  it('labels badges, including likely matches', () => {
    expect(badgeLabel([{ service: 'gfn', playType: 'ready', premium: false, match: 'store' }, { service: 'xbox', playType: 'ready', premium: false, match: 'title' }]))
      .toBe('Playable in the cloud: GeForce NOW and Xbox Cloud Gaming (likely match)');
  });

  it('turns the status page into a tone', () => {
    expect(healthTone(null)).toBeNull();
    const base = { service: 'gfn' as const, description: 'x', components: 111, degraded: 0, incidents: [], checkedAt: '', error: null };
    expect(healthTone({ ...base, indicator: 'none' })?.tone).toBe('ok');
    expect(healthTone({ ...base, indicator: 'maintenance', degraded: 2 })?.text).toBe('Maintenance at 2 of 111 locations');
    expect(healthTone({ ...base, indicator: 'major' })?.tone).toBe('danger');
    expect(healthTone({ ...base, indicator: 'none', error: 'offline' })).toBeNull();
  });

  it('formats a running clock', () => {
    expect(clock(65)).toBe('1:05');
    expect(clock(3909)).toBe('1:05:09');
  });
});

describe('cloud sessions in history', () => {
  it('count as observed play and carry a cloud origin', () => {
    expect(isObserved('cloud-gfn')).toBe(true);
    expect(isObserved('cloud-xbox')).toBe(true);
    expect(isCloud('tracked')).toBe(false);
    expect(sessionOrigin('cloud-gfn')?.label).toBe('GeForce NOW');
    expect(sessionOrigin('cloud-xbox')?.title).toContain('estimated');
  });
});
