// TypeScript mirror of the native DTOs in src/Vystral.Core/Contracts and
// src/Vystral.Windows. Keep both sides in sync.

export type PlatformKey = 'steam' | 'xbox' | 'epic' | 'gog' | 'ea' | 'ubisoft' | 'battlenet' | 'manual';

export interface Artwork {
  cover: string | null;
  hero: string | null;
  logo: string | null;
  header: string | null;
  icon: string | null;
}

export interface Installation {
  id: string;
  platform: PlatformKey;
  platformGameId: string;
  title: string;
  state: 'installed' | 'missing' | 'notinstalled';
  installPath: string | null;
  drive: string | null;
  sizeBytes: number | null;
  clientRequired: boolean;
  launchKind: 'Uri' | 'Executable' | 'PackagedApp';
  importedLastPlayed: string | null;
  importedPlaytimeMinutes: number | null;
  userLaunchArgs: string | null;
  manualLink: boolean;
  lastSeen: string;
}

export interface Game {
  id: string;
  title: string;
  sortTitle: string;
  description: string | null;
  developer: string | null;
  publisher: string | null;
  releaseDate: string | null;
  genres: string[];
  favorite: boolean;
  hidden: boolean;
  userRating: number | null;
  notes: string | null;
  preferredInstallationId: string | null;
  metadataSource: string | null;
  palette: string | null;
  art: Artwork;
  installations: Installation[];
  collections: string[];
  trackedSeconds: number;
  sessionCount: number;
  lastTrackedPlay: string | null;
  added: string;
  /** Play status set by the user (null/absent = none). */
  status?: GameStatus | null;
  /** When the status last changed (ISO), absent when there is no status. */
  statusChangedAt?: string | null;
}

export type GameStatus = 'backlog' | 'playing' | 'beaten' | 'completed' | 'abandoned';

export interface StatusHistoryEntry {
  gameId: string;
  status: GameStatus | null;
  at: string;
}

export interface StatusResult {
  status: GameStatus | null;
  statusChangedAt: string | null;
  previous: GameStatus | null;
  changed: boolean;
}

/** Why no trailer can play right now. */
export type TrailerReason = 'noSteamApp' | 'none' | 'notChecked' | 'offline' | 'dataSaver' | 'gameRunning' | 'lookupsOff';

export interface TrailerInfo {
  available: boolean;
  /** 'hls' = Steam's HLS (fMP4) trailer through the media proxy; 'file' = a single mp4/webm file. */
  kind: 'hls' | 'file' | null;
  src: string | null;
  name: string | null;
  reason: TrailerReason | null;
  source: string;
}

export interface NetworkStatus {
  connected: boolean;
  metered: boolean;
  costType: string;
  roaming: boolean;
  overDataLimit: boolean;
  approachingDataLimit: boolean;
  dataSaverActive: boolean;
  dataSaverReason: 'manual' | 'metered' | null;
}

export interface CollectionInfo {
  id: string;
  name: string;
  icon: string | null;
  sortOrder: number;
  rule: string | null;
  count: number;
}

export interface DuplicateSuggestion {
  gameIdA: string;
  gameIdB: string;
  explanation: string;
}

export interface LibrarySnapshot {
  games: Game[];
  collections: CollectionInfo[];
  duplicateSuggestions: DuplicateSuggestion[];
  lastScan: string | null;
}

export interface AdapterInfo {
  platform: PlatformKey;
  displayName: string;
  enabled: boolean;
  status: 'Available' | 'NotInstalled' | 'Error';
  clientPath: string | null;
  detail: string | null;
  capabilities: string[];
  limitations: string[];
  lastScanCount: number | null;
  lastScanError: string | null;
  lastScanMs: number | null;
}

export type LaunchPhase = 'validating' | 'starting' | 'waiting' | 'running' | 'notDetected' | 'ended' | 'failed';

export interface LaunchState {
  ticket: string;
  gameId: string;
  installationId: string;
  platform: string;
  phase: LaunchPhase;
  message: string | null;
  sessionId: string | null;
  durationSeconds: number | null;
  perfSummary: string | null;
  startedAt: string | null;
}

