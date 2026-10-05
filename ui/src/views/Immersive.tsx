import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { Clock3, Gamepad2, HardDrive, Heart, Monitor, Play, Timer } from 'lucide-react';
import type { Game, GamepadButton } from '../bridge/types';
import {
  formatBytes, formatDuration, formatRelative, importedMinutes, isInstalled, lastPlayed, PLATFORM_NAMES, plural, sizeOf,
} from '../lib/format';
import { haptic } from '../lib/haptics';
import { pushPadHandler } from '../lib/input';
import { ease, pick, spring } from '../lib/motion';
import { peekPalette, titleHue } from '../lib/palette';
import { suggestGames } from '../lib/recommend';
import { sound } from '../lib/sound';
import { setLaunchOrigin } from '../lib/flight';
import { toggleFavorite } from '../state/actions';
import { useGameRunning, useReducedMotion, useStore } from '../state/store';
import { OnScreenKeyboard } from '../components/controller/OnScreenKeyboard';
import { GameCover } from '../components/game/GameCover';
import { PadGlyph } from '../components/ui/primitives';
import { AttractMode } from './immersive/AttractMode';
import './immersive.css';

interface Row {
  id: string;
  title: string;
  meta?: string;
  games: Game[];
  wide?: boolean;
}

type Tab = 'home' | 'library';

const GRID_COLUMNS = 7;
/** Rows mounted around the focused one. Others are exact-height placeholders. */
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 4;
/** Focused cards grow by this much; the ring grows with them (kept in sync with immersive.css). */
const FOCUS_SCALE = 1.06;

/**
 * Immersive Mode: an independent, controller-first 10-foot layout.
 * - Focus is anchored: the focused card sits at the left edge and rows slide beneath it.
 * - One focus ring travels between cards (a single element on a spring), like a console.
 * - Every row has a fixed height, so mounting/unmounting rows never shifts the layout.
 * - Pointer input only moves focus when the pointer actually moves.
 */
