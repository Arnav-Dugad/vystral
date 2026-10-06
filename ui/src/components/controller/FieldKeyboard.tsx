import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { ArrowBigUp, ArrowBigUpDash, CornerDownLeft, Delete, Gamepad2, KeyRound, Space, WrapText } from 'lucide-react';
import { on } from '../../bridge/bridge';
import type { Game, GamepadButton } from '../../bridge/types';
import {
  columnsFor, cycleShift, erase, fieldValue, hasSelection, initialLayer, insert, keyCentre, keyName, layoutFor, mask, moveCaret,
  moveNav, nextLayer, normalizeNav, recentSuggestions, selection, shifted, startNav, toggleSign, at,
  type Dir, type EditResult, type FkKey, type FkNav, type FkText, type Layer, type Shift, type Suggestion,
} from '../../lib/fieldKeyboard';
import { haptic, lastInputWasPad } from '../../lib/haptics';
import { padActivity, pushPadHandler, setTextFieldActivator } from '../../lib/input';
import { ease, pick, spring } from '../../lib/motion';
import { predictGames, predictWords } from '../../lib/predict';
import { sound } from '../../lib/sound';
import {
  describeField, fixedLayer, isExcluded, isTextField, loadWordBank, pressEnter, readSelection, rememberWords, scrollParent, writeSelection, writeValue,
  type TextField,
} from '../../lib/textEntry';
import { useReducedMotion, useStore } from '../../state/store';
import { PadGlyph } from '../ui/primitives';
import './field-keyboard.css';

/**
 * Track S: the docked, Big Picture-style on-screen keyboard for desktop mode.
 *
 * When the last input came from a controller, pressing A on any text field — or a controller
 * action that moves focus into a text field in a dialog (New collection, the command palette…) —
 * slides this keyboard up from the bottom of the window. Focus stays in the field the whole time,
 * so the app's own handlers, screen readers and a physical keyboard all keep working; the keyboard
 * edits the field through its native value setter, exactly like typing.
 *
 * Mouse and keyboard users never see it: it only opens for controller input, and it closes the
 * moment someone starts typing on a real keyboard (keeping the text).
 */

const PAD_DIRS: Partial<Record<GamepadButton, Dir>> = { Up: 'up', Down: 'down', Left: 'left', Right: 'right' };
/** Held X (backspace) and LB/RB (caret) repeat like a keyboard: 380 ms, then quickening to ~45 ms. */
const REPEATING = new Set<GamepadButton>(['X', 'LB', 'RB']);

/** Escape while the keyboard is open (set by the open keyboard, read by the host's early listener). */
let escapeHandler: (() => void) | null = null;

interface Target {
  el: TextField;
  n: number;
}

// ------------------------------------------------------------------ host

export function FieldKeyboardHost() {
  const enabled = useStore((s) => !!s.settings && s.settings['controller.enabled'] && s.settings['controller.onScreenKeyboard'] !== false);
  const mode = useStore((s) => s.window.mode);
  const gameActive = useStore((s) => !!s.launch && ['starting', 'waiting', 'running'].includes(s.launch.phase));
  const [target, setTarget] = useState<Target | null>(null);
  const [hint, setHint] = useState<TextField | null>(null);
  const seq = useRef(0);
  const allowed = enabled && mode !== 'immersive' && !gameActive;

  const live = useRef({ allowed, target });
  useLayoutEffect(() => {
    live.current = { allowed, target };
  });

  const eligible = useCallback((el: Element | null): el is TextField => live.current.allowed && lastInputWasPad() && isTextField(el) && !isExcluded(el), []);

  const open = useCallback((el: TextField) => {
    setHint(null);
    if (el.readOnly) {
      haptic('edge');
      useStore.getState().toast({ tone: 'info', title: 'This field can’t be edited' });
      return;
    }
    setTarget({ el, n: ++seq.current });
  }, []);

  const close = useCallback(() => setTarget(null), []);

  // A on a focused text field opens the keyboard (instead of the default click).
  useEffect(
    () =>
      setTextFieldActivator((el) => {
        if (!eligible(el)) return false;
        open(el);
        return true;
      }),
    [eligible, open],
  );

  // Focus arriving in a text field because of a controller action (A on "Rename", Y for the command
  // palette…) opens it straight away when the field sits in a dialog that just appeared. Passing
  // through a field with the D-pad only shows a hint: opening there would capture the D-pad.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as Element | null;
      if (live.current.target) return;
      if (!eligible(el)) {
        setHint(null);
        return;
      }
      const now = performance.now();
      const byDpad = now - padActivity.dirAt < 450;
      const byPress = now - padActivity.pressAt < 1500;
      if (!byDpad && byPress && !el.readOnly && el.closest('[role="dialog"], [data-dialog-open]')) open(el);
      else setHint(el);
    };
    const onFocusOut = () => setHint(null);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [eligible, open]);

  // Escape closes the keyboard only, never the dialog under it. This listener is added when the app
  // starts, so on window capture it runs before any dialog's own Escape listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !escapeHandler) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      escapeHandler();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Hide the hint when the controller is put down.
  useEffect(() => {
    const root = document.documentElement;
    const mo = new MutationObserver(() => {
      if (root.dataset.input !== 'pad') setHint(null);
    });
    mo.observe(root, { attributes: true, attributeFilter: ['data-input'] });
    return () => mo.disconnect();
  }, []);

  // Switching to Immersive, turning the setting off, or a game starting closes it.
  if (!allowed && (target || hint)) {
    setTarget(null);
    setHint(null);
  }

  return createPortal(
    <>
      <AnimatePresence>{target && <FieldKeyboard key={target.n} el={target.el} onClose={close} />}</AnimatePresence>
      {hint && !target && <FieldHint el={hint} />}
    </>,
    document.body,
  );
}

