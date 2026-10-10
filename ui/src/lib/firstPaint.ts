/**
 * Track AA: the "first paint" snapshot. A compact copy of what Home last showed — the hero, the games on
 * each shelf (with their already-cached artwork URLs), the Library radar numbers and the theme — saved
 * through the bridge (the host keeps it in ui-state/first-paint.json, stamped with VYSTRAL's version) and
 * handed back on the next start before any script runs (`globalThis.__vystralFirstPaint`). Home paints
 * from it at once, then reconciles with the live library without flicker (same tree, same keys).
 *
 * Everything read here is validated field by field and rebuilt; anything unexpected (another schema,
 * a corrupt or tampered file) makes `parseFirstPaint` return null and the live path takes over silently.
 * The browser preview keeps its snapshot in localStorage and only reads it with `?firstpaint`.
 */
import type { Artwork, Game, GameStatus, Installation, PlatformKey, Settings } from '../bridge/types';
import { buildHomeModel, homeModelIds, type HomeModel } from './homeModel';

export const FIRST_PAINT_VERSION = 1;
export const MAX_GAMES = 120;
const MAX_FAVORITES = 24;
export const PREVIEW_KEY = 'vystral.preview.firstPaint';

export interface FirstPaintAppearance {
  theme: Settings['appearance.theme'];
  reduceMotion: Settings['motion.reduce'];
  quality: Settings['appearance.quality'];
}

export interface FirstPaint {
  v: typeof FIRST_PAINT_VERSION;
  savedAt: string;
  appearance: FirstPaintAppearance;
  model: HomeModel;
  games: Game[];
}

declare global {
  // eslint-disable-next-line no-var
  var __vystralFirstPaint: unknown;
}

const THEMES = ['obsidian', 'oled', 'light', 'contrast'] as const;
const REDUCE = ['system', 'on', 'off'] as const;
const QUALITY = ['auto', 'high', 'balanced', 'low'] as const;
const PLATFORMS: readonly PlatformKey[] = ['steam', 'xbox', 'epic', 'gog', 'ea', 'ubisoft', 'battlenet', 'manual'];
const STATES = ['installed', 'missing', 'notinstalled'] as const;
const LAUNCH = ['Uri', 'Executable', 'PackagedApp'] as const;
const STATUSES: readonly GameStatus[] = ['backlog', 'playing', 'beaten', 'completed', 'abandoned'];
const ID = /^[0-9a-f]{32}$/;
/** Artwork comes only from VYSTRAL's own art cache (or the preview's bundled files): never a remote URL. */
const ART = /^(https:\/\/art\.vystral\.example\/|\.?\/)[A-Za-z0-9._~%/\-]{1,380}$/;

// ---------------------------------------------------------------- building

const clip = (s: string | null | undefined, max: number) => (s == null ? null : s.length > max ? s.slice(0, max - 1) + '…' : s);
const safeArt = (u: string | null | undefined) => (typeof u === 'string' && ART.test(u) && !u.includes('..') ? u : null);

function liteArt(a: Artwork): Artwork {
  return { cover: safeArt(a.cover), hero: safeArt(a.hero), logo: safeArt(a.logo), header: safeArt(a.header), icon: safeArt(a.icon) };
}

function liteInstallation(i: Installation): Installation {
  // Track C1: package details and ownership dates aren't needed on Home; an estimated last-played keeps its label.
  const { version: _v, installedAt: _ia, noLongerOwned: _no, lastPlayedSource, ...rest } = i;
  return {
    ...rest, title: clip(i.title, 200) ?? '', installPath: null, userLaunchArgs: null, platformGameId: clip(i.platformGameId, 120) ?? '',
    ...(lastPlayedSource === 'saveData' ? { lastPlayedSource } : {}),
  };
}

/** Only what Home and its cards read; user notes, paths and long text stay out. */
export function liteGame(g: Game, withDescription: boolean): Game {
  return {
    id: g.id,
    title: clip(g.title, 200) ?? '',
    sortTitle: clip(g.sortTitle, 200) ?? '',
    description: withDescription ? clip(g.description, 600) : null,
    developer: null,
    publisher: null,
    releaseDate: g.releaseDate && g.releaseDate.length <= 40 ? g.releaseDate : null,
    genres: g.genres.slice(0, 4).map((x) => clip(x, 40) ?? ''),
    favorite: g.favorite,
    hidden: false,
    userRating: g.userRating,
    notes: null,
    preferredInstallationId: g.preferredInstallationId,
    metadataSource: null,
    palette: g.palette && g.palette.length <= 600 ? g.palette : null,
    art: liteArt(g.art),
    installations: g.installations.slice(0, 6).map(liteInstallation),
    collections: [],
    trackedSeconds: g.trackedSeconds,
    sessionCount: g.sessionCount,
    lastTrackedPlay: g.lastTrackedPlay,
    added: g.added,
    status: g.status ?? null,
    statusChangedAt: g.statusChangedAt ?? null,
  };
}

