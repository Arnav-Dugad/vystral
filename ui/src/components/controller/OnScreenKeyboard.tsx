import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import { motion, useIsPresent } from 'motion/react';
import { CornerDownLeft, Delete, Search, Space, X } from 'lucide-react';
import type { Game, GamepadButton } from '../../bridge/types';
import { haptic } from '../../lib/haptics';
import { pushPadHandler } from '../../lib/input';
import { ease, pick, spring } from '../../lib/motion';
import {
  backspace, initialNav, insertText, moveCaret, moveNav, normalizeNav, OSK_COLUMNS, OSK_LAYOUTS, OSK_MAX_LENGTH, switchLayout,
  type OskDir, type OskKey, type OskLayoutName, type OskNav, type OskText,
} from '../../lib/osk';
import { predictGames, predictWords, type WordPrediction } from '../../lib/predict';
import { sound } from '../../lib/sound';
import { useReducedMotion } from '../../state/store';
import { GameCover } from '../game/GameCover';
import { PadGlyph } from '../ui/primitives';
import './controller.css';

const GAME_SLOTS = 7;
const WORD_SLOTS = 4;

const PAD_DIRS: Partial<Record<GamepadButton, OskDir>> = { Up: 'up', Down: 'down', Left: 'left', Right: 'right' };
const KEY_DIRS: Record<string, OskDir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