/** "A Type" chip under a text field the D-pad landed on. */
function FieldHint({ el }: { el: TextField }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) return setPos(null);
      const below = r.bottom + 40 < innerHeight;
      setPos({ x: Math.max(8, Math.min(innerWidth - 180, r.left)), y: below ? r.bottom + 6 : r.top - 34 });
    };
    place();
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    return () => {
      removeEventListener('scroll', place, true);
      removeEventListener('resize', place);
    };
  }, [el]);
  if (!pos) return null;
  return (
    <div className="fkb-hint" style={{ left: pos.x, top: pos.y }} aria-hidden>
      <PadGlyph button="A" /> Type
    </div>
  );
}

// ------------------------------------------------------------------ keyboard

function readEdit(el: TextField): FkText {
  const sel = readSelection(el);
  if (!sel || sel.end === sel.start) return at(el.value);
  return sel.backward ? { text: el.value, caret: sel.start, anchor: sel.end } : { text: el.value, caret: sel.end, anchor: sel.start };
}

interface RingRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function FieldKeyboard({ el, onClose }: { el: TextField; onClose: () => void }) {
  const reduce = useReducedMotion();
  const isPresent = useIsPresent();
  const uid = useId();
  const games = useStore((s) => s.library.games);
  const { spec, label } = useMemo(() => describeField(el), [el]);
  const [layer, setLayer] = useState<Layer>(() => initialLayer(spec));
  const layout = useMemo(() => layoutFor(spec, layer), [spec, layer]);
  const [shift, setShift] = useState<Shift>('off');
  const [edit, setEdit] = useState<FkText>(() => readEdit(el));
  const [rawNav, setNav] = useState<FkNav>(() => startNav(layoutFor(spec, initialLayer(spec)), initialLayer(spec)));
  const [press, setPress] = useState<{ id: string; n: number } | null>(null);
  const [ring, setRing] = useState<RingRect | null>(null);
  const [announce, setAnnounce] = useState('');
  const editRef = useRef(edit);
  const writing = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef<HTMLDivElement>(null);
  const bank = useMemo(() => loadWordBank(), []);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (spec.predict === 'none') return [];
    if (spec.predict === 'games') {
      if (edit.caret !== edit.text.length || !edit.text.trim()) return [];
      const words = predictWords(games, edit.text, 4).map((w): Suggestion => ({ id: `g-${w.query}`, label: w.word, result: at(w.query.slice(0, spec.maxLength)) }));
      const titles =
        edit.text.trim().length >= 2
          ? predictGames(games, edit.text, 2)
              .filter((g: Game) => g.title.toLocaleLowerCase() !== edit.text.trim().toLocaleLowerCase())
              .map((g): Suggestion => ({ id: `t-${g.id}`, label: g.title, result: at(g.title.slice(0, spec.maxLength)), title: true }))
          : [];
      return [...titles, ...words].slice(0, 5);
    }
    return recentSuggestions(spec, bank, edit, 5);
  }, [spec, games, bank, edit]);

  const nav = normalizeNav(layout, rawNav, suggestions.length);
  const activeKey = nav.zone === 'keys' ? layout[nav.row][nav.col] : null;
  const activeId = nav.zone === 'keys' ? `${uid}-k-${activeKey!.id}` : `${uid}-s-${nav.s}`;
  const showSuggestRow = spec.kind !== 'number' && spec.kind !== 'tel';

  // ---- editing the real field

  const apply = useCallback(
    (next: FkText) => {
      editRef.current = next;
      setEdit(next);
      const value = fieldValue(spec, next.text);
      if (value !== null && value !== el.value) {
        writing.current = true;
        try {
          writeValue(el, value);
        } finally {
          writing.current = false;
        }
      }
      writeSelection(el, next.caret, next.anchor);
      // The app may reshape what it accepts (trim, cap, filter): follow the field.
      requestAnimationFrame(() => {
        const cur = editRef.current;
        if (spec.kind === 'number' || !el.isConnected || el.value === cur.text) return;
        const t = at(el.value, Math.min(cur.caret, el.value.length));
        editRef.current = t;
        setEdit(t);
      });
    },
    [el, spec],
  );

  // Typing on a real keyboard (or the app changing the value) keeps the preview in step.
  useEffect(() => {
    const onInput = () => {
      if (writing.current) return;
      const t = readEdit(el);
      editRef.current = t;
      setEdit(t);
    };
    el.addEventListener('input', onInput);
    return () => el.removeEventListener('input', onInput);
  }, [el]);

  // ---- open / close

  const closedRef = useRef(false);
  const finish = useCallback(
    (how: 'close' | 'done' | 'lost') => {
      if (closedRef.current) return;
      closedRef.current = true;
      // From now on Escape belongs to whatever is under the keyboard again (it is still animating out).
      escapeHandler = null;
      if (!spec.secret && spec.predict !== 'none') rememberWords(editRef.current.text);
      if (how === 'done') {
        if (spec.submit && el.isConnected) pressEnter(el);
        haptic('tick');
        sound.select();
      } else if (how === 'close') sound.back();
      onClose();
    },
    [el, spec, onClose],
  );

  const doneRef = useRef(finish);
  useLayoutEffect(() => {
    doneRef.current = finish;
  });

  // Focus stays in the field. If it leaves (a click elsewhere), the field goes away, or someone
  // starts typing on a real keyboard, the keyboard steps aside and keeps the text.
  useEffect(() => {
    if (document.activeElement !== el && el.isConnected) el.focus({ preventScroll: true });
    const onBlur = () =>
      window.setTimeout(() => {
        if (document.activeElement !== el && document.hasFocus()) doneRef.current('lost');
      }, 0);
    el.addEventListener('blur', onBlur);
    const alive = window.setInterval(() => {
      if (!el.isConnected) doneRef.current('lost');
    }, 400);
    const root = document.documentElement;
    const mo = new MutationObserver(() => {
      if (root.dataset.input === 'keyboard') doneRef.current('lost');
    });
    mo.observe(root, { attributes: true, attributeFilter: ['data-input'] });
    const offConn = on('gamepad.connection', ({ count }) => {
      if (count === 0) doneRef.current('lost');
    });
    const onEscape = () => doneRef.current('close');
    escapeHandler = onEscape;
    return () => {
      el.removeEventListener('blur', onBlur);
      window.clearInterval(alive);
      mo.disconnect();
      offConn();
      if (escapeHandler === onEscape) escapeHandler = null;
    };
  }, [el]);

  // Mark the field (accent ring) and keep it visible above the keyboard.
  useLayoutEffect(() => {
    el.dataset.oskTarget = '';
    const root = document.documentElement;
    root.dataset.fkbOpen = '';
    const panel = panelRef.current;
    const height = panel?.offsetHeight ?? 0;
    root.style.setProperty('--fkb-h', `${height}px`);
    const reveal = revealer(el, reduce);
    reveal.update(height);
    // Dialogs are still springing in when the keyboard opens: check again once they have settled.
    const again = window.setTimeout(() => reveal.update(panel?.offsetHeight ?? height), 380);
    return () => {
      window.clearTimeout(again);
      delete el.dataset.oskTarget;
      delete root.dataset.fkbOpen;
      root.style.removeProperty('--fkb-h');
      reveal.undo();
    };
  }, [el, reduce]);

  // Opening line for screen readers.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setAnnounce(`On-screen keyboard for ${label}. A types, X deletes, Y adds a space, RT is Done${spec.submit ? ' and presses Enter' : ''}. B closes and keeps your text.`);
    }, 120);
    return () => window.clearTimeout(t);
  }, [label, spec.submit]);

  // ---- the travelling ring

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const target = document.getElementById(activeId);
    if (!stage || !target) return;
    const s = stage.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    // offsetLeft/Top are immune to the panel's entrance transform; rects give sizes after scale.
    const pos = offsetWithin(target, stage) ?? { x: r.left - s.left, y: r.top - s.top };
    const next = { x: pos.x, y: pos.y, w: target.offsetWidth, h: target.offsetHeight };
    setRing((p) => (p && p.x === next.x && p.y === next.y && p.w === next.w && p.h === next.h ? p : next));
  }, [activeId, layer, suggestions]);

  // Keep the caret in view inside the preview.
  useLayoutEffect(() => {
    const box = valueRef.current;
    const caret = box?.querySelector<HTMLElement>('.fkb__caret');
    if (!box || !caret) return;
    if (spec.kind === 'multiline') {
      const top = caret.offsetTop;
      if (top < box.scrollTop) box.scrollTop = top - 4;
      else if (top + caret.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + caret.offsetHeight - box.clientHeight + 4;
    } else {
      const left = caret.offsetLeft;
      if (left < box.scrollLeft + 16) box.scrollLeft = Math.max(0, left - 48);
      else if (left > box.scrollLeft + box.clientWidth - 16) box.scrollLeft = left - box.clientWidth + 48;
    }
  }, [edit, spec.kind]);

  // ---- actions

  const flash = (id: string) => setPress((p) => ({ id, n: (p?.n ?? 0) + 1 }));

  const result = (r: EditResult, ok: () => void) => {
    if (r.next !== editRef.current) apply(r.next);
    if (r.refused) {
      haptic('edge');
      if (r.next.text.length >= spec.maxLength) setAnnounce(`That’s the limit: ${spec.maxLength} characters.`);
    } else ok();
  };

  const typeText = (s: string) => {
    result(insert(spec, editRef.current, s), () => {
      sound.focus();
      if (!spec.secret) setAnnounce(s === ' ' ? 'Space' : s === '\n' ? 'New line' : s);
      else setAnnounce('Character added');
    });
  };

  const typeChar = (k: FkKey) => {
    const ch = shifted(k.value ?? '', shift);
    typeText(ch);
    if (shift === 'once' && /\p{L}/u.test(ch)) setShift('off');
  };

  const backspace = () => {
    const before = editRef.current;
    const r = erase(before);
    if (r.refused) {
      haptic('edge');
      return;
    }
    apply(r.next);
    sound.back();
    if (spec.secret) setAnnounce('Deleted');
    else {
      const [s, e] = selection(before);
      setAnnounce(`Deleted ${e > s ? before.text.slice(s, e) : before.text.slice(r.next.caret, before.caret)}`);
    }
  };

  const caret = (delta: number) => {
    const r = moveCaret(editRef.current, delta, shift === 'once');
    if (r.refused) {
      haptic('edge');
      return;
    }
    apply(r.next);
    sound.focus();
  };

  const toggleShift = () => {
    if (layer === 'pad') return haptic('edge');
    flash('shift');
    const next = cycleShift(shift);
    setShift(next);
    haptic('tick');
    sound.select();
    setAnnounce(next === 'lock' ? 'Caps lock on' : next === 'once' ? 'Shift on' : 'Shift off');
  };

  const switchLayer = (to: Layer) => {
    setLayer(to);
    haptic('tick');
    sound.select();
    setAnnounce(to === 'symbols' ? 'Symbols' : to === 'accents' ? 'Accents' : 'Letters');
  };

  const accept = (sg: Suggestion | undefined) => {
    if (!sg) return;
    apply(sg.result);
    setNav((n) => ({ ...n, s: 0 }));
    haptic('tick');
    sound.select();
    setAnnounce(sg.label);
  };

  const pressKey = (k: FkKey) => {
    flash(k.id);
    switch (k.kind) {
      case 'char': return typeChar(k);
      case 'text': return typeText(k.value ?? '');
      case 'space': return typeText(' ');
      case 'newline': return typeText('\n');
      case 'backspace': return backspace();
      case 'clear':
        if (!editRef.current.text) return haptic('edge');
        apply(at(''));
        sound.back();
        return setAnnounce('Cleared');
      case 'sign':
        apply(toggleSign(editRef.current));
        return sound.focus();
      case 'shift': return toggleShift();
      case 'layer': return switchLayer(k.target ?? 'letters');
      case 'done': return finish('done');
    }
  };

  const move = (dir: Dir) => {
    const r = moveNav(layout, nav, dir, suggestions.length);
    if (r.blocked) return haptic('edge');
    if (!r.moved) return;
    setNav(r.nav);
    sound.focus();
    if (r.zoneChanged) haptic('tick');
    const k = r.nav.zone === 'keys' ? layout[r.nav.row][r.nav.col] : null;
    setAnnounce(k ? keyName(k, shift) : `Suggestion: ${suggestions[r.nav.s]?.label ?? ''}`);
  };

  // ---- controller

  const repeatTimer = useRef<number | undefined>(undefined);
  const stopRepeat = () => {
    window.clearTimeout(repeatTimer.current);
    repeatTimer.current = undefined;
  };

  const onPad = (button: GamepadButton, repeat: boolean) => {
    const dir = PAD_DIRS[button];
    if (dir) return move(dir);
    if (repeat) return; // LT/RT auto-repeat from the input layer; they are one-shot here
    switch (button) {
      case 'A':
        if (nav.zone === 'suggest') return accept(suggestions[nav.s]);
        return pressKey(activeKey!);
      case 'B': return finish('close');
      case 'X':
        flash('backspace');
        return backspace();
      case 'Y':
        if (spec.kind === 'number') return haptic('edge');
        flash('space');
        return typeText(' ');
      case 'LB': return caret(-1);
      case 'RB': return caret(1);
      case 'LT': return toggleShift();
      case 'RT':
      case 'Menu':
        flash('done');
        return finish('done');
      case 'View':
        if (layer === 'pad') return haptic('edge');
        flash('layer');
        return switchLayer(nextLayer(layer));
    }
  };

  const padRef = useRef(onPad);
  useLayoutEffect(() => {
    padRef.current = onPad;
  });

  useEffect(() => {
    if (!isPresent) return;
    const off = pushPadHandler((button, repeat) => {
      padRef.current(button, repeat);
      if (!repeat && REPEATING.has(button)) {
        stopRepeat();
        let delay = 380;
        const tick = () => {
          padRef.current(button, false);
          delay = Math.max(45, delay === 380 ? 95 : delay * 0.9);
          repeatTimer.current = window.setTimeout(tick, delay);
        };
        repeatTimer.current = window.setTimeout(tick, delay);
      }
      return true; // the keyboard owns every button while it is open
    });
    const offRelease = on('gamepad.button', ({ pressed }) => {
      if (!pressed) stopRepeat();
    });
    return () => {
      off();
      offRelease();
      stopRepeat();
    };
  }, [isPresent]);

  // ---- render

  const [selStart, selEnd] = selection(edit);
  const show = (s: string) => (spec.secret ? mask(s) : s);
  const before = show(edit.text.slice(0, selStart));
  const picked = show(edit.text.slice(selStart, selEnd));
  const after = show(edit.text.slice(selEnd));
  const caretFirst = edit.caret <= edit.anchor;
  const cols = columnsFor(spec);
  const letters = layer !== 'pad';

  return (
    <motion.div
      className="fkb"
      role="region"
      aria-label="On-screen keyboard"
      data-reduced={reduce}
      data-kind={spec.kind}
      inert={!isPresent || undefined}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: '100%' }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0, transition: { duration: 0.12 } } : { opacity: 0, y: '70%', transition: { duration: 0.2, ease: ease.in } }}
      transition={pick(reduce, spring.panel)}
      // Clicks on the keyboard never take focus from the field.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="fkb__panel" ref={panelRef}>
        <header className="fkb__head">
          <div className="fkb__label">
            {spec.secret && <KeyRound size="1em" aria-hidden />}
            <span className="fkb__label-text">{label}</span>
            {spec.secret && <span className="fkb__tag">Hidden · not remembered</span>}
          </div>
          <div className="fkb__value-row">
            <div
              ref={valueRef}
              className="fkb__value"
              data-multiline={spec.kind === 'multiline' || undefined}
              data-empty={!edit.text || undefined}
              data-secret={spec.secret || undefined}
              aria-hidden
            >
              {!edit.text && <span className="fkb__placeholder">{el.placeholder || 'Start typing'}</span>}
              {before}
              {caretFirst && hasSelection(edit) && <span className="fkb__caret" />}
              {picked && <mark className="fkb__sel">{picked}</mark>}
              {(!caretFirst || !hasSelection(edit)) && <span className="fkb__caret" />}
              {after}
            </div>
            {spec.limited && (
              <span className="fkb__count num" data-full={edit.text.length >= spec.maxLength || undefined} aria-hidden>
                {edit.text.length}/{spec.maxLength}
              </span>
            )}
          </div>
        </header>
        <p className="visually-hidden" aria-live="polite">{announce}</p>

        <div className="fkb__stage" ref={stageRef}>
          {showSuggestRow && (
            <div className="fkb__suggest" role="group" aria-label="Suggestions">
              {suggestions.length === 0 ? (
                <span className="fkb__suggest-empty">
                  {spec.secret ? 'No suggestions for passwords and keys — nothing you type here is remembered.' : spec.predict === 'none' ? '' : 'Suggestions appear as you type.'}
                </span>
              ) : (
                suggestions.map((sg, i) => (
                  <button
                    key={sg.id}
                    id={`${uid}-s-${i}`}
                    type="button"
                    tabIndex={-1}
                    className="fkb__chip"
                    data-title={sg.title || undefined}
                    data-focused={nav.zone === 'suggest' && nav.s === i}
                    onPointerMove={pointTo({ ...nav, zone: 'suggest', s: i })}
                    onClick={() => accept(sg)}
                  >
                    {sg.title && <Gamepad2 size="1em" aria-hidden />}
                    {sg.label}
                  </button>
                ))
              )}
            </div>
          )}
          <div className="fkb__keys" role="group" aria-label={layer === 'pad' ? 'Number pad' : layer === 'symbols' ? 'Symbols' : layer === 'accents' ? 'Accents' : 'Letters'} style={{ ['--fkb-cols' as string]: cols }}>
            {layout.map((row, ri) =>
              row.map((k, ci) => {
                const focused = nav.zone === 'keys' && nav.row === ri && nav.col === ci;
                const pressed = press?.id === k.id;
                return (
                  <button
                    key={k.id}
                    id={`${uid}-k-${k.id}`}
                    type="button"
                    tabIndex={-1}
                    className={`fkb__key fkb__key--${k.kind}`}
                    style={{ gridColumn: `span ${k.span}` }}
                    data-focused={focused}
                    data-on={(k.kind === 'shift' && shift !== 'off') || undefined}
                    aria-label={keyName(k, shift)}
                    aria-pressed={k.kind === 'shift' ? shift !== 'off' : undefined}
                    onPointerMove={pointTo({ ...nav, zone: 'keys', row: ri, col: ci, x: keyCentre(layout, ri, ci) })}
                    onClick={() => {
                      setNav({ ...nav, zone: 'keys', row: ri, col: ci, x: keyCentre(layout, ri, ci) });
                      pressKey(k);
                    }}
                  >
                    <span key={`${layer}-${pressed ? press.n : 0}`} className="fkb__face" data-pressed={pressed || undefined}>
                      <KeyFace k={k} shift={shift} submit={spec.submit} />
                    </span>
                  </button>
                );
              }),
            )}
          </div>
          {ring && (
            <motion.div
              className="fkb__ring"
              aria-hidden
              initial={false}
              animate={{ x: ring.x - 3, y: ring.y - 3, width: ring.w + 6, height: ring.h + 6 }}
              transition={pick(reduce, spring.focus)}
            />
          )}
        </div>

        <footer className="fkb__hints" aria-hidden>
          <span><PadGlyph button="A" /> Type</span>
          <span><PadGlyph button="X" /> Delete</span>
          {spec.kind !== 'number' && <span><PadGlyph button="Y" /> Space</span>}
          <span><PadGlyph button="LB" /><PadGlyph button="RB" /> Move cursor</span>
          {letters && <span><PadGlyph button="LT" /> Shift</span>}
          {letters && <span><PadGlyph button="View" /> Symbols</span>}
          <span><PadGlyph button="RT" /> {spec.submit ? 'Done · presses Enter' : 'Done'}</span>
          <span className="fkb__hint-close"><PadGlyph button="B" /> Close · keeps your text</span>
        </footer>
      </div>
    </motion.div>
  );

  function pointTo(n: FkNav) {
    return (e: React.PointerEvent) => {
      if (e.movementX === 0 && e.movementY === 0) return;
      setNav(n);
    };
  }
}

