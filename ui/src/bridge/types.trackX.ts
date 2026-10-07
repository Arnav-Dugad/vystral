// Track X: library tools. Mirror of src/Vystral.Windows/AppBackend.TrackX.cs, Services/HealthWatchService.cs,
// Storage/{UninstallAdvisor,ModFolders,SaveLocator}.cs and src/Vystral.Core/Controller/SteamInputCompare.cs.
import type { ControlId, ControllerLayout } from './types.controls';
import type { HealthIssue } from './types.health';
import type { PlatformKey } from './types';

/** call('health.news') and the 'health.news' event: issues noticed since the last background check, not yet acknowledged. */
export interface HealthNews {
  /** Most serious first. Empty when nothing is new, the card is turned off, or no background check has run yet. */
  issues: HealthIssue[];
  checkedAt: string | null;
  /** What triggered the last check: drive | scan | install | daily | check. */
  reason: string | null;
  score: number;
}

// ---------- Steam Input compare ----------

export type ControllerDiffChange = 'added' | 'removed' | 'changed';

export interface ControllerDiff {
  setId: string;
  setName: string;
  control: ControlId;
  change: ControllerDiffChange;
  /** The default's bindings in plain words. */
  before: string[];
  /** Yours. */
  after: string[];
  modeBefore: string | null;
  modeAfter: string | null;
}

/** call('controls.compare', { gameId }). */
export interface ControllerCompare {
  /** ok | same (no differences) | noDefault (nothing local to compare with) | notSteamInput. */
  status: 'ok' | 'same' | 'noDefault' | 'notSteamInput';
  yours: ControllerLayout | null;
  default: ControllerLayout | null;
  /** progenitor: the layout yours started from; title: a template with the same name; controllerDefault: Steam's Gamepad template; self: you use a template as it is. */
  basis: 'progenitor' | 'title' | 'controllerDefault' | 'self' | null;
  defaultName: string | null;
  differences: ControllerDiff[];
  unchanged: number;
  onlyInYours: string[];
  onlyInDefault: string[];
  note: string | null;
}

// ---------- Uninstall advisor ----------

export interface CloudSaves {
  /** steamCloud: Steam keeps copies online; localOnly: no Steam Cloud data for it on this PC; unknown: not a Steam game or Steam isn't here. */
  state: 'steamCloud' | 'localOnly' | 'unknown';
  files: number;
  bytes: number;
  lastSync: string | null;
}

export interface AdviceService {
  service: 'gamepass' | 'xbox' | 'gfn' | string;
  name: string;
  note: string;
}

/** call('uninstall.advice', { gameId, installationId? }). */
export interface UninstallAdvice {
  gameId: string;
  installationId: string;
  platform: PlatformKey;
  sizeBytes: number | null;
  /** manifest: Steam's own SizeOnDisk; scan: the last library scan; none. */
  sizeSource: 'manifest' | 'scan' | 'none';
  drive: string | null;
  saves: CloudSaves;
  services: AdviceService[];
  /** What the button does: Steam's uninstall (steam://uninstall/<appid>), the store app, Windows' Installed apps, or nothing (added by you). */
  action: 'steamUninstall' | 'openStore' | 'windowsApps' | 'none';
  actionLabel: string;
}

// ---------- Mods ----------

export interface ModItem {
  /** Workshop item id, or an opaque hash of a mod folder name. */
  id: string;
  name: string;
  /** Workshop title (opt-in lookup), when known. */
  title: string | null;
  bytes: number | null;
  updated: string | null;
  /** Mod Organizer 2's selected profile; null when unknown. */
  enabled: boolean | null;
  /** The folder is on disk. */
  present: boolean;
}

export interface ModSource {
  /** workshop | vortex | mo2-<n> */
  id: string;
  kind: 'workshop' | 'vortex' | 'mo2';
  label: string;
  detail: string | null;
  folder: string;
  bytes: number;
  count: number;
  /** Too many files to measure everything: sizes are at least this much. */
  partial: boolean;
  items: ModItem[];
}

/** call('mods.list' | 'mods.titles', { gameId }). */
export interface ModsList {
  gameId: string;
  appId: string | null;
  sources: ModSource[];
  /** off | offline | notSteam | none (nothing to name) | ready (titles can be looked up) | done. */
  titles: 'off' | 'offline' | 'notSteam' | 'none' | 'ready' | 'done';
  missingTitles: number;
  scannedAt: string;
}

// ---------- Save files ----------

export type SavePlatform = 'windows' | 'steam' | 'microsoftStore' | 'gog' | 'epic' | 'ea' | 'ubisoft' | 'battlenet';

export interface SaveLocation {
  /** Opaque id for saves.open (valid for the last lookup). */
  id: string;
  platform: SavePlatform;
  /** As PCGamingWiki writes it. */
  raw: string;
  /** With friendly roots ("%APPDATA%\Game"). */
  display: string;
  /** On this PC (null when its starting folder isn't known here). */
  path: string | null;
  exists: boolean;
  isFile: boolean;
  bytes: number | null;
  files: number;
  modified: string | null;
  partial: boolean;
  /** unsupported (registry key, another OS, an unsafe path) | noRoot. */
  problem: 'unsupported' | 'noRoot' | null;
}

/** call('saves.lookup', { gameId, refresh? }). */
export interface SavesLookup {
  gameId: string;
  status: 'ok' | 'none' | 'notFound' | 'off' | 'offline' | 'busy' | 'noSteamApp' | 'error';
  message: string | null;
  /** The PCGamingWiki article (credited with a link). */
  article: string | null;
  locations: SaveLocation[];
  fetched: string | null;
  stale: boolean;
}