export function ImmersiveView() {
  const games = useStore((s) => s.library.games);
  const setMode = useStore((s) => s.setMode);
  const setFocusGame = useStore((s) => s.setFocusGame);
  const reduce = useReducedMotion();
  const [tab, setTab] = useState<Tab>('home');
  const [row, setRow] = useState(0);
  const [cols, setCols] = useState<Record<string, number>>({});
  const [panel, setPanel] = useState<Game | null>(null);
  const [attract, setAttract] = useState(false);
  const [search, setSearch] = useState(false);

  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);
  const rows = useMemo<Row[]>(() => buildRows(visible, tab), [visible, tab]);

  const safeRow = Math.min(row, Math.max(0, rows.length - 1));
  const current = rows[safeRow];
  const col = Math.min(cols[current?.id ?? ''] ?? 0, Math.max(0, (current?.games.length ?? 1) - 1));
  const focused = current?.games[col] ?? null;

  useEffect(() => {
    if (focused) setFocusGame(focused.id);
  }, [focused, setFocusGame]);

  const move = useCallback(
    (dr: number, dc: number) => {
      if (!current) return;
      if (dc) {
        const next = Math.max(0, Math.min(current.games.length - 1, col + dc));
        if (next !== col) {
          setCols((c) => ({ ...c, [current.id]: next }));
          sound.focus();
        } else {
          haptic('edge'); // end of the row
        }
      }
      if (dr) {
        const nextRow = Math.max(0, Math.min(rows.length - 1, safeRow + dr));
        if (nextRow !== safeRow) {
          // The A–Z grid keeps the same column; shelves remember their own position.
          if (tab === 'library') setCols((c) => ({ ...c, [rows[nextRow].id]: Math.min(col, rows[nextRow].games.length - 1) }));
          setRow(nextRow);
          sound.focus();
        } else {
          haptic('edge'); // first or last row
        }
      }
    },
    [current, col, rows, safeRow, tab],
  );

  const switchTab = useCallback((t?: Tab) => {
    setTab((prev) => t ?? (prev === 'home' ? 'library' : 'home'));
    setRow(0);
    sound.select();
    haptic('tick');
  }, []);

  /** Opens a game picked from search, leaving focus on it when the panel closes. */
  const openFromSearch = useCallback(
    (g: Game) => {
      setSearch(false);
      const here = rows.findIndex((r) => r.games.some((x) => x.id === g.id));
      if (here >= 0) {
        setRow(here);
        setCols((c) => ({ ...c, [rows[here].id]: rows[here].games.findIndex((x) => x.id === g.id) }));
      } else {
        const all = buildRows(visible, 'library');
        const r = Math.max(0, all.findIndex((x) => x.games.some((y) => y.id === g.id)));
        setTab('library');
        setRow(r);
        setCols((c) => ({ ...c, [all[r].id]: all[r].games.findIndex((x) => x.id === g.id) }));
      }
      setPanel(g);
    },
    [rows, visible],
  );

  const handle = useCallback(
    (button: GamepadButton | string, repeat: boolean): boolean => {
      if (attract) return true; // the attract screen consumes input itself
      if (panel) {
        if (button === 'B' || button === 'Escape') {
          setPanel(null);
          sound.back();
          return true;
        }
        return false; // panel buttons are real focusable elements; spatial nav handles them
      }
      // Any other open dialog (command bar, update centre) owns input.
      if (document.querySelector('[data-dialog-open]')) return false;
      switch (button) {
        case 'Up': case 'ArrowUp': move(-1, 0); return true;
        case 'Down': case 'ArrowDown': move(1, 0); return true;
        case 'Left': case 'ArrowLeft': move(0, -1); return true;
        case 'Right': case 'ArrowRight': move(0, 1); return true;
        case 'A': case 'Enter': case ' ':
          if (repeat || !focused) return true;
          setPanel(focused);
          sound.select();
          haptic('tick');
          return true;
        case 'LB': case 'RB': case 'q': case 'e':
          if (!repeat) switchTab();
          return true;
        case 'Y': case 'y':
          if (!repeat) {
            setSearch(true);
            sound.select();
          }
          return true;
        case 'X':
          if (!repeat && focused) void toggleFavorite(focused);
          return true;
        case 'B': case 'Escape':
          return true;
        case 'Menu': case 'F11':
          if (!repeat) void setMode('desktop');
          return true;
        default:
          return false;
      }
    },
    [attract, panel, move, focused, switchTab, setMode],
  );

  useEffect(() => pushPadHandler((b, r) => handle(b, r)), [handle]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea') || useStore.getState().commandOpen) return;
      if (panel && e.key !== 'Escape') return;
      if (handle(e.key, e.repeat)) e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [handle, panel]);

  return (
    <LayoutGroup>
      <div className="imm" data-reduced={reduce}>
        <Backdrop game={focused} />
        <header className="imm__top">
          <img src="./vystral-mark.svg" alt="" className="imm__mark" />
          <nav className="imm__tabs" aria-label="Sections">
            <PadGlyph button="LB" />
            {(['home', 'library'] as Tab[]).map((t) => (
              <button key={t} className="imm__tab" aria-current={tab === t ? 'page' : undefined} onClick={() => t !== tab && switchTab(t)}>
                {t === 'home' ? 'Home' : 'All games'}
                {tab === t && <motion.span layoutId="imm-tab" className="imm__tab-bar" transition={pick(reduce, spring.focus)} />}
              </button>
            ))}
            <PadGlyph button="RB" />
          </nav>
          <div className="imm__status">
            <ControllerStatus />
            <Clock />
          </div>
        </header>

        <section className="imm__info" aria-live="polite">
          {/* Old and new info share one grid cell and crossfade, so fast browsing never blanks it. */}
          <AnimatePresence initial={false}>
            {focused && (
              <motion.div
                key={focused.id}
                className="imm__info-item"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: 'blur(4px)', transition: { duration: 0.18, ease: ease.in } }}
                transition={pick(reduce, spring.panel)}
              >
                {focused.art.logo ? <img className="imm__logo" src={focused.art.logo} alt={focused.title} /> : <h1 className="imm__title">{focused.title}</h1>}
                <GameMeta game={focused} />
                {focused.description && <p className="imm__desc">{focused.description}</p>}
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        <section className="imm__rows" aria-label="Games">
          {rows.length === 0 ? (
            <p className="imm__empty">No games yet. Press the Menu button for desktop mode, where you can scan your stores or add games.</p>
          ) : (
            <RowsTrack
              rows={rows}
              activeRow={safeRow}
              cols={cols}
              ringHidden={!!panel}
              onPick={(r, c) => {
                setRow(r);
                setCols((x) => ({ ...x, [rows[r].id]: c }));
              }}
              onOpen={(g) => {
                setPanel(g);
                sound.select();
              }}
            />
          )}
        </section>

        <footer className="imm__hints">
          <span><PadGlyph button="A" /> Open</span>
          <span><PadGlyph button="X" /> Favorite</span>
          <button className="imm__hint-btn" onClick={() => setSearch(true)}>
            <PadGlyph button="Y" /> Search
          </button>
          <span><PadGlyph button="LB" /><PadGlyph button="RB" /> Sections</span>
          <button className="imm__exit" onClick={() => void setMode('desktop')}>
            <PadGlyph button="Menu" /> <Monitor size={16} /> Desktop mode
          </button>
        </footer>

        <AnimatePresence>{panel && <GamePanel key={panel.id} game={panel} onClose={() => setPanel(null)} />}</AnimatePresence>
        <AnimatePresence>{search && <OnScreenKeyboard key="osk" games={visible} onClose={() => setSearch(false)} onOpenGame={openFromSearch} />}</AnimatePresence>
        <AttractMode games={visible} active={attract} onActiveChange={setAttract} />
      </div>
    </LayoutGroup>
  );
}

