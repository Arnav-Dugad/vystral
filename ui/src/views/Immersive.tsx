import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, LayoutGroup, motion, useTransform } from 'motion/react';
import { Clock3, Monitor, Pin, Timer, X as XIcon } from 'lucide-react';
import { call, on } from '../bridge/bridge';
import type { Game, GamepadButton } from '../bridge/types';
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
import { toggleFavorite } from '../state/actions';
import { setGameStatus } from '../state/statusActions';
import { useReducedMotion, useStore } from '../state/store';
import { OnScreenKeyboard, type OskFilters } from '../components/controller/OnScreenKeyboard';
import { GameCover } from '../components/game/GameCover';
import { openInStore } from '../components/game/InstallButton';
import { PadGlyph } from '../components/ui/primitives';
import { AttractMode } from './immersive/AttractMode';
import { GameLogo } from '../components/game/GameLogo';
import { HeroStage } from './immersive/HeroStage';
import { SystemBar } from './immersive/SystemBar';
import { QuickMenu, type QuickAction } from './immersive/QuickMenu';
import { GamePage, type PageTab } from './immersive/GamePage';
import { CouchSheet } from './immersive/CouchSheet';
import { Tour, type TourStep } from './immersive/Tour';
import { leanX, leanY, nudge } from './immersive/parallax';
import { filterLabel, greeting, homeRows, libraryRows, tileGame, tileLabel, type LibraryFilter, type Row, type Tile } from './immersive/rows';
import {
  applyFilter, clampRow, colOf, focusGame, INITIAL_NAV, moveNav, pick as pickTile, switchTab as switchNavTab, type ImmTab, type NavState,
} from './immersive/nav';
import './immersive.css';

/** Rows mounted around the focused one. Others are exact-height placeholders. */
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 4;
/** Focused cards grow by this much; the ring grows with them (kept in sync with immersive.css). */
const FOCUS_SCALE = 1.06;
/** Holding X this long opens the quick menu (a shorter press toggles Favorite). */
const HOLD_X_MS = 420;

type SearchFilter = 'all' | 'installed' | 'favorites' | 'unplayed';

interface RingRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The game Immersive opens on: the one the switch zoomed into (Home rows first, else the A–Z grid). */
function entryNav(visible: Game[], collections: ReturnType<typeof useStore.getState>['library']['collections']): NavState {
  const id = takeEntryFocus();
  if (!id) return INITIAL_NAV;
  const home = focusGame(INITIAL_NAV, homeRows(visible, collections, Date.now(), new Date().getHours()), id);
  if (home !== INITIAL_NAV) return home;
  const lib = { ...INITIAL_NAV, tab: 'library' as const };
  const inLib = focusGame(lib, libraryRows(visible, null), id);
  return inLib !== lib ? inLib : INITIAL_NAV;
}

/**
 * Immersive Mode: an independent, controller-first 10-foot layout (Track L overhaul).
 * - A hero stage: the focused game's art full-bleed with its live loop when allowed, leaning
 *   with each D-pad move (parallax).
 * - Rows ordered by time of day (Continue always first, with a pinned "last played" slot), plus
 *   Never played, your collections, and browse rows by store logo and genre.
 * - One travelling focus ring tinted by the game's palette; spatial sounds follow it (pan by
 *   position, pitch by row depth, timbre by mood); haptic ticks on row change.
 * - Hold X / View for a radial quick menu; A opens a tabbed game page; Y searches with fast filters.
 * - Focus is anchored: the focused card sits at the left edge and rows slide beneath it; every row
 *   has a fixed height so mounting/unmounting rows never shifts the layout.
 */