export interface Session {
  id: string;
  gameId: string;
  installationId: string | null;
  start: string;
  end: string | null;
  durationSeconds: number;
  source: SessionSource;
  perfSummary: string | null;
}

export interface PerfSummary {
  samples: number;
  cpuAvg: number | null;
  cpuMax: number | null;
  gpuAvg: number | null;
  gpuMax: number | null;
  gpuMemAvgMb: number | null;
  gpuMemMaxMb: number | null;
  ramAvgMb: number | null;
  ramMaxMb: number | null;
  gpuTempAvgC: number | null;
  gpuTempMaxC: number | null;
  fpsStatus: string;
}

export interface PerfSample {
  t: number;
  cpu: number | null;
  gpu: number | null;
  gpuMemMb: number | null;
  ramMb: number | null;
  gpuTempC: number | null;
}

export type UpdatePhase =
  | 'unavailable' | 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'ready' | 'applying' | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  newVersion: string | null;
  progress: number;
  totalBytes: number | null;
  bytesPerSecond: number | null;
  notes: string | null;
  message: string | null;
  checkedAt: string | null;
  /** True when only a small delta package is downloaded. */
  delta?: boolean;
}

export interface WindowState {
  mode: 'desktop' | 'immersive';
  maximized: boolean;
  fullscreen: boolean;
  captionInsetRight: number;
  scale: number;
}

export interface Settings {
  'appearance.theme': 'obsidian' | 'oled' | 'light' | 'contrast';
  'appearance.accent': 'auto' | 'violet' | 'blue' | 'cyan' | 'rose' | 'amber' | 'emerald' | 'system';
  'appearance.livingCanvas': boolean;
  'appearance.canvasIntensity': number;
  'appearance.quality': 'auto' | 'high' | 'balanced' | 'low';
  'appearance.gridSize': number;
  'motion.reduce': 'system' | 'on' | 'off';
  'startup.intro': boolean;
  'startup.immersive': boolean;
  'immersive.attract': boolean;
  'immersive.attractMinutes': number;
  'launch.cinematic': boolean;
  'launch.minimizeOnStart': boolean;
  'launch.restoreOnExit': boolean;
  'performance.collectMetrics': boolean;
  'pulse.enabled': boolean;
  'library.fetchMetadata': boolean;
  'library.fetchArtwork': boolean;
  'library.platformsEnabled': Record<string, boolean>;
  'ai.enabled': boolean;
  'ai.model': string;
  'updates.autoCheck': boolean;
  'updates.autoDownload': boolean;
  'controller.enabled': boolean;
  'controller.vibration': boolean;
  'sounds.enabled': boolean;
  'sounds.volume': number;
  'onboarding.completed': boolean;
  'privacy.localOnly': boolean;
  'moments.enabled': boolean;
  'dataSaver.enabled': boolean;
  'dataSaver.onMetered': boolean;
  'trailers.autoplay': boolean;
}

export type SettingKey = keyof Settings;

export interface AppInfo {
  version: string;
  safeMode: boolean;
  previousRunCrashed: boolean;
  startupProblem: string | null;
  dataPath: string;
  window: WindowState;
  settings: Settings;
  launch: LaunchState | null;
  update: UpdateState;
  os: string;
  cpuCount: number;
}

export interface AiModel {
  name: string;
  sizeBytes: number;
}

export interface AiStatus {
  enabled: boolean;
  running: boolean;
  version: string | null;
  models: AiModel[];
  selectedModel: string;
  selectedModelInstalled: boolean;
  recommended: { name: string; downloadGb: number; license: string; why: string };
  problem: string | null;
}

export interface AiQuery {
  intent: 'filter' | 'launch' | 'recommend';
  title?: string;
  installed?: boolean;
  favorite?: boolean;
  platforms?: PlatformKey[];
  genres?: string[];
  maxSizeGb?: number;
  minSizeGb?: number;
  notPlayedDays?: number;
  playedWithinDays?: number;
  drive?: string;
}

export interface DriveInfo {
  name: string;
  label: string;
  totalBytes: number;
  freeBytes: number;
  isSystem: boolean;
  removable: boolean;
}

export interface MediaFolder {
  id: string;
  path: string;
  label: string;
  automatic: boolean;
  exists: boolean;
}

