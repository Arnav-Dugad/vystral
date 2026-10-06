import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { Minus, Plus } from 'lucide-react';
import type { GamepadButton } from '../../bridge/types';
import { COUCH_SAFE, COUCH_SCALE, couchSafe, couchScale, formatSafe, formatScale, stepCouch } from '../../lib/couch';
import { haptic } from '../../lib/haptics';
import { pushPadHandler } from '../../lib/input';
import { ease, pick, spring } from '../../lib/motion';
import { sound } from '../../lib/sound';
import { useReducedMotion, useStore } from '../../state/store';
import { PadHint } from '../../components/ui/primitives';

type RowId = 'scale' | 'safe' | 'cinematic';
const ROWS: RowId[] = ['scale', 'safe', 'cinematic'];

/**
 * Couch display settings, from the sofa (Track L): text/interface size (100–130%) and a TV
 * overscan safe area (off–6% per edge), applied live with corner guides showing the safe edge,
 * plus the cinematic mode switch. Up/Down pick a row, Left/Right change it, A/B close. Saved as
 * normal settings (also in desktop Settings › Controller & sound).
 */
export function CouchSheet({ onClose }: { onClose: () => void }) {
  const reduce = useReducedMotion();
  const present = useIsPresent();
  const uid = useId();
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const [row, setRow] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);
  const scale = couchScale(settings?.['immersive.scale']);
  const safe = couchSafe(settings?.['immersive.safeArea']);
  const cinematic = settings?.['immersive.cinematicSwitch'] ?? true;

  useLayoutEffect(() => {
    refs.current[row]?.focus({ preventScroll: true });
  }, [row]);

  const change = (id: RowId, dir: -1 | 1) => {
    if (id === 'cinematic') {
      void setSetting('immersive.cinematicSwitch', !cinematic);
      sound.select();
      haptic('tick');
      return;
    }
    const key = id === 'scale' ? 'immersive.scale' : 'immersive.safeArea';
    const current = id === 'scale' ? scale : safe;
    const next = stepCouch(id, current, dir);
    if (next === current) {
      haptic('edge');
      return;
    }
    void setSetting(key, next);
    sound.focus();
    haptic('tick');
  };

  const handle = (button: string, repeat: boolean): boolean => {
    if (!present) return true;
    switch (button) {
      case 'Up': case 'ArrowUp':
        if (row > 0) setRow(row - 1);
        else haptic('edge');
        return true;
      case 'Down': case 'ArrowDown':
        if (row < ROWS.length - 1) setRow(row + 1);
        else haptic('edge');
        return true;
      case 'Left': case 'ArrowLeft': change(ROWS[row], -1); return true;
      case 'Right': case 'ArrowRight': change(ROWS[row], 1); return true;
      case 'A': case 'Enter': case ' ':
        if (repeat) return true;
        if (ROWS[row] === 'cinematic') change('cinematic', 1);
        else onClose();
        return true;
      case 'B': case 'Escape': case 'Y': case 'View':
        if (!repeat) {
          sound.back();
          onClose();
        }
        return true;
      default:
        return true;
    }
  };
  const handleRef = useRef(handle);
  useLayoutEffect(() => {
    handleRef.current = handle;
  });
  useEffect(() => {
    if (!present) return;
    return pushPadHandler((b: GamepadButton, r) => handleRef.current(b, r));
  }, [present]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!present) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      setRow((r) => (r + (e.shiftKey ? ROWS.length - 1 : 1)) % ROWS.length);
      return;
    }
    if (handle(e.key, e.repeat)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const slider = (id: 'scale' | 'safe', i: number, label: string, value: number, text: string, spec: typeof COUCH_SCALE | typeof COUCH_SAFE) => (
    <div className="imm-couch__row" data-focused={row === i} onPointerEnter={() => setRow(i)}>
      <span className="imm-couch__label" id={`${uid}-${id}`}>{label}</span>
      <button type="button" className="imm-couch__step" tabIndex={-1} aria-label={`Smaller ${label.toLowerCase()}`} onClick={() => change(id, -1)}>
        <Minus size="1em" aria-hidden />
      </button>
      <div
        ref={(el) => {
          refs.current[i] = el;
        }}
        className="imm-couch__slider"
        role="slider"
        tabIndex={row === i ? 0 : -1}
        aria-labelledby={`${uid}-${id}`}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuenow={value}
        aria-valuetext={text}
      >
        <span className="imm-couch__track">
          <span className="imm-couch__fill" style={{ transform: `scaleX(${(value - spec.min) / (spec.max - spec.min)})` }} />
        </span>
        <span className="imm-couch__value num">{text}</span>
      </div>
      <button type="button" className="imm-couch__step" tabIndex={-1} aria-label={`Larger ${label.toLowerCase()}`} onClick={() => change(id, 1)}>
        <Plus size="1em" aria-hidden />
      </button>
    </div>
  );

  return (
    <motion.div
      className="imm-couch"
      data-dialog-open={present || undefined}
      inert={!present || undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.16, ease: ease.in } }}
      transition={pick(reduce, spring.effect)}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      {/* Corner guides on the safe edge, so you can line it up with your TV. */}
      <div className="imm-couch__guides" aria-hidden>
        <span /><span /><span /><span />
      </div>
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        className="imm-couch__card"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 24, transition: { duration: 0.16, ease: ease.in } }}
        transition={pick(reduce, spring.panel)}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${uid}-title`} className="imm-couch__title">Display</h2>
        <p className="imm-couch__hint">For TVs across the room. Changes apply as you go.</p>
        {slider('scale', 0, 'Text size', scale, formatScale(scale), COUCH_SCALE)}
        {slider('safe', 1, 'Safe area', safe, formatSafe(safe), COUCH_SAFE)}
        <div className="imm-couch__row" data-focused={row === 2} onPointerEnter={() => setRow(2)}>
          <span className="imm-couch__label" id={`${uid}-cine`}>Cinematic mode switch</span>
          <button
            ref={(el) => {
              refs.current[2] = el;
            }}
            type="button"
            role="switch"
            aria-checked={cinematic}
            aria-labelledby={`${uid}-cine`}
            tabIndex={row === 2 ? 0 : -1}
            className="imm-couch__switch"
            onClick={() => change('cinematic', 1)}
          >
            <span className="imm-couch__knob" />
            <span className="imm-couch__switch-text">{cinematic ? 'On' : 'Off'}</span>
          </button>
        </div>
        <footer className="imm-couch__hints" aria-hidden>
          <PadHint button="A">Done</PadHint>
          <PadHint button="DpadH">Adjust</PadHint>
          <PadHint button="B">Close</PadHint>
        </footer>
      </motion.div>
    </motion.div>
  );
}