/** The snapshot for a loaded library, or null when there is nothing worth caching (empty, or onboarding). */
export function buildFirstPaint(visible: Game[], settings: Settings | null, now: number, model: HomeModel = buildHomeModel(visible, now)): FirstPaint | null {
  if (!settings || !settings['onboarding.completed'] || model.visibleCount === 0) return null;
  const trimmed: HomeModel = { ...model, favoriteIds: model.favoriteIds.slice(0, MAX_FAVORITES) };
  const byId = new Map(visible.map((g) => [g.id, g]));
  const games = homeModelIds(trimmed)
    .slice(0, MAX_GAMES)
    .map((id) => byId.get(id))
    .filter((g): g is Game => !!g)
    .map((g) => liteGame(g, g.id === trimmed.featuredId));
  const kept = new Set(games.map((g) => g.id));
  const keep = (ids: string[]) => ids.filter((id) => kept.has(id));
  return {
    v: FIRST_PAINT_VERSION,
    savedAt: new Date(now).toISOString(),
    appearance: { theme: settings['appearance.theme'], reduceMotion: settings['motion.reduce'], quality: settings['appearance.quality'] },
    model: {
      ...trimmed,
      featuredId: trimmed.featuredId && kept.has(trimmed.featuredId) ? trimmed.featuredId : null,
      continueIds: keep(trimmed.continueIds),
      suggestions: trimmed.suggestions.filter((s) => kept.has(s.id)),
      favoriteIds: keep(trimmed.favoriteIds),
      recentIds: keep(trimmed.recentIds),
      never: { ...trimmed.never, picks: trimmed.never.picks.filter((p) => kept.has(p.id)), restIds: keep(trimmed.never.restIds) },
    },
    games,
  };
}

/** A stable fingerprint of what the snapshot shows (without its timestamp), to skip saving identical ones. */
export function firstPaintKey(fp: FirstPaint): string {
  return JSON.stringify({ ...fp, savedAt: '' });
}