export function ImmersiveView() {
  const games = useStore((s) => s.library.games);
  const collections = useStore((s) => s.library.collections);
  const settings = useStore((s) => s.settings);
  const setMode = useStore((s) => s.setMode);
  const setFocusGame = useStore((s) => s.setFocusGame);
  const setSetting = useStore((s) => s.setSetting);
  const launchGame = useStore((s) => s.launchGame);
  const reduce = useReducedMotion();

  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);
  const [nav, setNav] = useState<NavState>(() => entryNav(visible, collections));
  const [hour, setHour] = useState(() => new Date().getHours());
  const [panel, setPanel] = useState<{ id: string; tab: PageTab } | null>(null);
  const [attract, setAttract] = useState(false);
  const [search, setSearch] = useState(false);
  const [searchFilter, setSearchFilter] = useState<SearchFilter>('all');
  const [quick, setQuick] = useState<{ id: string; anchor: { x: number; y: number } } | null>(null);
  const [couch, setCouch] = useState(false);
  const [holdingX, setHoldingX] = useState(false);
  const [gliding, setGliding] = useState(false);
  const [tourDone, setTourDone] = useState<Set<TourStep>>(() => new Set());
  const [filterOrigin, setFilterOrigin] = useState<NavState | null>(null);

  // Re-order rows when the part of the day changes (checked every few minutes).
  useEffect(() => {
    const t = window.setInterval(() => setHour(new Date().getHours()), 5 * 60_000);
    return () => window.clearInterval(t);
  }, []);

  const rows = useMemo<Row[]>(
    () => (nav.tab === 'home' ? homeRows(visible, collections, Date.now(), hour) : libraryRows(visible, nav.filter)),
    [visible, collections, hour, nav.tab, nav.filter],
  );
  const row = clampRow(nav, rows);
  const current = rows[row];
  const col = colOf(nav, rows, row);
  const tile: Tile | null = current?.tiles[col] ?? null;
  const focused = tileGame(tile);
  const focusedGame = tile?.kind === 'game' ? tile.game : null;

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

  // ---------------------------------------------------------------- actions
  const latest = useRef({ nav, rows, row, col, tile, focused, focusedGame, panel, search, quick, couch, attract, tourActive, filterOrigin });
  useLayoutEffect(() => {
    latest.current = { nav, rows, row, col, tile, focused, focusedGame, panel, search, quick, couch, attract, tourActive, filterOrigin };
  });

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
      markTour('move');
      const nextRow = clampRow(r.state, L.rows);
      const nextGame = tileGame(L.rows[nextRow]?.tiles[colOf(r.state, L.rows, nextRow)]);
      if (r.effect === 'row') {
        haptic('tick');
        spatial('row', nextRow, L.row, nextGame);
      } else spatial('focus', nextRow, L.row, nextGame);
      if (!reduce) nudge(dc, dr);
      // Momentum: while a direction auto-repeats, the shelves glide and labels step aside.
      if (repeat) {
        // The stage holds the game it showed when the glide began.
        if (!glidingRef.current) setLagged(L.focused);
        glidingRef.current = true;
        setGliding(true);
        window.clearTimeout(glideTimer.current);
        glideTimer.current = window.setTimeout(() => {
          glidingRef.current = false;
          setGliding(false);
        }, 200);
      }
    },
    [markTour, reduce, spatial],
  );

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
      sound.select();
      haptic('tick');
      markTour('search');
    },
    [markTour],
  );

  const openTile = useCallback(
    (t: Tile | null) => {
      if (!t) return;
      if (t.kind === 'game') return openPage(t.game);
      const filter: LibraryFilter = t.kind === 'store' ? { kind: 'store', platform: t.platform } : { kind: 'genre', genre: t.genre };
      setFilterOrigin(latest.current.nav);
      setNav((n) => applyFilter(n, filter));
      sound.select();
      haptic('tick');
    },
    [openPage],
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

  /** Opens a game picked from search, leaving focus on it when the page closes. */
  const openFromSearch = useCallback(
    (g: Game) => {
      setSearch(false);
      const L = latest.current;
      const here = focusGame(L.nav, L.rows, g.id);
      if (here !== L.nav) setNav(here);
      else {
        const lib = { ...L.nav, tab: 'library' as const, filter: null, row: 0, rowId: null };
        setNav(focusGame(lib, libraryRows(visible, null), g.id));
      }
      openPage(g);
    },
    [visible, openPage],
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
    // Anything modal (game page, quick menu, search, display, launch overlay, desktop dialogs) owns input.
    if (L.panel || L.quick || L.couch || L.search) return false;
    if (document.querySelector('[data-dialog-open], [data-nav-scope="overlay"]')) return false;
    switch (button) {
      case 'Up': case 'ArrowUp': move(-1, 0, repeat); return true;
      case 'Down': case 'ArrowDown': move(1, 0, repeat); return true;
      case 'Left': case 'ArrowLeft': move(0, -1, repeat); return true;
      case 'Right': case 'ArrowRight': move(0, 1, repeat); return true;
      case 'LT': case 'RT': {
        // Page through rows quickly.
        const target = Math.max(0, Math.min(L.rows.length - 1, L.row + (button === 'LT' ? -3 : 3)));
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
      case 'Menu': case 'F11':
        if (!repeat) void setMode('desktop');
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

  return (
    <LayoutGroup>
      <div
        className="imm"
        data-reduced={reduce}
        data-gliding={gliding || undefined}
        data-quick-open={!!quick || undefined}
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
                key={tile.key}
                className="imm__info-item"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: 'blur(4px)', transition: { duration: 0.18, ease: ease.in } }}
                transition={pick(reduce, spring.panel)}
              >
                <TileInfo tile={tile} />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.section>

        <section className="imm__rows" aria-label="Games">
          {rows.length === 0 ? (
            <p className="imm__empty">No games yet. Press the Menu button for desktop mode, where you can scan your stores or add games.</p>
          ) : (
            <RowsTrack
              rows={rows}
              activeRow={row}
              activeCol={col}
              cols={nav.cols}
              ringVars={ringVars}
              ringHidden={!!panel || !!quick}
              holding={holdingX}
              viewportRef={viewportRef}
              onRing={onRing}
              onPick={(r, c) => setNav((n) => pickTile(n, rows, r, c))}
              onOpen={openTile}
            />
          )}
        </section>

        <footer className="imm__hints">
          <span><PadGlyph button="A" /> Open</span>
          <span><PadGlyph button="X" /> Favorite</span>
          <button className="imm__hint-btn" onClick={openQuick}>
            <PadGlyph button="View" /> Quick menu
          </button>
          <button className="imm__hint-btn" onClick={openSearch}>
            <PadGlyph button="Y" /> Search
          </button>
          <span><PadGlyph button="LB" /><PadGlyph button="RB" /> Sections</span>
          <button className="imm__exit" onClick={() => void setMode('desktop')}>
            <PadGlyph button="Menu" /> <Monitor size={16} /> Desktop mode
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
        <AnimatePresence>
          {search && <OnScreenKeyboard key="osk" games={searchGames} filters={oskFilters} onClose={() => setSearch(false)} onOpenGame={openFromSearch} />}
        </AnimatePresence>
        </div>
        <AttractMode games={visible} active={attract} onActiveChange={setAttract} />
      </div>
    </LayoutGroup>
  );
}

/* ------------------------------------------------------------------ info */

function TileInfo({ tile }: { tile: Tile }) {
  if (tile.kind === 'store') {
    return (
      <>
        <div className="imm__browse-title">
          <StoreLogo platform={tile.platform} size={56} decorative />
          <h1 className="imm__title">{PLATFORM_NAMES[tile.platform]}</h1>
        </div>
        <div className="imm__meta"><span>{plural(tile.count, 'game')} from this store</span><span><PadGlyph button="A" /> Browse</span></div>
      </>
    );
  }
  if (tile.kind === 'genre') {
    return (
      <>
        <h1 className="imm__title">{tile.genre}</h1>
        <div className="imm__meta"><span>{plural(tile.count, 'game')}</span><span><PadGlyph button="A" /> Browse</span></div>
      </>
    );
  }
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
  };
}

