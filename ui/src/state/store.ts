import { create } from 'zustand';
import { call, errorMessage, isNative, on } from '../bridge/bridge';
import type {
  AdapterInfo, AppInfo, DriveInfo, Game, LaunchState, LibrarySnapshot, SettingKey, Settings, UpdateState, WindowState,
} from '../bridge/types';

export type Route =
  | { name: 'home' }
  | { name: 'library'; collectionId?: string; query?: string }
  | { name: 'game'; id: string }
  | { name: 'journal' }
  | { name: 'performance'; sessionId?: string }
  | { name: 'moments' }
  | { name: 'constellation' }
  | { name: 'assistant' }
  | { name: 'settings'; section?: string };

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
  sticky?: boolean;
}

export interface ScanStatus {
  running: boolean;
  platforms: Record<string, number | null>;
  last?: { added: number; updated: number; markedMissing: number; failures: { platform: string; error: string }[] };
}

interface State {
  ready: boolean;
  native: boolean;
  info: AppInfo | null;
  settings: Settings | null;
  window: WindowState;
  library: LibrarySnapshot;
  gamesById: Map<string, Game>;
  libraryLoaded: boolean;
  adapters: AdapterInfo[];
  drives: DriveInfo[];
  scan: ScanStatus;
  launch: LaunchState | null;
  update: UpdateState | null;
  route: Route;
  back: Route[];
  forward: Route[];
  commandOpen: boolean;
  focusGameId: string | null;
  systemReducedMotion: boolean;
  toasts: Toast[];
  fatal: string | null;

  init(): Promise<void>;
  refreshLibrary(): Promise<void>;
  refreshAdapters(): Promise<void>;
  scanLibrary(): Promise<void>;
  navigate(route: Route, opts?: { replace?: boolean }): void;
  goBack(): void;
  goForward(): void;
  setSetting<K extends SettingKey>(key: K, value: Settings[K]): Promise<void>;
  setCommandOpen(open: boolean): void;
  setFocusGame(id: string | null): void;
  launchGame(gameId: string, installationId?: string | null): Promise<void>;
  patchGame(id: string, patch: Partial<Game>): void;
  toast(t: Omit<Toast, 'id'>): number;
  dismissToast(id: number): void;
  setMode(mode: 'desktop' | 'immersive'): Promise<void>;
}

const EMPTY_LIBRARY: LibrarySnapshot = { games: [], collections: [], duplicateSuggestions: [], lastScan: null };
let toastSeq = 0;
let refreshTimer: number | undefined;

const indexGames = (lib: LibrarySnapshot) => new Map(lib.games.map((g) => [g.id, g]));
const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

