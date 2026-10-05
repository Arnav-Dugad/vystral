/**
 * Preview backend used only when the UI runs outside the VYSTRAL app (browser development,
 * automated UI tests). All games here are fictional; the shell shows a "Preview" badge.
 * Pass ?games=5000 to stress-test with a large generated library.
 */
import type {
  AdapterInfo, AppInfo, Game, GameStatus, Installation, LaunchState, LibrarySnapshot, PerfSample, PlatformKey,
  Session, Settings, StatusHistoryEntry, UpdateState, MediaItem,
} from './types';
import { BridgeError } from './bridge';
import { steamPreviewHandlers } from './preview.steam';
import { shellPreviewHandlers } from './preview.shell';
import { controllerPreviewHandlers } from './preview.controller';
import { INSIGHT_DEFAULT_SETTINGS, PREVIEW_EXPECTED_DETECT_MS, PREVIEW_FAILED_ACTIONS, decoratePreviewSessions, insightPreviewHandlers } from './preview.insights';
import { DATA_INSIGHT_DEFAULT_SETTINGS, dataInsightPreviewHandlers } from './preview.dataInsights';
import { TRACKING_DEFAULT_SETTINGS, decorateTrackingSessions, trackingPreviewHandlers } from './preview.tracking';

type Emit = (name: string, payload: unknown) => void;

const DEFAULT_SETTINGS: Settings = {
  'appearance.theme': 'obsidian',
  'appearance.accent': 'auto',
  'appearance.livingCanvas': true,
  'appearance.canvasIntensity': 0.7,
  'appearance.quality': 'auto',
  'appearance.gridSize': 180,
  'motion.reduce': 'system',
  'startup.intro': true,
  'startup.immersive': false,
  'immersive.attract': true,
  'immersive.attractMinutes': 3,
  'launch.cinematic': true,
  'launch.minimizeOnStart': true,
  'launch.restoreOnExit': true,
  'performance.collectMetrics': true,
  'pulse.enabled': false,
  'library.fetchMetadata': true,
  'library.fetchArtwork': true,
  'library.platformsEnabled': {},
  'ai.enabled': false,
  'ai.model': 'qwen3:4b',
  'updates.autoCheck': true,
  'updates.autoDownload': true,
  'controller.enabled': true,
  'controller.vibration': false,
  'sounds.enabled': false,
  'sounds.volume': 0.4,
  'onboarding.completed': false,
  'privacy.localOnly': false,
  'moments.enabled': false,
  'dataSaver.enabled': false,
  'dataSaver.onMetered': true,
  'trailers.autoplay': true,
  'canvas.followTrailer': true,
  'steam.webApi.backgroundAchievements': true,
  ...INSIGHT_DEFAULT_SETTINGS,
  ...DATA_INSIGHT_DEFAULT_SETTINGS,
  ...TRACKING_DEFAULT_SETTINGS,
};

