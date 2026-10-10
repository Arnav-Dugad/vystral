/**
 * What the game page's one Play button is right now. Pure: derived from the game, the current
 * launch and Steam's install progress, so every state (and every transition the button morphs
 * through) is tested in one place. Labels never claim more than the native side has seen.
 */
import type { Game, InstallProgress, Installation, LaunchState, PlatformKey } from '../../bridge/types';
import { phaseLabel, progressFraction } from '../../lib/installProgress';
import { formatClock, PLATFORM_NAMES, primaryInstallation } from '../../lib/format';

export type PlayKind =
  | 'play' // installed and ready
  | 'launching' // validating / starting / waiting for the game window
  | 'running' // VYSTRAL sees the game running
  | 'failed' // the last launch of this game didn't start
  | 'updating' // Steam is downloading or applying an update
  | 'uninstalling' // Steam is removing it
  | 'install' // not installed, Steam can install it
  | 'installing' // Steam is installing it (with progress)
  | 'storeInstall' // not installed, another store installs it
  | 'missing' // a copy VYSTRAL knew about wasn't found, and no store can install it
  | 'unavailable'; // nothing to do from here

/** Visual tone: primary (accent fill), live (playing), progress (ring), quiet (secondary). */
export type PlayTone = 'primary' | 'live' | 'progress' | 'quiet';

/** Which glyph sits in the icon slot. */
export type PlayIcon = 'play' | 'ring' | 'live' | 'retry' | 'download' | 'store' | 'rescan' | 'none';

export interface PlayState {
  kind: PlayKind;
  /** Short visible label. */
  label: string;
  /** Visible trailing figure (timer, percent); never part of the morph key. */
  detail: string | null;
  /** Accessible name. */
  name: string;
  /** Polite announcement for this state; changes only when the state meaningfully changes. */
  announce: string;
  tone: PlayTone;
  icon: PlayIcon;
  /** Ring progress 0–1, or null for an indeterminate ring (only meaningful when icon is 'ring'). */
  fraction: number | null;
  /** False: the button stays focusable (aria-disabled) but does nothing. */
  actionable: boolean;
  /** Labels this button may show while the game stays in the same family; sizes the button. */
  family: 'installed' | 'notInstalled';
  /** Store that installs it (install / installing / storeInstall). */
  store: Installation | null;
}

export interface PlayInput {
  game: Game;
  launch: LaunchState | null;
  install?: InstallProgress | null;
  /** Epoch ms; drives the session timer and the learned launch arc. */
  now: number;
}

const LAUNCHING = new Set(['validating', 'starting', 'waiting', 'notDetected']);

/** Session timer, clock style like the title bar's Now Playing chip: 4:07, 59:59, 1:12:30. */
export function formatSessionTimer(seconds: number): string {
  return formatClock(seconds);
}

/** Spoken duration at minute granularity ("12 minutes", "1 hour 5 minutes"). */
export function spokenDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (h === 0) return m === 0 ? 'less than a minute' : part(m, 'minute');
  return m === 0 ? part(h, 'hour') : `${part(h, 'hour')} ${part(m, 'minute')}`;
}

/**
 * Learned launch progress (LaunchOverlay's arc): elapsed since the store accepted the launch over
 * the median of recent detections. Never reaches 1 on its own — only detection completes it.
 */
export function learnedFraction(launch: Pick<LaunchState, 'expectedDetectMs' | 'acceptedAt'>, now: number): number | null {
  const expected = launch.expectedDetectMs;
  const accepted = launch.acceptedAt ? Date.parse(launch.acceptedAt) : NaN;
  if (!expected || expected <= 0 || Number.isNaN(accepted)) return null;
  return Math.min(0.97, Math.max(0, (now - accepted) / expected));
}

/** Short install labels (the long, precise wording goes to the accessible name and status line). */
const INSTALL_LABEL: Partial<Record<InstallProgress['phase'], string>> = {
  queued: 'Waiting for Steam…',
  downloading: 'Downloading',
  staging: 'Installing',
  paused: 'Paused in Steam',
  installed: 'Ready',
};