export interface MediaItem {
  url: string;
  thumbUrl: string;
  name: string;
  kind: 'image' | 'video';
  folderId: string;
  modifiedAt: string;
  sizeBytes: number;
  gameId: string | null;
  matchedBy: 'steam-appid' | 'filename' | null;
}

export interface ScanReport {
  added: number;
  updated: number;
  markedMissing: number;
  merged: number;
}

export interface DiagnosticsInfo {
  version: string;
  dataPath: string;
  database: { path: string; sizeBytes: number; schemaVersion: number };
  artCacheBytes: number;
  recentAudit: { at: string; action: string; detail: string | null }[];
  runtime: string;
  os: string;
  safeMode: boolean;
}

export interface BridgeEvents {
  'launch.state': LaunchState;
  'library.changed': { reason?: string } | null;
  'library.scan': {
    phase: 'started' | 'platform' | 'completed';
    platform?: string;
    count?: number;
    platforms?: string[];
    added?: number;
    updated?: number;
    markedMissing?: number;
    merged?: number;
    failures?: { platform: string; error: string }[];
  };
  'settings.changed': Settings;
  'update.state': UpdateState;
  'window.state': WindowState;
  'gamepad.button': { button: GamepadButton; pressed: boolean };
  'gamepad.scroll': { value: number };
  'gamepad.connection': { count: number };
  'ai.chat': { requestId: string; delta?: string; done?: boolean; error?: string };
  'ai.pull': { model: string; status: string; total?: number; completed?: number; error?: string };
  'status.changed': { gameId: string; status: GameStatus | null; previous: GameStatus | null; at: string };
}

export type GamepadButton =
  | 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'Menu' | 'View' | 'Up' | 'Down' | 'Left' | 'Right';

// ---------- Track A: Steam Web API, achievements, store installs (mirror of SteamAccountService / InstallWatcher) ----------

export interface Settings {
  'steam.webApi.backgroundAchievements': boolean;
}

export interface SteamAccount {
  steamId: string;
  personaName: string;
  mostRecent: boolean;
}

export type SteamTestOutcome = 'ok' | 'invalidKey' | 'privateProfile' | 'rateLimited' | 'unavailable' | 'malformed' | 'noAccount';

export interface SteamTestResult {
  outcome: SteamTestOutcome;
  message: string;
  gameCount: number | null;
  at: string;
}

export interface SteamApiStatus {
  localOnly: boolean;
  steamInstalled: boolean;
  configured: boolean;
  /** Only the last four characters, e.g. "••••3F9A". The key itself never reaches the UI. */
  keyMasked: string | null;
  accounts: SteamAccount[];
  steamId: string | null;
  lastSync: string | null;
  ownedCount: number;
  lastTest: SteamTestResult | null;
  syncing: boolean;
}

export interface SteamActionResult {
  result: SteamTestResult;
  status: SteamApiStatus;
}

export interface Achievement {
  apiName: string;
  name: string;
  /** Null for hidden achievements that are still locked. */
  description: string | null;
  hidden: boolean;
  achieved: boolean;
  unlockedAt: string | null;
  /** Share of all Steam players who unlocked it (0–100). */
  globalPercent: number | null;
  /** Cached icon on the art host, or null. Never a remote URL. */
  icon: string | null;
}

export type AchievementsStatus = 'ok' | 'none' | 'private' | 'error' | 'notSteam' | 'notConnected' | 'noAccount' | 'localOnly';

export interface AchievementsResult {
  status: AchievementsStatus;
  message: string | null;
  fetchedAt: string | null;
  achievements: Achievement[];
  unlocked: number;
  total: number;
}

export type InstallPhase = 'queued' | 'downloading' | 'staging' | 'paused' | 'installed' | 'removed' | 'unknown';

export interface InstallProgress {
  gameId: string;
  appId: string;
  kind: 'install' | 'update' | 'uninstall';
  phase: InstallPhase;
  bytesDone: number;
  bytesTotal: number;
  /** Bytes per second, measured from Steam's manifest; null when unknown. */
  rate: number | null;
  /** False once VYSTRAL stopped watching (finished, removed or no change for 10 minutes). */
  watching: boolean;
}