function KeyFace({ k, shift, submit }: { k: FkKey; shift: Shift; submit: boolean }): ReactNode {
  switch (k.kind) {
    case 'space':
      return <><Space size="1.1em" aria-hidden /> <span className="fkb__face-label">Space</span> <Glyph button="Y" /></>;
    case 'backspace':
      return <><Delete size="1.15em" aria-hidden /><Glyph button="X" /></>;
    case 'newline':
      return <><WrapText size="1.05em" aria-hidden /> <span className="fkb__face-label">New line</span></>;
    case 'shift':
      return <>{shift === 'lock' ? <ArrowBigUpDash size="1.2em" aria-hidden /> : <ArrowBigUp size="1.2em" aria-hidden fill={shift === 'once' ? 'currentColor' : 'none'} />}<Glyph button="LT" /></>;
    case 'done':
      return <><CornerDownLeft size="1.05em" aria-hidden /> {submit ? 'Done' : 'Done'} <Glyph button="RT" /></>;
    case 'layer':
      return <>{k.label}</>;
    case 'clear':
      return 'Clear';
    case 'char':
      return shifted(k.label, shift);
    default:
      return k.label;
  }
}

function Glyph({ button }: { button: 'X' | 'Y' | 'LT' | 'RT' }) {
  return (
    <span className="fkb__glyph" aria-hidden>
      <PadGlyph button={button} />
    </span>
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

/**
 * Keeps the field visible above the docked keyboard: scrolls its page (with room added at the
 * bottom), or — for a field in a dialog or palette that can't scroll — floats that layer up.
 * `update` can run again (a dialog still springing in when the keyboard opened); it measures from
 * where the field would be without the lift, so repeated calls never stack up.
 */
function revealer(el: TextField, reduce: boolean) {
  let layer: HTMLElement | null = null;
  let lifted = 0;
  let prev = { transform: '', transition: '' };
  let scroller: HTMLElement | null = null;

  const update = (keyboardHeight: number) => {
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    const limit = innerHeight - keyboardHeight - 20;
    // A tall textarea only needs its first lines visible (where the caret starts).
    const top = r.top + lifted;
    const bottom = Math.min(r.bottom, r.top + 96) + lifted;
    const over = bottom - limit;

    const fixed = fixedLayer(el);
    if (fixed) {
      const lift = Math.max(0, Math.min(over, top - 12));
      if (lift === lifted) return;
      if (!layer) {
        layer = fixed;
        prev = { transform: fixed.style.transform, transition: fixed.style.transition };
      }
      lifted = lift;
      layer.style.transition = reduce ? 'none' : 'transform 420ms cubic-bezier(0.1, 0.9, 0.2, 1)';
      layer.style.transform = lift ? `translateY(${-lift}px)` : prev.transform;
      return;
    }
    if (over <= 0) return;
    scroller ??= scrollParent(el) ?? el.closest<HTMLElement>('[data-scroll-main]');
    if (!scroller) return;
    scroller.dataset.fkbRoom = '';
    scroller.scrollBy({ top: over, behavior: reduce ? 'auto' : 'smooth' });
  };

  const undo = () => {
    if (layer) {
      const l = layer;
      l.style.transform = prev.transform;
      window.setTimeout(() => {
        if (l.style.transform === prev.transform) l.style.transition = prev.transition;
      }, 440);
    }
    if (scroller) delete scroller.dataset.fkbRoom;
  };

  return { update, undo };
}
