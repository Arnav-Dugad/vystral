/**
 * Track O preview: cloud play with a fictional catalogue. Cloud play is off by default like the real app;
 * `?cloud` turns it on with a Performance membership and some fictional cloud sessions. `?cloudMeter=near|reached|free|none`
 * picks a meter state, `?cloudNoData` shows the "not downloaded yet" state. Nothing here touches the network or starts
 * anything: launches are only recorded (window.__vystralPreviewCloud) for UI tests.
 */
import type {
  CloudBadge, CloudGame, CloudLaunchResult, CloudMap, CloudMeter, CloudOption, CloudService, CloudServiceHealth, CloudSession, CloudStatus,
  Game, GfnPlanId, Session, Settings,
} from './types';
import { BridgeError } from './bridge';

type Emit = (name: string, payload: unknown) => void;

export const CLOUD_DEFAULT_SETTINGS: Pick<Settings, 'cloud.enabled' | 'cloud.gfn' | 'cloud.xbox' | 'cloud.market' | 'cloud.gfnPlan' | 'cloud.resetDay' | 'cloud.browser'> = {
  'cloud.enabled': false,
  'cloud.gfn': true,
  'cloud.xbox': true,
  'cloud.market': '',
  'cloud.gfnPlan': 'none',
  'cloud.resetDay': 1,
  'cloud.browser': 'edge',
};

declare global {
  interface Window {
    __vystralPreviewCloud?: { launches: { gameId: string; service: string; surface: string }[] };
  }
}

interface Entry { service: CloudService; title: string; playType: 'ready' | 'install'; premium: boolean; match: 'store' | 'title'; store: string }

/** Fictional catalogue keyed by preview game title. */
const CATALOG: Record<string, Entry[]> = {
  'Nebula Drift': [{ service: 'gfn', title: 'Nebula Drift', playType: 'ready', premium: false, match: 'store', store: 'steam' }],
  'Ashen Crown': [
    { service: 'gfn', title: 'Ashen Crown', playType: 'ready', premium: false, match: 'store', store: 'steam' },
    { service: 'xbox', title: 'Ashen Crown', playType: 'ready', premium: false, match: 'title', store: 'steam' },
  ],
  'Circuit Apex': [
    { service: 'xbox', title: 'Circuit Apex', playType: 'ready', premium: false, match: 'store', store: 'xbox' },
    { service: 'gfn', title: 'Circuit Apex', playType: 'ready', premium: true, match: 'store', store: 'xbox' },
  ],
  Tidebreaker: [
    { service: 'gfn', title: 'Tidebreaker', playType: 'ready', premium: false, match: 'store', store: 'steam' },
    { service: 'xbox', title: 'Tidebreaker', playType: 'ready', premium: false, match: 'store', store: 'xbox' },
  ],
  'Moss & Marrow': [{ service: 'gfn', title: 'Moss and Marrow', playType: 'ready', premium: false, match: 'title', store: 'epic' }],
  'Last Signal': [{ service: 'gfn', title: 'Last Signal', playType: 'install', premium: true, match: 'store', store: 'steam' }],
  'Paper Kingdoms': [{ service: 'gfn', title: 'Paper Kingdoms', playType: 'ready', premium: false, match: 'title', store: 'ubisoft' }],
  'Velvet Orbit': [{ service: 'xbox', title: 'Velvet Orbit', playType: 'ready', premium: false, match: 'store', store: 'xbox' }],
};

const STORE_NAME: Record<string, string> = { steam: 'Steam', xbox: 'Xbox', epic: 'Epic Games', ubisoft: 'Ubisoft', gog: 'GOG' };
const PLAN: Record<GfnPlanId, { label: string; session: number | null; monthly: number | null; rollover: number; note: string }> = {
  none: { label: 'Not a member', session: null, monthly: null, rollover: 0, note: 'Pick your membership to see session and monthly limits.' },
  free: { label: 'Free', session: 1, monthly: null, rollover: 0, note: 'Sessions end after 1 hour. There may be a queue at busy times.' },
  performance: { label: 'Performance', session: 6, monthly: 100, rollover: 15, note: '100 hours a month, up to 15 unused hours roll over, sessions up to 6 hours.' },
  ultimate: { label: 'Ultimate', session: 8, monthly: 100, rollover: 15, note: '100 hours a month, up to 15 unused hours roll over, sessions up to 8 hours.' },
  daypass: { label: 'Day pass', session: null, monthly: null, rollover: 0, note: 'A day pass lasts 24 hours from purchase. Session length follows the pass’s tier.' },
};

