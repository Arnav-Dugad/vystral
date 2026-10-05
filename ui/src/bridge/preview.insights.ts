/**
 * Track B preview data: pre-flight, launch timing, one-click fixes, throttling, FPS capture,
 * the summon shortcut and notifications. Everything here is fictional sample data so the UI
 * can be developed in a browser; the real values come from the native backend.
 */
import type {
  FpsCaptureStatus, HotkeyStatus, InsightSample, LaunchFix, PreflightResult, Session, Settings,
} from './types';
import { BridgeError } from './bridge';
import { validateShortcut } from '../views/settings/hotkey';

type Emit = (name: string, payload: unknown) => void;

export const INSIGHT_DEFAULT_SETTINGS: Pick<Settings,
  'fps.captureEnabled' | 'hotkey.enabled' | 'hotkey.summon' | 'notifications.enabled' | 'notifications.sessions' |
  'notifications.updates' | 'notifications.installs' | 'notifications.thermal' | 'notifications.onlyInBackground'> = {
  'fps.captureEnabled': false,
  'hotkey.enabled': true,
  'hotkey.summon': 'Ctrl+Alt+V',
  'notifications.enabled': true,
  'notifications.sessions': true,
  'notifications.updates': true,
  'notifications.installs': true,
  'notifications.thermal': true,
  'notifications.onlyInBackground': true,
};

/** Learned launch time shown in preview launches. */
export const PREVIEW_EXPECTED_DETECT_MS = 6400;

const THROTTLED = new Set<string>();

