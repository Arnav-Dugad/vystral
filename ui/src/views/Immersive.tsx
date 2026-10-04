import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Heart, Monitor, Play } from 'lucide-react';
import type { Game, GamepadButton } from '../bridge/types';
import { formatDuration, formatRelative, importedMinutes, isInstalled, lastPlayed, PLATFORM_NAMES, plural } from '../lib/format';
import { pushPadHandler, rumble } from '../lib/input';
import { ease, pick, spring } from '../lib/motion';
import { suggestGames } from '../lib/recommend';
import { sound } from '../lib/sound';
import { toggleFavorite } from '../state/actions';
import { useReducedMotion, useStore } from '../state/store';
import { GameCover } from '../components/game/GameCover';
import { PadGlyph } from '../components/ui/primitives';
import './immersive.css';

interface Row {
  id: string;
  title: string;
  games: Game[];
  wide?: boolean;
}

type Tab = 'home' | 'library';

/**
 * Immersive Mode: a separate, controller-first 10-foot layout. Focus is always anchored —
 * the focused card stays near the left edge and rows scroll beneath it — so the user never
 * loses track of where they are. Works fully with keyboard and mouse too.
 */
export function ImmersiveView() {
  const games = useStore((s) => s.library.games);
  const setMode = useStore((s) => s.setMode);
  const setCommandOpen = useStore((s) => s.setCommandOpen);
  const setFocusGame = useStore((s) => s.setFocusGame);
  const reduce = useReducedMotion();
  const [tab, setTab] = useState<Tab>('home');
  const [row, setRow] = useState(0);
  const [cols, setCols] = useState<Record<string, number>>({});
  const [panel, setPanel] = useState<Game | null>(null);

  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);
  const rows = useMemo<Row[]>(() => {
    if (tab === 'library') {
      const sorted = [...visible].sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
      const perRow = 7;
      return Array.from({ length: Math.ceil(sorted.length / perRow) }, (_, i) => ({ id: `lib-${i}`, title: i === 0 ? `All games · ${plural(sorted.length, 'game')}` : '', games: sorted.slice(i * perRow, i * perRow + perRow) }));
    }
    const now = Date.now();
    const recent = visible.filter((g) => isInstalled(g) && lastPlayed(g).at).sort((a, b) => lastPlayed(b).at!.localeCompare(lastPlayed(a).at!)).slice(0, 15);
    const out: Row[] = [
      { id: 'continue', title: 'Continue playing', games: recent, wide: true },
      { id: 'suggested', title: 'Picked for you', games: suggestGames(visible, now, 15).map((s) => s.game) },
      { id: 'favorites', title: 'Favorites', games: visible.filter((g) => g.favorite) },
      { id: 'installed', title: 'Installed', games: visible.filter(isInstalled).sort((a, b) => a.sortTitle.localeCompare(b.sortTitle)).slice(0, 40) },
      { id: 'new', title: 'Recently added', games: [...visible].sort((a, b) => b.added.localeCompare(a.added)).slice(0, 15) },
    ];
    return out.filter((r) => r.games.length > 0);
  }, [visible, tab]);

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
        }
      }
      if (dr) {
        const nextRow = Math.max(0, Math.min(rows.length - 1, safeRow + dr));
        if (nextRow !== safeRow) {
          // In the A–Z grid keep the same column; shelves remember their own position.
          if (tab === 'library') setCols((c) => ({ ...c, [rows[nextRow].id]: Math.min(col, rows[nextRow].games.length - 1) }));
          setRow(nextRow);
          sound.focus();
        }
      }
    },
    [current, col, rows, safeRow, tab],
  );

  const handle = useCallback(
    (button: GamepadButton | string, repeat: boolean): boolean => {
      if (panel) {
        if (button === 'B' || button === 'Escape') {
          setPanel(null);
          sound.back();
          return true;
        }
        return false; // the panel's buttons are focusable; default spatial nav handles them
      }
      // Any other open dialog (command bar, update centre) owns input.
      if (document.querySelector('[data-dialog-open]')) return false;
      switch (button) {
        case 'Up': case 'ArrowUp': move(-1, 0); return true;
        case 'Down': case 'ArrowDown': move(1, 0); return true;
        case 'Left': case 'ArrowLeft': move(0, -1); return true;
        case 'Right': case 'ArrowRight': move(0, 1); return true;
        case 'A': case 'Enter':
          if (repeat || !focused) return true;
          setPanel(focused);
          sound.select();
          rumble(0.3, 40);
          return true;
        case 'LB': case 'RB': case 'q': case 'e':
          if (repeat) return true;
          setTab((t) => (t === 'home' ? 'library' : 'home'));
          setRow(0);
          sound.select();
          return true;
        case 'Y':
          if (!repeat) setCommandOpen(true);
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
    [panel, move, focused, setCommandOpen, setMode],
  );

  useEffect(() => pushPadHandler((b, r) => handle(b, r)), [handle]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea') || useStore.getState().commandOpen) return;
      if (panel && !['Escape'].includes(e.key)) return;
      if (handle(e.key, e.repeat)) e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [handle, panel]);

  return (
    <div className="imm" data-reduced={reduce}>
      <Backdrop game={focused} />
      <header className="imm__top">
        <img src="./vystral-mark.svg" alt="" className="imm__mark" />
        <nav className="imm__tabs" aria-label="Sections">
          <PadGlyph button="LB" />
          {(['home', 'library'] as Tab[]).map((t) => (
            <button key={t} className="imm__tab" aria-current={tab === t ? 'page' : undefined} onClick={() => { setTab(t); setRow(0); }}>
              {t === 'home' ? 'Home' : 'All games'}
              {tab === t && <motion.span layoutId="imm-tab" className="imm__tab-bar" transition={pick(reduce, spring.focus)} />}
            </button>
          ))}
          <PadGlyph button="RB" />
        </nav>
        <Clock />
      </header>

      <section className="imm__info" aria-live="polite">
        <AnimatePresence mode="wait">
          {focused && (
            <motion.div key={focused.id} initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.12 } }} transition={pick(reduce, spring.panel)}>
              {focused.art.logo ? <img className="imm__logo" src={focused.art.logo} alt={focused.title} /> : <h1 className="imm__title">{focused.title}</h1>}
              <GameMeta game={focused} />
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <section className="imm__rows" aria-label="Games">
        {rows.length === 0 && <p className="imm__empty">No games yet. Switch to desktop mode (Menu button) to scan your stores or add games.</p>}
        <RowsTrack rows={rows} activeRow={safeRow} cols={cols} onPick={(r, c) => { setRow(r); setCols((x) => ({ ...x, [rows[r].id]: c })); }} onOpen={(g) => setPanel(g)} />
      </section>

      <footer className="imm__hints">
        <span><PadGlyph button="A" /> Select</span>
        <span><PadGlyph button="B" /> Back</span>
        <span><PadGlyph button="Y" /> Search</span>
        <span><PadGlyph button="Menu" /> Desktop mode</span>
        <button className="imm__exit" onClick={() => void setMode('desktop')}><Monitor size={16} /> Desktop mode</button>
      </footer>

      <AnimatePresence>{panel && <GamePanel game={panel} onClose={() => setPanel(null)} />}</AnimatePresence>
    </div>
  );
}