export function cloudPreviewHandlers(ctx: { lib: { games: Game[]; sessions: Session[] }; emit: () => Emit; settings: () => Settings; setSettings: (s: Settings) => void; timers: number[] }) {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const meterState = params.get('cloudMeter');
  const noData = params.has('cloudNoData');
  const launches: { gameId: string; service: string; surface: string }[] = [];
  if (typeof window !== 'undefined') window.__vystralPreviewCloud = { launches };
  let active: CloudSession | null = null;
  let refreshedAt = new Date(Date.now() - 5 * 3600_000).toISOString();

  if (params.has('cloud')) {
    const plan: GfnPlanId = meterState === 'free' ? 'free' : meterState === 'none' ? 'none' : 'performance';
    // The cycle started 20 days ago, so the fictional month always has room for its sessions.
    const cycle = new Date(Date.now() - 20 * 86400_000);
    cycle.setHours(0, 0, 0, 0);
    ctx.setSettings({ ...ctx.settings(), 'cloud.enabled': true, 'cloud.gfnPlan': plan, 'cloud.resetDay': cycle.getDate() });
    // Fictional cloud sessions this month, sized for the requested meter state.
    const hours = meterState === 'reached' ? 101 : meterState === 'near' ? 86 : 38;
    const gfnGames = ctx.lib.games.filter((g) => CATALOG[g.title]?.some((e) => e.service === 'gfn'));
    const span = Math.max(1, Date.now() - cycle.getTime() - 3600_000);
    const count = Math.max(2, Math.ceil(hours / 6));
    for (let i = 0; i < count && gfnGames.length; i++) {
      const g = gfnGames[i % gfnGames.length];
      const dur = Math.round((hours * 3600) / count);
      const start = cycle.getTime() + Math.floor((span * i) / count);
      ctx.lib.sessions.push({ id: `c10d${String(i).padStart(28, '0')}`, gameId: g.id, installationId: null, start: new Date(start).toISOString(),
        end: new Date(start + dur * 1000).toISOString(), durationSeconds: dur, source: 'cloud-gfn', perfSummary: null });
    }
    const xg = ctx.lib.games.find((g) => g.title === 'Circuit Apex');
    if (xg) {
      const start = Date.now() - 2 * 86400_000;
      ctx.lib.sessions.push({ id: `c10e${'0'.repeat(28)}`, gameId: xg.id, installationId: null, start: new Date(start).toISOString(),
        end: new Date(start + 5400_000).toISOString(), durationSeconds: 5400, source: 'cloud-xbox', perfSummary: null });
    }
  }

  const s = () => ctx.settings();
  const on = (service: CloudService) => s()['cloud.enabled'] && s()[service === 'gfn' ? 'cloud.gfn' : 'cloud.xbox'];
  const market = () => (/^[A-Z]{2}$/.test(s()['cloud.market']) ? s()['cloud.market'] : 'GB');
  const entriesFor = (g: Game) => (noData ? [] : (CATALOG[g.title] ?? []).filter((e) => on(e.service)));

  const map = (): CloudMap => {
    if (!s()['cloud.enabled']) return {};
    const out: CloudMap = {};
    for (const g of ctx.lib.games) {
      const list = entriesFor(g).map<CloudBadge>((e) => ({ service: e.service, playType: e.playType, premium: e.premium, match: e.match }));
      if (list.length) out[g.id] = list;
    }
    return out;
  };

  const surfaceFor = (service: CloudService): CloudOption['surface'] =>
    service === 'gfn' ? 'gfnApp' : s()['cloud.browser'] === 'default' ? 'browser' : 'edge';
  const surfaceLabel = (surface: CloudOption['surface']) =>
    ({ gfnApp: 'GeForce NOW app', xboxApp: 'Xbox app', edge: 'a separate Microsoft Edge window', browser: 'your browser' })[surface];

  const option = (e: Entry): CloudOption => {
    const surface = surfaceFor(e.service);
    const store = STORE_NAME[e.store] ?? 'store';
    const likely = e.match === 'title';
    let note: string | null = e.playType === 'install' ? 'GeForce NOW installs it on its rig the first time, which can take a while.' : null;
    if (likely) note = `${note ? `${note} ` : ''}Likely match by title: the vendor’s page shows the final answer.`;
    return {
      service: e.service, serviceName: e.service === 'gfn' ? 'GeForce NOW' : 'Xbox Cloud Gaming', entryTitle: e.title, playType: e.playType, premium: e.premium,
      match: e.match, matchStore: e.store, surface, surfaceLabel: surfaceLabel(surface),
      headline: e.service === 'gfn' ? (e.playType === 'install' ? 'GeForce NOW · Install-to-Play (Performance/Ultimate)' : 'GeForce NOW · Ready to play') : 'Cloud playable · may be included with Game Pass',
      requirement: e.service === 'gfn'
        ? e.playType === 'install' || e.premium ? `Needs a Performance or Ultimate membership and your ${store} copy.` : `Works with a free or paid membership and your ${store} copy.`
        : e.store === 'xbox' && !likely
          ? 'Streams with Game Pass Essential, Premium or Ultimate, or if you own it and it’s on Xbox’s stream-your-own-game list.'
          : 'Streams with Game Pass Essential, Premium or Ultimate. Your copy from another store doesn’t count; xbox.com shows the final answer.',
      note,
    };
  };

  const meter = (): CloudMeter => {
    const planId = s()['cloud.gfnPlan'];
    const plan = PLAN[planId] ?? PLAN.none;
    const resetDay = Math.min(31, Math.max(1, Math.round(s()['cloud.resetDay'] || 1)));
    const now = new Date();
    const dim = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
    let cycle = new Date(now.getFullYear(), now.getMonth(), Math.min(resetDay, dim(now.getFullYear(), now.getMonth())));
    if (cycle > now) cycle = new Date(now.getFullYear(), now.getMonth() - 1, Math.min(resetDay, dim(now.getFullYear(), now.getMonth() - 1)));
    const next = new Date(cycle.getFullYear(), cycle.getMonth() + 1, Math.min(resetDay, dim(cycle.getFullYear(), cycle.getMonth() + 1)));
    const inCycle = (src: string) => ctx.lib.sessions.filter((x) => x.source === src && x.end && Date.parse(x.end) > cycle.getTime());
    const secs = (src: string) => inCycle(src).reduce((a, x) => a + Math.min(x.durationSeconds, (Date.parse(x.end!) - Math.max(Date.parse(x.start), cycle.getTime())) / 1000), 0);
    const runningGfn = active?.service === 'gfn' && active.state === 'running' && active.start ? (Date.now() - Date.parse(active.start)) / 1000 : 0;
    const used = Math.round(secs('cloud-gfn') + runningGfn);
    const limit = plan.monthly ? plan.monthly * 3600 : null;
    const fraction = limit ? Math.min(1, used / limit) : null;
    const level = fraction == null ? 'none' : fraction >= 1 ? 'reached' : fraction >= 0.8 ? 'near' : 'ok';
    const sessionLimit = plan.session ? plan.session * 3600 : null;
    const sessionLeft = sessionLimit && runningGfn ? Math.max(0, sessionLimit - runningGfn) : null;
    return {
      plan: planId, planLabel: plan.label, cycleStart: cycle.toISOString(), nextReset: next.toISOString(), usedSeconds: used, limitSeconds: limit,
      leftSeconds: limit != null ? Math.max(0, limit - used) : null, fraction, level, rolloverHours: plan.rollover, sessionLimitSeconds: sessionLimit,
      sessionLeftSeconds: sessionLeft, sessionLevel: sessionLeft == null ? 'none' : sessionLeft === 0 ? 'reached' : sessionLeft <= 900 ? 'near' : 'ok',
      sessions: inCycle('cloud-gfn').length, xboxSeconds: Math.round(secs('cloud-xbox')), xboxSessions: inCycle('cloud-xbox').length, resetDay,
      planNote: plan.note, asOf: '2026-10-05',
    };
  };

  const counts = (service: CloudService) => ({ count: noData ? 0 : service === 'gfn' ? 6097 : 561, matched: Object.values(map()).filter((l) => l.some((b) => b.service === service)).length });
  const status = (): CloudStatus => ({
    enabled: s()['cloud.enabled'], localOnly: s()['privacy.localOnly'], dataSaver: s()['dataSaver.enabled'], market: market(),
    marketSource: /^[A-Z]{2}$/.test(s()['cloud.market']) ? 'setting' : 'windows', browser: s()['cloud.browser'],
    services: (['gfn', 'xbox'] as CloudService[]).map((service) => ({
      service, name: service === 'gfn' ? 'GeForce NOW' : 'Xbox Cloud Gaming', enabled: !!on(service), ...counts(service),
      refreshedAt: noData ? null : refreshedAt, nextRefreshAt: noData ? null : new Date(Date.parse(refreshedAt) + 86400_000).toISOString(),
      state: !on(service) ? 'off' : s()['privacy.localOnly'] ? 'offline' : noData ? 'never' : 'ok', error: null,
    })),
    apps: { gfnApp: true, xboxApp: false, edge: true }, active, meter: meter(), refreshing: false,
  });

  const emitStatus = () => ctx.emit()('cloud.changed', status());

  return {
    'cloud.status': () => status(),
    'cloud.map': () => map(),
    'cloud.forGame': (p: { gameId: string }): CloudGame => {
      const g = ctx.lib.games.find((x) => x.id === p.gameId);
      if (!s()['cloud.enabled']) return { gameId: p.gameId, enabled: false, reason: 'off', options: [], active: null, meter: null };
      const options = g ? entriesFor(g).map(option) : [];
      return { gameId: p.gameId, enabled: true, reason: options.length ? null : noData ? 'noData' : 'none', options, active: active?.gameId === p.gameId ? active : null, meter: meter() };
    },
    'cloud.refresh': () => {
      if (!s()['cloud.enabled']) throw new BridgeError('disabled', 'Cloud play is off. Turn it on in Settings → Cloud play.');
      if (s()['privacy.localOnly']) throw new BridgeError('offline', 'Offline mode is on, so VYSTRAL doesn’t download cloud catalogues. Turn it off in Settings → Privacy.');
      refreshedAt = new Date().toISOString();
      emitStatus();
      return status();
    },
    'cloud.launch': (p: { gameId: string; service: CloudService }): CloudLaunchResult => {
      const g = ctx.lib.games.find((x) => x.id === p.gameId);
      const e = g ? entriesFor(g).find((x) => x.service === p.service) : undefined;
      if (!g || !e) throw new BridgeError('notFound', 'This game isn’t listed for that service in your region.');
      const surface = surfaceFor(p.service);
      launches.push({ gameId: g.id, service: p.service, surface });
      const sessionLimit = p.service === 'gfn' && PLAN[s()['cloud.gfnPlan']]?.session ? PLAN[s()['cloud.gfnPlan']].session! * 3600 : null;
      active = {
        gameId: g.id, title: g.title, service: p.service, surface, state: surface === 'gfnApp' ? 'waiting' : 'running',
        start: surface === 'gfnApp' ? null : new Date().toISOString(), seconds: 0, manual: surface === 'browser',
        sessionLimitSeconds: sessionLimit, sessionLeftSeconds: sessionLimit, sessionLevel: sessionLimit ? 'ok' : 'none',
      };
      ctx.emit()('cloud.session', active);
      if (surface === 'gfnApp') {
        // The fictional stream starts after a short "queue".
        ctx.timers.push(window.setTimeout(() => {
          if (active?.gameId !== g.id) return;
          active = { ...active, state: 'running', start: new Date().toISOString() };
          ctx.emit()('cloud.session', active);
        }, 1500));
      }
      const where = surfaceLabel(surface);
      return {
        service: p.service, surface, surfaceLabel: where,
        message: surface === 'gfnApp' ? `Starting ${g.title} in the GeForce NOW app.` : surface === 'edge' ? `Opening ${g.title} in ${where}. VYSTRAL never reads it.`
          : `Opening ${g.title} in your browser. VYSTRAL can’t see browser tabs, so press “I’m done” when you finish.`,
      };
    },
    'cloud.session': () => active,
    'cloud.endSession': () => {
      if (!active) return false;
      const a = active;
      active = null;
      const saved = a.state === 'running';
      if (saved) {
        const dur = 52 * 60; // fictional
        const end = Date.now();
        ctx.lib.sessions.push({ id: Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), gameId: a.gameId, installationId: null,
          start: new Date(end - dur * 1000).toISOString(), end: new Date(end).toISOString(), durationSeconds: dur, source: a.service === 'gfn' ? 'cloud-gfn' : 'cloud-xbox', perfSummary: null });
      }
      ctx.emit()('cloud.session', { ended: true, gameId: a.gameId, service: a.service, seconds: saved ? 52 * 60 : 0, saved });
      return true;
    },
    'cloud.meter': () => meter(),
    'cloud.serviceStatus': (): CloudServiceHealth => ({
      service: 'gfn', indicator: 'none', description: 'All Systems Operational', components: 111, degraded: 0, incidents: [], checkedAt: new Date().toISOString(), error: null,
    }),
    'cloud.openLink': () => true,
  };
}