// ---------------------------------------------------------------- reading

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown, max: number): string | undefined => (typeof x === 'string' && x.length <= max ? x : undefined);
const strOrNull = (x: unknown, max: number): string | null | undefined => (x === null ? null : str(x, max));
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 1e12 ? x : undefined);
const numOrNull = (x: unknown): number | null | undefined => (x === null ? null : typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const bool = (x: unknown): boolean | undefined => (typeof x === 'boolean' ? x : undefined);
const oneOf = <T extends string>(x: unknown, all: readonly T[]): T | undefined => (typeof x === 'string' && (all as readonly string[]).includes(x) ? (x as T) : undefined);
const id = (x: unknown): string | undefined => (typeof x === 'string' && ID.test(x) ? x : undefined);
const art = (x: unknown): string | null | undefined => (x === null || x === undefined ? null : typeof x === 'string' ? safeArt(x) ?? undefined : undefined);
const iso = (x: unknown): string | undefined => (typeof x === 'string' && x.length <= 40 && Number.isFinite(Date.parse(x)) ? x : undefined);
const isoOrNull = (x: unknown): string | null | undefined => (x === null || x === undefined ? null : iso(x));

class Invalid extends Error {}
function req<T>(v: T | undefined): T {
  if (v === undefined) throw new Invalid();
  return v;
}

function readInstallation(x: unknown): Installation {
  if (!isObj(x)) throw new Invalid();
  return {
    id: req(id(x.id)),
    platform: req(oneOf(x.platform, PLATFORMS)),
    platformGameId: req(str(x.platformGameId, 200)),
    title: req(str(x.title, 300)),
    state: req(oneOf(x.state, STATES)),
    installPath: null,
    drive: req(strOrNull(x.drive ?? null, 8)),
    sizeBytes: req(numOrNull(x.sizeBytes ?? null)),
    clientRequired: req(bool(x.clientRequired)),
    launchKind: req(oneOf(x.launchKind, LAUNCH)),
    importedLastPlayed: req(isoOrNull(x.importedLastPlayed)),
    importedPlaytimeMinutes: req(numOrNull(x.importedPlaytimeMinutes ?? null)),
    userLaunchArgs: null,
    manualLink: req(bool(x.manualLink ?? false)),
    lastSeen: req(str(x.lastSeen ?? '', 40)),
    // Track C1: an estimated last-played date stays labelled as one in the cached Home.
    ...(x.lastPlayedSource === 'saveData' ? { lastPlayedSource: 'saveData' as const } : {}),
  };
}

function readGame(x: unknown): Game {
  if (!isObj(x) || !isObj(x.art) || !Array.isArray(x.installations) || !Array.isArray(x.genres)) throw new Invalid();
  const a = x.art;
  return {
    id: req(id(x.id)),
    title: req(str(x.title, 300)),
    sortTitle: req(str(x.sortTitle, 300)),
    description: req(strOrNull(x.description ?? null, 2000)),
    developer: null,
    publisher: null,
    releaseDate: req(strOrNull(x.releaseDate ?? null, 40)),
    genres: x.genres.slice(0, 8).map((g) => req(str(g, 60))),
    favorite: req(bool(x.favorite)),
    hidden: false,
    userRating: req(numOrNull(x.userRating ?? null)),
    notes: null,
    preferredInstallationId: x.preferredInstallationId == null ? null : req(id(x.preferredInstallationId)),
    metadataSource: null,
    palette: req(strOrNull(x.palette ?? null, 600)),
    art: { cover: req(art(a.cover)), hero: req(art(a.hero)), logo: req(art(a.logo)), header: req(art(a.header)), icon: req(art(a.icon)) },
    installations: x.installations.slice(0, 8).map(readInstallation),
    collections: [],
    trackedSeconds: req(num(x.trackedSeconds)),
    sessionCount: req(num(x.sessionCount)),
    lastTrackedPlay: req(isoOrNull(x.lastTrackedPlay)),
    added: req(iso(x.added)),
    status: x.status == null ? null : req(oneOf(x.status, STATUSES)),
    statusChangedAt: req(isoOrNull(x.statusChangedAt)),
  };
}

function readModel(x: unknown, known: Set<string>): HomeModel {
  if (!isObj(x) || !isObj(x.never) || !isObj(x.pulse)) throw new Invalid();
  const ids = (v: unknown, max: number) => {
    if (!Array.isArray(v) || v.length > max) throw new Invalid();
    return v.map((i) => req(id(i))).filter((i) => known.has(i));
  };
  const reasons = (v: unknown, max: number) => {
    if (!Array.isArray(v) || v.length > max) throw new Invalid();
    return v
      .map((s) => {
        if (!isObj(s)) throw new Invalid();
        return { id: req(id(s.id)), reason: req(str(s.reason, 200)) };
      })
      .filter((s) => known.has(s.id));
  };
  const p = x.pulse;
  if (!Array.isArray(p.platforms) || p.platforms.length > PLATFORMS.length) throw new Invalid();
  const featuredId = x.featuredId == null ? null : req(id(x.featuredId));
  return {
    featuredId: featuredId && known.has(featuredId) ? featuredId : null,
    continueIds: ids(x.continueIds, 12),
    suggestions: reasons(x.suggestions, 12),
    favoriteIds: ids(x.favoriteIds, MAX_FAVORITES),
    favoriteCount: req(num(x.favoriteCount)),
    recentIds: ids(x.recentIds, 16),
    never: { count: req(num(x.never.count)), picks: reasons(x.never.picks, 3), restIds: ids(x.never.restIds, 24) },
    pulse: {
      installed: req(num(p.installed)),
      needsClient: req(num(p.needsClient)),
      missing: req(num(p.missing)),
      platforms: p.platforms.map((e) => {
        if (!Array.isArray(e) || e.length !== 2) throw new Invalid();
        return [req(oneOf(e[0], PLATFORMS)), req(num(e[1]))] as [PlatformKey, number];
      }),
    },
    visibleCount: req(num(x.visibleCount)),
  };
}

/** A validated, rebuilt snapshot, or null when anything about it is unexpected. Never throws. */
export function parseFirstPaint(raw: unknown): FirstPaint | null {
  try {
    if (!isObj(raw) || raw.v !== FIRST_PAINT_VERSION || !Array.isArray(raw.games) || raw.games.length > MAX_GAMES || !isObj(raw.appearance)) return null;
    const games = raw.games.map(readGame);
    const known = new Set(games.map((g) => g.id));
    if (known.size !== games.length) return null;
    const model = readModel(raw.model, known);
    if (model.visibleCount === 0) return null;
    const ap = raw.appearance;
    return {
      v: FIRST_PAINT_VERSION,
      savedAt: req(iso(raw.savedAt)),
      appearance: {
        theme: oneOf(ap.theme, THEMES) ?? 'obsidian',
        reduceMotion: oneOf(ap.reduceMotion, REDUCE) ?? 'system',
        quality: oneOf(ap.quality, QUALITY) ?? 'auto',
      },
      model,
      games,
    };
  } catch {
    return null;
  }
}

/**
 * The snapshot for this start, read once: in the app the host's document-created script set it; in the
 * browser preview it comes from localStorage, and only with `?firstpaint`.
 */
export function readFirstPaint(): FirstPaint | null {
  let raw: unknown = null;
  try {
    if (typeof window !== 'undefined' && window.chrome?.webview) {
      raw = globalThis.__vystralFirstPaint ?? null;
      globalThis.__vystralFirstPaint = undefined;
    } else if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('firstpaint')) {
      const s = localStorage.getItem(PREVIEW_KEY);
      raw = s ? JSON.parse(s) : null;
    }
  } catch {
    return null;
  }
  return raw == null ? null : parseFirstPaint(raw);
}

/** Puts the snapshot's theme on <html> before React renders, so the very first frame has the right colours. */
export function applyFirstPaintAppearance(fp: FirstPaint | null) {
  if (!fp || typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = fp.appearance.theme;
  const reduce = fp.appearance.reduceMotion === 'on' || (fp.appearance.reduceMotion === 'system' && matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  root.dataset.reducedMotion = String(!!reduce);
  const q = fp.appearance.quality;
  root.dataset.quality = q === 'auto' ? ((navigator.hardwareConcurrency ?? 8) <= 4 ? 'low' : 'balanced') : q;
}
