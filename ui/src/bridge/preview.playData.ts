/**
 * Track Y preview data (fictional, browser preview only): hardware history per session, the energy
 * estimate, controller battery history and a richer recent cadence for the completion forecast.
 *
 * URL switches: `?energy` turns the energy estimate on; `?pace` adds a few recent sessions to games with
 * a time-to-beat estimate (use with `?ttb`) so the completion forecast has a pace; `?lowBattery` makes the
 * pre-flight controller row warn; `?nopads` shows no controller battery history.
 */
import type {
  BatteryHistory, ControllerBattery, EnergyMethod, EnergyReport, Game, HardwareChange, HardwareHistory, HardwareSession, HardwareSpan,
  PreflightResult, Session, Settings, TimeToBeatMap,
} from './types';

export const PLAY_DATA_DEFAULT_SETTINGS: Pick<Settings, 'controller.batteryHistory' | 'energy.enabled' | 'energy.watts' | 'energy.price' | 'energy.currency'> = {
  'controller.batteryHistory': true,
  'energy.enabled': false,
  'energy.watts': 0,
  'energy.price': 0,
  'energy.currency': '',
};

const DAY = 86_400_000;
const GPU = 'NVIDIA GeForce RTX 4060 Laptop GPU';
const CPU = '13th Gen Intel(R) Core(TM) i7-13700H';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The same fictional driver history the Track F driver card uses (566.36 → 572.16 → 576.02). */
function driverAt(ms: number, now: number): string {
  const age = (now - ms) / DAY;
  return age > 120 ? '566.36' : age > 26 ? '572.16' : '576.02';
}

function hardwareFor(s: Session, now: number): HardwareSession {
  const start = Date.parse(s.start);
  const h = hash(s.id);
  const age = (now - start) / DAY;
  const unknown = h % 11 === 0; // like real history: some sessions predate recording or had metrics off
  const newScreen = age <= 75;
  return {
    sessionId: s.id, gameId: s.gameId, start: s.start, durationSeconds: s.durationSeconds,
    driver: unknown ? null : driverAt(start, now), gpuName: unknown ? null : GPU,
    width: unknown ? null : newScreen ? 2560 : 1920, height: unknown ? null : newScreen ? 1440 : 1080,
    refreshHz: unknown ? null : newScreen ? 165 : 144, hdr: unknown ? null : age <= 40,
  };
}

/** Mirrors HardwareHistory.Build (Core/Insights/PlayData.cs). */
export function buildHardwareHistory(rows: HardwareSession[]): HardwareHistory {
  const sorted = [...rows].sort((a, b) => a.start.localeCompare(b.start));
  const changes: HardwareChange[] = [];
  const spans: HardwareSpan[] = [];
  const mode = (r: HardwareSession) => (r.width && r.height ? `${r.width} × ${r.height}${r.refreshHz ? ` · ${r.refreshHz} Hz` : ''}` : r.refreshHz ? `${r.refreshHz} Hz` : null);
  let driver: string | null = null;
  let gpu: string | null = null;
  let display: string | null = null;
  let hdr: boolean | null = null;
  let d: HardwareSpan | null = null;
  let m: HardwareSpan | null = null;
  for (const r of sorted) {
    if (r.driver) {
      if (driver && driver !== r.driver) {
        changes.push({ kind: 'driver', at: r.start, sessionId: r.sessionId, from: driver, to: r.driver });
        if (d) spans.push(d);
        d = null;
      }
      driver = r.driver;
      const open = d as HardwareSpan | null;
      d = open ? { ...open, to: r.start, sessions: open.sessions + 1 } : { lane: 'driver', value: r.driver, from: r.start, to: r.start, sessions: 1 };
    }
    if (r.gpuName) {
      if (gpu && gpu !== r.gpuName) changes.push({ kind: 'gpu', at: r.start, sessionId: r.sessionId, from: gpu, to: r.gpuName });
      gpu = r.gpuName;
    }
    const md = mode(r);
    if (md) {
      if (display && display !== md) {
        changes.push({ kind: 'display', at: r.start, sessionId: r.sessionId, from: display, to: md });
        if (m) spans.push(m);
        m = null;
      }
      display = md;
      const open = m as HardwareSpan | null;
      m = open ? { ...open, to: r.start, sessions: open.sessions + 1 } : { lane: 'display', value: md, from: r.start, to: r.start, sessions: 1 };
    }
    if (r.hdr != null) {
      if (hdr != null && hdr !== r.hdr) changes.push({ kind: 'hdr', at: r.start, sessionId: r.sessionId, from: hdr ? 'HDR on' : 'HDR off', to: r.hdr ? 'HDR on' : 'HDR off' });
      hdr = r.hdr;
    }
  }
  if (d) spans.push(d);
  if (m) spans.push(m);
  return { sessions: sorted, changes, spans, withDriver: sorted.filter((r) => r.driver).length, withDisplay: sorted.filter((r) => mode(r)).length };
}

