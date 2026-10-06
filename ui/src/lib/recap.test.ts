import { describe, expect, it } from 'vitest';
import type { AwaySummary, BacklogSavings, Game, RecapSession, ReplayData, SaleForecast, TimeToBeat } from '../bridge/types';
import { closestToFinishing, playedSeconds, ttbProgress, ttbSummary } from './timeToBeat';
import { awayHeadline, awayOrigin, journalDay, latestDay, sessionLink, sortAchievements } from './away';
import { daysText, mainTotal, parseDay, providersLabel, saleHeadline } from './forecast';
import {
  achievementAt, buildReplayModel, CHUNK_BYTES, counterValue, downsample, easeOutBack, phase, REPLAY_SECONDS, replaySummary, TIMELINE, toBase64Chunks,
} from './replay';

const H = 3600;

function game(id: string, tracked: number, importedMin: number | null = null, status: Game['status'] = null): Game {
  return {
    id, title: id, sortTitle: id, description: null, developer: null, publisher: null, releaseDate: null, genres: [], favorite: false, hidden: false,
    userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null },
    installations: importedMin == null ? [] : [{
      id: `${id}-i`, platform: 'steam', platformGameId: '1', title: id, state: 'installed', installPath: null, drive: null, sizeBytes: null, clientRequired: true,
      launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: importedMin, userLaunchArgs: null, manualLink: false, lastSeen: '',
    }],
    collections: [], trackedSeconds: tracked, sessionCount: 0, lastTrackedPlay: null, added: '2026-01-01T00:00:00Z', status,
  };
}

const ttb = (main: number | null, extras: number | null, completionist: number | null): TimeToBeat => ({ main, extras, completionist, count: 10, fetched: '', source: 'igdb' });

describe('time to beat', () => {
  it('uses the larger of tracked and store playtime, never their sum', () => {
    expect(playedSeconds(game('a', 2 * H, 60))).toBe(2 * H);
    expect(playedSeconds(game('a', 30 * 60, 120))).toBe(2 * H);
    expect(playedSeconds(game('a', 0))).toBe(0);
  });

  it('places estimates on a bar scaled to the largest one', () => {
    const pr = ttbProgress(5 * H, ttb(10 * H, 20 * H, 40 * H))!;
    expect(pr.fill).toBeCloseTo(5 / 40);
    expect(pr.fraction).toBeCloseTo(0.5);
    expect(pr.markers.map((m) => m.pos)).toEqual([0.25, 0.5, 1]);
    expect(pr.state).toBe('inProgress');
    expect(pr.next?.key).toBe('main');
  });

  it('handles partial, missing and passed estimates honestly', () => {
    expect(ttbProgress(H, null)).toBeNull();
    expect(ttbProgress(H, ttb(null, null, null))).toBeNull();
    expect(ttbProgress(H, ttb(0, -5, null))).toBeNull();
    const extrasOnly = ttbProgress(H, ttb(null, 4 * H, null))!;
    expect(extrasOnly.target).toBe('extras');
    expect(extrasOnly.fraction).toBeCloseTo(0.25);
    const past = ttbProgress(50 * H, ttb(10 * H, 20 * H, 40 * H))!;
    expect(past.state).toBe('pastEstimate');
    expect(past.next).toBeNull();
    expect(past.fill).toBe(1);
    expect(ttbProgress(0, ttb(10 * H, null, null))!.state).toBe('notStarted');
  });

  it('summarises with the source label', () => {
    const s = ttbSummary(ttbProgress(5 * H, ttb(10 * H, null, null))!, '5h');
    expect(s).toContain('50% of main story');
    expect(s).toContain('IGDB estimate');
  });

  it('sorts "closest to finishing": in progress by time left, then unstarted, then past/finished, then no data', () => {
    const map = { a: ttb(10 * H, null, null), b: ttb(10 * H, null, null), c: ttb(3 * H, null, null), d: ttb(10 * H, null, null), e: ttb(10 * H, null, null) };
    const games = [
      game('nodata', H), game('a', 9 * H), game('b', 2 * H), game('c', 0), game('d', 12 * H), game('e', 9.5 * H, null, 'beaten'),
    ];
    expect(games.sort(closestToFinishing(map)).map((g) => g.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'nodata']);
  });
});

const session = (id: string, over: Partial<RecapSession> = {}): RecapSession => ({
  id, gameId: 'g1', title: 'Nebula Drift', source: 'background', start: '2026-10-05T20:00:00Z', end: '2026-10-05T21:00:00Z', durationSeconds: 3600,
  perf: { fpsAvg: null, fps1Low: null, peakTempC: null, gpuAvg: null, cpuAvg: null, hasMetrics: false }, ...over,
});