export interface BridgeEvents {
  'install.progress': InstallProgress;
  'steam.achievementsUpdated': { count: number };
}

// ---------- Track B: pre-flight, launch timing, fixes, throttling, FPS capture, hotkey, notifications ----------

export interface LaunchFix {
  id: 'rescanPlatform' | 'openStore' | 'startClient' | 'installClient' | 'openFolder';
  label: string;
  platform: string | null;
}

export interface LaunchState {
  /** Median launch→detected time (ms) of the last 3+ launches of this installation; null until learned. */
  expectedDetectMs?: number | null;
  /** One-click fixes for phase 'failed'. Run with call('launch.fix', { ticket, actionId }). */
  actions?: LaunchFix[] | null;
  /** ISO time the launch was accepted. Determinate progress = (now − acceptedAt) / expectedDetectMs. */
  acceptedAt?: string | null;
}

export interface PerfSummary {
  /** Seconds the GPU was thermally throttled (NVIDIA only); null when not reported. */
  throttledSeconds?: number | null;
  powerLimitedSeconds?: number | null;
  throttleReasons?: ('thermal' | 'power')[] | null;
  peakTempC?: number | null;
  gpuClockAvgMhz?: number | null;
  /** Set when thermal throttling lasted ≥ 30 s. */
  thermalNote?: string | null;
  fpsAvg?: number | null;
  fps1Low?: number | null;
  fps01Low?: number | null;
  frameTimeP50Ms?: number | null;
  frameTimeP99Ms?: number | null;
  stutterCount?: number | null;
  frameCount?: number | null;
  /** Frame counts per bucket; edges in FRAME_TIME_EDGES_MS (ui/src/views/perf/insight.ts). */
  frameTimeHistogram?: number[] | null;
  fpsSource?: string | null;
}

/** Extra per-sample data (schema v4), joined to PerfSample by t. */
export interface InsightSample {
  t: number;
  gpuClockMhz: number | null;
  /** Bit flags: 1 thermal (software), 2 thermal (hardware), 4 power cap, 8 power brake. */
  throttleFlags: number | null;
  fps: number | null;
  frameTimeMs: number | null;
  frameTimeP99Ms: number | null;
}

export type PreflightStatus = 'ok' | 'info' | 'warn';

export interface PreflightCheck {
  id: 'disk' | 'steamUpdate' | 'controller' | 'display' | 'launchers' | string;
  label: string;
  status: PreflightStatus;
  value: string;
  detail: string | null;
}

export interface PreflightResult {
  ticket: string;
  checks: PreflightCheck[];
}

export interface FpsCaptureStatus {
  enabled: boolean;
  installed: boolean;
  installing: boolean;
  version: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  sourceUrl: string;
  releasePage: string;
  licenseUrl: string;
  installPath: string;
  permission: 'granted' | 'signOutRequired' | 'missing';
  groupName: string;
  account: string | null;
  ready: boolean;
  localOnly: boolean;
}

export interface HotkeyStatus {
  shortcut: string;
  enabled: boolean;
  registered: boolean;
  error: string | null;
  available: boolean;
}

export interface Settings {
  'fps.captureEnabled': boolean;
  'hotkey.enabled': boolean;
  'hotkey.summon': string;
  'notifications.enabled': boolean;
  'notifications.sessions': boolean;
  'notifications.updates': boolean;
  'notifications.installs': boolean;
  'notifications.thermal': boolean;
  'notifications.onlyInBackground': boolean;
}

// ---------- Track E: game page (trailer-following canvas, morphing Play button) ----------

export interface Settings {
  /** Living Canvas eases toward the colours of a playing hero trailer. */
  'canvas.followTrailer': boolean;
}

export interface BridgeEvents {
  'launch.preflight': PreflightResult;
  'fps.install': { phase: 'downloading' | 'installed' | 'failed'; progress: number; error?: string };
  /** Sent when a Windows notification is clicked; route is a store Route object. */
  'app.navigate': { route: { name: string; id?: string; sessionId?: string; section?: string; tab?: string } };
}

// ---------- Track F: heatmap, achievement feed, driver comparison, background apps (mirror of DataInsightDtos.cs) ----------

export interface Settings {
  'notifications.achievements': boolean;
  'performance.backgroundApps': boolean;
}