function buildRows(visible: Game[], tab: Tab): Row[] {
  if (tab === 'library') {
    const sorted = [...visible].sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
    return Array.from({ length: Math.ceil(sorted.length / GRID_COLUMNS) }, (_, i) => {
      const slice = sorted.slice(i * GRID_COLUMNS, i * GRID_COLUMNS + GRID_COLUMNS);
      const letter = (g?: Game) => {
        const c = g?.sortTitle.charAt(0).toUpperCase() ?? '';
        return /[A-Z]/.test(c) ? c : '#';
      };
      const a = letter(slice[0]);
      const b = letter(slice[slice.length - 1]);
      return {
        id: `lib-${i}`,
        title: i === 0 ? 'All games' : a === b ? a : `${a} – ${b}`,
        meta: i === 0 ? plural(sorted.length, 'game') : undefined,
        games: slice,
      };
    });
  }
  const now = Date.now();
  const recent = visible
    .filter((g) => isInstalled(g) && lastPlayed(g).at)
    .sort((a, b) => lastPlayed(b).at!.localeCompare(lastPlayed(a).at!))
    .slice(0, 15);
  const out: Row[] = [
    { id: 'continue', title: 'Continue playing', games: recent, wide: true },
    { id: 'suggested', title: 'Picked for you', meta: 'From what you play', games: suggestGames(visible, now, 15).map((s) => s.game) },
    { id: 'favorites', title: 'Favorites', games: visible.filter((g) => g.favorite) },
    { id: 'installed', title: 'Installed', games: visible.filter(isInstalled).sort((a, b) => a.sortTitle.localeCompare(b.sortTitle)).slice(0, 40) },
    { id: 'new', title: 'Recently added', games: [...visible].sort((a, b) => b.added.localeCompare(a.added)).slice(0, 15) },
  ];
  // If nothing was played yet, lead with installed games instead of an empty first row.
  return out.filter((r) => r.games.length > 0);
}

interface RingRect {
  x: number;
  y: number;
  w: number;
  h: number;
  accent: string;
}