function RowsTrack({ rows, activeRow, cols, onPick, onOpen }: { rows: Row[]; activeRow: number; cols: Record<string, number>; onPick: (r: number, c: number) => void; onOpen: (g: Game) => void }) {
  const reduce = useReducedMotion();
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const [offsets, setOffsets] = useState<number[]>([]);
  useLayoutEffect(() => {
    setOffsets(refs.current.map((el) => el?.offsetTop ?? 0));
  }, [rows]);
  // Only rows near the focused one are mounted (large libraries stay fast).
  const from = Math.max(0, activeRow - 2);
  const to = Math.min(rows.length, activeRow + 5);
  return (
    <motion.div className="imm__track" animate={{ y: -(offsets[activeRow] ?? 0) }} transition={pick(reduce, spring.page)}>
      {rows.map((r, ri) => (
        <div key={r.id} ref={(el) => { refs.current[ri] = el; }} className={`imm__row ${r.wide ? 'imm__row--wide' : ''}`} data-active={ri === activeRow}>
          {r.title && <h2 className="imm__row-title">{r.title}</h2>}
          {ri >= from && ri < to ? (
            <Shelf row={r} active={ri === activeRow} col={cols[r.id] ?? 0} onPick={(c) => onPick(ri, c)} onOpen={onOpen} />
          ) : (
            <div className={r.wide ? 'imm__placeholder imm__placeholder--wide' : 'imm__placeholder'} />
          )}
        </div>
      ))}
    </motion.div>
  );
}

