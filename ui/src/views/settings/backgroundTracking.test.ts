import { describe, expect, it } from 'vitest';
import type { TrackingStatus } from '../../bridge/types';
import { trackingStatusLine } from './BackgroundTrackingSettings';

const NOW = Date.parse('2026-10-05T20:00:00Z');
const base: TrackingStatus = {
  enabled: true, available: true, safeMode: false, build: 'installed', autostart: 'on', helperRunning: true, detecting: true, owner: true,
  watchedGames: 42, pollSeconds: 4, savingPollSeconds: 15, minSessionSeconds: 60, lastSeen: null, ignored: [],
};

describe('background tracking status line', () => {
  it('says plainly when it is off', () => {
    expect(trackingStatusLine(base, false, NOW)).toBe('Off. Only games you start from VYSTRAL are recorded.');
  });

  it('names the last game seen and when', () => {
    const s: TrackingStatus = {
      ...base,
      lastSeen: { gameId: 'a', title: 'Ashen Crown', source: 'background', start: '2026-10-05T16:00:00Z', end: '2026-10-05T18:00:00Z', durationSeconds: 7200 },
    };
    expect(trackingStatusLine(s, true, NOW)).toBe('Background tracking is on — last game seen: Ashen Crown, 2 hours ago.');
  });

  it('is honest before anything was seen, and in safe mode', () => {
    expect(trackingStatusLine(base, true, NOW)).toBe('Background tracking is on — watching 42 installed games; nothing noticed yet.');
    expect(trackingStatusLine({ ...base, watchedGames: 1 }, true, NOW)).toContain('watching 1 installed game;');
    expect(trackingStatusLine({ ...base, safeMode: true, available: false }, true, NOW)).toBe('Paused: VYSTRAL is running in safe mode.');
  });
});