/** Mirrors EnergyModel (laptop: 15 W base, RTX 4060 Laptop 100 W, i7-13700H 45 W). */
function energyReport(sessions: Session[], settings: Settings, gameId: string | null): EnergyReport {
  if (!settings['energy.enabled']) return { enabled: false, method: null, price: null, currency: null, totalKWh: 0, sessions: 0, excluded: 0, partial: 0, sessionList: [], games: [], months: [] };
  const manual = settings['energy.watts'] > 0 ? settings['energy.watts'] : null;
  const method: EnergyMethod = {
    source: manual ? 'manual' : 'typical', gpuName: GPU, gpuClass: 'laptop', gpuWatts: 100, gpuKnown: true, cpuName: CPU, cpuWatts: 45, cpuKnown: true,
    baseWatts: 15, laptop: true, manualWatts: manual, typicalLoad: 0.6,
  };
  const watts = (g: number, c: number) => (manual ? manual * (0.3 + 0.7 * (0.75 * g + 0.25 * c)) : 15 + 100 * (0.2 + 0.8 * g) + 45 * (0.25 + 0.75 * c));
  const list = sessions.filter((s) => s.end && (!gameId || s.gameId === gameId)).sort((a, b) => b.start.localeCompare(a.start));
  const out: EnergyReport = {
    enabled: true, method, price: settings['energy.price'] > 0 ? settings['energy.price'] : null, currency: settings['energy.currency'] || null,
    totalKWh: 0, sessions: 0, excluded: 0, partial: 0, sessionList: [], games: [], months: [],
  };
  const games = new Map<string, { kWh: number; sessions: number; hours: number }>();
  const months = new Map<string, { kWh: number; sessions: number; hours: number }>();
  for (const s of list) {
    let perf: { gpuAvg?: number; cpuAvg?: number } | null = null;
    try { perf = s.perfSummary ? JSON.parse(s.perfSummary) : null; } catch { perf = null; }
    if (!perf || (perf.gpuAvg == null && perf.cpuAvg == null) || s.durationSeconds <= 0) {
      if (s.durationSeconds > 0) out.excluded++;
      continue;
    }
    const partial = perf.gpuAvg == null || perf.cpuAvg == null;
    const w = watts((perf.gpuAvg ?? 60) / 100, (perf.cpuAvg ?? 60) / 100);
    const kWh = (w * s.durationSeconds) / 3600 / 1000;
    const hours = s.durationSeconds / 3600;
    if (partial) out.partial++;
    out.sessionList.push({ sessionId: s.id, gameId: s.gameId, start: s.start, durationSeconds: s.durationSeconds, kWh: Math.round(kWh * 1e4) / 1e4, avgWatts: Math.round(w), partial });
    const g = games.get(s.gameId) ?? { kWh: 0, sessions: 0, hours: 0 };
    games.set(s.gameId, { kWh: g.kWh + kWh, sessions: g.sessions + 1, hours: g.hours + hours });
    const d = new Date(Date.parse(s.start));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const m = months.get(key) ?? { kWh: 0, sessions: 0, hours: 0 };
    months.set(key, { kWh: m.kWh + kWh, sessions: m.sessions + 1, hours: m.hours + hours });
    out.totalKWh += kWh;
    out.sessions++;
  }
  out.totalKWh = Math.round(out.totalKWh * 1e4) / 1e4;
  out.games = [...games.entries()].map(([id, v]) => ({ gameId: id, ...v, kWh: Math.round(v.kWh * 1e4) / 1e4 })).sort((a, b) => b.kWh - a.kWh);
  out.months = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, v]) => ({ month, ...v, kWh: Math.round(v.kWh * 1e4) / 1e4 }));
  return out;
}