function away(sessions: RecapSession[]): AwaySummary {
  const games = [...new Set(sessions.map((s) => s.gameId))].map((gameId) => ({ gameId, title: sessions.find((s) => s.gameId === gameId)!.title, sessions: 1, seconds: 3600, lastEnd: '' }));
  return { since: '', until: '', totalSeconds: sessions.reduce((n, s) => n + s.durationSeconds, 0), games, sessions, best: sessions[0] ?? null, bestFps: null, achievements: [], gamesWithoutAchievementData: 0 };
}

describe('while you were away', () => {
  it('writes a headline for one or several games', () => {
    expect(awayHeadline(away([session('a')]))).toBe('You played Nebula Drift for 1h');
    expect(awayHeadline(away([session('a'), session('b', { gameId: 'g2', title: 'Ashen Crown' })]))).toBe('You played 2 games for 2h');
  });

  it('says where the sessions came from', () => {
    expect(awayOrigin(away([session('a')]))).toContain('while the app was closed');
    expect(awayOrigin(away([session('a', { source: 'detected' })]))).toContain('noticed while it was open');
    expect(awayOrigin(away([session('a'), session('b', { source: 'detected' })]))).toContain('some while the app was closed');
  });

  it('links sessions with metrics to Performance and others to their Journal day', () => {
    expect(sessionLink(session('a', { perf: { fpsAvg: 90, fps1Low: null, peakTempC: null, gpuAvg: null, cpuAvg: null, hasMetrics: true } }))).toEqual({ name: 'performance', sessionId: 'a' });
    const link = sessionLink(session('a'));
    expect(link.name).toBe('journal');
    const day = new Date(journalDay(session('a')));
    expect([day.getHours(), day.getMinutes()]).toEqual([0, 0]);
    expect(latestDay(away([session('a'), session('b', { start: '2026-10-01T10:00:00Z' })]))).toBe(journalDay(session('a')));
  });

  it('shows the rarest achievements first', () => {
    const a = (name: string, p: number | null, at: string) => ({ gameId: 'g', sessionId: 's', apiName: name, name, description: null, unlockedAt: at, globalPercent: p, icon: null });
    expect(sortAchievements([a('common', 50, '1'), a('none', null, '3'), a('ultra', 0.4, '1'), a('rare', 3, '2')]).map((x) => x.name)).toEqual(['ultra', 'rare', 'common', 'none']);
  });
});

describe('value forecast', () => {
  const base: SaleForecast = { current: null, next: null, daysUntilNext: null, daysLeftInCurrent: null, source: '', sourceUrl: '', retrieved: '2026-10-06', version: 1, outdated: false };
  const winter = { id: 'w', name: 'Steam Winter Sale', start: '2026-12-17', end: '2027-01-04' };

  it('picks the headline: on now, upcoming, or honestly not announced', () => {
    expect(saleHeadline({ ...base, current: { ...winter, id: 'a' }, daysLeftInCurrent: 2, next: winter, daysUntilNext: 70 }).kind).toBe('onNow');
    expect(saleHeadline({ ...base, next: winter, daysUntilNext: 72 })).toEqual({ kind: 'upcoming', sale: winter, days: 72 });
    expect(saleHeadline({ ...base, outdated: true }).kind).toBe('notAnnounced');
  });

  it('reads published dates as local calendar days', () => {
    const d = parseDay('2026-12-17')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 11, 17, 0]);
    expect(parseDay('17/12/2026')).toBeNull();
    expect(daysText(0)).toBe('today');
    expect(daysText(1)).toBe('tomorrow');
    expect(daysText(12)).toBe('in 12 days');
  });

  it('uses the first (largest) currency total and names the providers', () => {
    const s: BacklogSavings = {
      candidates: 3, withoutData: 1, withoutSteamId: 0, country: 'US', reason: null,
      totals: [{ currency: 'USD', total: 12.5, games: 2 }, { currency: 'EUR', total: 3, games: 1 }],
      games: [
        { gameId: 'a', title: 'A', provider: 'itad', currency: 'EUR', current: 5, shop: null, low: 2, lowAt: null, saving: 3, pricedAt: '2026-10-01T00:00:00Z', stale: false },
        { gameId: 'b', title: 'B', provider: 'cheapshark', currency: 'USD', current: 15, shop: null, low: 2.5, lowAt: null, saving: 12.5, pricedAt: '2026-10-02T00:00:00Z', stale: false },
      ],
    };
    expect(mainTotal(s)).toEqual({ currency: 'USD', total: 12.5, games: 2 });
    expect(providersLabel(s)).toBe('Prices from IsThereAnyDeal and CheapShark');
  });
});