const SAMPLE: [string, string[], PlatformKey[], string, string][] = [
  ['Nebula Drift', ['Racing', 'Sci-fi'], ['steam'], 'Halcyon Forge', 'Anti-gravity racing across collapsing star systems.'],
  ['Ashen Crown', ['RPG', 'Fantasy'], ['steam', 'epic'], 'Ninefold Studio', 'Reclaim a burned kingdom in a sprawling, choice-driven role-playing epic.'],
  ['Hollow Lantern', ['Horror', 'Adventure'], ['gog'], 'Quiet Owl', 'A lighthouse keeper discovers the light keeps something out.'],
  ['Circuit Apex', ['Racing', 'Sports'], ['xbox'], 'Gridline Interactive', 'Precision motorsport with a living season calendar.'],
  ['Starfall Tactics', ['Strategy', 'Space'], ['steam'], 'Meridian Labs', 'Turn-based fleet command where every lost ship is remembered.'],
  ['Moss & Marrow', ['Adventure', 'Indie'], ['epic'], 'Little Lichen', 'A tiny forager crosses an overgrown world.'],
  ['Tidebreaker', ['Action', 'Adventure'], ['steam', 'xbox'], 'Saltworks', 'Raid drowned cities between tides.'],
  ['Last Signal', ['Horror', 'Sci-fi'], ['steam'], 'Coldwave', 'A distress call from a station that was decommissioned decades ago.'],
  ['Iron Meridian', ['Shooter', 'Action'], ['battlenet'], 'Bastion Works', 'Squad-based shooter on a fractured continent.'],
  ['Velvet Orbit', ['Simulation', 'Space'], ['xbox'], 'Gravity Well', 'Build and balance a luxury orbital hotel.'],
  ['Glasswing', ['Platformer', 'Indie'], ['steam'], 'Prism Lane', 'A fragile moth navigates a city of glass.'],
  ['Northbound', ['Survival', 'Open World'], ['steam'], 'Tundra Kin', 'Survive the long walk to the edge of the map.'],
  ['Paper Kingdoms', ['Strategy', 'Casual'], ['ubisoft'], 'Fold Games', 'Origami realms that grow when you look away.'],
  ['Echoes of Vael', ['RPG', 'Fantasy'], ['ea'], 'Thornhill', 'An ancient song wakes the gods of Vael.'],
  ['Redline Rivals', ['Racing'], ['ea'], 'Torque Collective', 'Street racing built around rivalries.'],
  ['Quiet Harbor', ['Puzzle', 'Indie'], ['gog'], 'Low Tide', 'Untangle a fishing town’s secrets, one knot at a time.'],
  ['Overclock Arena', ['Action', 'Multiplayer'], ['steam'], 'Hyperthread', 'Fast arena combat where the stage overheats.'],
  ['Solace Station', ['Simulation', 'Space'], ['steam'], 'Gravity Well', 'Run a medical station at the edge of known space.'],
  ['Grim Tide', ['Horror', 'Action'], ['epic'], 'Coldwave', 'Something rises with the tide.'],
  ['Summit Sixteen', ['Sports'], ['xbox'], 'Peak Line', 'Big-mountain snowboarding with sixteen legendary peaks.'],
  ['Deep Field', ['Space', 'Exploration'], ['steam'], 'Meridian Labs', 'Chart the unknown in a slow, beautiful survey ship.'],
  ['Kingsfall', ['Strategy', 'Fantasy'], ['steam'], 'Crown & Quill', 'Medieval grand strategy.'],
  ['Kingsfall Remastered', ['Strategy', 'Fantasy'], ['xbox'], 'Crown & Quill', 'The remastered edition of the medieval classic.'],
  ['Ember Run', ['Platformer', 'Action'], ['steam', 'epic'], 'Spark Theory', 'Outrun the wildfire.'],
  ['Lumen Garden', ['Puzzle', 'Casual'], ['manual'], 'Bloom', 'A calm light-bending puzzle garden.'],
  ['Cobalt Frontier', ['Shooter', 'Sci-fi'], ['steam'], 'Bastion Works', 'Frontier law on a cobalt moon.'],
  ['Wyrmspire', ['RPG', 'Fantasy'], ['gog'], 'Ninefold Studio', 'Climb the tower of dragons.'],
  ['Night Courier', ['Racing', 'Action'], ['ubisoft'], 'Torque Collective', 'Deliver anything, anywhere, before dawn.'],
];

const NAME_A = ['Silent', 'Crimson', 'Hollow', 'Neon', 'Ancient', 'Shattered', 'Golden', 'Iron', 'Frozen', 'Lost', 'Astral', 'Wild'];
const NAME_B = ['Realm', 'Protocol', 'Horizon', 'Legacy', 'Frontier', 'Requiem', 'Garden', 'Circuit', 'Oath', 'Signal', 'Harbor', 'Tide'];
const GENRES = ['Action', 'RPG', 'Racing', 'Strategy', 'Horror', 'Puzzle', 'Simulation', 'Space', 'Fantasy', 'Indie', 'Shooter', 'Sports'];
const PLATFORMS: PlatformKey[] = ['steam', 'xbox', 'epic', 'gog', 'ea', 'ubisoft', 'battlenet'];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