interface RingRect {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/**
 * Controller-first on-screen keyboard for searching the library from Immersive Mode.
 * - One travelling focus ring (same feel as Immersive's) moves over keys and predictions.
 * - A types, B deletes (B on an empty query closes), X space, Y closes, LB/RB move the caret,
 *   LT switches to symbols, RT/Menu jumps to the results.
 * - Above the keys: live predictions from the user's own library — matching games with their
 *   art, and word completions — reached by pressing Up.
 * - Keyboard and mouse work too: the query field stays focused for typing, keys are clickable,
 *   and predictions are tabbable buttons.
 */
/** Track L: fast filters above the results (Immersive: All / Installed / Favorites / Never played). View cycles them. */
export interface OskFilters {
  options: { id: string; label: string; count: number }[];
  value: string;
  onChange: (id: string) => void;
}

export function OnScreenKeyboard({ games, onClose, onOpenGame, filters }: { games: Game[]; onClose: () => void; onOpenGame: (game: Game) => void; filters?: OskFilters }) {
  const reduce = useReducedMotion();
  const isPresent = useIsPresent();
  const uid = useId();
  const [layoutName, setLayoutName] = useState<OskLayoutName>('letters');
  const layout = OSK_LAYOUTS[layoutName];
  const [edit, setEdit] = useState<OskText>({ text: '', caret: 0 });
  const [rawNav, setNav] = useState<OskNav>(() => initialNav(OSK_LAYOUTS.letters));
  const [press, setPress] = useState<{ id: string; n: number } | null>(null);
  const [ring, setRing] = useState<RingRect | null>(null);
  const [size, setSize] = useState(0);
  const [announce, setAnnounce] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const query = edit.text.trim();
  const results = useMemo(() => predictGames(games, edit.text, GAME_SLOTS), [games, edit.text]);
  const words = useMemo(() => predictWords(games, edit.text, WORD_SLOTS), [games, edit.text]);
  const counts = { games: results.length, words: words.length };
  const nav = normalizeNav(layout, rawNav, counts);
  const total = useMemo(() => games.filter((g) => !g.hidden).length, [games]);

  const idFor = (n: OskNav) =>
    n.zone === 'games' ? `${uid}-game-${n.game}` : n.zone === 'words' ? `${uid}-word-${n.word}` : `${uid}-key-${layout[n.row][n.col].id}`;
  const activeId = idFor(nav);

  // Focus moves in on open (before the next key event, so fast typing after Y loses nothing)
  // and goes back to where it was on close.
  useLayoutEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Keep the real caret in step with controller edits.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input && document.activeElement === input && input.selectionStart !== edit.caret) input.setSelectionRange(edit.caret, edit.caret);
  }, [edit]);

  // The ring's target comes from layout offsets (immune to the panel's entrance transform).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const el = document.getElementById(activeId);
    if (!stage || !el) return;
    const target = el.querySelector<HTMLElement>('[data-ring-target]') ?? el;
    const pos = offsetWithin(target, stage);
    if (!pos) return;
    const r = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 12;
    const next = { x: pos.x, y: pos.y, w: target.offsetWidth, h: target.offsetHeight, r };
    setRing((prev) => (prev && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h && prev.r === next.r ? prev : next));
  }, [activeId, layoutName, results, words, size]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => setSize(stage.clientWidth * 10000 + stage.clientHeight));
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  // Announce the result count once typing pauses, not on every key.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setAnnounce(!query ? '' : results.length ? `${results.length === GAME_SLOTS ? `${GAME_SLOTS} or more` : results.length} matching ${results.length === 1 ? 'game' : 'games'}` : 'No matching games');
    }, 450);
    return () => window.clearTimeout(t);
  }, [query, results.length]);

  const close = useCallback(() => {
    sound.back();
    const back = restoreRef.current;
    if (back?.isConnected) back.focus({ preventScroll: true });
    onClose();
  }, [onClose]);

  const flash = (id: string) => setPress((p) => ({ id, n: (p?.n ?? 0) + 1 }));
  const type = (s: string) => {
    setEdit((e) => insertText(e, s));
    sound.focus();
  };
  const erase = () => {
    setEdit((e) => backspace(e));
    sound.back();
  };
  const clear = () => setEdit({ text: '', caret: 0 });
  const toggleLayout = () => {
    setLayoutName(switchLayout);
    haptic('tick');
    sound.select();
  };

  const openGame = (g: Game | undefined) => {
    if (!g) return;
    haptic('tick');
    sound.select();
    onOpenGame(g);
  };

  const acceptWord = (w: WordPrediction | undefined) => {
    if (!w) return;
    setEdit({ text: w.query.slice(0, OSK_MAX_LENGTH), caret: Math.min(w.query.length, OSK_MAX_LENGTH) });
    setNav((n) => ({ ...n, word: 0 }));
    sound.select();
  };

  /** "Done": go to the results to pick one; with nothing typed, just close. */
  const done = () => {
    if (!query) return close();
    if (results.length === 0) {
      haptic('error');
      setAnnounce('No matching games');
      return;
    }
    setNav((n) => ({ ...n, zone: 'games', game: 0 }));
    haptic('tick');
    sound.select();
  };

  const pressKey = (k: OskKey) => {
    flash(k.id);
    switch (k.kind) {
      case 'char': return type(k.value ?? '');
      case 'space': return type(' ');
      case 'backspace': return edit.text ? erase() : haptic('edge');
      case 'clear': return clear();
      case 'done': return done();
      case 'layout': return toggleLayout();
    }
  };

  const activate = () => {
    if (nav.zone === 'games') return openGame(results[nav.game]);
    if (nav.zone === 'words') return acceptWord(words[nav.word]);
    pressKey(layout[nav.row][nav.col]);
  };

  const move = (dir: OskDir) => {
    const r = moveNav(layout, nav, dir, counts);
    if (r.blocked) {
      haptic('edge');
      return;
    }
    if (!r.moved) return;
    setNav(r.nav);
    sound.focus();
    if (r.zoneChanged && r.nav.zone !== 'keys') haptic('tick');
  };

  const onPad = (button: GamepadButton, repeat: boolean) => {
    const dir = PAD_DIRS[button];
    if (dir) return move(dir);
    if (repeat) return;
    switch (button) {
      case 'A': return activate();
      case 'B':
        if (!edit.text) return close();
        flash('backspace');
        return erase();
      case 'X':
        flash('space');
        return type(' ');
      case 'Y': return close();
      case 'LB': return setEdit((e) => moveCaret(e, -1));
      case 'RB': return setEdit((e) => moveCaret(e, 1));
      case 'LT':
        flash('layout');
        return toggleLayout();
      case 'RT':
      case 'Menu':
        flash('done');
        return done();
      case 'View':
        if (!filters || filters.options.length < 2) return clear();
        haptic('tick');
        sound.select();
        return filters.onChange(filters.options[(filters.options.findIndex((o) => o.id === filters.value) + 1) % filters.options.length].id);
    }
  };

  // Latest handler without re-registering: the keyboard owns every controller button while open.
  const padRef = useRef(onPad);
  useLayoutEffect(() => {
    padRef.current = onPad;
  });
  useEffect(() => {
    if (!isPresent) return;
    return pushPadHandler((button, repeat) => {
      padRef.current(button, repeat);
      return true;
    });
  }, [isPresent]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isPresent) return;
    const inInput = e.target === inputRef.current;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return close();
    }
    if (e.key === 'Tab') return trapTab(e, panelRef.current);
    const dir = KEY_DIRS[e.key];
    if (dir) {
      // Left/Right edit the caret while typing on the keys; elsewhere they move along the predictions.
      if ((dir === 'left' || dir === 'right') && inInput && nav.zone === 'keys') return;
      e.preventDefault();
      return move(dir);
    }
    if (e.key === 'Enter' && inInput) {
      e.preventDefault();
      if (nav.zone !== 'keys') return activate();
      if (!query) return close();
      if (results[0]) return openGame(results[0]);
      haptic('error');
      setAnnounce('No matching games');
    }
  };

  const pointTo = (n: OskNav) => (e: ReactPointerEvent) => {
    if (e.movementX === 0 && e.movementY === 0) return; // content moving under a still cursor isn't a hover
    if (idFor(n) !== activeId) setNav(n);
  };

  return (
    <motion.div
      className="osk"
      data-dialog-open={isPresent || undefined}
      // While it animates out it is gone: no key (a quick Enter after Escape) may act on it.
      inert={!isPresent || undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18, ease: ease.in } }}
      transition={pick(reduce, spring.effect)}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <motion.div
        ref={panelRef}
        className="osk__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        data-reduced={reduce}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 48, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 28, scale: 0.98, transition: { duration: 0.18, ease: ease.in } }}
        transition={pick(reduce, spring.panel)}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${uid}-title`} className="visually-hidden">Search your library</h2>
        <div className="osk__field">
          <Search className="osk__field-icon" size="1.3em" aria-hidden />
          <input
            ref={inputRef}
            className="osk__input"
            type="text"
            role="searchbox"
            value={edit.text}
            maxLength={OSK_MAX_LENGTH}
            placeholder={`Search ${total.toLocaleString()} ${total === 1 ? 'game' : 'games'}`}
            aria-label="Search your library"
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setEdit({ text: e.target.value.slice(0, OSK_MAX_LENGTH), caret: e.target.selectionStart ?? e.target.value.length })}
            onSelect={(e) => {
              const caret = e.currentTarget.selectionStart ?? edit.text.length;
              if (caret !== edit.caret) setEdit((x) => ({ ...x, caret }));
            }}
          />
          <span className="osk__count num" aria-hidden>
            {query ? (results.length ? `${results.length}${results.length === GAME_SLOTS ? '+' : ''} ${results.length === 1 ? 'match' : 'matches'}` : 'No matches') : ''}
          </span>
          <button type="button" className="osk__close" aria-label="Close search" onClick={close}>
            <X size="1.15em" aria-hidden />
          </button>
        </div>
        {filters && filters.options.length > 1 && (
          <div className="osk__filters" role="radiogroup" aria-label="Show">
            {filters.options.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={o.id === filters.value}
                className="osk__filter"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  sound.select();
                  filters.onChange(o.id);
                }}
              >
                {o.label} <span className="osk__filter-count num">{o.count.toLocaleString()}</span>
              </button>
            ))}
            <span className="osk__filter-hint" aria-hidden><PadGlyph button="View" /></span>
          </div>
        )}
        <p className="visually-hidden" aria-live="polite">{announce}</p>

        <div className="osk__stage" ref={stageRef}>
          <section className="osk__zone" aria-labelledby={`${uid}-games`}>
            <h3 id={`${uid}-games`} className="osk__caption">{query ? 'Top matches' : 'Recently played'}</h3>
            <div className="osk__games" role="group" aria-labelledby={`${uid}-games`}>
              {results.length === 0 ? (
                <p className="osk__empty">{query ? <>No games match “{query}”. Try fewer letters.</> : 'Start typing — matches from your library appear here.'}</p>
              ) : (
                results.map((g, i) => {
                  const n: OskNav = { ...nav, zone: 'games', game: i };
                  return (
                    <button
                      key={g.id}
                      id={`${uid}-game-${i}`}
                      type="button"
                      className="osk__game"
                      data-focused={nav.zone === 'games' && nav.game === i}
                      aria-label={g.title}
                      onMouseDown={(e) => e.preventDefault()}
                      onPointerMove={pointTo(n)}
                      onClick={() => openGame(g)}
                    >
                      <span className="osk__game-cover" data-ring-target>
                        <GameCover game={g} />
                      </span>
                      <span className="osk__game-title">{highlight(g.title, query)}</span>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <div className="osk__zone osk__zone--words">
            <div className="osk__words" role="group" aria-label="Word suggestions">
              {words.map((w, i) => {
                const n: OskNav = { ...nav, zone: 'words', word: i };
                return (
                  <button
                    key={w.query}
                    id={`${uid}-word-${i}`}
                    type="button"
                    className="osk__word"
                    data-focused={nav.zone === 'words' && nav.word === i}
                    aria-label={`Complete as ${w.word}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onPointerMove={pointTo(n)}
                    onClick={() => acceptWord(w)}
                  >
                    {completion(w.word, edit.text)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="osk__keys" role="group" aria-label={layoutName === 'letters' ? 'Letters and numbers' : 'Symbols'} style={{ ['--osk-cols' as string]: OSK_COLUMNS }}>
            {layout.map((row, ri) =>
              row.map((k, ci) => {
                const n: OskNav = { ...nav, zone: 'keys', row: ri, col: ci };
                const focused = nav.zone === 'keys' && nav.row === ri && nav.col === ci;
                const pressed = press?.id === k.id;
                return (
                  <button
                    key={k.id}
                    id={`${uid}-key-${k.id}`}
                    type="button"
                    tabIndex={-1}
                    className={`osk__key osk__key--${k.kind}`}
                    style={{ gridColumn: `span ${k.span}` }}
                    data-focused={focused}
                    aria-label={keyName(k)}
                    onMouseDown={(e) => e.preventDefault()}
                    onPointerMove={pointTo(n)}
                    onClick={() => {
                      setNav(n);
                      pressKey(k);
                    }}
                  >
                    <span key={`${layoutName}-${pressed ? press.n : 0}`} className="osk__key-face" data-pressed={pressed || undefined}>
                      <KeyFace k={k} />
                    </span>
                    {pressed && <span key={press.n} className="osk__ripple" aria-hidden />}
                  </button>
                );
              }),
            )}
          </div>

          {/* The one travelling focus ring. */}
          {ring && (
            <motion.div
              className="osk__ring"
              aria-hidden
              initial={false}
              animate={{ x: ring.x - 3, y: ring.y - 3, width: ring.w + 6, height: ring.h + 6, borderRadius: ring.r + 3 }}
              transition={pick(reduce, spring.focus)}
            />
          )}
        </div>

        <footer className="osk__hints" aria-hidden>
          <span><PadGlyph button="A" /> Type</span>
          <span><PadGlyph button="B" /> Delete</span>
          <span><PadGlyph button="X" /> Space</span>
          <span><PadGlyph button="LB" /><PadGlyph button="RB" /> Cursor</span>
          <span><PadGlyph button="LT" /> Symbols</span>
          <span><PadGlyph button="RT" /> Results</span>
          {filters && filters.options.length > 1 && <span><PadGlyph button="View" /> Filter</span>}
          <span><PadGlyph button="Y" /> Close</span>
        </footer>
      </motion.div>
    </motion.div>
  );
}