describe('session replay timeline', () => {
  it('fits in about ten seconds and every phase is ordered', () => {
    expect(REPLAY_SECONDS).toBe(10);
    for (const [a, b] of [TIMELINE.backdrop, TIMELINE.title, TIMELINE.counter, TIMELINE.line, TIMELINE.temps, TIMELINE.brand]) {
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThanOrEqual(REPLAY_SECONDS);
    }
    const [start, stagger, pop] = TIMELINE.achievements;
    expect(start + 5 * stagger + pop + TIMELINE.shimmer).toBeLessThanOrEqual(REPLAY_SECONDS);
  });

  it('counts the duration up and lands exactly on it', () => {
    expect(counterValue(0, 5400)).toBe(0);
    expect(counterValue(2, 5400)).toBeGreaterThan(0);
    expect(counterValue(2, 5400)).toBeLessThan(5400);
    expect(counterValue(TIMELINE.counter[1], 5400)).toBe(5400);
    expect(counterValue(REPLAY_SECONDS, 5400)).toBe(5400);
  });

  it('pops achievements in one after another with an overshoot', () => {
    const [start, stagger, pop] = TIMELINE.achievements;
    expect(achievementAt(0, start - 0.1).scale).toBe(0);
    expect(achievementAt(1, start + 0.1).scale).toBe(0);
    expect(achievementAt(1, start + stagger + 0.05).scale).toBeGreaterThan(0);
    const peak = Math.max(...Array.from({ length: 20 }, (_, i) => easeOutBack(i / 19)));
    expect(peak).toBeGreaterThan(1);
    expect(achievementAt(0, start + pop).scale).toBeCloseTo(1);
    expect(achievementAt(2, REPLAY_SECONDS).shimmer).toBe(1);
    expect(phase(5, 5, 5)).toBe(1);
  });

  it('downsamples real samples only', () => {
    expect(downsample([1, null, undefined, Number.NaN])).toBeNull();
    expect(downsample([1, 2, 3])).toEqual([1, 2, 3]);
    const long = downsample(Array.from({ length: 1000 }, (_, i) => i), 100)!;
    expect(long).toHaveLength(100);
    expect(long[0]).toBeCloseTo(4.5);
  });

  it('builds the model from real numbers and caps achievements', () => {
    const data: ReplayData = {
      session: session('s', { perf: { fpsAvg: 112.6, fps1Low: 70.4, peakTempC: 74, gpuAvg: 86, cpuAvg: 44, hasMetrics: true } }),
      achievements: Array.from({ length: 8 }, (_, i) => ({ gameId: 'g1', sessionId: 's', apiName: `A${i}`, name: `A${i}`, description: null, unlockedAt: `2026-10-05T20:0${i}:00Z`, globalPercent: i === 7 ? 0.5 : 20 + i, icon: null })),
      steamGame: true,
      achievementsKnown: true,
    };
    const m = buildReplayModel(data, [{ t: 0, cpu: 40, gpu: null, gpuMemMb: null, ramMb: null, gpuTempC: null }, { t: 2000, cpu: 50, gpu: null, gpuMemMb: null, ramMb: null, gpuTempC: null }], []);
    expect(m.fps).toBeNull();
    expect(m.cpu).toEqual([40, 50]);
    expect(m.achievements).toHaveLength(6);
    expect(m.achievements[0]).toMatchObject({ name: 'A7', tier: 'ultra' });
    expect(m.moreAchievements).toBe(2);
    expect(replaySummary(m, '1h')).toContain('113 FPS average, 1% low 70');
    expect(buildReplayModel({ ...data, achievementsKnown: false, achievements: [] }, [], []).achievementsNote).toContain('weren’t checked');
  });

  it('splits PNG bytes into whole base64 chunks under the bridge cap', () => {
    const bytes = new Uint8Array(CHUNK_BYTES * 2 + 5).map((_, i) => i % 251);
    const chunks = toBase64Chunks(bytes);
    expect(chunks).toHaveLength(3);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(196_608);
    const back = Uint8Array.from(atob(chunks.join('')), (c) => c.charCodeAt(0));
    expect(back).toEqual(bytes);
    expect(() => toBase64Chunks(bytes, 1000)).toThrow();
  });
});
