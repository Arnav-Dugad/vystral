/**
 * Track M preview: away card, time to beat, anti-cheat notes, value forecast and session replay with
 * fictional data. Features that change Home or Library at a glance are opt-in by URL so the existing
 * screenshot tests stay stable: `?away` (away card), `?ttb` (time-to-beat bars), `?antiCheat` (every
 * Steam game gets a kernel anti-cheat note), `?saleOn` (a sale running now). Nothing here touches the
 * network, and images "saved" or "copied" are only recorded for UI tests.
 */
import type {
  AntiCheatNote, AwayResult, BacklogSavings, Game, PreflightResult, RecapAchievement, RecapSession, ReplayData, SaleForecast, Session, Settings,
  TimeToBeatMap,
} from './types';
import { BridgeError } from './bridge';

type Emit = (name: string, payload: unknown) => void;

export const RECAP_DEFAULT_SETTINGS: Pick<Settings, 'launch.antiCheatNotes' | 'library.timeToBeat'> = {
  'launch.antiCheatNotes': true,
  'library.timeToBeat': true,
};

const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const steamAppOf = (g: Game) => g.installations.find((i) => i.platform === 'steam')?.platformGameId ?? null;

function perfOf(json: string | null) {
  let o: Record<string, unknown> = {};
  try { o = json ? JSON.parse(json) : {}; } catch { o = {}; }
  const n = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? Math.round((o[k] as number) * 10) / 10 : null);
  return { fpsAvg: n('fpsAvg'), fps1Low: n('fps1Low'), peakTempC: n('peakTempC') ?? n('gpuTempMaxC'), gpuAvg: n('gpuAvg'), cpuAvg: n('cpuAvg'), hasMetrics: !!json };
}

const FICTIONAL_UNLOCKS: [string, string, number][] = [
  ['FIRST_LIGHT', 'First Light', 64.2],
  ['NO_WITNESSES', 'No Witnesses', 3.4],
  ['THE_LONG_WAY', 'The Long Way Round', 0.6],
];