function KeyFace({ k }: { k: OskKey }): ReactNode {
  switch (k.kind) {
    case 'space':
      return <><Space size="1.15em" aria-hidden /> Space <Glyph button="X" /></>;
    case 'backspace':
      return <><Delete size="1.2em" aria-hidden /><Glyph button="B" /></>;
    case 'clear':
      return 'Clear';
    case 'done':
      return <><CornerDownLeft size="1.1em" aria-hidden /> Done</>;
    case 'layout':
      return <>{k.label} <Glyph button="LT" /></>;
    default:
      return k.label;
  }
}

function Glyph({ button }: { button: 'X' | 'B' | 'LT' }) {
  return (
    <span className="osk__glyph" aria-hidden>
      <PadGlyph button={button} />
    </span>
  );
}

function keyName(k: OskKey): string {
  switch (k.kind) {
    case 'space': return 'Space';
    case 'backspace': return 'Backspace';
    case 'clear': return 'Clear search';
    case 'done': return 'Done, go to results';
    case 'layout': return k.label === 'abc' ? 'Letters' : 'Symbols';
    default: return k.label === "'" ? 'Apostrophe' : k.label;
  }
}

/** Bolds the part of a title that matches the query. */
function highlight(title: string, query: string): ReactNode {
  if (!query) return title;
  const i = title.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (i < 0) return title;
  return (
    <>
      {title.slice(0, i)}
      <mark>{title.slice(i, i + query.length)}</mark>
      {title.slice(i + query.length)}
    </>
  );
}

/** Shows the letters already typed dimmed and the completion bright. */
function completion(word: string, text: string): ReactNode {
  const fragment = text.split(/\s+/).pop() ?? '';
  if (!fragment || !word.toLocaleLowerCase().startsWith(fragment.toLocaleLowerCase())) return word;
  return (
    <>
      <span className="osk__word-typed">{word.slice(0, fragment.length)}</span>
      {word.slice(fragment.length)}
    </>
  );
}

function offsetWithin(el: HTMLElement, container: HTMLElement): { x: number; y: number } | null {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== container) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return node === container ? { x, y } : null;
}

function trapTab(e: ReactKeyboardEvent, panel: HTMLElement | null) {
  if (!panel) return;
  const items = [...panel.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'));
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
