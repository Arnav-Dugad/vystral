/**
 * Track V preview: your subscriptions with a fictional Game Pass catalogue. Everything here is made up and never
 * touches the network; posters are drawn locally as SVG data URIs.
 *
 * URL switches:
 * - `?subs` — you've said you have Game Pass Ultimate, Humble Choice and GeForce NOW Performance, with the public lists
 *   on: badges, the "In my subscriptions" filter, the Home row and the value card (some fictional sessions this month).
 * - `?subsPrice` — as `?subs`, plus a monthly price, so the value card shows cost per hour.
 * - `?leaving` — as `?subs`, with two of your games and two included games in "Leaving soon" (one with a date).
 * - `?subsAsk` — not asked yet: Home shows the one-time "Tell VYSTRAL your subscriptions" card (also with `?onboarding`).
 * - `?subsNoData` — the lists are on but haven't downloaded yet.
 *
 * Without a switch the preview behaves like a user who already answered "None" with "show every service" on, so other
 * tracks' previews and screenshots don't change.
 */
import type { CloudQueueSignal, Game, Session, Settings, SubsBadge, SubsMap, SubsPick, SubsPlanId, SubsStatus, SubsValue } from './types';
import { BridgeError } from './bridge';

type Emit = (name: string, payload: unknown) => void;

export const SUBS_DEFAULT_SETTINGS: Pick<Settings, 'subs.owned' | 'subs.asked' | 'subs.catalog' | 'subs.cloudShowAll' | 'subs.leavingNotify' | 'subs.price' | 'subs.currency' | 'cloud.queueAlerts' | 'cloud.queueAlertAt'> = {
  'subs.owned': '',
  // The real app starts unasked (existing users get the Home card once); the preview starts answered unless asked to.
  'subs.asked': true,
  'subs.catalog': false,
  // Also preview-only: an answered "None" would hide every cloud service, which would change Track O's preview.
  'subs.cloudShowAll': true,
  'subs.leavingNotify': true,
  'subs.price': 0,
  'subs.currency': '',
  'cloud.queueAlerts': true,
  'cloud.queueAlertAt': 5,
};

declare global {
  interface Window {
    __vystralPreviewSubs?: { opened: string[] };
  }
}

const KEYS: Record<SubsPlanId, string[]> = {
  'gp-pc': ['pc', 'eaaccess'],
  'gp-essential': ['gamepasscore'],
  'gp-premium': ['gamepassstandard'],
  'gp-ultimate': ['pc', 'console', 'ultimate', 'eaaccess', 'ubisoftplus'],
  'ea-play': ['eaaccess'],
  'ea-play-pro': ['eaaccess'],
  'ubi-classics': ['ubisoftplus'],
  'ubi-premium': ['ubisoftplus'],
  'humble-choice': [],
  'prime-gaming': [],
};
const NAMES: Record<SubsPlanId, string> = {
  'gp-pc': 'PC Game Pass', 'gp-essential': 'Game Pass Essential', 'gp-premium': 'Game Pass Premium', 'gp-ultimate': 'Game Pass Ultimate',
  'ea-play': 'EA Play', 'ea-play-pro': 'EA Play Pro', 'ubi-classics': 'Ubisoft+ Classics', 'ubi-premium': 'Ubisoft+ Premium',
  'humble-choice': 'Humble Choice', 'prime-gaming': 'Prime Gaming',
};
const FAMILY: Record<SubsPlanId, SubsBadge['family']> = {
  'gp-pc': 'gamepass', 'gp-essential': 'gamepass', 'gp-premium': 'gamepass', 'gp-ultimate': 'gamepass', 'ea-play': 'eaplay', 'ea-play-pro': 'eaplay',
  'ubi-classics': 'ubisoft', 'ubi-premium': 'ubisoft', 'humble-choice': 'humble', 'prime-gaming': 'prime',
};
const ORDER = Object.keys(KEYS) as SubsPlanId[];