export function recapPreviewHandlers(ctx: {
  lib: { games: Game[]; sessions: Session[] };
  emit: () => Emit;
  settings: () => Settings;
  igdbTimeToBeat: (gameId: string) => { hastily: number | null; normally: number | null; completely: number | null; count: number } | null;
}) {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const tickets = new Map<string, string>();
  const uploads = new Map<string, { sessionId: string; total: number; chunks: string[] }>();
  const images: { action: 'save' | 'copy'; sessionId: string; bytes: number; width: number; height: number }[] = [];
  const seen: string[] = [];
  let seq = 0;

  const find = (id: string) => ctx.lib.games.find((g) => g.id === id);
  if (params.has('away')) {
    // A Steam game played with the background helper too, so the card can show (fictional) achievements.
    const steamSession = [...ctx.lib.sessions].sort((a, b) => b.start.localeCompare(a.start))
      .find((s) => s.source === 'tracked' && s.end && (() => { const g = find(s.gameId); return !!g && !!steamAppOf(g); })());
    if (steamSession) steamSession.source = 'background';
  }
  const toRecap = (s: Session): RecapSession => ({
    id: s.id, gameId: s.gameId, title: find(s.gameId)?.title ?? 'Unknown game', source: s.source, start: s.start, end: s.end ?? s.start,
    durationSeconds: s.durationSeconds, perf: perfOf(s.perfSummary),
  });
  const unlocksFor = (s: Session, n: number): RecapAchievement[] => {
    const g = find(s.gameId);
    if (!g || !steamAppOf(g)) return [];
    const start = Date.parse(s.start);
    return FICTIONAL_UNLOCKS.slice(0, n).map(([api, name, pct], i) => ({
      gameId: g.id, sessionId: s.id, apiName: api, name, description: null, unlockedAt: new Date(start + (i + 1) * 600_000).toISOString(), globalPercent: pct, icon: null,
    }));
  };
  const kernelFor = (g: Game): string | null => {
    if (!steamAppOf(g)) return null;
    const h = hash(g.id);
    if (params.has('antiCheat')) return h % 2 ? 'Easy Anti-Cheat' : 'BattlEye';
    return h % 3 === 0 ? (h % 2 ? 'Easy Anti-Cheat' : 'BattlEye') : null; // same rule as the preview compat badge
  };
  const note = (g: Game): AntiCheatNote | null => {
    const s = ctx.settings();
    const k = kernelFor(g);
    if (!k || !s['launch.antiCheatNotes'] || !s['dataSources.antiCheat']) return null;
    const notes = [
      'VYSTRAL never interacts with it: it doesn’t inject code into games, draw overlays inside them or read their memory.',
      'To see that the game is running, VYSTRAL only asks Windows which programs are running (read-only).',
      ...(s['fps.captureEnabled'] ? ['Frame-rate capture is on: it uses Intel PresentMon, which reads the frame timing events Windows itself publishes (ETW) and doesn’t hook into the game.'] : []),
      'Each anti-cheat decides for itself what other software it allows; VYSTRAL can’t speak for it.',
    ];
    return { kernel: [k], other: [], headline: `Uses kernel anti-cheat (${k}). VYSTRAL never interacts with it.`, notes, source: 'Anti-cheat per AreWeAntiCheatYet (community-maintained).', updated: '2025-11-02T00:00:00.000Z' };
  };

  const handlers = {
    'away.summary': (): AwayResult => {
      if (!params.has('away')) return { summary: null, firstVisit: false };
      const noticed = ctx.lib.sessions.filter((s) => (s.source === 'background' || s.source === 'detected') && s.end).sort((a, b) => b.start.localeCompare(a.start));
      if (!noticed.length) return { summary: null, firstVisit: false };
      const sessions = noticed.map(toRecap);
      const byGame = new Map<string, { title: string; sessions: number; seconds: number; lastEnd: string }>();
      for (const s of sessions) {
        const cur = byGame.get(s.gameId) ?? { title: s.title, sessions: 0, seconds: 0, lastEnd: s.end };
        cur.sessions += 1;
        cur.seconds += s.durationSeconds;
        if (s.end > cur.lastEnd) cur.lastEnd = s.end;
        byGame.set(s.gameId, cur);
      }
      const best = [...sessions].sort((a, b) => b.durationSeconds - a.durationSeconds)[0];
      const bestFps = sessions.filter((s) => s.perf.fpsAvg != null).sort((a, b) => b.perf.fpsAvg! - a.perf.fpsAvg!)[0] ?? null;
      const since = new Date(Date.parse(noticed[noticed.length - 1].start) - 3600_000).toISOString();
      return {
        firstVisit: false,
        summary: {
          since, until: new Date().toISOString(), totalSeconds: sessions.reduce((n, s) => n + s.durationSeconds, 0),
          games: [...byGame.entries()].map(([gameId, g]) => ({ gameId, ...g })).sort((a, b) => b.seconds - a.seconds),
          sessions, best, bestFps, gamesWithoutAchievementData: 0,
          // Fictional unlocks for the first session of a Steam game (only Steam reports achievements).
          achievements: noticed.flatMap((s) => unlocksFor(s, 3)).slice(0, 3),
        },
      };
    },
    'away.markSeen': (p: { until: string }) => {
      if (!Number.isFinite(Date.parse(p?.until))) throw new BridgeError('invalid', 'Invalid time.');
      seen.push(p.until);
      return true;
    },
    'preview.awaySeen': () => [...seen],

    'ttb.map': (): TimeToBeatMap => {
      if (!ctx.settings()['library.timeToBeat']) return { games: {}, reason: 'disabled' };
      if (!params.has('ttb')) return { games: {}, reason: 'noData' };
      const games: TimeToBeatMap['games'] = {};
      for (const g of ctx.lib.games) {
        if (hash(g.id) % 4 === 3) continue; // some games have no estimate, like real libraries
        const t = ctx.igdbTimeToBeat(g.id);
        if (!t) continue;
        games[g.id] = { main: t.hastily, extras: t.normally, completionist: t.completely, count: t.count, fetched: new Date(Date.now() - 3 * 86400000).toISOString(), source: 'igdb' };
      }
      return { games, reason: null };
    },

    'forecast.sales': (): SaleForecast => {
      const day = (offset: number) => {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const on = params.has('saleOn');
      return {
        current: on ? { id: 'preview-now', name: 'Steam Autumn Sale', start: day(-3), end: day(4) } : null,
        next: { id: 'preview-next', name: 'Steam Winter Sale', start: day(on ? 72 : 12), end: day(on ? 90 : 30) },
        daysUntilNext: on ? 72 : 12, daysLeftInCurrent: on ? 4 : null,
        source: 'Preview: fictional dates', sourceUrl: 'https://partner.steamgames.com/doc/marketing/upcoming_events', retrieved: day(0), version: 1, outdated: false,
      };
    },
    'forecast.openSource': () => true,
    'forecast.backlogSavings': (): BacklogSavings => {
      const s = ctx.settings();
      const candidates = ctx.lib.games.filter((g) => !g.hidden && (g.status === 'backlog' || (!g.status && g.trackedSeconds === 0 && !g.installations.some((i) => (i.importedPlaytimeMinutes ?? 0) > 0))));
      const games: BacklogSavings['games'] = [];
      let withoutSteam = 0;
      for (const g of candidates) {
        if (!steamAppOf(g)) { withoutSteam++; continue; }
        const h = hash(`${g.id}deals`);
        if (h % 3 === 0) continue; // never opened, so no cached price
        const regular = [9.99, 14.99, 19.99, 29.99, 39.99, 59.99][h % 6];
        const current = Math.round(regular * (1 - (h % 4) * 0.15) * 100) / 100;
        const low = Math.round(regular * 0.2 * 100) / 100;
        games.push({ gameId: g.id, title: g.title, provider: 'cheapshark', currency: 'USD', current, shop: 'Steam', low, lowAt: new Date(Date.now() - 200 * 86400000).toISOString(), saving: Math.max(0, Math.round((current - low) * 100) / 100), pricedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), stale: false });
      }
      games.sort((a, b) => b.saving - a.saving);
      const total = Math.round(games.reduce((n, g) => n + g.saving, 0) * 100) / 100;
      const enabled = s['dataSources.cheapshark'];
      return {
        candidates: candidates.length, games: enabled ? games : [], totals: enabled && games.length ? [{ currency: 'USD', total, games: games.length }] : [],
        withoutData: candidates.length - (enabled ? games.length : 0), withoutSteamId: withoutSteam, country: s['dataSources.priceCountry'],
        reason: !enabled ? 'disabled' : candidates.length === 0 ? 'noBacklog' : games.length === 0 ? 'noPrices' : null,
      };
    },

    'compat.antiCheatNote': (p: { gameId: string }) => {
      const g = find(p.gameId);
      if (!g) throw new BridgeError('notFound', 'That item no longer exists.');
      return note(g);
    },

    'replay.get': (p: { sessionId: string }): ReplayData => {
      const s = ctx.lib.sessions.find((x) => x.id === p.sessionId && x.end);
      if (!s) throw new BridgeError('notFound', 'That session is no longer in your journal.');
      const g = find(s.gameId);
      const steam = !!(g && steamAppOf(g));
      return { session: toRecap(s), achievements: steam ? unlocksFor(s, hash(s.id) % 4) : [], steamGame: steam, achievementsKnown: steam };
    },
    'replay.imageBegin': (p: { sessionId: string; bytes: number }) => {
      if (!ctx.lib.sessions.some((x) => x.id === p.sessionId)) throw new BridgeError('notFound', 'That session is no longer in your journal.');
      if (!(p.bytes >= 64 && p.bytes <= 20 * 1024 * 1024)) throw new BridgeError('invalid', 'That image is too large to save.');
      const token = (++seq).toString(16).padStart(32, '0');
      uploads.set(token, { sessionId: p.sessionId, total: p.bytes, chunks: [] });
      return { token, maxChunk: 196_608 };
    },
    'replay.imageChunk': (p: { token: string; index: number; data: string }) => {
      const u = uploads.get(p.token);
      if (!u) throw new BridgeError('notFound', 'That image upload expired. Try again.');
      if (p.index !== u.chunks.length || p.data.length > 196_608) throw new BridgeError('invalid', 'Invalid image chunk.');
      u.chunks.push(p.data);
      return { received: u.chunks.length };
    },
    'replay.imageSave': (p: { token: string }) => {
      const r = take(p.token, 'save');
      return { path: `C:\\Users\\you\\Pictures\\VYSTRAL replay - ${find(ctx.lib.sessions.find((x) => x.id === r.sessionId)!.gameId)?.title ?? 'Session'}.png` };
    },
    'replay.imageCopy': (p: { token: string }) => {
      take(p.token, 'copy');
      return true;
    },
    'preview.replayImages': () => [...images],

    /** Called by the preview game.launch so pre-flight knows which game a ticket is for. */
    __launch: (p: { ticket: string; gameId: string }) => { tickets.set(p.ticket, p.gameId); },
    /** Adds the anti-cheat row to a preview pre-flight result (the native side adds it in BuildPreflightChecks). */
    __decoratePreflight: (r: PreflightResult | null): PreflightResult | null => {
      if (!r) return r;
      const g = find(tickets.get(r.ticket) ?? '');
      const n = g ? note(g) : null;
      if (!n || r.checks.some((c) => c.id === 'antiCheat')) return r;
      const fps = ctx.settings()['fps.captureEnabled'];
      return {
        ...r,
        checks: [...r.checks, {
          id: 'antiCheat', label: 'Anti-cheat', status: 'info', value: `${n.kernel[0]} · kernel`,
          detail: `${n.headline}${fps ? ' Frame-rate capture reads Windows’ own frame events (ETW) and doesn’t touch the game.' : ''} ${n.source}`,
        }],
      };
    },
  };

  function take(token: string, action: 'save' | 'copy') {
    const u = uploads.get(token);
    if (!u) throw new BridgeError('notFound', 'That image upload expired. Try again.');
    uploads.delete(token);
    const bin = atob(u.chunks.join(''));
    if (bin.length !== u.total) throw new BridgeError('invalid', 'The image didn’t arrive completely. Try again.');
    const byte = (i: number) => bin.charCodeAt(i);
    const be = (i: number) => ((byte(i) << 24) | (byte(i + 1) << 16) | (byte(i + 2) << 8) | byte(i + 3)) >>> 0;
    const png = byte(0) === 0x89 && bin.slice(1, 4) === 'PNG' && bin.slice(12, 16) === 'IHDR';
    if (!png || be(16) !== 1920 || be(20) !== 1080) throw new BridgeError('invalid', 'That isn’t a 1920×1080 PNG image.');
    images.push({ action, sessionId: u.sessionId, bytes: bin.length, width: be(16), height: be(20) });
    return u;
  }

  return handlers;
}