/** One unlocked Steam achievement in the merged feed. `icon` is a cached art-host URL or null. */
export interface AchievementFeedItem {
  appId: string;
  gameId: string | null;
  gameTitle: string;
  apiName: string;
  name: string;
  description: string | null;
  unlockedAt: string;
  globalPercent: number | null;
  icon: string | null;
}

export type AchievementDataStatus = 'ok' | 'notConnected' | 'localOnly' | 'empty';

export interface AchievementFeed {
  status: AchievementDataStatus;
  items: AchievementFeedItem[];
  offset: number;
  total: number;
  hasMore: boolean;
}

export interface NearCompletion {
  appId: string;
  gameId: string | null;
  gameTitle: string;
  unlocked: number;
  total: number;
  remaining: number;
  fraction: number;
  /** Null when the rarest locked achievement is hidden (no spoilers). */
  rarestRemainingName: string | null;
  rarestRemainingPercent: number | null;
  rarestRemainingHidden: boolean;
  lastUnlockAt: string | null;
}

export interface AchievementOverview {
  status: AchievementDataStatus;
  message: string | null;
  totalUnlocked: number;
  gamesWithData: number;
  rare: number;
  ultraRare: number;
  lastFetched: string | null;
  nearCompletion: NearCompletion[];
}

export interface AchievementUnlockEvent {
  sessionId: string;
  gameId: string;
  gameTitle: string;
  appId: string;
  items: AchievementFeedItem[];
  /** 1, 2, 5 or 10 — the tightest "rarer than" threshold; null when no unlock is below 10%. */
  rareThreshold: number | null;
  rareCount: number;
}

export interface DriverVersion {
  version: string;
  gpuName: string | null;
  firstSeen: string;
  lastSeen: string;
  sessions: number;
}

export interface DriverSide {
  version: string;
  gpuName: string | null;
  sessions: number;
  fpsAvg: number | null;
  fps1Low: number | null;
  frameTimeP99Ms: number | null;
  from: string;
  to: string;
}

export interface DriverGameComparison {
  gameId: string;
  before: DriverSide;
  after: DriverSide;
  changedAt: string;
  smallSample: boolean;
  gpuChanged: boolean;
}

export interface DriverInsight {
  drivers: DriverVersion[];
  games: DriverGameComparison[];
  sessionsWithDriver: number;
  sessionsWithFps: number;
  gamesWithoutFps: number;
}

export interface BackgroundAppStat {
  name: string;
  displayName: string;
  sessions: number;
  presence: number;
  roughPresence: number | null;
  cleanPresence: number | null;
  lift: number | null;
  avgMb: number | null;
  maxMb: number | null;
  avgCpu: number | null;
}

export interface BackgroundImpact {
  mode: 'fps' | 'memory' | 'none';
  sessionsAnalyzed: number;
  roughSessions: number;
  cleanSessions: number;
  enough: boolean;
  suspects: BackgroundAppStat[];
  common: BackgroundAppStat[];
  hidden: string[];
  collecting: boolean;
}

export interface BridgeEvents {
  'achievements.unlocked': AchievementUnlockEvent;
  'achievements.iconsReady': { appIds: string[] };
}

// ---------- Track G: Windows shell — accent colour, Mica backdrop (mirror of SystemAppearanceDto) ----------

export interface SystemAppearance {
  /** Windows accent colour, #RRGGBB. */
  accent: string;
  /** AccentLight1..3 and AccentDark1..3 (#RRGGBB). */
  accentLight: string[];
  accentDark: string[];
  /** Windows app mode is dark. */
  systemDark: boolean;
  highContrast: boolean;
  /** Windows "Transparency effects" setting. */
  transparencyEffects: boolean;
  energySaver: boolean;
  /** Mica is available (Windows 11). */
  backdropSupported: boolean;
  backdropRequested: boolean;
  /** What the window draws right now: 'mica' only while the UI asked for it and Windows can show it. */
  backdrop: 'mica' | 'none';
  backdropReason: 'notRequested' | 'safeMode' | 'immersive' | 'unsupported' | 'highContrast' | 'transparencyOff' | 'energySaver' | 'preview' | null;
}

