import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, LayoutGroup, motion, useTransform } from 'motion/react';
import { Clock3, CloudDownload, Pin, Timer, X as XIcon } from 'lucide-react';
import { call, errorMessage, on } from '../bridge/bridge';
import type { Game, GamepadButton, InstallProgress } from '../bridge/types';
import { formatDuration, formatRelative, importedMinutes, isInstalled, lastPlayed, PLATFORM_NAMES, plural } from '../lib/format';
import { haptic } from '../lib/haptics';
import { StoreLogo } from '../components/ui/StoreLogo';
import { pushPadHandler } from '../lib/input';
import { ease, pick, spring } from '../lib/motion';
import { paletteFor, peekPalette, titleHue } from '../lib/palette';
import { sound } from '../lib/sound';
import { moodFor } from '../lib/mood';
import { couchVars } from '../lib/couch';
import { takeEntryFocus } from '../lib/modeSwitch';
import { isWaiting } from '../lib/neverPlayed';
import { sentence, voiceOver } from '../lib/voiceover';
import { useVoiceOverSurface } from '../lib/useVoiceOver';
import { toggleFavorite } from '../state/actions';
import { setGameStatus } from '../state/statusActions';
import { ensureInstallsStarted, useInstalls } from '../state/installs';
import { useReducedMotion, useStore } from '../state/store';
import { OnScreenKeyboard, type OskFilters } from '../components/controller/OnScreenKeyboard';
import { GameCover } from '../components/game/GameCover';
import { openInStore } from '../components/game/InstallButton';
import { PadGlyph, PadHint } from '../components/ui/primitives';
import { CaptionBar } from '../components/voiceover/CaptionBar';
import { AttractMode } from './immersive/AttractMode';
import { GameLogo } from '../components/game/GameLogo';
import { HeroStage } from './immersive/HeroStage';
import { SystemBar } from './immersive/SystemBar';
import { QuickMenu, type QuickAction } from './immersive/QuickMenu';
import { GamePage, type PageTab } from './immersive/GamePage';
import { CouchSheet } from './immersive/CouchSheet';
import { Guide, type GuideAction } from './immersive/Guide';
import { VoiceSheet } from './immersive/VoiceSheet';
import { Tour, type TourStep } from './immersive/Tour';
import { DownloadFace, DownloadInfo, JumpFlash, JumpRail, PlayingFace, PlayingInfo, ToolChip } from './immersive/LiveTiles';
import { focusSpeech } from './immersive/speech';
import { leanX, leanY, nudge } from './immersive/parallax';
import {
  filterLabel, greeting, homeRows, jumpAt, LIBRARY_SORTS, libraryView, nextJump, normalizeSort, SORT_LABEL, tileGame, tileLabel,
  type Jump, type LibraryFilter, type LibrarySort, type LiveState, type Row, type Tile,
} from './immersive/rows';
import {
  applyFilter, clampRow, colOf, focusGame, INITIAL_NAV, moveNav, pick as pickTile, switchTab as switchNavTab, type ImmTab, type NavState,
} from './immersive/nav';
import './immersive.css';
import './immersive/immersive-t.css';

/** Rows mounted around the focused one. Others are exact-height placeholders. */
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 4;
/** Focused cards grow by this much; the ring grows with them (kept in sync with immersive.css). */
const FOCUS_SCALE = 1.06;
/** Holding X this long opens the quick menu (a shorter press toggles Favorite). */
const HOLD_X_MS = 420;
/** Re-entering Immersive within this long returns to the same row and card (Track T). */
const NAV_MEMORY_MS = 30 * 60_000;
const ACTIVE_PHASES = ['starting', 'waiting', 'running'];
const DOWNLOAD_PHASES: InstallProgress['phase'][] = ['queued', 'downloading', 'staging', 'paused'];

type SearchFilter = 'all' | 'installed' | 'favorites' | 'unplayed';

interface RingRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where Immersive was when it last closed (Track T: focus memory across visits). */
let memory: { nav: NavState; at: number; gameId: string | null } | null = null;

/** The game Immersive opens on: the one the switch zoomed into (Home rows first, else the grid); else where you left it. */
function entryNav(visible: Game[], collections: ReturnType<typeof useStore.getState>['library']['collections'], sort: ReturnType<typeof normalizeSort>): NavState {
  const id = takeEntryFocus();
  // Back from the desktop on the game you left from (or with no particular game): exactly where you were.
  const remembered = memory && Date.now() - memory.at < NAV_MEMORY_MS ? memory : null;
  if (remembered && (!id || id === remembered.gameId)) return remembered.nav;
  if (!id) return INITIAL_NAV;
  const home = focusGame(INITIAL_NAV, homeRows(visible, collections, Date.now(), new Date().getHours()), id);
  if (home !== INITIAL_NAV) return home;
  const lib = { ...INITIAL_NAV, tab: 'library' as const };
  const inLib = focusGame(lib, libraryView(visible, null, sort, Date.now()).rows, id);
  return inLib !== lib ? inLib : INITIAL_NAV;
}

/** Brings the running game back to the front (never launches anything). */
function returnToGame(game: Game) {
  const toast = useStore.getState().toast;
  if (useStore.getState().launch?.phase !== 'running') {
    toast({ tone: 'info', title: `${game.title} is still starting`, body: 'It comes to the front by itself once its window opens.' });
    return;
  }
  void call<boolean>('game.focus')
    .then((ok) => {
      if (ok === false) toast({ tone: 'info', title: `Couldn’t switch to ${game.title}`, body: 'Windows didn’t let VYSTRAL bring it forward. Use Alt+Tab to switch to it.' });
    })
    .catch((err) => toast({ tone: 'info', title: `Couldn’t switch to ${game.title}`, body: errorMessage(err) }));
}

/**
 * Immersive Mode: an independent, controller-first 10-foot layout (Track L overhaul, Track T).
 * - A hero stage: the focused game's art full-bleed with its live loop when allowed, leaning
 *   with each D-pad move (parallax); its palette glow crossfades between games.
 * - Rows ordered by time of day (Continue always first, with a pinned "last played" slot), plus
 *   Now playing (return to the running game), Downloads, collections and browse rows.
 * - All games: a toolbar of sort and filter chips (store logos) over the grid; LT/RT jump between
 *   letters (or time bands) with a rail and a big letter flash.
 * - One travelling focus ring tinted by the game's palette; spatial sounds follow it.
 * - Hold X / View for a radial quick menu; A opens a tabbed game page; Y searches; Menu opens the
 *   guide (desktop mode, display, voice-over, settings, close VYSTRAL).
 * - Voice-over and captions (off by default) read the focused game, rows, menus and notices.
 * - Leaving lands the desktop on the game you were on.
 */