function Shelf({ row, active, col, onPick, onOpen }: { row: Row; active: boolean; col: number; onPick: (c: number) => void; onOpen: (g: Game) => void }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [maxShift, setMaxShift] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.children.length < 1) return;
    const first = el.children[0] as HTMLElement;
    const second = el.children[1] as HTMLElement | undefined;
    const s = second ? second.offsetLeft - first.offsetLeft : first.offsetWidth;
    setStep(s);
    setMaxShift(Math.max(0, el.scrollWidth - (el.parentElement?.clientWidth ?? 0) + 24));
  }, [row.games.length]);
  const shift = Math.min(col * step, maxShift);
  return (
    <div className="imm__viewport">
      <motion.div ref={ref} className="imm__shelf" animate={{ x: -shift }} transition={pick(reduce, spring.focus)}>
        {row.games.map((g, i) => (
          <button
            key={g.id}
            className={`imm__card ${row.wide ? 'imm__card--wide' : ''}`}
            data-focused={active && i === col}
            tabIndex={-1}
            aria-label={g.title}
            aria-current={active && i === col ? 'true' : undefined}
            onMouseEnter={() => onPick(i)}
            onClick={() => (active && i === col ? onOpen(g) : onPick(i))}
          >
            <div className="imm__card-frame">
              <GameCover game={g} kind={row.wide ? 'hero' : 'cover'} />
            </div>
            {row.wide && <div className="imm__card-label">{g.title}</div>}
          </button>
        ))}
      </motion.div>
    </div>
  );
}

function Backdrop({ game }: { game: Game | null }) {
  const reduce = useReducedMotion();
  return (
    <div className="imm__backdrop" aria-hidden>
      <AnimatePresence>
        {game && (
          <motion.div key={game.id} className="imm__backdrop-art" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0.15 : 0.6, ease: ease.out }}>
            <GameCover game={game} kind="hero" />
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
  return (
    <div className="imm__meta">
      <span>{[...new Set(game.installations.map((i) => PLATFORM_NAMES[i.platform]))].join(' · ')}</span>
      {lp.at && <span>Played {formatRelative(lp.at)}</span>}
      {game.trackedSeconds > 0 && <span>{formatDuration(game.trackedSeconds)} tracked</span>}
      {imported ? <span>{formatDuration(imported * 60)} in store</span> : null}
      {!isInstalled(game) && <span className="imm__warn">Not installed</span>}
      {game.genres.length > 0 && <span>{game.genres.slice(0, 3).join(' · ')}</span>}
    </div>
  );
}

function GamePanel({ game, onClose }: { game: Game; onClose: () => void }) {
  const launchGame = useStore((s) => s.launchGame);
  const reduce = useReducedMotion();
  const installed = game.installations.filter((i) => i.state === 'installed');
  const playRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => playRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <motion.div
      className="imm-panel"
      data-dialog-open
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div role="dialog" aria-modal="true" aria-label={game.title} className="imm-panel__card" initial={reduce ? { opacity: 0 } : { opacity: 0, y: 40, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={pick(reduce, spring.hero)}>
        <div className="imm-panel__cover"><GameCover game={game} /></div>
        <div className="imm-panel__body">
          <h2 className="imm-panel__title">{game.title}</h2>
          <GameMeta game={game} />
          {game.description && <p className="imm-panel__desc">{game.description}</p>}
          <div className="imm-panel__actions">
            {installed.length === 0 && <p className="imm__warn">This game isn’t installed on this PC.</p>}
            {installed.map((i, idx) => (
              <button
                key={i.id}
                ref={idx === 0 ? playRef : undefined}
                className="imm-btn imm-btn--primary"
                onClick={() => {
                  sound.launch();
                  rumble(0.5, 80);
                  onClose();
                  void launchGame(game.id, i.id);
                }}
              >
                <Play size={22} fill="currentColor" /> {installed.length > 1 ? `Play on ${PLATFORM_NAMES[i.platform]}` : 'Play'}
              </button>
            ))}
            <button className="imm-btn" onClick={() => void toggleFavorite(game)}>
              <Heart size={20} fill={game.favorite ? 'currentColor' : 'none'} /> {game.favorite ? 'Favorited' : 'Favorite'}
            </button>
            <button className="imm-btn" onClick={onClose}>Back</button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  return <div className="imm__clock num">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>;
}