export interface BridgeEvents {
  /** Windows accent, theme or backdrop state changed. Also returned by call('system.accent') and call('window.backdrop', { value }). */
  'system.accent': SystemAppearance;
}

// ---------- Track K: live tiles, ambient sound (mirror of LiveTileDto) ----------

export interface Settings {
  /** Home tiles play Steam's short silent micro-trailers while visible (never in Data saver). */
  'home.liveTiles': boolean;
  /** Mood-following ambient sound bed and spatial focus sounds (needs UI sounds on). */
  'sound.ambient': boolean;
  'sound.ambientVolume': number;
}

/** Why a Home tile can't animate. */
export type LiveTileReason = 'off' | 'gameRunning' | 'noSteamApp' | 'none' | 'notChecked' | 'offline' | 'dataSaver' | 'lookupsOff';

/** call('liveTile.get', { gameId }): a proxied micro-trailer (https://media.vystral.example/live/…) or why there is none. */
export interface LiveTileInfo {
  gameId: string;
  src: string | null;
  reason: LiveTileReason | null;
}
// ---------- Track I: data sources (mirror of DataSourcesService DTOs; types in ./types.dataSources) ----------

export interface Settings {
  /** Fill missing details from IGDB/RAWG when the user's own keys are set. */
  'dataSources.enrichment': boolean;
  'dataSources.cheapshark': boolean;
  'dataSources.wikidata': boolean;
  'dataSources.steamDeck': boolean;
  'dataSources.antiCheat': boolean;
  /** Current Steam store prices for the library value timeline. */
  'dataSources.storePrices': boolean;
  /** Two-letter country for prices (Steam, IsThereAnyDeal). */
  'dataSources.priceCountry': string;
}

export interface BridgeEvents {
  'dataSources.changed': import('./types.dataSources').DataSourcesStatus;
}

export type * from './types.dataSources';
// ---------- Track H: games started outside VYSTRAL, background tracker (mirror of AppBackend.Tracking.cs) ----------

/**
 * How a session was recorded. 'tracked' = started from VYSTRAL; 'detected' = started outside VYSTRAL and noticed
 * while it was open; 'background' = noticed by the background tracker while VYSTRAL was closed. All three are
 * observed by VYSTRAL and count the same everywhere; 'imported' is store playtime and never mixed in.
 */
export type SessionSource = 'tracked' | 'detected' | 'background' | 'imported' | 'cloud-gfn' | 'cloud-xbox'; // Track O: cloud streams started from VYSTRAL

export interface Settings {
  /** Notice games started outside VYSTRAL, and keep tracking them while it is closed. Off by default. */
  'tracking.background': boolean;
}

export interface LaunchState {
  /** How VYSTRAL came to track this game (absent from older backends = 'tracked'). */
  source?: Exclude<SessionSource, 'imported'> | null;
}

/** call('tracking.status'); call('tracking.setIgnored', { gameId, ignored }) returns it too. */
export interface TrackingStatus {
  enabled: boolean;
  /** False in safe mode. */
  available: boolean;
  safeMode: boolean;
  /** Only the installed app can start the tracker with Windows. */
  build: 'installed' | 'development' | 'portable';
  /** The per-user sign-in entry: 'disabledByWindows' = turned off in Task Manager › Startup apps. */
  autostart: 'on' | 'off' | 'disabledByWindows' | 'stale' | 'unavailable';
  helperRunning: boolean;
  /** VYSTRAL itself is noticing games right now (it owns tracking and the setting is on). */
  detecting: boolean;
  owner: boolean;
  watchedGames: number;
  pollSeconds: number;
  savingPollSeconds: number;
  minSessionSeconds: number;
  /** The newest finished session VYSTRAL noticed without launching it. */
  lastSeen: { gameId: string; title: string; source: SessionSource; start: string; end: string | null; durationSeconds: number } | null;
  /** Games the user asked VYSTRAL not to notice. */
  ignored: { gameId: string; title: string }[];
}

// ---------- Track N: art packs, live-tile director (mirror of ArtPackService and LiveTileDto) ----------

export interface BridgeEvents {
  /** An art pack's progress (a few times a second while it runs, and on every state change). */
  'artPacks.progress': import('./types.artPacks').ArtPackJob;
}