/** Adds frame-rate and throttling figures to the three most recent preview sessions. */
export function decoratePreviewSessions(sessions: Session[]): void {
  const recent = sessions.filter((s) => s.perfSummary).sort((a, b) => b.start.localeCompare(a.start)).slice(0, 3);
  recent.forEach((s, i) => {
    const base = JSON.parse(s.perfSummary!) as Record<string, unknown>;
    const throttled = i === 0;
    if (throttled) THROTTLED.add(s.id);
    Object.assign(base, {
      fpsStatus: 'Measured with Intel PresentMon 2.6.0. Frame time is the time between the game’s presented frames.',
      fpsAvg: 118.4 - i * 9, fps1Low: 71.2 - i * 6, fps01Low: 48.9 - i * 5, frameTimeP50Ms: 8.3 + i, frameTimeP99Ms: 15.6 + i * 2,
      stutterCount: 14 + i * 9, frameCount: 640_000 - i * 50_000,
      frameTimeHistogram: [1200, 9800, 120400, 260100, 141000, 52000, 31000, 14200, 6100, 2900, 900, 160, 40],
      fpsSource: 'Intel PresentMon 2.6.0',
      throttledSeconds: throttled ? 252 : 0, powerLimitedSeconds: throttled ? 610 : 120,
      throttleReasons: throttled ? ['thermal', 'power'] : ['power'], peakTempC: throttled ? 87 : 74, gpuClockAvgMhz: throttled ? 1710 : 2040,
      thermalNote: throttled
        ? 'Your GPU got hot and slowed down for 4m 12s — check airflow, a laptop stand, or a lower power profile in your laptop’s performance app (for example Armoury Crate).'
        : null,
    });
    s.perfSummary = JSON.stringify(base);
  });
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

/** Per-sample extras matching the 240 preview samples (2 s apart). */
export function previewInsightSamples(sessionId: string, withFps: boolean): InsightSample[] {
  const r = rng(sessionId.length * 97 + sessionId.charCodeAt(0));
  const throttled = THROTTLED.has(sessionId) || sessionId === 'preview';
  return Array.from({ length: 240 }, (_, i) => {
    const hot = throttled && i >= 110 && i < 236;
    const dip = i % 47 === 13;
    const fps = withFps ? Math.max(30, (hot ? 96 : 122) + (r() - 0.5) * 18 - (dip ? 40 : 0)) : null;
    return {
      t: i * 2000,
      gpuClockMhz: hot ? 1650 + r() * 90 : 2010 + r() * 70,
      throttleFlags: hot ? 1 | 4 : r() > 0.8 ? 4 : 0,
      fps,
      frameTimeMs: fps ? 1000 / fps : null,
      frameTimeP99Ms: fps ? (1000 / fps) * (1.6 + r() * 0.6) : null,
    };
  });
}

export function previewPreflight(ticket: string, platform: string): PreflightResult {
  return {
    ticket,
    checks: [
      { id: 'disk', label: 'Free space on D:', status: 'ok', value: '354 GB free', detail: null },
      ...(platform === 'steam'
        ? [{ id: 'steamUpdate', label: 'Steam updates', status: 'warn' as const, value: 'Update pending', detail: 'Steam may update before the game starts. About 1.2 GB still needs to download.' }]
        : []),
      { id: 'controller', label: 'Controller', status: 'ok', value: 'Xbox Wireless Controller · 64% battery', detail: null },
      { id: 'display', label: 'Display', status: 'ok', value: '165 Hz · HDR on', detail: null },
      {
        id: 'launchers', label: 'Other store apps', status: 'info', value: '2 running · 640 MB',
        detail: 'EA app, Epic Games are running in the background and using 640 MB of memory. VYSTRAL never closes them; close them yourself if the game needs the memory.',
      },
    ],
  };
}

export const PREVIEW_FAILED_ACTIONS: LaunchFix[] = [
  { id: 'rescanPlatform', label: 'Rescan Steam', platform: 'steam' },
  { id: 'openStore', label: 'Open in Steam', platform: 'steam' },
];

export function insightPreviewHandlers(ctx: { emit: () => Emit; settings: () => Settings; setSettings: (s: Settings) => void; timers: number[]; withFps: (sessionId: string) => boolean }) {
  let installed = false;
  let permission: FpsCaptureStatus['permission'] = 'missing';
  let lastPreflight: PreflightResult | null = null;
  const hotkeyError: string | null = null;

  const fps = (): FpsCaptureStatus => {
    const s = ctx.settings();
    return {
      enabled: s['fps.captureEnabled'], installed, installing: false, version: '2.6.0', fileName: 'PresentMon-2.6.0-x64.exe', sizeBytes: 980_320,
      sha256: 'b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af',
      sourceUrl: 'https://github.com/GameTechDev/PresentMon/releases/download/v2.6.0/PresentMon-2.6.0-x64.exe',
      releasePage: 'https://github.com/GameTechDev/PresentMon/releases/tag/v2.6.0',
      licenseUrl: 'https://github.com/GameTechDev/PresentMon/blob/main/LICENSE.txt',
      installPath: '(preview)\\tools\\PresentMon-2.6.0-x64.exe', permission, groupName: 'Performance Log Users', account: 'PREVIEW\\player',
      ready: s['fps.captureEnabled'] && installed && permission === 'granted', localOnly: s['privacy.localOnly'],
    };
  };
  const hotkey = (): HotkeyStatus => {
    const s = ctx.settings();
    return { shortcut: s['hotkey.summon'], enabled: s['hotkey.enabled'], registered: s['hotkey.enabled'], error: hotkeyError, available: true };
  };
  const set = (patch: Partial<Settings>) => {
    const next = { ...ctx.settings(), ...patch };
    ctx.setSettings(next);
    ctx.emit()('settings.changed', next);
  };

  return {
    'sessions.insightSamples': (p: { sessionId: string }) => previewInsightSamples(p.sessionId, ctx.withFps(p.sessionId)),
    'launch.preflightResult': (p: { ticket: string }) => (lastPreflight?.ticket === p.ticket ? lastPreflight : null),
    'launch.fix': (p: { ticket: string; actionId: string }) => {
      if (!PREVIEW_FAILED_ACTIONS.some((a) => a.id === p.actionId)) throw new BridgeError('forbidden', 'That fix isn’t available for this launch.');
      return { ok: true, message: p.actionId === 'rescanPlatform' ? 'Rescanned Steam.' : 'Opened Steam.' };
    },
    /** Called by the preview game.launch to simulate the backend's pre-flight event. */
    __preflight: (p: { ticket: string; platform: string }) => {
      lastPreflight = previewPreflight(p.ticket, p.platform);
      ctx.timers.push(window.setTimeout(() => ctx.emit()('launch.preflight', lastPreflight), 260));
      return true;
    },
    'fps.status': fps,
    'fps.install': async () => {
      if (ctx.settings()['privacy.localOnly']) throw new BridgeError('forbidden', 'Local-only mode is on, so VYSTRAL won’t download PresentMon.');
      for (const progress of [0, 0.35, 0.7, 1]) {
        ctx.emit()('fps.install', { phase: 'downloading', progress });
        await new Promise((r) => setTimeout(r, 220));
      }
      installed = true;
      ctx.emit()('fps.install', { phase: 'installed', progress: 1 });
      return fps();
    },
    'fps.remove': () => {
      installed = false;
      set({ 'fps.captureEnabled': false });
      return fps();
    },
    'fps.grantPermission': () => {
      permission = 'signOutRequired';
      return { status: 'added', signOutRequired: true, fps: fps() };
    },
    'hotkey.status': hotkey,
    'hotkey.set': (p: { shortcut: string }) => {
      const v = validateShortcut(p.shortcut);
      if (!v.ok) throw new BridgeError('invalid', v.error);
      if (v.shortcut === 'Win+G' || v.shortcut === 'Win+V') throw new BridgeError('conflict', `${v.shortcut} is already used by another app or by Windows. Try a different shortcut.`);
      set({ 'hotkey.summon': v.shortcut, 'hotkey.enabled': true });
      return hotkey();
    },
    'notifications.status': () => ({ available: true }),
    'notifications.test': () => ({ shown: true }),
  } satisfies Record<string, (p: never) => unknown>;
}
