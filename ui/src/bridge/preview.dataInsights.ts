/**
 * Track F preview data: achievement feed and near-completion shelf, GPU driver comparison,
 * background-app report, and an "achievements unlocked" event after a preview session. Everything
 * here is fictional sample data for developing the UI in a browser; the real values come from the
 * native backend.
 */
import type {
  AchievementFeed, AchievementFeedItem, AchievementOverview, AchievementUnlockEvent, BackgroundAppStat, BackgroundImpact, DriverInsight,
  DriverVersion, Game, Session, Settings,
} from './types';
import { BridgeError } from './bridge';

type Emit = (name: string, payload: unknown) => void;

export const DATA_INSIGHT_DEFAULT_SETTINGS: Pick<Settings, 'notifications.achievements' | 'performance.backgroundApps'> = {
  'notifications.achievements': true,
  'performance.backgroundApps': true,
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

const WORDS_A = ['First', 'Silent', 'Long', 'Bright', 'Hollow', 'Iron', 'Last', 'Wandering', 'Patient', 'Lucky', 'Burning', 'Quiet', 'Crowned', 'Gilded'];
const WORDS_B = ['Step', 'Signal', 'Road', 'Harvest', 'Echo', 'Promise', 'Light', 'Detour', 'Spark', 'Tide', 'Ledger', 'Orbit', 'Vow', 'Summit'];
const GLYPHS = ['M16 6l3 6.5 7 .8-5.2 4.8 1.4 7L16 21.6 9.8 25l1.4-7L6 13.3l7-.8z', 'M16 5l10 11-10 11L6 16z', 'M16 6a10 10 0 1 1 0 20 10 10 0 0 1 0-20z', 'M8 8h16v16H8z', 'M16 5l11 19H5z'];

/** A small fictional achievement badge as an inline SVG (preview only). */
function icon(seed: number, rare: boolean): string {
  const r = rng(seed);
  const hue = Math.floor(r() * 360);
  const glyph = GLYPHS[Math.floor(r() * GLYPHS.length)];
  const a = rare ? `oklch(0.8 0.14 85)` : `oklch(0.66 0.16 ${hue})`;
  const b = rare ? `oklch(0.55 0.13 55)` : `oklch(0.42 0.12 ${(hue + 50) % 360})`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="32" height="32" rx="7" fill="url(#g)"/><path d="${glyph}" fill="white" fill-opacity="0.88"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

interface PreviewAch {
  appId: string;
  gameId: string;
  gameTitle: string;
  apiName: string;
  name: string;
  description: string;
  achieved: boolean;
  unlockedAt: string | null;
  globalPercent: number;
  hidden: boolean;
}

function buildAchievements(games: Game[]): PreviewAch[] {
  const now = Date.now();
  const out: PreviewAch[] = [];
  const steam = games.filter((g) => g.installations.some((i) => i.platform === 'steam')).slice(0, 12);
  steam.forEach((g, gi) => {
    const r = rng(gi * 7919 + 17);
    const appId = g.installations.find((i) => i.platform === 'steam')!.platformGameId;
    const total = 14 + Math.floor(r() * 30);
    // A few games are close to 100% so the near-completion shelf has a story.
    const target = gi % 4 === 1 ? 0.93 : gi % 4 === 2 ? 0.76 : 0.25 + r() * 0.4;
    const span = 40 + Math.floor(r() * 280);
    for (let i = 0; i < total; i++) {
      const pct = Math.round(Math.pow(r(), 2.2) * 9000) / 100;
      const achieved = i / total < target;
      const hidden = r() < 0.12;
      out.push({
        appId,
        gameId: g.id,
        gameTitle: g.title,
        apiName: `ACH_${gi}_${i}`,
        name: `${WORDS_A[Math.floor(r() * WORDS_A.length)]} ${WORDS_B[Math.floor(r() * WORDS_B.length)]}`,
        description: `Sample achievement ${i + 1} in ${g.title}.`,
        achieved,
        unlockedAt: achieved ? new Date(now - Math.floor(r() * span) * 86_400_000 - Math.floor(r() * 50_000_000)).toISOString() : null,
        globalPercent: Math.max(0.2, pct),
        hidden,
      });
    }
  });
  return out;
}

const APPS: [string, number, number][] = [
  ['Discord.exe', 420, 1.2], ['steamwebhelper.exe', 610, 0.9], ['chrome.exe', 1850, 4.5], ['obs64.exe', 780, 9.8], ['Spotify.exe', 260, 0.6],
  ['wallpaper64.exe', 340, 3.1], ['OneDrive.exe', 120, 0.4], ['Teams.exe', 690, 1.6], ['iCUE.exe', 230, 1.1],
];

export function dataInsightPreviewHandlers(ctx: { lib: { games: Game[]; sessions: Session[] }; emit: () => Emit; settings: () => Settings; timers: number[] }) {
  let achievements: PreviewAch[] | null = null;
  const ach = () => (achievements ??= buildAchievements(ctx.lib.games));
  const hidden = new Set<string>();

  const feedItem = (a: PreviewAch): AchievementFeedItem => ({
    appId: a.appId, gameId: a.gameId, gameTitle: a.gameTitle, apiName: a.apiName, name: a.name, description: a.description,
    unlockedAt: a.unlockedAt!, globalPercent: a.globalPercent, icon: icon(a.apiName.length * 131 + a.name.charCodeAt(0) * 7 + a.name.length, a.globalPercent <= 1),
  });

  const unlocked = () => ach().filter((a) => a.achieved && a.unlockedAt).sort((a, b) => b.unlockedAt!.localeCompare(a.unlockedAt!));
  const configured = () => !ctx.settings()['privacy.localOnly'];

  const overview = (): AchievementOverview => {
    const list = ach();
    const byApp = new Map<string, PreviewAch[]>();
    for (const a of list) byApp.set(a.appId, [...(byApp.get(a.appId) ?? []), a]);
    const near = [...byApp.values()].map((rows) => {
      const done = rows.filter((r) => r.achieved);
      const locked = rows.filter((r) => !r.achieved).sort((a, b) => a.globalPercent - b.globalPercent);
      const rarest = locked[0];
      return {
        appId: rows[0].appId, gameId: rows[0].gameId, gameTitle: rows[0].gameTitle, unlocked: done.length, total: rows.length, remaining: rows.length - done.length,
        fraction: done.length / rows.length, rarestRemainingName: rarest && !rarest.hidden ? rarest.name : null, rarestRemainingPercent: rarest?.globalPercent ?? null,
        rarestRemainingHidden: !!rarest?.hidden, lastUnlockAt: done.map((d) => d.unlockedAt!).sort().pop() ?? null,
      };
    }).filter((n) => n.unlocked < n.total && n.fraction >= 0.7).sort((a, b) => a.remaining - b.remaining || b.fraction - a.fraction);
    const got = list.filter((a) => a.achieved);
    return {
      status: 'ok', message: null, totalUnlocked: got.length, gamesWithData: byApp.size,
      rare: got.filter((a) => a.globalPercent <= 5).length, ultraRare: got.filter((a) => a.globalPercent <= 1).length,
      lastFetched: new Date(Date.now() - 2 * 3600_000).toISOString(), nearCompletion: near,
    };
  };

  const drivers: DriverVersion[] = [
    { version: '566.36', gpuName: 'NVIDIA GeForce RTX 4060 Laptop GPU', firstSeen: new Date(Date.now() - 230 * 86_400_000).toISOString(), lastSeen: new Date(Date.now() - 121 * 86_400_000).toISOString(), sessions: 21 },
    { version: '572.16', gpuName: 'NVIDIA GeForce RTX 4060 Laptop GPU', firstSeen: new Date(Date.now() - 120 * 86_400_000).toISOString(), lastSeen: new Date(Date.now() - 27 * 86_400_000).toISOString(), sessions: 17 },
    { version: '576.02', gpuName: 'NVIDIA GeForce RTX 4060 Laptop GPU', firstSeen: new Date(Date.now() - 26 * 86_400_000).toISOString(), lastSeen: new Date(Date.now() - 1 * 86_400_000).toISOString(), sessions: 9 },
  ];

  const driverInsight = (gameId: string | null): DriverInsight => {
    const played = [...new Set(ctx.lib.sessions.map((s) => s.gameId))].slice(0, 2);
    const games = played.map((id, i) => ({
      gameId: id,
      before: { version: '572.16', gpuName: drivers[1].gpuName, sessions: i === 0 ? 6 : 2, fpsAvg: i === 0 ? 108.4 : 61.2, fps1Low: i === 0 ? 66.1 : 41.5, frameTimeP99Ms: i === 0 ? 17.9 : 27.4, from: drivers[1].firstSeen, to: drivers[1].lastSeen },
      after: { version: '576.02', gpuName: drivers[2].gpuName, sessions: i === 0 ? 4 : 3, fpsAvg: i === 0 ? 116.9 : 60.4, fps1Low: i === 0 ? 74.8 : 37.9, frameTimeP99Ms: i === 0 ? 15.2 : 30.1, from: drivers[2].firstSeen, to: drivers[2].lastSeen },
      changedAt: drivers[2].firstSeen,
      smallSample: i !== 0,
      gpuChanged: false,
    }));
    return {
      drivers,
      games: gameId ? games.filter((g) => g.gameId === gameId) : games,
      sessionsWithDriver: 47,
      sessionsWithFps: 22,
      gamesWithoutFps: 3,
    };
  };

  const background = (): BackgroundImpact => {
    const stat = ([name, mb, cpu]: [string, number, number], i: number): BackgroundAppStat => {
      const suspect = name === 'obs64.exe' || name === 'wallpaper64.exe';
      const rough = suspect ? (name === 'obs64.exe' ? 0.8 : 0.6) : 0.5 + ((i * 37) % 30) / 100;
      const clean = suspect ? (name === 'obs64.exe' ? 0.22 : 0.33) : rough - 0.05;
      return {
        name, displayName: name.replace(/\.exe$/i, ''), sessions: Math.round(14 * ((rough * 5 + clean * 9) / 14)), presence: Math.round(((rough * 5 + clean * 9) / 14) * 1000) / 1000,
        roughPresence: rough, cleanPresence: Math.round(clean * 1000) / 1000, lift: Math.round((rough - clean) * 1000) / 1000, avgMb: mb, maxMb: Math.round(mb * 1.3), avgCpu: cpu,
      };
    };
    const all = APPS.map(stat).filter((a) => !hidden.has(a.name.toLowerCase()));
    return {
      mode: 'fps', sessionsAnalyzed: 14, roughSessions: 5, cleanSessions: 9, enough: true,
      suspects: all.filter((a) => (a.lift ?? 0) >= 0.2).sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0)),
      common: all.slice().sort((a, b) => b.presence - a.presence || (b.avgMb ?? 0) - (a.avgMb ?? 0)).slice(0, 8),
      hidden: [...hidden].sort(),
      collecting: ctx.settings()['performance.collectMetrics'] && ctx.settings()['performance.backgroundApps'],
    };
  };

  return {
    'achievements.overview': (): AchievementOverview =>
      configured() ? overview() : { status: 'localOnly', message: null, totalUnlocked: 0, gamesWithData: 0, rare: 0, ultraRare: 0, lastFetched: null, nearCompletion: [] },
    'achievements.feed': (p: { offset?: number; limit?: number }): AchievementFeed => {
      const offset = p?.offset ?? 0;
      const limit = p?.limit ?? 40;
      if (offset < 0 || limit < 1 || limit > 100) throw new BridgeError('invalid', 'Invalid page.');
      if (!configured()) return { status: 'localOnly', items: [], offset, total: 0, hasMore: false };
      const list = unlocked();
      const items = list.slice(offset, offset + limit).map(feedItem);
      return { status: 'ok', items, offset, total: list.length, hasMore: offset + items.length < list.length };
    },
    'insights.driverComparison': (p: { gameId?: string | null }) => driverInsight(p?.gameId ?? null),
    'insights.backgroundApps': background,
    'insights.hideBackgroundApp': (p: { name: string; hidden: boolean }) => {
      if (!p?.name || /[\\/:*?"<>|]/.test(p.name)) throw new BridgeError('invalid', 'That isn’t an app name.');
      if (p.hidden) hidden.add(p.name.toLowerCase());
      else hidden.delete(p.name.toLowerCase());
      return background();
    },
    /** Called by the preview game.launch after a session ends: two fictional unlocks for Steam games. */
    __unlocked: (p: { gameId: string; sessionId: string }) => {
      const game = ctx.lib.games.find((g) => g.id === p.gameId);
      const appId = game?.installations.find((i) => i.platform === 'steam')?.platformGameId;
      if (!game || !appId || !configured()) return false;
      const at = new Date().toISOString();
      const items: AchievementFeedItem[] = [
        { appId, gameId: game.id, gameTitle: game.title, apiName: 'PREVIEW_RARE', name: 'Against the Current', description: 'A fictional unlock from this preview session.', unlockedAt: at, globalPercent: 1.4, icon: icon(77, false) },
        { appId, gameId: game.id, gameTitle: game.title, apiName: 'PREVIEW_COMMON', name: 'Second Wind', description: 'Another fictional unlock.', unlockedAt: at, globalPercent: 38.2, icon: icon(91, false) },
      ];
      const event: AchievementUnlockEvent = { sessionId: p.sessionId, gameId: game.id, gameTitle: game.title, appId, items, rareThreshold: 2, rareCount: 1 };
      ctx.emit()('achievements.unlocked', event);
      return true;
    },
  } satisfies Record<string, (p: never) => unknown>;
}
