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
  applyFilter, clampRow, colOf, focusGame, IMM_TABS, INITIAL_NAV, moveNav, pick as pickTile, switchTab as switchNavTab, TAB_LABEL, tabBeside, type ImmTab, type NavState,
} from './immersive/nav';
import { isAutomatic, isMovableRow, mergeRowOrder, movableIds, parseRowOrder, serializeRowOrder, stepRow } from './immersive/rowOrder';
import { RowOrderList } from './immersive/RowMover';
import { useImmDiscover } from './immersive/useImmDiscover';
import { DiscoverFace, DiscoverInfo, NoteFace, SearchFace, useDiscoverStage } from './immersive/DiscoverTiles';
import { DiscoverPage } from './immersive/DiscoverPage';
import type { DiscoverItem } from './immersive/discoverRows';
import { useRecommendSignals } from '../state/recommend'; // Track D5
import './immersive.css';
import './immersive/immersive-t.css';
import './immersive/immersive-z.css';

/** Rows mounted around the focused one. Others are exact-height placeholders. */
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 4;
/** Focused cards grow by this much; the ring grows with them (kept in sync with immersive.css). */
const FOCUS_SCALE = 1.06;
/** Holding X this long opens the quick menu (a shorter press toggles Favorite). */
const HOLD_X_MS = 420;
/** Track Z: holding Y this long on a row header picks the row up (a shorter press still searches). */
const HOLD_Y_MS = 420;
/** Track Z: rows keep sliding into place this long after a move ends. */
const SETTLE_MS = 650;
/** Re-entering Immersive within this long returns to the same row and card (Track T). */
const NAV_MEMORY_MS = 30 * 60_000;
const ACTIVE_PHASES = ['starting', 'waiting', 'running'];
const DOWNLOAD_PHASES: InstallProgress['phase'][] = ['queued', 'downloading', 'staging', 'paused'];

type SearchFilter = 'all' | 'installed' | 'favorites' | 'unplayed';