/** Library titles in the fictional lists: which lists, and how they matched. */
const IN_LISTS: Record<string, { lists: string[]; match: 'store' | 'title' }> = {
  'Circuit Apex': { lists: ['pc', 'console', 'gamepassstandard', 'gamepasscore'], match: 'store' },
  'Velvet Orbit': { lists: ['pc', 'gamepassstandard'], match: 'store' },
  'Summit Sixteen': { lists: ['pc', 'console', 'gamepassstandard'], match: 'store' },
  Tidebreaker: { lists: ['pc', 'console', 'gamepassstandard', 'gamepasscore'], match: 'store' },
  'Kingsfall Remastered': { lists: ['console', 'gamepassstandard'], match: 'store' },
  'Ashen Crown': { lists: ['pc', 'gamepassstandard'], match: 'title' },
  'Echoes of Vael': { lists: ['eaaccess'], match: 'title' },
  'Redline Rivals': { lists: ['eaaccess'], match: 'title' },
  'Night Courier': { lists: ['ubisoftplus'], match: 'title' },
};

/** Included games that aren't in the library (fictional). */
const NOT_OWNED: { id: string; title: string; lists: string[]; reason: SubsPick['reason']; hue: number }[] = [
  { id: '9PRV00000001', title: 'Lanternfall', lists: ['pc', 'gamepassstandard'], reason: 'new', hue: 32 },
  { id: '9PRV00000002', title: 'Quantum Courier', lists: ['pc', 'console'], reason: 'new', hue: 200 },
  { id: '9PRV00000003', title: 'Ironwood Saga', lists: ['pc', 'gamepassstandard'], reason: 'popular', hue: 140 },
  { id: '9PRV00000004', title: 'Echo Basin', lists: ['console', 'gamepassstandard'], reason: 'popular', hue: 260 },
  { id: '9PRV00000005', title: 'Pixel Pilgrims', lists: ['pc'], reason: 'new', hue: 320 },
  { id: '9PRV00000006', title: 'Rift Runners', lists: ['eaaccess'], reason: 'popular', hue: 10 },
  { id: '9PRV00000007', title: 'Cinder Vale', lists: ['ubisoftplus'], reason: 'popular', hue: 90 },
];
const LEAVING_NOT_OWNED = [
  { id: '9PRV00000008', title: 'Harbor Lights', lists: ['pc', 'gamepassstandard'], reason: 'leaving' as const, hue: 210 },
  { id: '9PRV00000009', title: 'Moth & Meridian', lists: ['pc'], reason: 'leaving' as const, hue: 50 },
];