function RowsTrack({
  rows, activeRow, cols, ringHidden, onPick, onOpen,
}: {
  rows: Row[];
  activeRow: number;
  cols: Record<string, number>;
  ringHidden: boolean;
  onPick: (r: number, c: number) => void;
  onOpen: (g: Game) => void;
}) {
  const reduce = useReducedMotion();
  const viewportRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [offsets, setOffsets] = useState<number[]>([]);
  const [shifts, setShifts] = useState<Record<string, number>>({});
  const [ring, setRing] = useState<RingRect | null>(null);
  const [size, setSize] = useState(0);

  // Rows have fixed heights (CSS), so offsets only change when rows or the viewport change.
  useLayoutEffect(() => {
    setOffsets(rowRefs.current.map((el) => el?.offsetTop ?? 0));
  }, [rows, size]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize(el.clientWidth * 10000 + el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const activeCol = cols[rows[activeRow]?.id] ?? 0;

  // Compute the anchored horizontal shift for the active row and the ring's target rect from
  // layout positions (offsetLeft/offsetTop ignore transforms, so the target is exact even while
  // springs are mid-flight).
  useLayoutEffect(() => {
    const rowEl = rowRefs.current[activeRow];
    const viewport = viewportRef.current;
    const r = rows[activeRow];
    if (!rowEl || !viewport || !r) return;
    const shelf = rowEl.querySelector<HTMLElement>('.imm__shelf');
    const card = shelf?.children[Math.min(activeCol, r.games.length - 1)] as HTMLElement | undefined;
    if (!shelf || !card) return;
    const frame = card.querySelector<HTMLElement>('.imm__card-frame') ?? card;
    const viewportWidth = viewport.clientWidth;
    const padding = parseFloat(getComputedStyle(viewport).paddingLeft) || 0;
    const content = shelf.scrollWidth;
    const maxShift = Math.max(0, content - (viewportWidth - padding * 2));
    const shift = Math.min(card.offsetLeft, maxShift);
    setShifts((s) => (s[r.id] === shift ? s : { ...s, [r.id]: shift }));
    const g = r.games[Math.min(activeCol, r.games.length - 1)];
    setRing({
      x: padding + card.offsetLeft - shift,
      y: shelf.offsetTop + card.offsetTop,
      w: frame.offsetWidth,
      h: frame.offsetHeight,
      accent: peekPalette(g)?.accent ?? `oklch(0.75 0.15 ${titleHue(g.title)})`,
    });
  }, [rows, activeRow, activeCol, size, offsets]);

  const from = Math.max(0, activeRow - WINDOW_BEFORE);
  const to = Math.min(rows.length, activeRow + WINDOW_AFTER + 1);

  return (
    <div className="imm__viewport-y" ref={viewportRef}>
      <motion.div className="imm__track" animate={{ y: -(offsets[activeRow] ?? 0) }} transition={pick(reduce, spring.page)}>
        {rows.map((r, ri) => {
          const active = ri === activeRow;
          const mounted = ri >= from && ri < to;
          return (
            <div
              key={r.id}
              ref={(el) => { rowRefs.current[ri] = el; }}
              className={`imm__row ${r.wide ? 'imm__row--wide' : ''}`}
              data-active={active}
              aria-hidden={!mounted || undefined}
            >
              <h2 className="imm__row-title">
                {r.title}
                {r.meta && <span className="imm__row-meta">{r.meta}</span>}
              </h2>
              {mounted && (
                <motion.div className="imm__shelf" animate={{ x: -(shifts[r.id] ?? 0) }} transition={pick(reduce, spring.focus)}>
                  {r.games.map((g, i) => {
                    const isFocused = active && i === (cols[r.id] ?? 0);
                    return (
                      <button
                        key={g.id}
                        className={`imm__card ${r.wide ? 'imm__card--wide' : ''}`}
                        data-focused={isFocused}
                        tabIndex={-1}
                        aria-label={`${g.title}${isInstalled(g) ? '' : ', not installed'}`}
                        aria-current={isFocused ? 'true' : undefined}
                        onPointerMove={(e) => {
                          // Only real pointer movement moves focus (content sliding under a still cursor must not).
                          if (e.movementX !== 0 || e.movementY !== 0) {
                            if (!isFocused) onPick(ri, i);
                          }
                        }}
                        onClick={() => {
                          onPick(ri, i);
                          onOpen(g);
                        }}
                      >
                        <motion.div layoutId={isFocused ? `imm-cover-${g.id}` : undefined} className="imm__card-frame">
                          <GameCover game={g} kind={r.wide ? 'hero' : 'cover'} />
                          {!isInstalled(g) && <span className="imm__card-flag">Not installed</span>}
                        </motion.div>
                        <div className="imm__card-label">{g.title}</div>
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </div>
          );
        })}
      </motion.div>

      {/* The one travelling focus ring. */}
      {ring && (
        <motion.div
          className="imm__ring"
          aria-hidden
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
          style={{ ['--ring' as string]: ring.accent, top: 0, left: 0 }}
          transition={pick(reduce, spring.focus)}
        />
      )}
    </div>
  );
}

function Backdrop({ game }: { game: Game | null }) {
  const reduce = useReducedMotion();
  return (
    <div className="imm__backdrop" aria-hidden>
      <AnimatePresence initial={false}>
        {game && (
          <motion.div
            key={game.id}
            className="imm__backdrop-art"
            initial={{ opacity: 0, scale: reduce ? 1 : 1.04 }}
            animate={{ opacity: 1, scale: reduce ? 1 : 1.0 }}
            exit={{ opacity: 0 }}
            transition={{ opacity: { duration: reduce ? 0.15 : 0.7, ease: ease.out }, scale: { duration: 1.6, ease: ease.cinematic } }}
          >
            <div className="imm__backdrop-drift">
              <GameCover game={game} kind="hero" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="imm__backdrop-scrim" />
    </div>
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
            <span className="imm__store-dot" style={{ background: `var(--p-${p})` }} />
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

function GamePanel({ game, onClose }: { game: Game; onClose: () => void }) {
  const launchGame = useStore((s) => s.launchGame);
  const reduce = useReducedMotion();
  const installed = game.installations.filter((i) => i.state === 'installed');
  const playRef = useRef<HTMLButtonElement>(null);
  const lp = lastPlayed(game);
  const imported = importedMinutes(game);
  const size = sizeOf(game);

  useEffect(() => {
    const t = window.setTimeout(() => playRef.current?.focus({ preventScroll: true }), 80);
    return () => window.clearTimeout(t);
  }, []);

  const stats = [
    { icon: <Clock3 size={18} />, label: 'Last played', value: lp.at ? formatRelative(lp.at) : 'Never' },
    { icon: <Timer size={18} />, label: 'Tracked', value: game.trackedSeconds ? formatDuration(game.trackedSeconds) : '—' },
    { icon: <Gamepad2 size={18} />, label: 'In store', value: imported ? formatDuration(imported * 60) : '—' },
    { icon: <HardDrive size={18} />, label: 'Size', value: size ? formatBytes(size) : '—' },
  ];

  return (
    <motion.div
      className="imm-panel"
      data-dialog-open
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={game.title}
        className="imm-panel__card"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 30, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.985, transition: { duration: 0.18, ease: ease.in } }}
        transition={pick(reduce, spring.hero)}
      >
        <div className="imm-panel__bg" aria-hidden>
          <GameCover game={game} kind="hero" />
        </div>
        <motion.div layoutId={`imm-cover-${game.id}`} className="imm-panel__cover" transition={pick(reduce, spring.hero)}>
          <GameCover game={game} />
        </motion.div>
        <div className="imm-panel__body">
          {game.art.logo ? <img className="imm-panel__logo" src={game.art.logo} alt={game.title} /> : <h2 className="imm-panel__title">{game.title}</h2>}
          <GameMeta game={game} />
          {game.description && <p className="imm-panel__desc">{game.description}</p>}
          <div className="imm-panel__stats">
            {stats.map((s, i) => (
              <motion.div
                key={s.label}
                className="imm-panel__stat"
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...spring.panel, delay: 0.12 + i * 0.04 }}
              >
                {s.icon}
                <span className="imm-panel__stat-label">{s.label}</span>
                <span className="imm-panel__stat-value">{s.value}</span>
              </motion.div>
            ))}
          </div>
          <div className="imm-panel__actions">
            {installed.length === 0 && <p className="imm__warn">This game isn’t installed on this PC.</p>}
            {installed.map((i, idx) => (
              <button
                key={i.id}
                ref={idx === 0 ? playRef : undefined}
                className="imm-btn imm-btn--primary"
                onClick={(e) => {
                  setLaunchOrigin(game.id, e.currentTarget);
                  sound.launch();
                  haptic('confirm');
                  onClose();
                  void launchGame(game.id, i.id);
                }}
              >
                <Play size="1.1em" fill="currentColor" /> {installed.length > 1 ? `Play on ${PLATFORM_NAMES[i.platform]}` : 'Play'}
              </button>
            ))}
            <button className="imm-btn" ref={installed.length === 0 ? playRef : undefined} onClick={() => void toggleFavorite(game)} aria-pressed={game.favorite}>
              <Heart size="1em" fill={game.favorite ? 'currentColor' : 'none'} /> {game.favorite ? 'Favorite' : 'Add to favorites'}
            </button>
            <button className="imm-btn imm-btn--ghost" onClick={onClose}>
              <PadGlyph button="B" /> Back
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ControllerStatus() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    void import('../bridge/bridge').then(({ on }) => {
      off = on('gamepad.connection', (e) => setCount(e.count));
    });
    return () => off?.();
  }, []);
  if (count === null) return null;
  return (
    <span className="imm__pad" data-connected={count > 0}>
      <Gamepad2 size="1em" /> {count > 0 ? (count > 1 ? `${count} controllers` : 'Controller') : 'No controller'}
    </span>
  );
}

function Clock() {
  const running = useGameRunning();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (running) return;
    // Tick on the minute boundary so the clock never shows a stale minute.
    let t: number;
    const schedule = () => {
      const d = new Date();
      t = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, (60 - d.getSeconds()) * 1000 - d.getMilliseconds() + 20);
    };
    schedule();
    return () => window.clearTimeout(t);
  }, [running]);
  return <div className="imm__clock num">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>;
}