/** The live-tile director's choice for a game's cached micro-trailer. */
export interface LiveLoop {
  /** Seconds into the clip. */
  start: number;
  duration: number;
}

export interface LiveTileInfo {
  /** The stretch to loop; null/absent = the whole clip. */
  loop?: LiveLoop | null;
  /** The cached clip was already analysed (absent from older backends). */
  directed?: boolean;
}

export type * from './types.artPacks';
// ---------- Track M (v0.5): away card, time to beat, anti-cheat notes, value forecast, session replay (types in ./types.recap) ----------

export interface Settings {
  /** Informative kernel anti-cheat notes before launch and on game pages. */
  'launch.antiCheatNotes': boolean;
  /** IGDB time-to-beat bars on library cards, list rows and game pages (needs the user's IGDB key). */
  'library.timeToBeat': boolean;
}

export type * from './types.recap';
// ---------- Track L: Immersive Mode — couch settings, system bar (mirror of AppBackend.Immersive.cs / SystemStatusService) ----------

export interface Settings {
  /** The cinematic desktop ↔ Immersive switch; off = a quick crossfade. */
  'immersive.cinematicSwitch': boolean;
  /** Couch mode: Immersive text and interface scale, 1.0–1.3. */
  'immersive.scale': number;
  /** Couch mode: TV overscan safe area on each edge, 0–0.06 of the screen. */
  'immersive.safeArea': number;
  /** The short Immersive tour was finished or skipped (it shows once). */
  'immersive.tourDone': boolean;
}

// ---------- Track T: voice-over and captions, controller glyphs, the Immersive grid's sort ----------

export interface Settings {
  /** Speak focused games, rows, menus and notices in Immersive (Windows' local voices only). Off by default. */
  'voiceover.enabled': boolean;
  /** Show captions without speaking. */
  'voiceover.captionsOnly': boolean;
  /** voiceURI of the chosen local voice; '' = the best one for the interface language. */
  'voiceover.voice': string;
  /** Speaking rate, 0.5–2. */
  'voiceover.rate': number;
  /** Voice volume, 0–1. */
  'voiceover.volume': number;
  /** Which controller's button glyphs to draw; 'auto' follows the connected pad. */
  'controller.glyphs': 'auto' | 'xbox' | 'playstation' | 'nintendo';
  /** How Immersive's All games grid is ordered. */
  'immersive.librarySort': 'az' | 'recent' | 'played' | 'added';
}

/** call('system.status'): what the Immersive system bar shows. Read-only Windows APIs; null = not present / unknown. */
export interface SystemStatus {
  /** Null on PCs without a battery. */
  battery: { percent: number; charging: boolean; saver: boolean } | null;
  network: { kind: 'wifi' | 'ethernet' | 'cellular' | 'other' | 'none'; /** 0–4 signal bars (Wi-Fi/cellular), else null. */ bars: number | null; internet: boolean };
  /** Connected Xbox-compatible controllers; battery 0–1, null when wired or unknown. */
  controllers: { battery: number | null; charging: boolean; wired: boolean }[];
}

// ---------- Track S: docked on-screen keyboard in desktop mode (mirror of SettingsService) ----------

export interface Settings {
  /** A controller user activating a text field in desktop mode gets the docked on-screen keyboard. */
  'controller.onScreenKeyboard': boolean;
}

// ---------- Track P: friends playing now (opt-in), update-space forecast (types in types.trackP.ts) ----------

export interface Settings {
  /** "Friends playing now" on Home: reads your friends' public Steam status with your own key. Off by default. */
  'home.friendsActivity': boolean;
  /** Windows notification when a pending Steam update won't fit (or leaves a drive nearly full). */
  'notifications.diskSpace': boolean;
}

export interface BridgeEvents {
  /** The update-space forecast changed (pushed by the native manifest watcher). */
  'disk.forecast': import('./types.trackP').DiskForecast;
}

export type * from './types.trackP';

// ---------- Track Q: library health check, per-game Steam Input layouts (types in ./types.health, ./types.controls) ----------

export interface BridgeEvents {
  /** "Fix all safe issues" progress. */
  'health.progress': import('./types.health').HealthProgress;
}