const hex = (r: () => number) => Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join('');

const STATUSES: GameStatus[] = ['backlog', 'playing', 'beaten', 'completed', 'abandoned'];

/** Fictional status journeys (backlog → playing → beaten…) so the Journal's backlog card has a story to show. */
function buildStatusHistory(games: Game[], seed: number): StatusHistoryEntry[] {
  const r = rng(seed);
  const now = Date.now();
  const out: StatusHistoryEntry[] = [];
  games.slice(0, 26).forEach((g, i) => {
    if (i % 7 === 6) return; // some games never get a status
    let t = now - (40 + Math.floor(r() * 260)) * 86400000;
    const path: GameStatus[] = ['backlog'];
    const roll = r();
    if (roll > 0.35) path.push('playing');
    if (roll > 0.55) path.push(r() > 0.7 ? 'completed' : 'beaten');
    else if (roll > 0.45) path.push('abandoned');
    for (const status of path) {
      if (t > now) break;
      out.push({ gameId: g.id, status, at: new Date(t).toISOString() });
      t += (3 + Math.floor(r() * 40)) * 86400000;
    }
  });
  out.sort((a, b) => a.at.localeCompare(b.at));
  for (const e of out) {
    const g = games.find((x) => x.id === e.gameId)!;
    g.status = e.status;
    g.statusChangedAt = e.at;
  }
  return out;
}

function buildLibrary(extra: number): { games: Game[]; sessions: Session[] } {
  const r = rng(7);
  const now = Date.now();
  const games: Game[] = [];
  const sessions: Session[] = [];
  const entries = [...SAMPLE];
  for (let i = 0; i < extra; i++) {
    const g1 = GENRES[Math.floor(r() * GENRES.length)];
    const g2 = GENRES[Math.floor(r() * GENRES.length)];
    entries.push([
      `${NAME_A[Math.floor(r() * NAME_A.length)]} ${NAME_B[Math.floor(r() * NAME_B.length)]} ${i + 1}`,
      [...new Set([g1, g2])], [PLATFORMS[Math.floor(r() * PLATFORMS.length)]], 'Generated', 'Generated preview entry.',
    ]);
  }
  entries.forEach(([title, genres, platforms, dev, desc], idx) => {
    const id = hex(r);
    const installed = idx % 9 !== 4;
    const installs: Installation[] = platforms.map((p, j) => {
      const lastPlayed = r() > 0.3 ? new Date(now - Math.floor(r() * 120) * 86400000).toISOString() : null;
      return {
        id: hex(r), platform: p, platformGameId: String(100000 + idx * 10 + j), title,
        state: installed || j > 0 ? 'installed' : 'missing',
        installPath: `${r() > 0.5 ? 'D:' : 'C:'}\\Games\\${title}`, drive: r() > 0.5 ? 'D:' : 'C:',
        sizeBytes: Math.floor((2 + r() * 120) * 1024 ** 3), clientRequired: p !== 'manual' && p !== 'gog',
        launchKind: p === 'xbox' ? 'PackagedApp' : p === 'manual' || p === 'gog' ? 'Executable' : 'Uri',
        importedLastPlayed: p === 'steam' ? lastPlayed : null,
        importedPlaytimeMinutes: p === 'steam' ? Math.floor(r() * 9000) : null,
        userLaunchArgs: null, manualLink: false, lastSeen: new Date(now).toISOString(),
      };
    });
    const sessionCount = idx < 14 ? Math.floor(r() * 12) : 0;
    let tracked = 0;
    let last: string | null = null;
    for (let s = 0; s < sessionCount; s++) {
      const start = now - Math.floor(r() * 330) * 86400000 - Math.floor(r() * 86400000);
      const dur = Math.floor(600 + r() * 9000);
      tracked += dur;
      const iso = new Date(start).toISOString();
      if (!last || iso > last) last = iso;
      sessions.push({
        id: hex(r), gameId: id, installationId: installs[0].id, start: iso, end: new Date(start + dur * 1000).toISOString(),
        durationSeconds: dur, source: 'tracked',
        perfSummary: JSON.stringify({
          samples: Math.floor(dur / 2), cpuAvg: 20 + r() * 40, cpuMax: 60 + r() * 35, gpuAvg: 40 + r() * 50, gpuMax: 80 + r() * 20,
          gpuMemAvgMb: 2000 + r() * 5000, gpuMemMaxMb: 6000 + r() * 1800, ramAvgMb: 7000 + r() * 5000, ramMaxMb: 12000 + r() * 3000,
          gpuTempAvgC: 58 + r() * 14, gpuTempMaxC: 72 + r() * 10,
          fpsStatus: 'Frame-rate capture is off. It can be turned on in Settings › Launching & sessions (it uses Intel PresentMon). FPS is not recorded.',
        }),
      });
    }
    games.push({
      id, title, sortTitle: title.toLowerCase(), description: desc, developer: dev, publisher: dev,
      releaseDate: `${2015 + Math.floor(r() * 11)}`, genres, favorite: idx % 5 === 1, hidden: false,
      userRating: idx % 4 === 0 ? 4 : null, notes: null, preferredInstallationId: null,
      metadataSource: 'Preview data', palette: null,
      art: { cover: null, hero: null, logo: null, header: null, icon: null },
      installations: installs, collections: [], trackedSeconds: tracked, sessionCount, lastTrackedPlay: last,
      added: new Date(now - Math.floor(r() * 200) * 86400000).toISOString(),
    });
  });
  return { games, sessions };
}