/** "Downloading, 30 percent. Show in Steam" without doubling the ellipsis of "Waiting for Steam…". */
const then = (first: string, next: string) => `${first}${/[….]$/.test(first) ? ' ' : '. '}${next}`;

const pct = (f: number | null) => (f == null ? null : `${Math.round(f * 100)}%`);

/** The store that can install a game that isn't installed: Steam (in-app flow) first, then any store. */
export function installSource(game: Game): { inst: Installation; steam: boolean } | null {
  // Track C1: a copy Steam no longer lists (refunded or removed) can't be installed from here.
  const steam = game.installations.find((i) => i.platform === 'steam' && i.state !== 'installed' && !i.noLongerOwned && /^\d{1,10}$/.test(i.platformGameId));
  if (steam) return { inst: steam, steam: true };
  const store = game.installations.find((i) => i.platform !== 'manual' && i.state !== 'installed' && !i.noLongerOwned);
  return store ? { inst: store, steam: false } : null;
}

export function playLabel(game: Game): string {
  const installed = game.installations.filter((i) => i.state === 'installed');
  const primary = primaryInstallation(game);
  return installed.length > 1 && primary ? `Play · ${PLATFORM_NAMES[primary.platform]}` : 'Play';
}

export function derivePlayState({ game, launch, install, now }: PlayInput): PlayState {
  const title = game.title;
  const installed = game.installations.some((i) => i.state === 'installed');
  const family: PlayState['family'] = installed ? 'installed' : 'notInstalled';
  const base = { detail: null, fraction: null, actionable: true, family, store: null } as const;
  const mine = launch && launch.gameId === game.id ? launch : null;

  if (mine && LAUNCHING.has(mine.phase)) {
    const waiting = mine.phase === 'notDetected';
    const f = waiting ? null : learnedFraction(mine, now);
    return {
      ...base,
      kind: 'launching',
      label: waiting ? 'Still waiting…' : 'Launching…',
      name: waiting ? `Still waiting for ${title} to start` : `Launching ${title}`,
      announce: waiting ? `Still waiting for ${title} to start.` : `Launching ${title}.`,
      tone: 'primary',
      icon: 'ring',
      fraction: f,
      actionable: false,
    };
  }
  if (mine && mine.phase === 'running') {
    const started = mine.startedAt ? Date.parse(mine.startedAt) : NaN;
    const elapsed = Number.isNaN(started) ? null : (now - started) / 1000;
    return {
      ...base,
      kind: 'running',
      label: 'Playing',
      detail: elapsed == null ? null : formatSessionTimer(elapsed),
      name: `Playing ${title}${elapsed == null ? '' : `, ${spokenDuration(elapsed)}`}. Switch to the game`,
      announce: `${title} is running.`,
      tone: 'live',
      icon: 'live',
    };
  }
  if (mine && mine.phase === 'failed') {
    return {
      ...base,
      kind: 'failed',
      label: 'Try again',
      name: `Try again: ${title} didn’t start`,
      announce: `${title} didn’t start.`,
      tone: 'primary',
      icon: 'retry',
    };
  }

  if (install && install.phase !== 'removed') {
    const f = progressFraction(install);
    if (install.kind === 'uninstall') {
      return { ...base, kind: 'uninstalling', label: 'Uninstalling…', name: `Steam is uninstalling ${title}`, announce: `Steam is uninstalling ${title}.`, tone: 'progress', icon: 'ring', actionable: false };
    }
    if (install.kind === 'update' && installed && (install.phase === 'downloading' || install.phase === 'staging')) {
      const steam = game.installations.find((i) => i.platform === 'steam') ?? null;
      return {
        ...base,
        kind: 'updating',
        label: 'Updating',
        detail: pct(f),
        name: then(`${phaseLabel(install)}${f != null ? `, ${Math.round(f * 100)} percent` : ''}`, 'Show in Steam'),
        announce: `${phaseLabel(install)}.`,
        tone: 'progress',
        icon: 'ring',
        fraction: f,
        store: steam,
      };
    }
    if (install.kind === 'install' && !(installed && install.phase === 'installed')) {
      const steam = game.installations.find((i) => i.platform === 'steam') ?? null;
      const label = INSTALL_LABEL[install.phase] ?? 'Installing';
      return {
        ...base,
        kind: 'installing',
        label,
        detail: install.phase === 'queued' || install.phase === 'installed' ? null : pct(f),
        name: then(`${phaseLabel(install)}${f != null && install.phase !== 'installed' ? `, ${Math.round(f * 100)} percent` : ''}`, 'Show in Steam'),
        announce: `${phaseLabel(install)}.`,
        tone: 'progress',
        icon: 'ring',
        fraction: install.phase === 'queued' ? null : f,
        store: steam,
      };
    }
    // Queued/paused updates and finished work: the game is playable (Steam decides about updates).
  }

  if (installed) {
    const label = playLabel(game);
    return { ...base, kind: 'play', label, name: label === 'Play' ? `Play ${title}` : `${label}: play ${title}`, announce: `Ready to play ${title}.`, tone: 'primary', icon: 'play' };
  }

  if (game.notOwned) {
    return { ...base, kind: 'unavailable', label: 'Not owned', name: `${title} is no longer in your Steam library`, announce: `${title} is no longer in your Steam library.`, tone: 'quiet', icon: 'none', actionable: false };
  }
  const source = installSource(game);
  if (source?.steam) {
    return { ...base, kind: 'install', label: 'Install', name: `Install ${title} with Steam`, announce: `${title} isn’t installed.`, tone: 'primary', icon: 'download', store: source.inst };
  }
  if (source) {
    const store = PLATFORM_NAMES[source.inst.platform as PlatformKey];
    return { ...base, kind: 'storeInstall', label: `Install in ${store}`, name: `Install in ${store}: opens ${store} to install ${title}`, announce: `${title} isn’t installed.`, tone: 'primary', icon: 'store', store: source.inst };
  }
  if (game.installations.some((i) => i.state === 'missing')) {
    return { ...base, kind: 'missing', label: 'Rescan', name: `Rescan: ${title} wasn’t found during the last scan`, announce: `${title} wasn’t found.`, tone: 'quiet', icon: 'rescan' };
  }
  return { ...base, kind: 'unavailable', label: 'Not installed', name: `${title} isn’t installed`, announce: `${title} isn’t installed.`, tone: 'quiet', icon: 'none', actionable: false };
}