function poster(title: string, hue: number): string {
  const words = title.split(' ');
  const lines = words.length > 2 ? [words.slice(0, 2).join(' '), words.slice(2).join(' ')] : [title];
  const text = lines.map((l, i) => `<text x="150" y="${330 + i * 40}" font-family="Segoe UI, sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="rgba(255,255,255,.94)">${l.replace(/&/g, '&amp;')}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 48%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 55% 16%)"/></linearGradient><radialGradient id="r" cx=".7" cy=".25" r=".6"><stop offset="0" stop-color="rgba(255,255,255,.35)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/></radialGradient></defs><rect width="300" height="450" fill="url(#g)"/><rect width="300" height="450" fill="url(#r)"/><circle cx="150" cy="170" r="70" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="3"/>${text}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function subsPreviewHandlers(ctx: { lib: { games: Game[]; sessions: Session[] }; emit: () => Emit; settings: () => Settings; setSettings: (s: Settings) => void }) {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const leavingOn = params.has('leaving');
  const on = params.has('subs') || params.has('subsPrice') || leavingOn || params.has('subsNoData');
  const noData = params.has('subsNoData');
  const opened: string[] = [];
  if (typeof window !== 'undefined') window.__vystralPreviewSubs = { opened };
  let refreshedAt = new Date(Date.now() - 3 * 3600_000).toISOString();

  if (params.has('subsAsk') || params.has('onboarding')) ctx.setSettings({ ...ctx.settings(), 'subs.asked': false });
  if (on) {
    ctx.setSettings({
      ...ctx.settings(), 'subs.owned': 'gp-ultimate,humble-choice', 'subs.asked': true, 'subs.catalog': true, 'subs.cloudShowAll': false, 'cloud.gfnPlan': 'performance',
      ...(params.has('subsPrice') ? { 'subs.price': 29.99, 'subs.currency': 'USD' } : {}),
    });
    // Fictional sessions this month in plan games, so the value card has something to count.
    const month = new Date();
    month.setDate(1);
    month.setHours(0, 0, 0, 0);
    const span = Math.max(3600_000, Date.now() - month.getTime() - 3600_000);
    ['Circuit Apex', 'Tidebreaker', 'Echoes of Vael', 'Circuit Apex', 'Velvet Orbit'].forEach((title, i) => {
      const g = ctx.lib.games.find((x) => x.title === title);
      if (!g) return;
      const dur = [5400, 7200, 3600, 4800, 2700][i];
      const start = month.getTime() + Math.floor((span * (i + 1)) / 7);
      ctx.lib.sessions.push({ id: `5b5${String(i).padStart(29, '0')}`, gameId: g.id, installationId: g.installations[0]?.id ?? null, start: new Date(start).toISOString(),
        end: new Date(start + dur * 1000).toISOString(), durationSeconds: dur, source: 'tracked', perfSummary: null });
    });
  }

  const s = () => ctx.settings();
  const plans = (): SubsPlanId[] => {
    const picked = new Set(s()['subs.owned'].split(',').filter((x): x is SubsPlanId => (ORDER as string[]).includes(x)));
    return ORDER.filter((p) => picked.has(p));
  };
  const listed = () => s()['subs.catalog'] && !noData && plans().some((p) => KEYS[p].length > 0);
  const inPlan = (lists: string[], plan: SubsPlanId) => KEYS[plan].some((k) => lists.includes(k));
  const soon = (days: number) => { const d = new Date(Date.now() + days * 86400_000); d.setHours(10, 0, 0, 0); return d.toISOString(); };
  const leavingGames: Record<string, string | null> = leavingOn ? { 'Velvet Orbit': soon(3), 'Ashen Crown': null } : {};

  const map = (): SubsMap => {
    if (!listed()) return {};
    const out: SubsMap = {};
    for (const g of ctx.lib.games) {
      const e = IN_LISTS[g.title];
      if (!e) continue;
      const badges = plans().filter((p) => inPlan(e.lists, p)).map<SubsBadge>((p) => {
        const leaving = FAMILY[p] === 'gamepass' && g.title in leavingGames;
        return { plan: p, planName: NAMES[p], family: FAMILY[p], match: e.match, leaving, leavingEnd: leaving ? leavingGames[g.title] : null };
      });
      if (badges.length) out[g.id] = badges;
    }
    return out;
  };

  const included = (): SubsPick[] => {
    if (!listed()) return [];
    const pool = [...(leavingOn ? LEAVING_NOT_OWNED : []), ...NOT_OWNED];
    return pool.flatMap((x, i) => {
      const plan = plans().find((p) => inPlan(x.lists, p));
      if (!plan) return [];
      // One without a cached poster, as happens before the art has downloaded.
      return [{ productId: x.id, title: x.title, plan, planName: NAMES[plan], reason: x.reason, poster: i === 3 ? null : poster(x.title, x.hue),
        leavingEnd: x.reason === 'leaving' ? (i === 0 ? soon(5) : null) : null }];
    }).slice(0, 12);
  };

  const status = (): SubsStatus => {
    const m = map();
    const p = plans();
    const counts = p.map((plan) => ({ plan, name: NAMES[plan], hasList: KEYS[plan].length > 0, count: KEYS[plan].length === 0 ? 0 : listed() ? 380 + KEYS[plan].length * 140 : 0,
      inLibrary: Object.values(m).filter((b) => b.some((x) => x.plan === plan)).length }));
    const catalog = s()['subs.catalog'];
    return {
      plans: p, asked: s()['subs.asked'], catalog, localOnly: s()['privacy.localOnly'], dataSaver: s()['dataSaver.enabled'],
      market: /^[A-Z]{2}$/.test(s()['cloud.market']) ? s()['cloud.market'] : 'GB',
      state: !catalog ? 'off' : !p.some((x) => KEYS[x].length) ? 'noPlans' : s()['privacy.localOnly'] ? 'offline' : noData ? 'never' : 'ok',
      refreshedAt: noData ? null : refreshedAt, nextRefreshAt: noData ? null : new Date(Date.parse(refreshedAt) + 86400_000).toISOString(), error: null,
      counts, leaving: leavingOn ? 9 : 0, leavingInLibrary: Object.values(m).filter((b) => b.some((x) => x.leaving)).length, pending: 0, refreshing: false,
    };
  };

  const value = (): SubsValue => {
    const month = new Date();
    month.setDate(1);
    month.setHours(0, 0, 0, 0);
    const m = map();
    const p = plans();
    const gfn = s()['cloud.gfnPlan'] !== 'none';
    const perGame = new Map<string, number>();
    const rows = new Map<string, { seconds: number; games: Set<string> }>();
    let sessions = 0;
    for (const x of ctx.lib.sessions) {
      if (!x.end || Date.parse(x.end) <= month.getTime()) continue;
      const secs = Math.min(x.durationSeconds, (Math.min(Date.now(), Date.parse(x.end)) - Math.max(Date.parse(x.start), month.getTime())) / 1000);
      if (secs <= 0) continue;
      const planRows: string[] = (m[x.gameId] ?? []).map((b) => b.plan);
      if (x.source === 'cloud-gfn' && gfn) planRows.push('geforce-now');
      if (!planRows.length) continue;
      sessions++;
      perGame.set(x.gameId, (perGame.get(x.gameId) ?? 0) + secs);
      for (const r of planRows) {
        const row = rows.get(r) ?? { seconds: 0, games: new Set<string>() };
        row.seconds += secs;
        row.games.add(x.gameId);
        rows.set(r, row);
      }
    }
    const seconds = Math.round([...perGame.values()].reduce((a, b) => a + b, 0));
    const price = s()['subs.price'];
    return {
      monthStart: month.toISOString(), plans: p, hasLists: listed(), seconds, games: perGame.size, sessions,
      rows: [...rows.entries()].map(([plan, r]) => ({ plan: plan as SubsPlanId, name: plan === 'geforce-now' ? 'GeForce NOW' : NAMES[plan as SubsPlanId], seconds: Math.round(r.seconds), games: r.games.size })),
      top: [...perGame.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([gameId, secs]) => ({ gameId, title: ctx.lib.games.find((g) => g.id === gameId)?.title ?? '', seconds: Math.round(secs) })),
      price, currency: s()['subs.currency'],
      costPerHour: price > 0 && seconds >= 3600 ? Math.round((price / (seconds / 3600)) * 100) / 100 : null,
      costNote: price > 0 ? (seconds === 0 ? 'none' : seconds < 3600 ? 'underHour' : null) : null,
    };
  };

  return {
    'subs.status': () => status(),
    'subs.map': () => map(),
    'subs.included': () => included(),
    'subs.value': () => value(),
    'subs.refresh': () => {
      if (!s()['subs.catalog']) throw new BridgeError('disabled', 'Public Game Pass lists are off. Turn them on in Settings → Library & stores → Your subscriptions.');
      if (s()['privacy.localOnly']) throw new BridgeError('offline', 'Offline mode is on, so VYSTRAL doesn’t download Game Pass lists. Turn it off in Settings → Privacy.');
      refreshedAt = new Date().toISOString();
      const st = status();
      ctx.emit()('subs.changed', st);
      return st;
    },
    'subs.openStore': (p: { productId: string }) => {
      if (!/^[0-9A-Z]{12}$/.test(p?.productId ?? '') || !included().some((x) => x.productId === p.productId)) throw new BridgeError('invalid', 'Unknown game.');
      opened.push(p.productId);
      return { opened: 'xboxApp' };
    },
    'cloud.queueState': (): CloudQueueSignal | null => null,
  };
}