/** Track E: saves a finished preview session (with FPS, like recent sessions) so the game page's ghost line can replay it. */
function recordPreviewSession(lib: { games: Game[]; sessions: Session[] }, game: Game, installationId: string, durationSeconds: number): string {
  const id = hex(Math.random);
  const end = Date.now();
  const start = new Date(end - durationSeconds * 1000).toISOString();
  lib.sessions.push({
    id, gameId: game.id, installationId, start, end: new Date(end).toISOString(), durationSeconds, source: 'tracked',
    perfSummary: JSON.stringify({
      samples: 240, cpuAvg: 44.2, cpuMax: 71.5, gpuAvg: 86.1, gpuMax: 99, gpuMemAvgMb: 5480, gpuMemMaxMb: 6020, ramAvgMb: 9420, ramMaxMb: 9900,
      gpuTempAvgC: 69, gpuTempMaxC: 74, fpsAvg: 112.6, fps1Low: 70.4, fps01Low: 51.2, frameTimeP50Ms: 8.6, frameTimeP99Ms: 15.1,
      fpsStatus: 'Measured with Intel PresentMon 2.6.0. Frame time is the time between the game’s presented frames.', fpsSource: 'Intel PresentMon 2.6.0',
    }),
  });
  // A new object, as the native bridge would send, so views keyed on the game see the change.
  const i = lib.games.indexOf(game);
  if (i >= 0) lib.games[i] = { ...game, sessionCount: game.sessionCount + 1, trackedSeconds: game.trackedSeconds + durationSeconds, lastTrackedPlay: start };
  return id;
}