export const useStore = create<State>((set, get) => ({
  ready: false,
  native: isNative,
  info: null,
  settings: null,
  window: { mode: 'desktop', maximized: false, fullscreen: false, captionInsetRight: 138, scale: 1 },
  library: EMPTY_LIBRARY,
  gamesById: new Map(),
  libraryLoaded: false,
  adapters: [],
  drives: [],
  scan: { running: false, platforms: {} },
  launch: null,
  update: null,
  route: { name: 'home' },
  back: [],
  forward: [],
  commandOpen: false,
  focusGameId: null,
  systemReducedMotion: typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  toasts: [],
  fatal: null,

  async init() {
    subscribeEvents(set, get);
    try {
      const info = await call<AppInfo>('app.info');
      set({ info, settings: info.settings, window: info.window, launch: info.launch, update: info.update });
      if (info.window.mode === 'immersive') document.documentElement.dataset.mode = 'immersive';
      const lastRoute = readLastRoute();
      if (lastRoute) set({ route: lastRoute });
    } catch (err) {
      set({ fatal: errorMessage(err) });
      return;
    }
    // Library and drives load in parallel; the shell is interactive immediately.
    await Promise.allSettled([get().refreshLibrary(), get().refreshAdapters(), call<DriveInfo[]>('system.drives').then((drives) => set({ drives }))]);
    set({ ready: true });
    void call('app.ready');
    const info = get().info!;
    if (info.startupProblem) get().toast({ tone: 'warning', title: 'Library database was reset', body: info.startupProblem, sticky: true });
    if (info.previousRunCrashed && !info.safeMode)
      get().toast({
        tone: 'warning',
        title: 'VYSTRAL closed unexpectedly last time',
        body: 'If it happens again, hold Shift while starting VYSTRAL to open it in safe mode.',
      });
    if (info.safeMode) get().toast({ tone: 'info', title: 'Safe mode', body: 'Visual effects, local AI and background downloads are off for this session.', sticky: true });
  },

  async refreshLibrary() {
    try {
      const library = await call<LibrarySnapshot>('library.get');
      set({ library, gamesById: indexGames(library), libraryLoaded: true });
    } catch (err) {
      set({ libraryLoaded: true });
      get().toast({ tone: 'danger', title: 'Couldn’t load your library', body: errorMessage(err) });
    }
  },

  async refreshAdapters() {
    try {
      set({ adapters: await call<AdapterInfo[]>('library.adapters') });
    } catch {
      // Adapter status is informational; the library still works.
    }
  },

  async scanLibrary() {
    if (get().scan.running) return;
    try {
      await call('library.scan', undefined, 120_000);
    } catch (err) {
      get().toast({ tone: 'danger', title: 'Scan didn’t finish', body: errorMessage(err) });
    }
  },

  navigate(route, opts) {
    const { route: current, back } = get();
    if (sameRoute(current, route)) return;
    set({
      route,
      back: opts?.replace ? back : [...back.slice(-50), current],
      forward: [],
      commandOpen: false,
    });
    saveLastRoute(route);
  },

  goBack() {
    const { back, route, forward } = get();
    const prev = back[back.length - 1];
    if (!prev) return;
    set({ route: prev, back: back.slice(0, -1), forward: [route, ...forward] });
    saveLastRoute(prev);
  },

  goForward() {
    const { back, route, forward } = get();
    const next = forward[0];
    if (!next) return;
    set({ route: next, back: [...back, route], forward: forward.slice(1) });
    saveLastRoute(next);
  },

  async setSetting(key, value) {
    const prev = get().settings;
    if (prev) set({ settings: { ...prev, [key]: value } });
    try {
      const settings = await call<Settings>('settings.set', { key, value });
      set({ settings });
    } catch (err) {
      if (prev) set({ settings: prev });
      get().toast({ tone: 'danger', title: 'Setting not saved', body: errorMessage(err) });
    }
  },

  setCommandOpen(open) {
    set({ commandOpen: open });
  },

  setFocusGame(id) {
    if (get().focusGameId !== id) set({ focusGameId: id });
  },

  async launchGame(gameId, installationId) {
    const current = get().launch;
    if (current && ['starting', 'waiting', 'running'].includes(current.phase)) {
      get().toast({ tone: 'info', title: 'A game is already starting or running', body: current.phase === 'running' ? 'Close it before starting another.' : undefined });
      return;
    }
    try {
      const state = await call<LaunchState>('game.launch', { gameId, installationId: installationId ?? null });
      set({ launch: state });
    } catch (err) {
      get().toast({ tone: 'danger', title: 'Couldn’t start the game', body: errorMessage(err) });
    }
  },

  patchGame(id, patch) {
    const lib = get().library;
    const games = lib.games.map((g) => (g.id === id ? { ...g, ...patch } : g));
    const library = { ...lib, games };
    set({ library, gamesById: indexGames(library) });
  },

  toast(t) {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    if (!t.sticky) window.setTimeout(() => get().dismissToast(id), t.tone === 'danger' ? 9000 : 5200);
    return id;
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  async setMode(mode) {
    try {
      const w = await call<WindowState>('window.setMode', { mode });
      set({ window: w });
    } catch {
      set({ window: { ...get().window, mode } });
    }
    document.documentElement.dataset.mode = mode;
  },
}));

function subscribeEvents(set: (p: Partial<State>) => void, get: () => State) {
  on('library.changed', () => {
    // Coalesce bursts (metadata enrichment emits per batch).
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void get().refreshLibrary(), 250);
  });
  on('library.scan', (e) => {
    const scan = get().scan;
    if (e.phase === 'started') {
      set({ scan: { running: true, platforms: Object.fromEntries((e.platforms ?? []).map((p) => [p, null])) } });
    } else if (e.phase === 'platform' && e.platform) {
      set({ scan: { ...scan, platforms: { ...scan.platforms, [e.platform]: e.count ?? 0 } } });
    } else if (e.phase === 'completed') {
      set({
        scan: {
          running: false,
          platforms: scan.platforms,
          last: { added: e.added ?? 0, updated: e.updated ?? 0, markedMissing: e.markedMissing ?? 0, failures: e.failures ?? [] },
        },
      });
      void get().refreshAdapters();
      for (const f of e.failures ?? []) get().toast({ tone: 'warning', title: 'An integration couldn’t be read', body: f.error });
      if ((e.added ?? 0) > 0) get().toast({ tone: 'success', title: `${e.added} new ${e.added === 1 ? 'game' : 'games'} found` });
    }
  });
  on('settings.changed', (settings) => set({ settings }));
  on('update.state', (update) => {
    const prev = get().update;
    set({ update });
    if (update.phase === 'ready' && prev?.phase !== 'ready')
      get().toast({ tone: 'success', title: `VYSTRAL ${update.newVersion} is ready`, body: 'Restart to finish updating. It also installs automatically when you close VYSTRAL.' });
  });
  on('window.state', (w) => set({ window: w }));
  on('launch.state', (launch) => {
    set({ launch });
    if (launch.phase === 'failed') {
      // The launch overlay shows the details; nothing else to do.
    }
    if (launch.phase === 'ended' && launch.sessionId) void get().refreshLibrary();
  });
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', () => set({ systemReducedMotion: mq.matches }));
}

const ROUTE_KEY = 'vystral.lastRoute';

function saveLastRoute(route: Route) {
  try {
    if (route.name !== 'game') localStorage.setItem(ROUTE_KEY, JSON.stringify(route));
  } catch {
    // storage unavailable — not important
  }
}

function readLastRoute(): Route | null {
  try {
    const raw = localStorage.getItem(ROUTE_KEY);
    return raw ? (JSON.parse(raw) as Route) : null;
  } catch {
    return null;
  }
}

/** Selector helpers. */
export const useSettings = () => useStore((s) => s.settings);
export const useReducedMotion = () =>
  useStore((s) => (s.settings?.['motion.reduce'] === 'on' ? true : s.settings?.['motion.reduce'] === 'off' ? false : s.systemReducedMotion));
export const useGameRunning = () => useStore((s) => s.launch?.phase === 'running');