/** Track Z: a row picked up to move. `order` is the Home rows you can move, as they show now. */
interface Moving {
  rowId: string;
  order: string[];
  /** Picked up from its header (focus goes back there when it's dropped). */
  fromHeader: boolean;
}

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
  // Track Z: your own Home row order, the row header focus, and a row being moved.
  const rowOrderSetting = settings?.['immersive.rowOrder'];
  const savedOrder = useMemo(() => parseRowOrder(rowOrderSetting), [rowOrderSetting]);
  const [header, setHeader] = useState(false);
  const [moving, setMoving] = useState<Moving | null>(null);
  const [settling, setSettling] = useState(false);
  const [holdingY, setHoldingY] = useState(false);
  // Track C6: Discover — games you don't own. Nothing is asked for until the section is first opened.
  const [discoverOpened, setDiscoverOpened] = useState(false);
  const disc = useImmDiscover(visible, discoverOpened || nav.tab === 'discover');
  const [dpanel, setDpanel] = useState<DiscoverItem | null>(null);
  const [searchMode, setSearchMode] = useState<'library' | 'discover'>('library');

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

  // Track D5: recommend.v2's inputs (tags, sessions, cloud lists, "Not interested"…) for Picked for you and Play in the cloud.
  const recSignals = useRecommendSignals();
  const view = useMemo<{ rows: Row[]; jumps: Jump[] }>(
    () =>
      nav.tab === 'home'
        ? { rows: homeRows(visible, collections, Date.now(), hour, live, moving ? moving.order : savedOrder, recSignals), jumps: [] }
        : nav.tab === 'discover'
          ? { rows: disc.rows, jumps: [] }
          : libraryView(visible, nav.filter, sort, Date.now()),
    [visible, collections, hour, nav.tab, nav.filter, live, sort, moving, savedOrder, disc.rows, recSignals],
  );
  const rows = view.rows;
  const row = clampRow(nav, rows);
  const current = rows[row];
  const col = colOf(nav, rows, row);
  const tile: Tile | null = current?.tiles[col] ?? null;
  const focused = tileGame(tile);
  const focusedGame = tile && (tile.kind === 'game' || tile.kind === 'playing' || tile.kind === 'download') ? tile.game : null;
  const here = nav.tab === 'library' ? jumpAt(view.jumps, row, col) : null;
  /** Track Z: focus is on the row's header (Left from its first card), where you can pick it up. */
  const onHeader = header && !moving && nav.tab === 'home' && isMovableRow(current);

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
  // Track C6: a Discover card has no library game; the stage shows a stand-in carrying its art.
  const discoverStage = useDiscoverStage(tile);
  const visual = focused ?? discoverStage;
  const stageGame = gliding ? lagged : visual;
  const discoverTile = tile && (tile.kind === 'discover' || tile.kind === 'search' || tile.kind === 'note') ? tile : null;
  const focusedItem = tile?.kind === 'discover' ? tile.item : null;

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
  const fallbackHue = visual ? titleHue(visual.title) : 292;
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
  // Track Z: a row header or a row being moved says its own words (and the card is said again after).
  const overlayOpen = !!(panel || dpanel || quick || search || couch || guide || voiceSheet || attract || moving || onHeader);
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
    const prefix = [tabChanged && s.tab !== null ? TAB_LABEL[nav.tab] : '', s.prefix].filter(Boolean).join('. ');
    s.tab = nav.tab;
    s.row = current.id;
    s.prefix = '';
    voiceOver.say(sentence(prefix, focusSpeech(current, tile, { rowChanged })), 'focus');
    // Re-said when an overlay closes, so you always know where you landed.
  }, [voiceOn, gliding, overlayOpen, tileKey, rowKey, nav.tab]);

  // ---------------------------------------------------------------- actions
  const latest = useRef({ nav, rows, row, col, tile, focused, focusedGame, panel, search, quick, couch, guide, voiceSheet, attract, tourActive, filterOrigin, jumps: view.jumps, onHeader, moving, savedOrder, dpanel, visual, focusedItem });
  useLayoutEffect(() => {
    latest.current = { nav, rows, row, col, tile, focused, focusedGame, panel, search, quick, couch, guide, voiceSheet, attract, tourActive, filterOrigin, jumps: view.jumps, onHeader, moving, savedOrder, dpanel, visual, focusedItem };
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
    if (!glidingRef.current) setLagged(L.visual);
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
      // Track Z: on a header, Up/Down walk the headers (rows that can't move have none).
      if (L.onHeader && r.effect === 'row') {
        const nr = L.rows[nextRow];
        if (!isMovableRow(nr)) setHeader(false);
        else voiceOver.say(`${nr.title} row. Press A or hold Y to move it.`, 'focus');
      }
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

  // ---------------------------------------------------------------- Track Z: row headers and moving rows
  const settleTimer = useRef<number | undefined>(undefined);
  const settle = useCallback(() => {
    setSettling(true);
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => setSettling(false), SETTLE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  /** Left from a row's first card: focus its header. */
  const enterHeader = useCallback(() => {
    const L = latest.current;
    const r = L.rows[L.row];
    if (!r) return;
    setHeader(true);
    engaged.current = true;
    haptic('tick');
    sound.focus();
    voiceOver.say(`${r.title} row. Press A or hold Y to move it.`, 'focus');
  }, []);

  /** Picks a Home row up (from its header, or the quick menu's Move row). */
  const startMoving = useCallback(
    (rowId: string, fromHeader: boolean) => {
      const L = latest.current;
      const order = movableIds(L.rows);
      const i = order.indexOf(rowId);
      if (L.nav.tab !== 'home' || i < 0 || order.length < 2) {
        haptic('edge');
        return;
      }
      const m: Moving = { rowId, order, fromHeader };
      L.moving = m;
      setNav((n) => ({ ...n, rowId }));
      setMoving(m);
      setHeader(fromHeader);
      settle();
      engaged.current = true;
      sound.select();
      haptic('confirm');
      const title = L.rows.find((r) => r.id === rowId)?.title ?? 'Row';
      voiceOver.say(sentence(`Moving ${title}`, `Row ${i + 1} of ${order.length}`, 'Up or down to move it, A to drop it, B to cancel'), 'nav');
    },
    [settle],
  );

  const stepMoving = useCallback(
    (dir: -1 | 1) => {
      const L = latest.current;
      const m = L.moving;
      if (!m) return;
      const next = stepRow(m.order, m.rowId, dir);
      if (!next) {
        haptic('edge');
        spatial('edge', L.row, L.row, L.focused);
        return;
      }
      const nm = { ...m, order: next };
      L.moving = nm;
      setMoving(nm);
      haptic('tick');
      const to = next.indexOf(m.rowId);
      spatial('row', to, m.order.indexOf(m.rowId), L.focused);
      voiceOver.say(`Row ${to + 1} of ${next.length}`, 'nav');
    },
    [spatial],
  );

  /** A drops the row where it is (and remembers the order); B puts everything back. */
  const dropRow = useCallback(
    (commit: boolean) => {
      const L = latest.current;
      const m = L.moving;
      if (!m) return;
      if (commit) {
        const auto = movableIds(homeRows(visible, collections, Date.now(), hour));
        const value = isAutomatic(auto, m.order) ? '' : serializeRowOrder(mergeRowOrder(L.savedOrder, m.order));
        if (value !== serializeRowOrder(L.savedOrder)) void setSetting('immersive.rowOrder', value);
        sound.select();
        haptic('confirm');
        voiceOver.say(value ? 'Row order saved' : 'Rows are in their automatic order', 'nav');
      } else {
        sound.back();
        haptic('tick');
        voiceOver.say('Move cancelled', 'nav');
      }
      L.moving = null;
      setMoving(null);
      setHeader(m.fromHeader);
      settle();
    },
    [visible, collections, hour, setSetting, settle],
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
      if (t === 'discover') setDiscoverOpened(true);
      setNav((n) => switchNavTab(n, t));
      setFilterOrigin(null);
      setHeader(false);
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

  const openSearch = useCallback(() => {
    // In Discover, the keyboard searches every store; elsewhere, your library.
    setSearchMode(latest.current.nav.tab === 'discover' ? 'discover' : 'library');
    setSearch(true);
    sound.select();
    markTour('search');
  }, [markTour]);

  /** Track C6: a Discover card opens its page; X (or Y on the page) watches it. */
  const openDiscover = useCallback((item: DiscoverItem) => {
    setDpanel(item);
    engaged.current = true;
    sound.select();
    haptic('tick');
  }, []);

  const toggleWatch = useCallback(
    async (item: DiscoverItem) => {
      const on = !disc.watchingKeys.has(item.key);
      const r = await disc.setWatching(item.key, item.title, on);
      if (r === null) haptic('error');
      else {
        haptic('confirm');
        sound.select();
      }
    },
    [disc],
  );

  /** Track C6: runs a Discover search and puts focus on its results. */
  const runDiscoverSearch = useCallback(
    (text: string) => {
      disc.setQuery(text);
      setNav((n) => ({ ...n, tab: 'discover', row: 1, rowId: 'disc-results', cols: { ...n.cols, 'disc-results': 0, 'disc-owned': 0 } }));
      setDiscoverOpened(true);
      engaged.current = true;
      voiceOver.say(`Searching for ${text}`, 'nav');
    },
    [disc],
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
        // Track C6: Discover.
        case 'discover': return openDiscover(t.item);
        case 'search':
          if (t.query) {
            sound.select();
            haptic('tick');
            return runDiscoverSearch(t.query);
          }
          return openSearch();
        case 'note':
          switch (t.action) {
            case 'turnOn':
              sound.select();
              haptic('confirm');
              void setSetting('discover.searchOnline', true);
              voiceOver.say('Searching stores is on', 'notice');
              return;
            case 'retry': sound.select(); return disc.retry();
            case 'more': sound.select(); haptic('tick'); return disc.loadMore();
            case 'search': return openSearch();
            default: haptic('edge'); return;
          }
        case 'store': case 'genre': {
          const filter: LibraryFilter = t.kind === 'store' ? { kind: 'store', platform: t.platform } : { kind: 'genre', genre: t.genre };
          setFilterOrigin(latest.current.nav);
          setNav((n) => applyFilter(n, filter));
          sound.select();
          haptic('tick');
        }
      }
    },
    [openPage, applyTool, openDiscover, runDiscoverSearch, openSearch, setSetting, disc],
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
        case 'moveRow': {
          const r = latest.current.rows[latest.current.row];
          if (r) startMoving(r.id, false);
          return;
        }
      }
    },
    [quick, launchGame, openPage, startMoving],
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
  // Track Z: on a row header, Y is held to pick the row up; released early, it searches as usual.
  const yTimer = useRef<number | null>(null);
  const cancelHoldY = () => {
    if (yTimer.current !== null) window.clearTimeout(yTimer.current);
    yTimer.current = null;
    setHoldingY(false);
  };
  const beginHoldY = () => {
    if (yTimer.current !== null) return;
    setHoldingY(true);
    yTimer.current = window.setTimeout(() => {
      yTimer.current = null;
      setHoldingY(false);
      const L = latest.current;
      const r = L.rows[L.row];
      if (L.onHeader && r) startMoving(r.id, true);
    }, HOLD_Y_MS);
  };
  /** Y released: before the hold completed, that was a tap (search). */
  const releaseY = () => {
    if (yTimer.current === null) return;
    cancelHoldY();
    openSearch();
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
    if (L.dpanel && button === 'Escape') {
      setDpanel(null);
      sound.back();
      return true;
    }
    // Anything modal (game page, quick menu, search, display, guide, launch overlay, desktop dialogs) owns input.
    if (L.panel || L.dpanel || L.quick || L.couch || L.search || L.guide || L.voiceSheet) return false;
    if (document.querySelector('[data-dialog-open], [data-nav-scope="overlay"]')) return false;
    // Track Z: a row is picked up — it owns every button until it's dropped (A) or put back (B).
    if (L.moving) {
      switch (button) {
        case 'Up': case 'ArrowUp': stepMoving(-1); return true;
        case 'Down': case 'ArrowDown': stepMoving(1); return true;
        case 'A': case 'Enter': case ' ': if (!repeat) dropRow(true); return true;
        case 'B': case 'Escape': case 'Backspace': if (!repeat) dropRow(false); return true;
        case 'F11':
          if (!repeat) {
            dropRow(false);
            exitToDesktop();
          }
          return true;
        default: return true;
      }
    }
    if (L.onHeader) {
      switch (button) {
        case 'Right': case 'ArrowRight': case 'B': case 'Escape': case 'Backspace':
          if (!repeat) {
            setHeader(false);
            sound.focus();
            haptic('tick');
          }
          return true;
        case 'Left': case 'ArrowLeft': haptic('edge'); return true;
        case 'A': case 'Enter': case ' ': {
          const r = L.rows[L.row];
          if (!repeat && r) startMoving(r.id, true);
          return true;
        }
        case 'Y': case 'y':
          if (!repeat) beginHoldY();
          return true;
        case 'X': case 'x': haptic('edge'); return true;
      }
    }
    switch (button) {
      case 'Up': case 'ArrowUp': move(-1, 0, repeat); return true;
      case 'Down': case 'ArrowDown': move(1, 0, repeat); return true;
      case 'Left': case 'ArrowLeft':
        // Track Z: past a Home row's first card is its header (hold Y there to move the row).
        if (!repeat && L.nav.tab === 'home' && L.col === 0 && isMovableRow(L.rows[L.row])) {
          enterHeader();
          return true;
        }
        move(0, -1, repeat);
        return true;
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
      case 'LB': case 'RB': case 'q': case 'e': {
        if (repeat) return true;
        const next = tabBeside(L.nav.tab, button === 'LB' || button === 'q' ? -1 : 1);
        if (next) switchTab(next);
        else haptic('edge');
        return true;
      }
      case 'Y': case 'y':
        if (!repeat) openSearch();
        return true;
      case 'X':
        // Track C6: on a game you don't own, X watches it (or stops).
        if (L.focusedItem) {
          if (!repeat) void toggleWatch(L.focusedItem);
          return true;
        }
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
        if (!repeat && L.focusedItem) void toggleWatch(L.focusedItem);
        else if (!repeat && L.focusedGame) void toggleFavorite(L.focusedGame);
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
  const releaseYRef = useRef(releaseY);
  useLayoutEffect(() => {
    handleRef.current = handle;
    releaseYRef.current = releaseY;
  });

  // Registered once, so overlays opened later (attract, game page, search, quick menu) always sit above it.
  useEffect(() => pushPadHandler((b, r) => handleRef.current(b, r)), []);
  useEffect(() => {
    // X released before the hold completed: that was a tap → Favorite.
    const offY = on('gamepad.button', ({ button, pressed }) => {
      if (button === 'Y' && !pressed) releaseYRef.current();
    });
    const off = on('gamepad.button', ({ button, pressed }) => {
      if (button !== 'X' || pressed || xTimer.current === null) return;
      cancelHoldX();
      const g = latest.current.focusedGame;
      if (g) {
        void toggleFavorite(g);
        haptic('tick');
      }
    });
    const offConn = on('gamepad.connection', () => {
      cancelHoldX();
      cancelHoldY();
    });
    return () => {
      off();
      offY();
      offConn();
      cancelHoldX();
      cancelHoldY();
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea') || useStore.getState().commandOpen) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (handleRef.current(e.key, e.repeat)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'y' || e.key === 'Y') releaseYRef.current();
    };
    addEventListener('keydown', onKey);
    addEventListener('keyup', onKeyUp);
    return () => {
      removeEventListener('keydown', onKey);
      removeEventListener('keyup', onKeyUp);
    };
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
  const oskSubmit = useMemo(
    () => (searchMode === 'discover' ? { initial: disc.query ?? '', onSubmit: (text: string) => { setSearch(false); runDiscoverSearch(text); } } : undefined),
    [searchMode, disc.query, runDiscoverSearch],
  );
  const watchingFocused = !!focusedItem && disc.watchingKeys.has(focusedItem.key);
  const lean = useTransform(leanX, (v) => v * -4);
  const leanInfoY = useTransform(leanY, (v) => v * -2);
  const voiceState = !voiceOn ? 'Off' : settings?.['voiceover.captionsOnly'] ? 'Captions only' : 'On';
  const movingRows = moving ? rows.filter(isMovableRow) : [];
  const primary = tile?.kind === 'playing' ? 'Return to game'
    : tile?.kind === 'tool' ? (tile.tool.type === 'sort' ? 'Change sort' : 'Show')
    : tile?.kind === 'discover' ? 'Details'
    : tile?.kind === 'search' ? (tile.query ? 'Search' : 'Type')
    : tile?.kind === 'note' ? NOTE_PRIMARY[tile.action ?? 'none']
    : tile && tile.kind !== 'game' && tile.kind !== 'download' ? 'Browse' : 'Open';

  return (
    <LayoutGroup>
      <div
        className="imm"
        data-reduced={reduce}
        data-gliding={gliding || undefined}
        data-quick-open={!!quick || undefined}
        data-tab={nav.tab}
        data-moving={moving ? true : undefined}
        data-header={onHeader || undefined}
      >
        <HeroStage game={stageGame} tint={ringA} tint2={ringB} />
        <header className="imm__top">
          <img src="./vystral-mark.svg" alt="" className="imm__mark" />
          <nav className="imm__tabs" aria-label="Sections">
            <PadGlyph button="LB" />
            {IMM_TABS.map((t) => (
              <button key={t} className="imm__tab" aria-current={nav.tab === t ? 'page' : undefined} onClick={() => t !== nav.tab && switchTab(t)}>
                {TAB_LABEL[t]}
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
            {moving ? (
              // Track Z: while a row is picked up, the info area shows the row order.
              <motion.div
                key="moving"
                className="imm__info-item imm__info-item--moving"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: 'blur(4px)', transition: { duration: 0.18, ease: ease.in } }}
                transition={pick(reduce, spring.panel)}
              >
                <RowOrderList rows={movingRows} liftedId={moving.rowId} />
              </motion.div>
            ) : onHeader && current ? (
              <motion.div
                key={`header-${current.id}`}
                className="imm__info-item"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: 'blur(4px)', transition: { duration: 0.18, ease: ease.in } }}
                transition={pick(reduce, spring.panel)}
              >
                <h1 className="imm__title imm__title--section">{current.title}</h1>
                <div className="imm__meta">
                  <span>{current.meta ?? plural(current.tiles.length, current.browse ? 'tile' : 'game')}</span>
                  <span>{savedOrder.length ? 'In your row order' : 'Ordered by time of day'}</span>
                </div>
              </motion.div>
            ) : tile && (
              <motion.div
                key={tile.kind === 'tool' ? 'tools' : tile.key}
                className="imm__info-item"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: 'blur(4px)', transition: { duration: 0.18, ease: ease.in } }}
                transition={pick(reduce, spring.panel)}
              >
                {discoverTile ? <DiscoverInfo tile={discoverTile} watching={watchingFocused} /> : <TileInfo tile={tile} row={current} sort={sort} />}
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
              ringHidden={!!panel || !!dpanel || !!quick || !!guide || onHeader || !!moving}
              watching={disc.watchingKeys}
              holding={holdingX}
              viewportRef={viewportRef}
              onRing={onRing}
              onPick={(r, c) => {
                if (latest.current.moving) return;
                setHeader(false);
                setNav((n) => pickTile(n, rows, r, c));
              }}
              onOpen={(t) => !latest.current.moving && openTile(t)}
              headerId={onHeader ? current?.id ?? null : null}
              holdingY={holdingY}
              liftedId={moving?.rowId ?? null}
              flowing={!!moving || settling}
            />
          )}
          {nav.tab === 'library' && sort === 'az' && <JumpRail jumps={view.jumps} current={here} below={current?.kind === 'tools'} onJump={(j) => jump(1, false, j)} />}
          <JumpFlash flash={flash} />
        </section>

        {moving ? (
          // Track Z: moving a row — just what works right now.
          <footer className="imm__hints" data-mode="moving">
            <span className="imm__hint"><PadHint button="DpadV">Move row</PadHint></span>
            <span className="imm__hint"><PadHint button="A">Drop it here</PadHint></span>
            <span className="imm__hint"><PadHint button="B">Cancel</PadHint></span>
          </footer>
        ) : onHeader ? (
          <footer className="imm__hints" data-mode="header">
            <span className="imm__hint"><PadHint button="A">Move row</PadHint></span>
            <span className="imm__hint"><PadHint button="Y">Hold to move row · tap to search</PadHint></span>
            <span className="imm__hint"><PadHint button="DpadV">Other rows</PadHint></span>
            <span className="imm__hint"><PadHint button="B">Back to games</PadHint></span>
            <button type="button" className="imm__exit" onClick={openGuide} aria-label="Menu: desktop mode, display, voice-over, settings">
              <PadHint button="Menu">Menu</PadHint>
            </button>
          </footer>
        ) : (
        <footer className="imm__hints">
          <span className="imm__hint"><PadHint button="A">{primary}</PadHint></span>
          {focusedGame && <span className="imm__hint"><PadHint button="X">Favorite</PadHint></span>}
          {focusedItem && <span className="imm__hint"><PadHint button="X">{watchingFocused ? 'Stop watching' : 'Watch'}</PadHint></span>}
          {nav.tab !== 'discover' && (
            <button type="button" className="imm__hint imm__hint--btn" onClick={openQuick} disabled={!focusedGame}>
              <PadHint button="View">Quick menu</PadHint>
            </button>
          )}
          <button type="button" className="imm__hint imm__hint--btn" onClick={openSearch}>
            <PadHint button="Y">{nav.tab === 'discover' ? 'Search any game' : 'Search'}</PadHint>
          </button>
          <span className="imm__hint"><PadHint button={['LB', 'RB']}>Sections</PadHint></span>
          {nav.tab === 'library' && view.jumps.length > 1 && (
            <span className="imm__hint"><PadHint button={['LT', 'RT']}>{sort === 'az' ? 'Jump to letter' : 'Jump'}</PadHint></span>
          )}
          <button type="button" className="imm__exit" onClick={openGuide} aria-label="Menu: desktop mode, display, voice-over, settings">
            <PadHint button="Menu">Menu</PadHint>
          </button>
        </footer>
        )}

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
          {dpanel && (
            <DiscoverPage
              key={dpanel.key}
              item={dpanel}
              watching={disc.watchingKeys.has(dpanel.key)}
              onWatch={(on) => disc.setWatching(dpanel.key, dpanel.title, on)}
              onOpenGame={(g) => {
                setDpanel(null);
                openPage(g);
              }}
              onClose={() => setDpanel(null)}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {quick && quickGame && (
            <QuickMenu
              key={quick.id}
              game={quickGame}
              anchor={quick.anchor}
              moveRow={nav.tab === 'home' && isMovableRow(current) && movableIds(rows).length > 1 ? current.title : undefined}
              onAction={runQuick}
              onClose={() => setQuick(null)}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>{couch && <CouchSheet key="couch" onClose={() => setCouch(false)} />}</AnimatePresence>
        <AnimatePresence>{voiceSheet && <VoiceSheet key="voice" onClose={() => setVoiceSheet(false)} />}</AnimatePresence>
        <AnimatePresence>{guide && <Guide key="guide" voiceState={voiceState} onAction={runGuide} onClose={() => setGuide(false)} />}</AnimatePresence>
        <AnimatePresence>
          {search && (
            <OnScreenKeyboard
              key="osk"
              games={oskSubmit ? visible : searchGames}
              filters={oskSubmit ? undefined : oskFilters}
              submit={oskSubmit}
              onClose={() => setSearch(false)}
              onOpenGame={openFromSearch}
            />
          )}
        </AnimatePresence>
        </div>
        <AttractMode games={visible} active={attract} onActiveChange={setAttract} onOpen={openPage} />
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
    case 'discover': return t.item.title;
    // The faces of search and status cards already say it.
    case 'search': case 'note': return '';
  }
}

/** Track C6: what A does on a Discover status card. */
const NOTE_PRIMARY: Record<string, string> = { turnOn: 'Turn on', retry: 'Try again', more: 'Show more', search: 'Search again', none: 'Open' };

function RowsTrack({
  rows, activeRow, activeCol, cols, ringVars, ringHidden, holding, viewportRef, onRing, onPick, onOpen, headerId, holdingY, liftedId, flowing, watching,
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
  /** Track Z: the row whose header has focus. */
  headerId: string | null;
  /** Track Z: Y is being held on that header (the hold fills). */
  holdingY: boolean;
  /** Track Z: the row picked up to move. */
  liftedId: string | null;
  /** Track Z: rows slide to their new places (while moving and just after). */
  flowing: boolean;
  /** Track C6: Discover keys on your Watching list. */
  watching: ReadonlySet<string>;
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
          const isHeader = headerId === r.id;
          const lifted = liftedId === r.id;
          return (
            <motion.div
              key={r.id}
              layout={flowing ? 'position' : false}
              transition={pick(reduce, spring.page)}
              className={`imm__row ${r.wide ? 'imm__row--wide' : ''} ${r.browse ? 'imm__row--browse' : ''} ${r.compact ? 'imm__row--tools' : ''} imm__row--${r.kind}`}
              data-active={active}
              data-row-id={r.id}
              data-lifted={lifted || undefined}
              aria-hidden={!mounted || undefined}
            >
              <h2 className="imm__row-title" style={active ? ringVars : undefined} data-header-focus={isHeader || undefined} data-holding={(isHeader && holdingY) || undefined}>
                <span className="imm__row-name">{r.title}</span>
                {/* Track D5: on a recommended row, the focused game's reason replaces the row's line. */}
                {(active && r.reasons?.[r.tiles[activeCol]?.key ?? ''] && !isHeader && !lifted)
                  ? <span className="imm__row-meta imm__row-why" aria-live="polite">{r.reasons[r.tiles[activeCol].key]}</span>
                  : r.meta && <span className="imm__row-meta">{r.meta}</span>}
                {active && r.tiles.length > 1 && !r.compact && !isHeader && !lifted && (
                  <span className="imm__row-count num" aria-hidden>
                    {activeCol + 1} / {r.tiles.length}
                  </span>
                )}
                {isHeader && (
                  <span className="imm__row-move" aria-hidden>
                    <span className="imm__row-move-hold" />
                    <PadHint button="Y">Hold to move</PadHint>
                  </span>
                )}
                {lifted && (
                  <span className="imm__row-move imm__row-move--lifted" aria-hidden>
                    <PadHint button="DpadV">Moving</PadHint>
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
                          ) : t.kind === 'discover' ? (
                            <DiscoverFace tile={t} watching={watching.has(t.item.key)} />
                          ) : t.kind === 'search' ? (
                            <SearchFace tile={t} />
                          ) : t.kind === 'note' ? (
                            <NoteFace tile={t} />
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
            </motion.div>
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