const sameMetrics = (a: Metrics | null, b: Metrics) => !!a && (Object.keys(b) as (keyof Metrics)[]).every((k) => Math.abs(a[k] - b[k]) < 0.5);

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
      y += r.wide ? m.rowWideH : m.rowH;
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
      for (const t of r.tiles) {
        const w = r.wide ? (t.kind === 'game' && t.pinned ? m.pinW : m.ww) : m.pw;
        xs.push(x);
        widths.push(w);
        x += w + m.gap;
      }
      return { xs, widths, total: Math.max(0, x - m.gap) };
    },
    [m],
  );
  /** How far a shelf is slid so its focused card sits at the left edge (never past its end). */
  const shiftOf = useCallback(
    (r: Row, col: number) => {
      if (!m) return 0;
      const { xs, total } = layoutRow(r);
      const c = Math.max(0, Math.min(col, r.tiles.length - 1));
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
    return { x: m.pad + xs[c] - shiftOf(r, c), y: m.titleH, w: widths[c], h: r.wide ? m.wh : m.ph };
  }, [rows, activeRow, activeCol, m, layoutRow, shiftOf]);

  useEffect(() => {
    // Screen position (for spatial sound), from the cached viewport edge.
    if (ring && m) onRing({ ...ring, x: m.left + ring.x });
  }, [ring, m, onRing]);

  const from = Math.max(0, activeRow - WINDOW_BEFORE);
  const to = Math.min(rows.length, activeRow + WINDOW_AFTER + 1);

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
      </div>
      <motion.div className="imm__track" animate={{ y: -(offsets[activeRow] ?? 0) }} transition={pick(reduce, spring.page)}>
        {rows.map((r, ri) => {
          const active = ri === activeRow;
          const mounted = ri >= from && ri < to;
          const focusCol = active ? activeCol : -1;
          return (
            <div
              key={r.id}
              className={`imm__row ${r.wide ? 'imm__row--wide' : ''} ${r.browse ? 'imm__row--browse' : ''}`}
              data-active={active}
              aria-hidden={!mounted || undefined}
            >
              <h2 className="imm__row-title" style={active ? ringVars : undefined}>
                <span className="imm__row-name">{r.title}</span>
                {r.meta && <span className="imm__row-meta">{r.meta}</span>}
                {active && r.tiles.length > 1 && (
                  <span className="imm__row-count num" aria-hidden>
                    {activeCol + 1} / {r.tiles.length}
                  </span>
                )}
              </h2>
              {mounted && (
                <motion.div className="imm__shelf" animate={{ x: -shiftOf(r, active ? activeCol : cols[r.id] ?? 0) }} transition={pick(reduce, spring.focus)}>
                  {r.tiles.map((t, i) => {
                    const isFocused = i === focusCol;
                    return (
                      <button
                        key={t.key}
                        className={`imm__card ${r.wide ? 'imm__card--wide' : ''} ${t.kind === 'game' && t.pinned ? 'imm__card--pinned' : ''} ${t.kind !== 'game' ? 'imm__card--browse' : ''}`}
                        data-focused={isFocused}
                        tabIndex={-1}
                        aria-label={tileLabel(t)}
                        aria-current={isFocused ? 'true' : undefined}
                        onPointerMove={(e) => {
                          // Only real pointer movement moves focus (content sliding under a still cursor must not).
                          if ((e.movementX !== 0 || e.movementY !== 0) && !isFocused) onPick(ri, i);
                        }}
                        onClick={() => {
                          onPick(ri, i);
                          onOpen(t);
                        }}
                      >
                        <motion.div layoutId={isFocused && t.kind === 'game' ? `imm-cover-${t.game.id}` : undefined} className="imm__card-frame">
                          {t.kind === 'game' ? (
                            <>
                              <GameCover game={t.game} kind={r.wide ? 'hero' : 'cover'} />
                              {!isInstalled(t.game) && <span className="imm__card-flag">Not installed</span>}
                              {t.pinned && (
                                <span className="imm__card-pin">
                                  <Pin size="0.85em" aria-hidden /> {lastPlayed(t.game).at ? formatRelative(lastPlayed(t.game).at) : 'Last played'}
                                </span>
                              )}
                            </>
                          ) : (
                            <BrowseFace tile={t} />
                          )}
                        </motion.div>
                        <div className="imm__card-label">{t.kind === 'game' ? t.game.title : t.kind === 'store' ? PLATFORM_NAMES[t.platform] : t.genre}</div>
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
          initial={false}
          animate={{
            // The active row is always translated to the top of the viewport, so the ring's
            // target is the card's layout rect, enlarged by the focus scale around its centre.
            x: ring.x - (ring.w * (FOCUS_SCALE - 1)) / 2,
            y: ring.y - (ring.h * (FOCUS_SCALE - 1)) / 2,
            width: ring.w * FOCUS_SCALE,
            height: ring.h * FOCUS_SCALE,
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

function BrowseFace({ tile }: { tile: Exclude<Tile, { kind: 'game' }> }) {
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
