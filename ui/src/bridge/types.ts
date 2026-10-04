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
  'appearance.accent': 'auto' | 'violet' | 'blue' | 'cyan' | 'rose' | 'amber' | 'emerald';
  'appearance.livingCanvas': boolean;
  'appearance.canvasIntensity': number;
  'appearance.quality': 'auto' | 'high' | 'balanced' | 'low';
  'appearance.gridSize': number;
  'motion.reduce': 'system' | 'on' | 'off';
  'startup.intro': boolean;
  'startup.immersive': boolean;
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
}

export type GamepadButton =
  | 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'Menu' | 'View' | 'Up' | 'Down' | 'Left' | 'Right';