/**
 * Every label the button can show without the game changing family (installed ↔ not), widest
 * figures included. The button reserves the widest so morphing between them never shifts the row.
 */
export function familyLabels(game: Game, family: PlayState['family']): { label: string; detail: string | null; aux: boolean }[] {
  if (family === 'installed') {
    return [
      { label: playLabel(game), detail: null, aux: false },
      { label: 'Launching…', detail: null, aux: false },
      { label: 'Still waiting…', detail: null, aux: false },
      { label: 'Playing', detail: '00h 00m', aux: true },
      { label: 'Try again', detail: null, aux: false },
      { label: 'Updating', detail: '100%', aux: false },
      { label: 'Uninstalling…', detail: null, aux: false },
    ];
  }
  const source = installSource(game);
  const first = game.notOwned ? 'Not owned' : source ? (source.steam ? 'Install' : `Install in ${PLATFORM_NAMES[source.inst.platform as PlatformKey]}`) : game.installations.some((i) => i.state === 'missing') ? 'Rescan' : 'Not installed';
  const rows: { label: string; detail: string | null; aux: boolean }[] = [{ label: first, detail: null, aux: false }];
  if (source?.steam) {
    rows.push(
      { label: 'Waiting for Steam…', detail: null, aux: true },
      { label: 'Downloading', detail: '100%', aux: true },
      { label: 'Installing', detail: '100%', aux: true },
      { label: 'Paused in Steam', detail: '100%', aux: true },
    );
  }
  return rows;
}