/** A week of one wireless pad: evenings of play (~6 points an hour), charging some nights. */
function previewPads(now: number, days: number, low: boolean): ControllerBattery[] {
  const points: { at: string; percent: number; charging: boolean }[] = [];
  let pct = 92;
  const start = now - days * DAY;
  for (let t = start; t <= now; t += 20 * 60_000) {
    const d = new Date(t);
    const h = d.getHours();
    const day = Math.floor((t - start) / DAY);
    const playing = h >= 19 && h < 23;
    const chargeNight = day % 3 === 2 && h >= 1 && h < 4;
    if (chargeNight) pct = Math.min(100, pct + 12);
    else if (playing) pct = Math.max(low ? 14 : 22, pct - 2);
    else continue; // the pad is off: no readings, like the real sampler
    points.push({ at: d.toISOString(), percent: Math.round(pct), charging: chargeNight });
  }
  if (low) points.push({ at: new Date(now - 5 * 60_000).toISOString(), percent: 14, charging: false });
  const last = points[points.length - 1];
  return [{
    pad: 'preview-pad-1', name: 'Xbox Wireless Controller', points, latest: last?.percent ?? null, charging: last?.charging ?? null, lastSeen: last?.at ?? null,
    drainPerHour: 6, minutesLeft: last && !last.charging ? Math.round((last.percent / 6) * 60) : null,
  }];
}

export function playDataPreviewHandlers(ctx: { lib: { games: Game[]; sessions: Session[] }; settings: () => Settings }) {
  const params = new URLSearchParams(location.search);
  let cleared = params.has('nopads');
  return {
    'insights.hardwareHistory': (p: { gameId?: string | null }) => {
      const now = Date.now();
      const rows = ctx.lib.sessions.filter((s) => s.end && s.perfSummary && (!p?.gameId || s.gameId === p.gameId)).map((s) => hardwareFor(s, now));
      return buildHardwareHistory(rows);
    },
    'energy.report': (p: { gameId?: string | null }) => energyReport(ctx.lib.sessions, ctx.settings(), p?.gameId ?? null),
    'controller.batteryHistory': (p: { days?: number }): BatteryHistory => {
      const days = Math.min(90, Math.max(1, p?.days ?? 7));
      return { enabled: ctx.settings()['controller.batteryHistory'], days, pads: cleared ? [] : previewPads(Date.now(), days, params.has('lowBattery')) };
    },
    'controller.clearBatteryHistory': (): BatteryHistory => {
      cleared = true;
      return { enabled: ctx.settings()['controller.batteryHistory'], days: 7, pads: [] };
    },
    /** `?lowBattery`: the pre-flight controller row warns, with the usual-drain estimate. */
    __decoratePreflight: (r: PreflightResult | null): PreflightResult | null => {
      if (!r || !params.has('lowBattery')) return r;
      return {
        ...r,
        checks: r.checks.map((c) => c.id !== 'controller' ? c : {
          ...c, status: 'warn', value: 'Xbox Wireless Controller · 14% battery',
          detail: 'Xbox Wireless Controller is low on battery: about 2 h 20 min left at your usual rate. Charge it or swap the batteries before a long session.',
        }),
      };
    },
  };
}

/**
 * `?pace` (with `?ttb`): a steady recent cadence on up to three games that have a time-to-beat estimate
 * and are well short of it, so the completion forecast has something honest to say.
 */
export function decoratePace(lib: { games: Game[]; sessions: Session[] }, ttb: TimeToBeatMap): void {
  const now = Date.now();
  const store = (g: Game) => Math.max(0, ...g.installations.map((i) => i.importedPlaytimeMinutes ?? 0)) * 60;
  const picks = lib.games.filter((g) => {
    const t = ttb.games[g.id]?.main;
    return t != null && Math.max(g.trackedSeconds, store(g)) < t * 0.3;
  }).slice(0, 3);
  picks.forEach((g, k) => {
    const sessions = 5 + k * 2;
    // Leave room to finish: the added play stays under half of what's left of the estimate.
    const room = (ttb.games[g.id].main! - Math.max(g.trackedSeconds, store(g))) * 0.5;
    const each = Math.min(1.6 * 3600, room / sessions);
    let added = 0;
    for (let i = 0; i < sessions; i++) {
      const dur = Math.round(each * (0.75 + (hash(`${g.id}${i}`) % 50) / 100));
      const start = now - (1 + i * (k + 2)) * DAY - (hash(g.id + i) % 5) * 3600_000 - 2 * 3600_000;
      lib.sessions.push({
        id: `pace${k}${i}${g.id.slice(0, 20)}`, gameId: g.id, installationId: g.installations[0]?.id ?? null, start: new Date(start).toISOString(),
        end: new Date(start + dur * 1000).toISOString(), durationSeconds: dur, source: 'tracked',
        perfSummary: JSON.stringify({ samples: Math.floor(dur / 2), cpuAvg: 32 + k * 4, cpuMax: 70, gpuAvg: 78 + k * 5, gpuMax: 99 }),
      });
      added += dur;
    }
    const i = lib.games.indexOf(g);
    lib.games[i] = { ...g, trackedSeconds: g.trackedSeconds + added, sessionCount: g.sessionCount + sessions, lastTrackedPlay: new Date(now - DAY).toISOString() };
  });
}