export type * from './types.health';
export type * from './types.controls';

// ---------- Track O: cloud play — Xbox Cloud Gaming and GeForce NOW (types in ./types.cloud) ----------

export interface Settings {
  /** Cloud play (opt-in, off by default): download the vendors' public cloud catalogues and offer "Play in the cloud". */
  'cloud.enabled': boolean;
  'cloud.gfn': boolean;
  'cloud.xbox': boolean;
  /** Two-letter market override; '' = the Windows region. */
  'cloud.market': string;
  'cloud.gfnPlan': import('./types.cloud').GfnPlanId;
  /** Day of the month the hours meter resets (1–31; clamped to short months). */
  'cloud.resetDay': number;
  /** Browser fallback: a separate Edge window (VYSTRAL never reads it) or the default browser. */
  'cloud.browser': 'edge' | 'default';
}

export interface BridgeEvents {
  'cloud.changed': import('./types.cloud').CloudStatus;
  /** A cloud session changed: the active session, or { ended: true, … } when it finished. */
  'cloud.session': import('./types.cloud').CloudSession | { ended: true; gameId: string; service: string; seconds: number; saved: boolean } | null;
}

export type * from './types.cloud';

// ---------- Track Y: play data and insights — hardware history, energy estimate, controller battery history ----------

export interface Settings {
  /** Keep a sparse controller battery history (about every 10 minutes while connected); local only. */
  'controller.batteryHistory': boolean;
  /** Opt-in energy estimate from recorded GPU/CPU load. Off by default. */
  'energy.enabled': boolean;
  /** Your PC's full-load wattage; 0 = use typical board power for the detected GPU and CPU. */
  'energy.watts': number;
  /** Electricity price per kWh; 0 = don't show cost. */
  'energy.price': number;
  /** ISO 4217 currency for the price; '' = the Windows region's currency. */
  'energy.currency': string;
}

export type * from './types.playData';

// ---------- Track X: library tools — new health issues on Home, layout compare, uninstall advisor, mods, save files (types in ./types.trackX) ----------

export interface Settings {
  /** Save locations from PCGamingWiki on a game's Files tab (opt-in; keyless; CC BY-NC-SA, credited). */
  'dataSources.pcgamingwiki': boolean;
  /** Names for Steam Workshop items from Steam's public GetPublishedFileDetails (opt-in; keyless). */
  'dataSources.workshopTitles': boolean;
  /** A small Home card when the background health check notices something new (once per issue). */
  'home.healthNews': boolean;
}

export interface BridgeEvents {
  /** The background health re-check noticed something new (or a pending one went away). */
  'health.news': import('./types.trackX').HealthNews;
}

export type * from './types.trackX';

// ---------- Track V: your gaming subscriptions, "leaving soon", cloud queue alerts (types in ./types.subs) ----------

export interface Settings {
  /** The plans you said you have (comma list of SubsPlanId). Stored on this PC only; never checked against an account. */
  'subs.owned': string;
  /** You answered (or dismissed) "Which subscriptions do you have?". */
  'subs.asked': boolean;
  /** Opt-in: download Microsoft's public Game Pass lists to see what your plans include. Off by default. */
  'subs.catalog': boolean;
  /** Cloud play shows every service, not only the ones you have. */
  'subs.cloudShowAll': boolean;
  /** A Windows notification a few days before a game you own leaves Game Pass. */
  'subs.leavingNotify': boolean;
  /** What you pay a month in total (0 = not entered), only for the value card's cost per hour. */
  'subs.price': number;
  /** ISO 4217 code for that price ('' = your Windows currency). */
  'subs.currency': string;
  /** GeForce NOW queue alerts (read from the official app's window title; "Your stream is starting"). */
  'cloud.queueAlerts': boolean;
  /** Notify when the queue position reaches this number or less. */
  'cloud.queueAlertAt': number;
}

export interface BridgeEvents {
  'subs.changed': import('./types.subs').SubsStatus;
  /** Owned games leaving Game Pass (the native side also shows the notification). */
  'subs.leaving': { key: string; count: number; items: { gameId: string; title: string; end: string | null }[] };
  'cloud.queue': import('./types.subs').CloudQueueSignal;
}

export type * from './types.subs';