export function ImmersiveView() {
  const games = useStore((s) => s.library.games);
  const gamesById = useStore((s) => s.gamesById);
  const collections = useStore((s) => s.library.collections);
  const settings = useStore((s) => s.settings);
  const setMode = useStore((s) => s.setMode);
  const setFocusGame = useStore((s) => s.setFocusGame);
  const setSetting = useStore((s) => s.setSetting);
  const launchGame = useStore((s) => s.launchGame);
  const reduce = useReducedMotion();
  const sort = normalizeSort(settings?.['immersive.librarySort']);
  const voiceOn = !!settings?.['voiceover.enabled'];

  useVoiceOverSurface({ focusRoot: ':is(.imm-panel, .imm-quick, .imm-couch, .imm-guide, .osk)' });

  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);
  const [nav, setNav] = useState<NavState>(() => entryNav(visible, collections, sort));
  const [hour, setHour] = useState(() => new Date().getHours());
  const [panel, setPanel] = useState<{ id: string; tab: PageTab } | null>(null);
  const [attract, setAttract] = useState(false);
  const [search, setSearch] = useState(false);
  const [searchFilter, setSearchFilter] = useState<SearchFilter>('all');
  const [quick, setQuick] = useState<{ id: string; anchor: { x: number; y: number } } | null>(null);
  const [couch, setCouch] = useState(false);
  const [guide, setGuide] = useState(false);
  const [voiceSheet, setVoiceSheet] = useState(false);
  const [holdingX, setHoldingX] = useState(false);
  const [gliding, setGliding] = useState(false);
  const [tourDone, setTourDone] = useState<Set<TourStep>>(() => new Set());
  const [filterOrigin, setFilterOrigin] = useState<NavState | null>(null);
  const [flash, setFlash] = useState<{ label: string; n: number } | null>(null);

  // Re-order rows when the part of the day changes (checked every few minutes).
  useEffect(() => {
    const t = window.setInterval(() => setHour(new Date().getHours()), 5 * 60_000);
    return () => window.clearInterval(t);
  }, []);

  // ---------------------------------------------------------------- live rows (Track T)
  const launch = useStore((s) => s.launch);
  const playingGame = launch && ACTIVE_PHASES.includes(launch.phase) ? gamesById.get(launch.gameId) ?? null : null;
  const playingPhase = playingGame ? launch!.phase : null;
  const playingStart = playingGame ? launch!.startedAt : null;
  useEffect(() => ensureInstallsStarted(), []);
  // Only the set of downloads rebuilds the rows; their progress is read live by the tiles.
  const downloadKey = useInstalls((s) =>
    Object.values(s.byGame)
      .filter((p) => p.watching && p.kind !== 'uninstall' && DOWNLOAD_PHASES.includes(p.phase))
      .map((p) => p.gameId)
      .sort()
      .join('|'),
  );
  const live = useMemo<LiveState>(() => {
    const byGame = useInstalls.getState().byGame;
    const downloads = downloadKey
      ? downloadKey.split('|').flatMap((id) => {
          const game = gamesById.get(id);
          return game && !game.hidden && byGame[id] ? [{ game, progress: byGame[id] }] : [];
        })
      : [];
    return { playing: playingGame && playingPhase ? { game: playingGame, phase: playingPhase, startedAt: playingStart } : null, downloads };
  }, [downloadKey, gamesById, playingGame, playingPhase, playingStart]);

  const view = useMemo<{ rows: Row[]; jumps: Jump[] }>(
    () => (nav.tab === 'home' ? { rows: homeRows(visible, collections, Date.now(), hour, live), jumps: [] } : libraryView(visible, nav.filter, sort, Date.now())),
    [visible, collections, hour, nav.tab, nav.filter, live, sort],
  );
  const rows = view.rows;
  const row = clampRow(nav, rows);
  const current = rows[row];
  const col = colOf(nav, rows, row);
  const tile: Tile | null = current?.tiles[col] ?? null;
  const focused = tileGame(tile);
  const focusedGame = tile && (tile.kind === 'game' || tile.kind === 'playing' || tile.kind === 'download') ? tile.game : null;
  const here = nav.tab === 'library' ? jumpAt(view.jumps, row, col) : null;

  useEffect(() => {
    if (focused) setFocusGame(focused.id);
  }, [focused, setFocusGame]);

  // While a direction auto-repeats (momentum), the full-screen hero art waits until focus slows
  // down instead of crossfading on every step: far less to paint, and it reads calmer.
  const [lagged, setLagged] = useState<Game | null>(null);
  useEffect(() => {
    if (!gliding) return;
    const t = window.setTimeout(() => setLagged(focused), 160);
    return () => window.clearTimeout(t);
  }, [focused, gliding]);
  const stageGame = gliding ? lagged : focused;

  // The ring and the stage glow take the focused game's palette (accent + its second colour).
  const [palette, setPalette] = useState<{ id: string; a: string; b: string } | null>(null);
  useEffect(() => {
    if (!focused) return;
    const peek = peekPalette(focused);
    if (peek) {
      setPalette({ id: focused.id, a: peek.accent, b: peek.accent2 });
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      void paletteFor(focused).then((p) => alive && setPalette({ id: focused.id, a: p.accent, b: p.accent2 }));
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [focused]);
  const fallbackHue = focused ? titleHue(focused.title) : 292;
  const ringA = palette && focused && palette.id === focused.id ? palette.a : `oklch(0.75 0.15 ${fallbackHue})`;
  const ringB = palette && focused && palette.id === focused.id ? palette.b : `oklch(0.7 0.14 ${(fallbackHue + 40) % 360})`;
  // The palette colours go only on the few elements that use them: setting them on the Immersive
  // root would restyle every card on every focus move.
  const ringVars = useMemo(() => ({ ['--ring' as string]: ringA, ['--ring-2' as string]: ringB }) as CSSProperties, [ringA, ringB]);

  // Couch mode: text scale on the root (Immersive sizes everything in rem) and the overscan safe area.
  useLayoutEffect(() => {
    const vars = couchVars(settings?.['immersive.scale'], settings?.['immersive.safeArea']);
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    return () => {
      for (const k of Object.keys(vars)) root.style.removeProperty(k);
    };
  }, [settings]);

  const tourActive = !!settings && !settings['immersive.tourDone'] && !attract;
  const markTour = useCallback((step: TourStep) => {
    setTourDone((s) => (s.has(step) ? s : new Set(s).add(step)));
  }, []);
  const finishTour = useCallback(() => {
    void setSetting('immersive.tourDone', true);
  }, [setSetting]);

  // ---------------------------------------------------------------- feedback
  const ringRef = useRef<RingRect | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const glideTimer = useRef<number | undefined>(undefined);
  const glidingRef = useRef(false);
  /** The user moved or opened something here: leaving lands the desktop on that game. */
  const engaged = useRef(false);
  const onRing = useCallback((r: RingRect) => {
    ringRef.current = r;
  }, []);

  /** Spatial sound for a move: read the ring's landing spot after this frame's layout. */
  const spatial = useCallback((kind: 'focus' | 'row' | 'edge' | 'select', depth: number, fromDepth: number, game: Game | null) => {
    if (!useStore.getState().settings?.['sounds.enabled']) return;
    // After this move's render the ring ref holds the new target (screen coordinates, no layout read).
    requestAnimationFrame(() => {
      const ring = ringRef.current;
      const x = ring ? ring.x + ring.w / 2 : innerWidth * 0.25;
      sound.spatial(kind, moodFor(game), { x, width: innerWidth, depth, fromDepth });
    });
  }, []);

  // ---------------------------------------------------------------- voice-over: the focused tile
  const spoken = useRef<{ row: string | null; tab: ImmTab | null; prefix: string; key: string }>({ row: null, tab: null, prefix: '', key: '' });
  const overlayOpen = !!(panel || quick || search || couch || guide || voiceSheet || attract);
  const speakNow = useRef({ tile, current });
  useLayoutEffect(() => {
    speakNow.current = { tile, current };
  });
  const tileKey = tile?.key ?? null;
  const rowKey = current?.id ?? null;
  useEffect(() => {
    // Keyed on the tile and row ids: rows being rebuilt (a download ticking, the library refreshing) say nothing.
    const { tile, current } = speakNow.current;
    const s = spoken.current;
    if (!voiceOn || gliding || !tile || !current) return;
    if (overlayOpen) {
      s.key = ''; // said again when the overlay closes, so you know where you landed
      return;
    }
    // The same focus again (a re-render, React's development double effects) says nothing new.
    const key = `${nav.tab}|${current.id}|${tile.key}`;
    if (s.key === key) return;
    s.key = key;
    const tabChanged = s.tab !== nav.tab;
    const rowChanged = s.row !== current.id;
    const prefix = [tabChanged && s.tab !== null ? (nav.tab === 'home' ? 'Home' : 'All games') : '', s.prefix].filter(Boolean).join('. ');
    s.tab = nav.tab;
    s.row = current.id;
    s.prefix = '';
    voiceOver.say(sentence(prefix, focusSpeech(current, tile, { rowChanged })), 'focus');
    // Re-said when an overlay closes, so you always know where you landed.
  }, [voiceOn, gliding, overlayOpen, tileKey, rowKey, nav.tab]);

  // ---------------------------------------------------------------- actions
  const latest = useRef({ nav, rows, row, col, tile, focused, focusedGame, panel, search, quick, couch, guide, voiceSheet, attract, tourActive, filterOrigin, jumps: view.jumps });
  useLayoutEffect(() => {
    latest.current = { nav, rows, row, col, tile, focused, focusedGame, panel, search, quick, couch, guide, voiceSheet, attract, tourActive, filterOrigin, jumps: view.jumps };
  });

  // Remember where we were for the next visit.
  useEffect(
    () => () => {
      memory = { nav: latest.current.nav, at: Date.now(), gameId: latest.current.focusedGame?.id ?? null };
    },
    [],
  );

  const startGlide = useCallback(() => {
    const L = latest.current;
    // The stage holds the game it showed when the glide began.
    if (!glidingRef.current) setLagged(L.focused);
    glidingRef.current = true;
    setGliding(true);
    window.clearTimeout(glideTimer.current);
    glideTimer.current = window.setTimeout(() => {
      glidingRef.current = false;
      setGliding(false);
    }, 200);
  }, []);

  const move = useCallback(
    (dr: number, dc: number, repeat: boolean) => {
      const L = latest.current;
      const r = moveNav(L.nav, L.rows, dr, dc);
      if (r.effect === 'edge') {
        haptic('edge');
        spatial('edge', L.row, L.row, L.focused);
        return;
      }
      if (!r.effect) return;
      // Several repeats can land before React re-renders: the next one must start from this state.
      L.nav = r.state;
      setNav(r.state);
      engaged.current = true;
      markTour('move');
      const nextRow = clampRow(r.state, L.rows);
      const nextGame = tileGame(L.rows[nextRow]?.tiles[colOf(r.state, L.rows, nextRow)]);
      if (r.effect === 'row') {
        haptic('tick');
        spatial('row', nextRow, L.row, nextGame);
      } else spatial('focus', nextRow, L.row, nextGame);
      if (!reduce) nudge(dc, dr);
      // Momentum: while a direction auto-repeats, the shelves glide and labels step aside.
      if (repeat) startGlide();
    },
    [markTour, reduce, spatial, startGlide],
  );

  /** LT/RT in All games: to the previous/next letter (or band). */
  const jump = useCallback(
    (dir: 1 | -1, repeat: boolean, target?: Jump) => {
      const L = latest.current;
      const j = target ?? nextJump(L.jumps, L.row, L.nav.cols[L.rows[L.row]?.id ?? ''] ?? 0, dir);
      if (!j) {
        haptic('edge');
        spatial('edge', L.row, L.row, L.focused);
        return;
      }
      const next = pickTile(L.nav, L.rows, j.row, j.col);
      L.nav = next;
      setNav(next);
      engaged.current = true;
      setFlash((f) => ({ label: j.label, n: (f?.n ?? 0) + 1 }));
      spoken.current.prefix = j.label.length === 1 ? `Letter ${j.label}` : j.label;
      haptic('tick');
      spatial('row', j.row, L.row, tileGame(L.rows[j.row]?.tiles[j.col]));
      if (repeat) startGlide();
    },
    [spatial, startGlide],
  );
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 700);
    return () => window.clearTimeout(t);
  }, [flash]);

  const switchTab = useCallback(
    (t?: ImmTab) => {
      setNav((n) => switchNavTab(n, t));
      setFilterOrigin(null);
      sound.select();
      haptic('tick');
      markTour('sections');
    },
    [markTour],
  );

  const openPage = useCallback(
    (g: Game, tab: PageTab = 'overview') => {
      setPanel({ id: g.id, tab });
      engaged.current = true;
      sound.select();
      haptic('tick');
      markTour('search');
    },
    [markTour],
  );

  const applyTool = useCallback(
    (t: Extract<Tile, { kind: 'tool' }>) => {
      const tool = t.tool;
      if (tool.type === 'sort') {
        const next = LIBRARY_SORTS[(LIBRARY_SORTS.indexOf(tool.sort) + 1) % LIBRARY_SORTS.length];
        void setSetting('immersive.librarySort', next);
        setNav((n) => {
          const cols = { ...n.cols };
          for (const id of Object.keys(cols)) if (id.startsWith('lib-')) delete cols[id];
          return { ...n, cols, rowId: 'tools' };
        });
        voiceOver.say(`Sort: ${SORT_LABEL[next]}`, 'nav');
      } else {
        setFilterOrigin(null);
        setNav((n) => ({ ...applyFilter(n, tool.filter), rowId: 'tools' }));
        voiceOver.say(sentence(`Showing ${tool.filter ? filterLabel(tool.filter) : 'all games'}`, plural(tool.count, 'game')), 'nav');
      }
      sound.select();
      haptic('tick');
    },
    [setSetting],
  );

  const openTile = useCallback(
    (t: Tile | null) => {
      if (!t) return;
      switch (t.kind) {
        case 'game': case 'download': return openPage(t.game);
        case 'playing':
          haptic('confirm');
          sound.select();
          return returnToGame(t.game);
        case 'tool': return applyTool(t);
        case 'store': case 'genre': {
          const filter: LibraryFilter = t.kind === 'store' ? { kind: 'store', platform: t.platform } : { kind: 'genre', genre: t.genre };
          setFilterOrigin(latest.current.nav);
          setNav((n) => applyFilter(n, filter));
          sound.select();
          haptic('tick');
        }
      }
    },
    [openPage, applyTool],
  );

  const clearFilter = useCallback(() => {
    const origin = latest.current.filterOrigin;
    setNav((n) => (origin ? origin : applyFilter(n, null)));
    setFilterOrigin(null);
    sound.back();
    haptic('tick');
  }, []);

  const openQuick = useCallback(() => {
    const g = latest.current.focusedGame;
    if (!g) {
      haptic('edge');
      return;
    }
    const el = document.querySelector('.imm__ring')?.getBoundingClientRect();
    setQuick({ id: g.id, anchor: el ? { x: el.left + el.width / 2, y: el.top + el.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 } });
    sound.select();
    haptic('tick');
    markTour('quick');
  }, [markTour]);

  const openSearch = useCallback(() => {
    setSearch(true);
    sound.select();
    markTour('search');
  }, [markTour]);

  const openGuide = useCallback(() => {
    setGuide(true);
    sound.select();
    haptic('tick');
  }, []);

  /** Leaves for the desktop. If you moved or opened something here, the desktop opens on that game. */
  const exitToDesktop = useCallback(() => {
    const g = latest.current.focusedGame;
    if (engaged.current && g) useStore.getState().navigate({ name: 'game', id: g.id });
    void setMode('desktop');
  }, [setMode]);

  /** Opens a game picked from search, leaving focus on it when the page closes. */
  const openFromSearch = useCallback(
    (g: Game) => {
      setSearch(false);
      const L = latest.current;
      const found = focusGame(L.nav, L.rows, g.id);
      if (found !== L.nav) setNav(found);
      else {
        const lib = { ...L.nav, tab: 'library' as const, filter: null, row: 0, rowId: null };
        setNav(focusGame(lib, libraryView(visible, null, sort, Date.now()).rows, g.id));
      }
      openPage(g);
    },
    [visible, sort, openPage],
  );

  const runQuick = useCallback(
    (a: QuickAction) => {
      const g = quick ? useStore.getState().gamesById.get(quick.id) : null;
      setQuick(null);
      if (!g) return;
      switch (a.kind) {
        case 'play':
          sound.launch();
          void launchGame(g.id);
          return;
        case 'install':
          void call('steam.install', { gameId: g.id }).catch(() => useStore.getState().toast({ tone: 'danger', title: 'Steam couldn’t be asked to install it' }));
          return;
        case 'favorite':
          void toggleFavorite(g);
          return;
        case 'status':
          void setGameStatus(g, a.status);
          return;
        case 'achievements':
          openPage(g, 'achievements');
          return;
        case 'store': {
          const inst = g.installations.find((i) => i.platform !== 'manual');
          if (inst) openInStore(inst);
          return;
        }
        case 'display':
          setCouch(true);
          return;
      }
    },
    [quick, launchGame, openPage],
  );

  const runGuide = useCallback(
    (a: GuideAction) => {
      setGuide(false);
      switch (a) {
        case 'resume': {
          const l = useStore.getState().launch;
          const g = l ? useStore.getState().gamesById.get(l.gameId) : null;
          if (g) returnToGame(g);
          return;
        }
        case 'desktop':
          return exitToDesktop();
        case 'display':
          return setCouch(true);
        case 'voice':
          return setVoiceSheet(true);
        case 'settings':
          useStore.getState().navigate({ name: 'settings', section: 'controller' });
          void setMode('desktop');
          return;
        case 'close':
          haptic('confirm');
          void call('window.close').catch(() => {});
          return;
      }
    },
    [exitToDesktop, setMode],
  );

  // ---------------------------------------------------------------- input
  const xTimer = useRef<number | null>(null);
  const cancelHoldX = () => {
    if (xTimer.current !== null) window.clearTimeout(xTimer.current);
    xTimer.current = null;
    setHoldingX(false);
  };

  const handle = (button: GamepadButton | string, repeat: boolean): boolean => {
    const L = latest.current;
    if (L.attract) return true; // AttractMode's own handler sits above this one and wakes it
    // Escape closes the game page even before focus has moved into it (e.g. straight after search).
    if (L.panel && button === 'Escape') {
      setPanel(null);
      sound.back();
      return true;
    }
    // Anything modal (game page, quick menu, search, display, guide, launch overlay, desktop dialogs) owns input.
    if (L.panel || L.quick || L.couch || L.search || L.guide || L.voiceSheet) return false;
    if (document.querySelector('[data-dialog-open], [data-nav-scope="overlay"]')) return false;
    switch (button) {
      case 'Up': case 'ArrowUp': move(-1, 0, repeat); return true;
      case 'Down': case 'ArrowDown': move(1, 0, repeat); return true;
      case 'Left': case 'ArrowLeft': move(0, -1, repeat); return true;
      case 'Right': case 'ArrowRight': move(0, 1, repeat); return true;
      case 'LT': case 'RT': case 'PageUp': case 'PageDown': {
        const back = button === 'LT' || button === 'PageUp';
        // All games: jump by letter (or band). Home: page through rows quickly.
        if (L.nav.tab === 'library' && L.jumps.length > 1) {
          jump(back ? -1 : 1, repeat);
          return true;
        }
        const target = Math.max(0, Math.min(L.rows.length - 1, L.row + (back ? -3 : 3)));
        if (target === L.row) haptic('edge');
        else move(target - L.row, 0, repeat);
        return true;
      }
      case 'A': case 'Enter': case ' ':
        if (!repeat) openTile(L.tile);
        return true;
      case 'LB': case 'RB': case 'q': case 'e':
        if (!repeat) switchTab();
        return true;
      case 'Y': case 'y':
        if (!repeat) openSearch();
        return true;
      case 'X':
        // Controller: a tap toggles Favorite (on release), holding opens the quick menu.
        if (repeat || xTimer.current !== null) return true;
        if (!L.focusedGame) {
          haptic('edge');
          return true;
        }
        setHoldingX(true);
        xTimer.current = window.setTimeout(() => {
          xTimer.current = null;
          setHoldingX(false);
          openQuick();
        }, HOLD_X_MS);
        return true;
      case 'x':
        if (!repeat && L.focusedGame) void toggleFavorite(L.focusedGame);
        return true;
      case 'View': case 'm': case 'ContextMenu':
        if (!repeat) openQuick();
        return true;
      case 'B': case 'Escape': case 'Backspace':
        if (repeat) return true;
        if (L.nav.filter) clearFilter();
        else if (L.tourActive) finishTour();
        return true;
      case 'Menu': case 'g':
        if (!repeat) openGuide();
        return true;
      case 'F11':
        if (!repeat) exitToDesktop();
        return true;
      default:
        return false;
    }
  };
  const handleRef = useRef(handle);
  useLayoutEffect(() => {
    handleRef.current = handle;
  });

  // Registered once, so overlays opened later (attract, game page, search, quick menu) always sit above it.
  useEffect(() => pushPadHandler((b, r) => handleRef.current(b, r)), []);
  useEffect(() => {
    // X released before the hold completed: that was a tap → Favorite.
    const off = on('gamepad.button', ({ button, pressed }) => {
      if (button !== 'X' || pressed || xTimer.current === null) return;
      cancelHoldX();
      const g = latest.current.focusedGame;
      if (g) {
        void toggleFavorite(g);
        haptic('tick');
      }
    });
    const offConn = on('gamepad.connection', () => cancelHoldX());
    return () => {
      off();
      offConn();
      cancelHoldX();
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea') || useStore.getState().commandOpen) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (handleRef.current(e.key, e.repeat)) e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // ---------------------------------------------------------------- search filters
  const searchGames = useMemo(() => {
    switch (searchFilter) {
      case 'installed': return visible.filter(isInstalled);
      case 'favorites': return visible.filter((g) => g.favorite);
      case 'unplayed': return visible.filter(isWaiting);
      default: return visible;
    }
  }, [visible, searchFilter]);
  const oskFilters = useMemo<OskFilters>(
    () => ({
      value: searchFilter,
      onChange: (id) => setSearchFilter(id as SearchFilter),
      options: [
        { id: 'all', label: 'All', count: visible.length },
        { id: 'installed', label: 'Installed', count: visible.filter(isInstalled).length },
        { id: 'favorites', label: 'Favorites', count: visible.filter((g) => g.favorite).length },
        { id: 'unplayed', label: 'Never played', count: visible.filter(isWaiting).length },
      ].filter((o) => o.id === 'all' || o.count > 0),
    }),
    [visible, searchFilter],
  );

  const quickGame = useStore((s) => (quick ? s.gamesById.get(quick.id) ?? null : null));
  const lean = useTransform(leanX, (v) => v * -4);
  const leanInfoY = useTransform(leanY, (v) => v * -2);
  const voiceState = !voiceOn ? 'Off' : settings?.['voiceover.captionsOnly'] ? 'Captions only' : 'On';
  const primary = tile?.kind === 'playing' ? 'Return to game' : tile?.kind === 'tool' ? (tile.tool.type === 'sort' ? 'Change sort' : 'Show') : tile && tile.kind !== 'game' && tile.kind !== 'download' ? 'Browse' : 'Open';

  return (
    <LayoutGroup>
      <div
        className="imm"
        data-reduced={reduce}
        data-gliding={gliding || undefined}
        data-quick-open={!!quick || undefined}
        data-tab={nav.tab}
      >
        <HeroStage game={stageGame} tint={ringA} tint2={ringB} />
        <header className="imm__top">
          <img src="./vystral-mark.svg" alt="" className="imm__mark" />
          <nav className="imm__tabs" aria-label="Sections">
            <PadGlyph button="LB" />
            {(['home', 'library'] as ImmTab[]).map((t) => (
              <button key={t} className="imm__tab" aria-current={nav.tab === t ? 'page' : undefined} onClick={() => t !== nav.tab && switchTab(t)}>
                {t === 'home' ? 'Home' : 'All games'}
                {nav.tab === t && <motion.span layoutId="imm-tab" className="imm__tab-bar" transition={pick(reduce, spring.focus)} />}
              </button>
            ))}
            <PadGlyph button="RB" />
          </nav>
          <AnimatePresence>
            {nav.filter && (
              <motion.button
                key="filter"
                className="imm__filter"
                style={ringVars}
                onClick={clearFilter}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -6 }}
                transition={pick(reduce, spring.panel)}
                aria-label={`Showing ${filterLabel(nav.filter)}. Clear filter`}
              >
                {nav.filter.kind === 'store' && <StoreLogo platform={nav.filter.platform} size={16} decorative />}
                {filterLabel(nav.filter)}
                <span className="imm__filter-x"><PadGlyph button="B" /><XIcon size="0.9em" aria-hidden /></span>
              </motion.button>
            )}
          </AnimatePresence>
          {nav.tab === 'home' && <span className="imm__greeting">{greeting(hour)}</span>}
          <SystemBar onDisplay={() => setCouch(true)} />
        </header>

        <motion.section className="imm__info" aria-live="polite" style={reduce ? ringVars : { ...ringVars, x: lean, y: leanInfoY }}>
          {/* Old and new info share one grid cell and crossfade, so fast browsing never blanks it. */}
          <AnimatePresence initial={false}>
            {tile && (
              <motion.div
                key={tile.kind === 'tool' ? 'tools' : tile.key}
                className="imm__info-item"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: 'blur(4px)', transition: { duration: 0.18, ease: ease.in } }}
                transition={pick(reduce, spring.panel)}
              >
                <TileInfo tile={tile} row={current} sort={sort} />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.section>

        <section className="imm__rows" aria-label="Games">
          {rows.length === 0 ? (
            <p className="imm__empty">No games yet. Press the Menu button and choose Desktop mode, where you can scan your stores or add games.</p>
          ) : (
            <RowsTrack
              rows={rows}
              activeRow={row}
              activeCol={col}
              cols={nav.cols}
              ringVars={ringVars}
              ringHidden={!!panel || !!quick || !!guide}
              holding={holdingX}
              viewportRef={viewportRef}
              onRing={onRing}
              onPick={(r, c) => setNav((n) => pickTile(n, rows, r, c))}
              onOpen={openTile}
            />
          )}
          {nav.tab === 'library' && sort === 'az' && <JumpRail jumps={view.jumps} current={here} below={current?.kind === 'tools'} onJump={(j) => jump(1, false, j)} />}
          <JumpFlash flash={flash} />
        </section>

        <footer className="imm__hints">
          <span className="imm__hint"><PadHint button="A">{primary}</PadHint></span>
          {focusedGame && <span className="imm__hint"><PadHint button="X">Favorite</PadHint></span>}
          <button type="button" className="imm__hint imm__hint--btn" onClick={openQuick} disabled={!focusedGame}>
            <PadHint button="View">Quick menu</PadHint>
          </button>
          <button type="button" className="imm__hint imm__hint--btn" onClick={openSearch}>
            <PadHint button="Y">Search</PadHint>
          </button>
          <span className="imm__hint"><PadHint button={['LB', 'RB']}>Sections</PadHint></span>
          {nav.tab === 'library' && view.jumps.length > 1 && (
            <span className="imm__hint"><PadHint button={['LT', 'RT']}>{sort === 'az' ? 'Jump to letter' : 'Jump'}</PadHint></span>
          )}
          <button type="button" className="imm__exit" onClick={openGuide} aria-label="Menu: desktop mode, display, voice-over, settings">
            <PadHint button="Menu">Menu</PadHint>
          </button>
        </footer>

        {/* Overlays read the palette colours from this scope (display: contents, so it adds no box). */}
        <div className="imm__scope" style={ringVars}>
        {tourActive && <Tour done={tourDone} onFinish={finishTour} />}

        <AnimatePresence>
          {panel && (
            <GamePage
              key={panel.id}
              gameId={panel.id}
              tab={panel.tab}
              onTab={(t) => setPanel((p) => (p ? { ...p, tab: t } : p))}
              onClose={() => setPanel(null)}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {quick && quickGame && <QuickMenu key={quick.id} game={quickGame} anchor={quick.anchor} onAction={runQuick} onClose={() => setQuick(null)} />}
        </AnimatePresence>
        <AnimatePresence>{couch && <CouchSheet key="couch" onClose={() => setCouch(false)} />}</AnimatePresence>
        <AnimatePresence>{voiceSheet && <VoiceSheet key="voice" onClose={() => setVoiceSheet(false)} />}</AnimatePresence>
        <AnimatePresence>{guide && <Guide key="guide" voiceState={voiceState} onAction={runGuide} onClose={() => setGuide(false)} />}</AnimatePresence>
        <AnimatePresence>
          {search && <OnScreenKeyboard key="osk" games={searchGames} filters={oskFilters} onClose={() => setSearch(false)} onOpenGame={openFromSearch} />}
        </AnimatePresence>
        </div>
        <AttractMode games={visible} active={attract} onActiveChange={setAttract} />
        <CaptionBar className="imm-captions" />
      </div>
    </LayoutGroup>
  );
}

/* ------------------------------------------------------------------ info */

function TileInfo({ tile, row, sort }: { tile: Tile; row: Row | undefined; sort: LibrarySort }) {
  switch (tile.kind) {
    case 'playing': return <PlayingInfo tile={tile} />;
    case 'download': return <DownloadInfo tile={tile} />;
    case 'tool':
      return (
        <>
          <h1 className="imm__title imm__title--section">{activeFilterTitle(row)}</h1>
          <div className="imm__meta">
            <span>{plural(activeCount(row), 'game')}</span>
            <span>{sort === 'az' ? 'Sorted A to Z' : `Sorted by ${SORT_LABEL[sort].toLowerCase()}`}</span>
          </div>
        </>
      );
    case 'store':
      return (
        <>
          <div className="imm__browse-title">
            <StoreLogo platform={tile.platform} size={56} decorative />
            <h1 className="imm__title">{PLATFORM_NAMES[tile.platform]}</h1>
          </div>
          <div className="imm__meta"><span>{plural(tile.count, 'game')} from this store</span><PadHint button="A">Browse</PadHint></div>
        </>
      );
    case 'genre':
      return (
        <>
          <h1 className="imm__title">{tile.genre}</h1>
          <div className="imm__meta"><span>{plural(tile.count, 'game')}</span><PadHint button="A">Browse</PadHint></div>
        </>
      );
    case 'game': {
      const game = tile.game;
      return (
        <>
          {tile.pinned && (
            <span className="imm__pinned">
              <Pin size="0.9em" aria-hidden /> Jump back in
            </span>
          )}
          {game.art.logo ? <GameLogo className="imm__logo" src={game.art.logo} alt={game.title} /> : <h1 className="imm__title">{game.title}</h1>}
          <GameMeta game={game} />
          {game.description && <p className="imm__desc">{game.description}</p>}
        </>
      );
    }
  }
}

/** The toolbar's heading: what the grid shows now ("All games", "Steam", "Installed"…). */
function activeFilterTitle(row: Row | undefined): string {
  const active = row?.tiles.find((t) => t.kind === 'tool' && t.tool.type === 'filter' && t.tool.active);
  return active?.kind === 'tool' && active.tool.type === 'filter' && active.tool.filter ? active.tool.label : 'All games';
}

function activeCount(row: Row | undefined): number {
  const active = row?.tiles.find((t) => t.kind === 'tool' && t.tool.type === 'filter' && t.tool.active);
  return active?.kind === 'tool' && active.tool.type === 'filter' ? active.tool.count : 0;
}

function GameMeta({ game }: { game: Game }) {
  const lp = lastPlayed(game);
  const imported = importedMinutes(game);
  const platforms = [...new Set(game.installations.map((i) => i.platform))];
  return (
    <div className="imm__meta">
      <span className="imm__meta-stores">
        {platforms.map((p) => (
          <span key={p} className="imm__store">
            <StoreLogo platform={p} size={20} decorative />
            {PLATFORM_NAMES[p]}
          </span>
        ))}
      </span>
      {lp.at && <span><Clock3 size="0.9em" aria-hidden /> {formatRelative(lp.at)}</span>}
      {game.trackedSeconds > 0 && <span><Timer size="0.9em" aria-hidden /> {formatDuration(game.trackedSeconds)} tracked</span>}
      {imported ? <span>{formatDuration(imported * 60)} in store</span> : null}
      {!isInstalled(game) && <span className="imm__warn">Not installed</span>}
      {game.genres.length > 0 && <span className="imm__genres">{game.genres.slice(0, 3).join(' · ')}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ rows */

interface Metrics {
  /** Viewport's left edge on screen, its inner padding and width. */
  left: number;
  pad: number;
  vw: number;
  gap: number;
  pw: number;
  ph: number;
  ww: number;
  wh: number;
  pinW: number;
  titleH: number;
  rowH: number;
  rowWideH: number;
  chipW: number;
  sortW: number;
  chipH: number;
  chipGap: number;
  rowChipH: number;
}

/** Card and row geometry, read from a hidden probe that uses the same CSS variables as the cards. */
function measureMetrics(viewport: HTMLElement, probe: HTMLElement): Metrics {
  const q = (c: string) => probe.querySelector<HTMLElement>(c)!;
  return {
    left: viewport.getBoundingClientRect().left,
    pad: parseFloat(getComputedStyle(viewport).paddingLeft) || 0,
    vw: viewport.clientWidth,
    gap: q('.imm__probe-gap').offsetWidth,
    pw: q('.imm__probe-card').offsetWidth,
    ph: q('.imm__probe-card').offsetHeight,
    ww: q('.imm__probe-wide').offsetWidth,
    wh: q('.imm__probe-wide').offsetHeight,
    pinW: q('.imm__probe-pin').offsetWidth,
    titleH: q('.imm__probe-title').offsetHeight,
    rowH: q('.imm__probe-row').offsetHeight,
    rowWideH: q('.imm__probe-roww').offsetHeight,
    chipW: q('.imm__probe-chip').offsetWidth,
    sortW: q('.imm__probe-sort').offsetWidth,
    chipH: q('.imm__probe-chip').offsetHeight,
    chipGap: q('.imm__probe-chipgap').offsetWidth,
    rowChipH: q('.imm__probe-rowc').offsetHeight,
  };
}

const sameMetrics = (a: Metrics | null, b: Metrics) => !!a && (Object.keys(b) as (keyof Metrics)[]).every((k) => Math.abs(a[k] - b[k]) < 0.5);

function tileText(t: Tile): string {
  switch (t.kind) {
    case 'game': case 'playing': case 'download': return t.game.title;
    case 'store': return PLATFORM_NAMES[t.platform];
    case 'genre': return t.genre;
    case 'tool': return '';
  }
}

function RowsTrack({
  rows, activeRow, activeCol, cols, ringVars, ringHidden, holding, viewportRef, onRing, onPick, onOpen,
}: {
  rows: Row[];
  activeRow: number;
  activeCol: number;
  cols: Record<string, number>;
  ringVars: CSSProperties;
  ringHidden: boolean;
  holding: boolean;
  viewportRef: React.MutableRefObject<HTMLDivElement | null>;
  onRing: (r: RingRect) => void;
  onPick: (r: number, c: number) => void;
  onOpen: (t: Tile) => void;
}) {
  const reduce = useReducedMotion();
  const probeRef = useRef<HTMLDivElement>(null);
  const [m, setM] = useState<Metrics | null>(null);

  // Geometry is measured once and again only when the viewport resizes (window size, couch scale,
  // safe area). Every move is then pure arithmetic: no layout reads, no layout thrash.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    const probe = probeRef.current;
    if (!el || !probe) return;
    const update = () => {
      const next = measureMetrics(el, probe);
      setM((prev) => (sameMetrics(prev, next) ? prev : next));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewportRef]);

  const offsets = useMemo(() => {
    if (!m) return [] as number[];
    let y = 0;
    return rows.map((r) => {
      const at = y;
      y += r.compact ? m.rowChipH : r.wide ? m.rowWideH : m.rowH;
      return at;
    });
  }, [rows, m]);

  /** x of each tile within its shelf, and the shelf's width. */
  const layoutRow = useCallback(
    (r: Row) => {
      if (!m) return { xs: [] as number[], widths: [] as number[], total: 0 };
      const xs: number[] = [];
      const widths: number[] = [];
      let x = 0;
      const gap = r.compact ? m.chipGap : m.gap;
      for (const t of r.tiles) {
        const w = r.compact
          ? t.kind === 'tool' && t.tool.type === 'sort' ? m.sortW : m.chipW
          : r.wide ? (t.kind === 'game' && t.pinned) || t.kind === 'playing' ? m.pinW : m.ww : m.pw;
        xs.push(x);
        widths.push(w);
        x += w + gap;
      }
      return { xs, widths, total: Math.max(0, x - gap) };
    },
    [m],
  );
  /** How far a shelf is slid so its focused card sits at the left edge (never past its end). */
  const shiftOf = useCallback(
    (r: Row, col: number) => {
      if (!m) return 0;
      const { xs, total } = layoutRow(r);
      const c = Math.max(0, Math.min(col, r.tiles.length - 1));
      // The toolbar only slides once its focused chip would leave the screen.
      if (r.compact) {
        const room = m.vw - m.pad * 2;
        const { widths } = layoutRow(r);
        const need = (xs[c] ?? 0) + (widths[c] ?? 0) - room * 0.8;
        return Math.max(0, Math.min(need, total - room));
      }
      return Math.min(xs[c] ?? 0, Math.max(0, total - (m.vw - m.pad * 2)));
    },
    [m, layoutRow],
  );

  // The ring's target: the focused card's layout rect (the active row always sits at the top).
  const ring = useMemo<RingRect | null>(() => {
    const r = rows[activeRow];
    if (!m || !r || r.tiles.length === 0) return null;
    const { xs, widths } = layoutRow(r);
    const c = Math.max(0, Math.min(activeCol, r.tiles.length - 1));
    return { x: m.pad + xs[c] - shiftOf(r, c), y: m.titleH, w: widths[c], h: r.compact ? m.chipH : r.wide ? m.wh : m.ph };
  }, [rows, activeRow, activeCol, m, layoutRow, shiftOf]);
  const compactRing = !!rows[activeRow]?.compact;

  useEffect(() => {
    // Screen position (for spatial sound), from the cached viewport edge.
    if (ring && m) onRing({ ...ring, x: m.left + ring.x });
  }, [ring, m, onRing]);

  const from = Math.max(0, activeRow - WINDOW_BEFORE);
  const to = Math.min(rows.length, activeRow + WINDOW_AFTER + 1);
  const scale = compactRing ? 1.04 : FOCUS_SCALE;

  return (
    <div className="imm__viewport-y" ref={viewportRef}>
      <div className="imm__probe" ref={probeRef} aria-hidden>
        <span className="imm__probe-gap" />
        <span className="imm__probe-card" />
        <span className="imm__probe-wide" />
        <span className="imm__probe-pin" />
        <span className="imm__probe-title" />
        <span className="imm__probe-row" />
        <span className="imm__probe-roww" />
        <span className="imm__probe-chip" />
        <span className="imm__probe-sort" />
        <span className="imm__probe-chipgap" />
        <span className="imm__probe-rowc" />
      </div>
      <motion.div className="imm__track" animate={{ y: -(offsets[activeRow] ?? 0) }} transition={pick(reduce, spring.page)}>
        {rows.map((r, ri) => {
          const active = ri === activeRow;
          const mounted = ri >= from && ri < to;
          const focusCol = active ? activeCol : -1;
          return (
            <div
              key={r.id}
              className={`imm__row ${r.wide ? 'imm__row--wide' : ''} ${r.browse ? 'imm__row--browse' : ''} ${r.compact ? 'imm__row--tools' : ''} imm__row--${r.kind}`}
              data-active={active}
              aria-hidden={!mounted || undefined}
            >
              <h2 className="imm__row-title" style={active ? ringVars : undefined}>
                <span className="imm__row-name">{r.title}</span>
                {r.meta && <span className="imm__row-meta">{r.meta}</span>}
                {active && r.tiles.length > 1 && !r.compact && (
                  <span className="imm__row-count num" aria-hidden>
                    {activeCol + 1} / {r.tiles.length}
                  </span>
                )}
              </h2>
              {mounted && (
                <motion.div className="imm__shelf" animate={{ x: -shiftOf(r, active ? activeCol : cols[r.id] ?? 0) }} transition={pick(reduce, spring.focus)}>
                  {r.tiles.map((t, i) => {
                    const isFocused = i === focusCol;
                    const common = {
                      tabIndex: -1,
                      'aria-label': tileLabel(t),
                      'aria-current': isFocused ? ('true' as const) : undefined,
                      'data-focused': isFocused,
                      onPointerMove: (e: React.PointerEvent) => {
                        // Only real pointer movement moves focus (content sliding under a still cursor must not).
                        if ((e.movementX !== 0 || e.movementY !== 0) && !isFocused) onPick(ri, i);
                      },
                      onClick: () => {
                        onPick(ri, i);
                        onOpen(t);
                      },
                    };
                    if (t.kind === 'tool') {
                      return (
                        <button
                          key={t.key}
                          type="button"
                          className={`imm__chip ${t.tool.type === 'sort' ? 'imm__chip--sort' : ''}`}
                          aria-pressed={t.tool.type === 'filter' ? t.tool.active : undefined}
                          {...common}
                        >
                          <ToolChip tile={t} />
                        </button>
                      );
                    }
                    const pinned = (t.kind === 'game' && t.pinned) || t.kind === 'playing';
                    return (
                      <button
                        key={t.key}
                        type="button"
                        className={`imm__card ${r.wide ? 'imm__card--wide' : ''} ${pinned ? 'imm__card--pinned' : ''} ${t.kind === 'store' || t.kind === 'genre' ? 'imm__card--browse' : ''} imm__card--${t.kind}`}
                        {...common}
                      >
                        <motion.div layoutId={isFocused && t.kind === 'game' ? `imm-cover-${t.game.id}` : undefined} className="imm__card-frame">
                          {t.kind === 'game' ? (
                            <>
                              <GameCover game={t.game} kind={r.wide ? 'hero' : 'cover'} />
                              {!isInstalled(t.game) && (
                                // Like desktop cards: a quiet icon that names itself only on the focused card.
                                <span className="imm__card-flag" aria-hidden>
                                  <CloudDownload size="1em" strokeWidth={2.2} />
                                  <span className="imm__card-flag-label">Not installed</span>
                                </span>
                              )}
                              {t.pinned && (
                                <span className="imm__card-pin">
                                  <Pin size="0.85em" aria-hidden /> {lastPlayed(t.game).at ? formatRelative(lastPlayed(t.game).at) : 'Last played'}
                                </span>
                              )}
                            </>
                          ) : t.kind === 'playing' ? (
                            <PlayingFace tile={t} />
                          ) : t.kind === 'download' ? (
                            <DownloadFace tile={t} />
                          ) : (
                            <BrowseFace tile={t} />
                          )}
                        </motion.div>
                        <div className="imm__card-label">{tileText(t)}</div>
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </div>
          );
        })}
      </motion.div>

      {/* The one travelling focus ring, tinted by the focused game's palette. */}
      {ring && (
        <motion.div
          className="imm__ring"
          aria-hidden
          data-holding={holding || undefined}
          data-compact={compactRing || undefined}
          initial={false}
          animate={{
            // The active row is always translated to the top of the viewport, so the ring's
            // target is the card's layout rect, enlarged by the focus scale around its centre.
            x: ring.x - (ring.w * (scale - 1)) / 2,
            y: ring.y - (ring.h * (scale - 1)) / 2,
            width: ring.w * scale,
            height: ring.h * scale,
            opacity: ringHidden ? 0 : 1,
          }}
          style={{ ...ringVars, top: 0, left: 0 }}
          transition={pick(reduce, spring.focus)}
        >
          <span className="imm__ring-glint" />
          <span className="imm__ring-hold" />
        </motion.div>
      )}
    </div>
  );
}

function BrowseFace({ tile }: { tile: Extract<Tile, { kind: 'store' | 'genre' }> }) {
  return (
    <div className="imm__browse" data-kind={tile.kind}>
      {tile.sample && (
        <div className="imm__browse-art" aria-hidden>
          <GameCover game={tile.sample} kind="hero" />
        </div>
      )}
      <div className="imm__browse-face">
        {tile.kind === 'store' ? <StoreLogo platform={tile.platform} size={44} decorative brand /> : <span className="imm__browse-genre">{tile.genre}</span>}
        <span className="imm__browse-count num">{plural(tile.count, 'game')}</span>
      </div>
    </div>
  );
}
