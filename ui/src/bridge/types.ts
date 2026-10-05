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
  source: 'tracked' | 'imported';
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