export function createPreviewBackend() {
  const params = new URLSearchParams(location.search);
  const extra = Math.min(20000, Number(params.get('games') ?? 0) || 0);
  const empty = params.has('empty');
  const lib = empty ? { games: [], sessions: [] } : buildLibrary(extra);
  decoratePreviewSessions(lib.sessions); // Track B: FPS and throttling on recent sessions
  decorateTrackingSessions(lib.sessions); // Track H: a background and a detected session
  const statusHistory: StatusHistoryEntry[] = buildStatusHistory(lib.games, 11);
  let settings: Settings = { ...DEFAULT_SETTINGS, 'onboarding.completed': !params.has('onboarding') };
  if (params.has('reduced')) settings['motion.reduce'] = 'on';
  if (params.has('vibration')) settings['controller.vibration'] = true;
  const collections: LibrarySnapshot['collections'] = [];
  let emit: Emit = () => {};
  let launch: LaunchState | null = null;
  let update: UpdateState = { phase: 'idle', currentVersion: '0.1.0-preview', newVersion: null, progress: 0, totalBytes: null, bytesPerSecond: null, notes: null, message: null, checkedAt: null };
  const timers: number[] = [];

  const findGame = (id: string) => {
    const g = lib.games.find((x) => x.id === id);
    if (!g) throw new BridgeError('notFound', 'That item no longer exists.');
    return g;
  };
  const snapshot = (): LibrarySnapshot => ({
    games: lib.games,
    collections: collections.map((c) => ({ ...c, count: lib.games.filter((g) => g.collections.includes(c.id)).length })),
    duplicateSuggestions: (() => {
      const a = lib.games.find((g) => g.title === 'Kingsfall');
      const b = lib.games.find((g) => g.title === 'Kingsfall Remastered');
      return a && b ? [{ gameIdA: a.id, gameIdB: b.id, explanation: 'Both titles reduce to “kingsfall” but differ in edition or store, so they were kept separate.' }] : [];
    })(),
    lastScan: new Date().toISOString(),
  });
  const adapters: AdapterInfo[] = PLATFORMS.map((p) => ({
    platform: p,
    displayName: { steam: 'Steam', xbox: 'Xbox', epic: 'Epic Games', gog: 'GOG', ea: 'EA app', ubisoft: 'Ubisoft Connect', battlenet: 'Battle.net', manual: 'Added by you' }[p],
    enabled: true, status: p === 'battlenet' ? 'NotInstalled' : 'Available', clientPath: null, detail: null,
    capabilities: ['DiscoverInstalled', 'Launch'], limitations: ['Preview data — not read from this PC.'],
    lastScanCount: lib.games.filter((g) => g.installations.some((i) => i.platform === p)).length, lastScanError: null, lastScanMs: 40,
  }));

  const setLaunch = (s: LaunchState) => {
    launch = s;
    emit('launch.state', s);
  };

  const insight = insightPreviewHandlers({
    emit: () => emit, settings: () => settings, setSettings: (s) => { settings = s; }, timers,
    withFps: (id) => id === 'preview' || !!lib.sessions.find((s) => s.id === id)?.perfSummary?.includes('"fpsAvg"'),
  });
  const dataInsights = dataInsightPreviewHandlers({ lib, emit: () => emit, settings: () => settings, timers });

  const handlers: Record<string, (p: any) => unknown> = {
    'app.info': (): AppInfo => ({
      version: '0.1.0-preview', safeMode: false, previousRunCrashed: false, startupProblem: null, dataPath: '(preview)',
      window: { mode: 'desktop', maximized: false, fullscreen: false, captionInsetRight: 138, scale: 1 },
      settings, launch, update, os: navigator.userAgent, cpuCount: navigator.hardwareConcurrency ?? 8,
    }),
    'app.ready': () => true,
    'window.state': () => ({ mode: 'desktop', maximized: false, fullscreen: false, captionInsetRight: 138, scale: 1 }),
    'window.setMode': (p: { mode: 'desktop' | 'immersive' }) => ({ mode: p.mode, maximized: false, fullscreen: p.mode === 'immersive', captionInsetRight: 138, scale: 1 }),
    'library.get': snapshot,
    'library.scan': () => {
      emit('library.scan', { phase: 'started', platforms: PLATFORMS });
      timers.push(window.setTimeout(() => emit('library.scan', { phase: 'completed', added: 0, updated: lib.games.length, markedMissing: 0, merged: 0, failures: [] }), 900));
      return { added: 0, updated: lib.games.length, markedMissing: 0, merged: 0 };
    },
    'library.adapters': () => adapters,
    'library.setPlatformEnabled': (p: { platform: string; enabled: boolean }) => {
      const a = adapters.find((x) => x.platform === p.platform);
      if (a) a.enabled = p.enabled;
      return adapters;
    },
    'settings.get': () => settings,
    'settings.set': (p: { key: keyof Settings; value: never }) => {
      settings = { ...settings, [p.key]: p.value };
      emit('settings.changed', settings);
      return settings;
    },
    'settings.reset': () => (settings = { ...DEFAULT_SETTINGS, 'onboarding.completed': true }),
    'game.setFavorite': (p: { gameId: string; value: boolean }) => { findGame(p.gameId).favorite = p.value; return true; },
    'game.setHidden': (p: { gameId: string; value: boolean }) => { findGame(p.gameId).hidden = p.value; return true; },
    'game.setRating': (p: { gameId: string; rating: number | null }) => { findGame(p.gameId).userRating = p.rating; return true; },
    'game.setNotes': (p: { gameId: string; notes: string }) => { findGame(p.gameId).notes = p.notes; return true; },
    'game.setPreferred': (p: { gameId: string; installationId: string | null }) => { findGame(p.gameId).preferredInstallationId = p.installationId; return true; },
    'game.setLaunchArgs': (p: { installationId: string; args: string | null }) => {
      lib.games.flatMap((g) => g.installations).filter((i) => i.id === p.installationId).forEach((i) => (i.userLaunchArgs = p.args));
      return true;
    },
    'game.savePalette': (p: { gameId: string; palette: unknown }) => { findGame(p.gameId).palette = JSON.stringify(p.palette); return true; },
    'game.addManual': () => { throw new BridgeError('unsupported', 'Adding programs needs the VYSTRAL app (preview mode can’t open file dialogs).'); },
    'game.chooseArtwork': () => { throw new BridgeError('unsupported', 'Choosing artwork needs the VYSTRAL app.'); },
    'game.openFolder': () => true,
    'game.openInStore': () => true,
    'game.dismissDuplicate': () => true,
    'game.merge': (p: { targetGameId: string; sourceGameId: string }) => {
      const t = findGame(p.targetGameId);
      const s = findGame(p.sourceGameId);
      t.installations.push(...s.installations);
      lib.games.splice(lib.games.indexOf(s), 1);
      emit('library.changed', null);
      return true;
    },
    'game.launch': (p: { gameId: string; installationId?: string | null }) => {
      const g = findGame(p.gameId);
      const inst = g.installations.find((i) => i.id === p.installationId) ?? g.installations.find((i) => i.state === 'installed');
      const base: LaunchState = { ticket: hex(Math.random), gameId: g.id, installationId: inst?.id ?? '', platform: inst?.platform ?? '', phase: 'validating', message: null, sessionId: null, durationSeconds: null, perfSummary: null, startedAt: null, expectedDetectMs: PREVIEW_EXPECTED_DETECT_MS };
      if (!inst) {
        const failed = { ...base, phase: 'failed' as const, actions: PREVIEW_FAILED_ACTIONS, message: `${g.title} wasn’t found during the last scan. Reinstall it, or rescan your library.` };
        setLaunch(failed);
        return failed;
      }
      setLaunch({ ...base, phase: 'starting', message: `Starting via ${inst.platform}…` });
      insight.__preflight({ ticket: base.ticket, platform: inst.platform });
      timers.push(window.setTimeout(() => setLaunch({ ...base, phase: 'waiting', message: 'Waiting for the game window…', acceptedAt: new Date().toISOString() }), 700));
      timers.push(window.setTimeout(() => setLaunch({ ...base, phase: 'running', sessionId: 'preview', startedAt: new Date().toISOString(), message: null }), 2600));
      let sessionId = 'preview';
      timers.push(window.setTimeout(() => {
        // Like the native side, the finished session is saved before 'ended' is reported.
        sessionId = recordPreviewSession(lib, findGame(g.id), inst.id, 5400);
        setLaunch({ ...base, phase: 'ended', sessionId, durationSeconds: 5400, message: null });
      }, 7000));
      // Track F: Steam reports two fictional unlocks a moment after the session ends.
      timers.push(window.setTimeout(() => dataInsights.__unlocked({ gameId: g.id, sessionId }), 8500));
      return { ...base, phase: 'starting' };
    },
    'game.stopTracking': () => { timers.forEach(clearTimeout); if (launch) setLaunch({ ...launch, phase: 'ended', message: 'Stopped tracking. The game was not affected.' }); return true; },
    'launch.current': () => launch,
    // Preview can't bring another app's window forward; the real app does (SetForegroundWindow).
    'game.focus': () => launch?.phase === 'running',
    'collections.create': (p: { name: string; icon?: string | null }) => {
      const id = hex(Math.random);
      collections.push({ id, name: p.name, icon: p.icon ?? null, sortOrder: collections.length, rule: null, count: 0 });
      emit('library.changed', null);
      return id;
    },
    'collections.rename': (p: { collectionId: string; name: string }) => { const c = collections.find((x) => x.id === p.collectionId); if (c) c.name = p.name; return true; },
    'collections.delete': (p: { collectionId: string }) => { const i = collections.findIndex((x) => x.id === p.collectionId); if (i >= 0) collections.splice(i, 1); return true; },
    'collections.setMembership': (p: { collectionId: string; gameId: string; member: boolean }) => {
      const g = findGame(p.gameId);
      g.collections = p.member ? [...new Set([...g.collections, p.collectionId])] : g.collections.filter((c) => c !== p.collectionId);
      return true;
    },
    'sessions.list': (p: { gameId?: string | null; limit?: number }) =>
      lib.sessions.filter((s) => !p?.gameId || s.gameId === p.gameId).sort((a, b) => b.start.localeCompare(a.start)).slice(0, p?.limit ?? 500),
    'sessions.samples': (): PerfSample[] => {
      const r = rng(3);
      return Array.from({ length: 240 }, (_, i) => ({ t: i * 2000, cpu: 30 + r() * 30, gpu: 70 + r() * 25, gpuMemMb: 5200 + r() * 600, ramMb: 9000 + r() * 800, gpuTempC: 66 + r() * 6 }));
    },
    'system.drives': () => [
      { name: 'C:', label: 'Windows', totalBytes: 512e9, freeBytes: 140e9, isSystem: true, removable: false },
      { name: 'D:', label: 'Games', totalBytes: 1e12, freeBytes: 380e9, isSystem: false, removable: false },
    ],
    'update.state': () => update,
    'update.check': () => {
      update = { ...update, phase: 'available', newVersion: '0.2.0', totalBytes: 96 * 1024 * 1024, notes: '## Preview release notes\n- This is sample text shown in preview mode.', checkedAt: new Date().toISOString() };
      emit('update.state', update);
      return update;
    },
    'update.download': () => {
      let p = 0;
      const tick = () => {
        p = Math.min(100, p + 4 + Math.random() * 6);
        update = { ...update, phase: p >= 100 ? 'ready' : 'downloading', progress: Math.floor(p), bytesPerSecond: p >= 100 ? null : 9.5e6 };
        emit('update.state', update);
        if (p < 100) timers.push(window.setTimeout(tick, 180));
      };
      tick();
      return update;
    },
    'update.cancel': () => { update = { ...update, phase: 'available', progress: 0 }; emit('update.state', update); return update; },
    'update.apply': () => { throw new BridgeError('unsupported', 'Updates install in the real app. This is preview mode.'); },
    'update.openReleases': () => true,
    'ai.status': () => ({ enabled: settings['ai.enabled'], running: false, version: null, models: [], selectedModel: settings['ai.model'], selectedModelInstalled: false, recommended: { name: 'qwen3:4b', downloadGb: 2.5, license: 'Apache-2.0', why: 'Small enough for 8 GB laptop GPUs while handling search and recommendations well.' }, problem: 'Ollama isn’t available in preview mode.' }),
    'ai.parseQuery': () => null,
    'ai.chat': () => { throw new BridgeError('unavailable', 'Local AI isn’t available in preview mode.'); },
    'media.folders': () => [],
    'media.list': (): MediaItem[] => [],
    'diagnostics.info': () => ({ version: '0.1.0-preview', dataPath: '(preview)', database: { path: '(preview)', sizeBytes: 0, schemaVersion: 1 }, artCacheBytes: 0, recentAudit: [], runtime: 'browser', os: navigator.userAgent, safeMode: false }),
    'diagnostics.checkDatabase': () => ({ result: 'ok' }),
    'diagnostics.backupNow': () => ({ path: '(preview)' }),
    'data.clearArtCache': () => ({ freedBytes: 0 }),
    'game.setStatus': (p: { gameId: string; status: GameStatus | null }) => {
      if (p.status !== null && !STATUSES.includes(p.status)) throw new BridgeError('invalid', 'Unknown status.');
      const g = findGame(p.gameId);
      const previous = g.status ?? null;
      if (previous === p.status) return { status: previous, statusChangedAt: g.statusChangedAt ?? null, previous, changed: false };
      const at = new Date().toISOString();
      g.status = p.status;
      g.statusChangedAt = p.status ? at : null;
      statusHistory.push({ gameId: g.id, status: p.status, at });
      emit('status.changed', { gameId: g.id, status: p.status, previous, at });
      return { status: p.status, statusChangedAt: g.statusChangedAt, previous, changed: true };
    },
    'status.history': () => statusHistory.filter((e) => lib.games.some((g) => g.id === e.gameId)),
    // Preview can't reach Steam's video CDN, so trailers are honestly unavailable here.
    'trailer.get': () => ({ available: false, kind: null, src: null, name: null, reason: settings['privacy.localOnly'] ? 'offline' : settings['dataSaver.enabled'] ? 'dataSaver' : 'notChecked', source: 'Steam' }),
    'network.status': () => ({
      connected: true, metered: false, costType: 'Unrestricted', roaming: false, overDataLimit: false, approachingDataLimit: false,
      dataSaverActive: settings['dataSaver.enabled'], dataSaverReason: settings['dataSaver.enabled'] ? 'manual' : null,
    }),
    'data.exportJournal': () => null,
    'data.deleteHistory': () => { const n = lib.sessions.length; lib.sessions.length = 0; return { deletedSessions: n }; },
    // Track A: Steam Web API, achievements and store installs (fictional data).
    ...steamPreviewHandlers({ lib, emit: () => emit, settings: () => settings, timers }),
    // Track B: pre-flight, fixes, FPS capture, hotkey, notifications (fictional data).
    ...insight,
    // Track G: fictional Windows accent; no Mica in a browser.
    ...shellPreviewHandlers({ emit: () => emit, timers }),
    // Track D: controller haptics (recorded, never played) and simulated controller input.
    ...controllerPreviewHandlers({ emit: () => emit }),
    // Track F: achievement feed, driver comparison, background apps (fictional data).
    ...dataInsights,
    // Track H: games started outside VYSTRAL (fictional status; ?detected simulates one).
    ...trackingPreviewHandlers({ lib, emit: () => emit, settings: () => settings, setLaunch, timers }),
  };

  return {
    attach(e: Emit) { emit = e; },
    async call(method: string, params?: unknown) {
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 40));
      const h = handlers[method];
      if (!h) return true; // window controls etc. are no-ops in preview
      return h(params);
    },
  };
}
