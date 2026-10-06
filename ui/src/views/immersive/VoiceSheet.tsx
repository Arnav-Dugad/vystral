import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import type { GamepadButton, SettingKey, Settings } from '../../bridge/types';
import { haptic } from '../../lib/haptics';
import { pushPadHandler } from '../../lib/input';
import { ease, pick, spring } from '../../lib/motion';
import { sound } from '../../lib/sound';
import { useLocalVoices } from '../../lib/useVoiceOver';
import { normalizePrefs, pickVoice, RATE, voiceLabel, voiceOver } from '../../lib/voiceover';
import { useReducedMotion, useStore } from '../../state/store';
import { PadHint } from '../../components/ui/primitives';

type RowId = 'enabled' | 'captions' | 'voice' | 'rate' | 'volume' | 'test';

/**
 * Voice-over & captions from the sofa (Track T): turn it on, captions only, the voice (Windows'
 * installed voices only), speed, volume and a test phrase. Same controls as Settings › Controller
 * & sound. Up/Down pick a row, Left/Right change it, A toggles or tests, B closes.
 */
export function VoiceSheet({ onClose }: { onClose: () => void }) {
  const reduce = useReducedMotion();
  const present = useIsPresent();
  const uid = useId();
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const voices = useLocalVoices();
  const prefs = normalizePrefs({
    enabled: settings?.['voiceover.enabled'],
    captionsOnly: settings?.['voiceover.captionsOnly'],
    voice: settings?.['voiceover.voice'],
    rate: settings?.['voiceover.rate'],
    volume: settings?.['voiceover.volume'],
  });
  const noVoices = voices.length === 0;
  const rows: RowId[] = noVoices ? ['enabled', 'test'] : ['enabled', 'captions', 'voice', 'rate', 'volume', 'test'];
  const [row, setRow] = useState(0);
  const refs = useRef<Partial<Record<RowId, HTMLElement | null>>>({});
  const current = rows[Math.min(row, rows.length - 1)];
  const voice = pickVoice(voices, prefs.voice, typeof navigator !== 'undefined' ? navigator.language : 'en');

  useLayoutEffect(() => {
    refs.current[current]?.focus({ preventScroll: true });
  }, [current]);

  const set = <K extends SettingKey>(k: K, v: Settings[K]) => void setSetting(k, v);

  const test = () => {
    sound.select();
    voiceOver.say(
      noVoices || prefs.captionsOnly
        ? 'This is how captions look. They show what voice-over would say.'
        : `Hi, I'm ${voice ? voiceLabel(voice).split(' · ')[0] : 'your voice'}. This is how VYSTRAL sounds.`,
      'test',
      true,
    );
  };

  const change = (id: RowId, dir: -1 | 1) => {
    switch (id) {
      case 'enabled':
        set('voiceover.enabled', !prefs.enabled);
        break;
      case 'captions':
        set('voiceover.captionsOnly', !prefs.captionsOnly);
        break;
      case 'voice': {
        if (voices.length < 2) return haptic('edge');
        const i = Math.max(0, voices.findIndex((v) => v.voiceURI === voice?.voiceURI));
        const next = voices[(i + dir + voices.length) % voices.length];
        set('voiceover.voice', next.voiceURI);
        break;
      }
      case 'rate': {
        const next = Math.round(Math.min(RATE.max, Math.max(RATE.min, prefs.rate + dir * RATE.step)) * 10) / 10;
        if (next === prefs.rate) return haptic('edge');
        set('voiceover.rate', next);
        break;
      }
      case 'volume': {
        const next = Math.round(Math.min(1, Math.max(0, prefs.volume + dir * 0.1)) * 10) / 10;
        if (next === prefs.volume) return haptic('edge');
        set('voiceover.volume', next);
        break;
      }
      case 'test':
        return test();
    }
    sound.focus();
    haptic('tick');
  };

  const handle = (button: string, repeat: boolean): boolean => {
    if (!present) return true;
    const i = rows.indexOf(current);
    switch (button) {
      case 'Up': case 'ArrowUp':
        if (i > 0) setRow(i - 1);
        else haptic('edge');
        return true;
      case 'Down': case 'ArrowDown':
        if (i < rows.length - 1) setRow(i + 1);
        else haptic('edge');
        return true;
      case 'Left': case 'ArrowLeft':
        if (current === 'voice' || current === 'rate' || current === 'volume') change(current, -1);
        return true;
      case 'Right': case 'ArrowRight':
        if (current === 'voice' || current === 'rate' || current === 'volume') change(current, 1);
        return true;
      case 'A': case 'Enter': case ' ':
        if (repeat) return true;
        if (current === 'enabled' || current === 'captions' || current === 'test') change(current, 1);
        else if (current === 'voice') change('voice', 1);
        return true;
      case 'B': case 'Escape': case 'Y':
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
      const i = rows.indexOf(current);
      setRow((i + (e.shiftKey ? rows.length - 1 : 1)) % rows.length);
      return;
    }
    if (handle(e.key, e.repeat)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const ref = (id: RowId) => (el: HTMLElement | null) => {
    refs.current[id] = el;
  };
  const focusRow = (id: RowId) => () => setRow(rows.indexOf(id));

  const sw = (id: 'enabled' | 'captions', label: string, on: boolean, hint?: ReactNode) => (
    <div className="imm-couch__row imm-voice__row" data-focused={current === id} onPointerEnter={focusRow(id)}>
      <span className="imm-couch__label" id={`${uid}-${id}`}>{label}</span>
      <button ref={ref(id)} type="button" role="switch" aria-checked={on} aria-labelledby={`${uid}-${id}`} aria-describedby={hint ? `${uid}-${id}-hint` : undefined} tabIndex={current === id ? 0 : -1} className="imm-couch__switch" onClick={() => change(id, 1)}>
        <span className="imm-couch__knob" />
        <span className="imm-couch__switch-text">{on ? 'On' : 'Off'}</span>
      </button>
      {hint && <span className="imm-voice__hint" id={`${uid}-${id}-hint`}>{hint}</span>}
    </div>
  );

  const slider = (id: 'rate' | 'volume', label: string, value: number, min: number, max: number, text: string) => (
    <div className="imm-couch__row" data-focused={current === id} onPointerEnter={focusRow(id)}>
      <span className="imm-couch__label" id={`${uid}-${id}`}>{label}</span>
      <button type="button" className="imm-couch__step" tabIndex={-1} aria-label={`Less ${label.toLowerCase()}`} onClick={() => change(id, -1)}>
        <Minus size="1em" aria-hidden />
      </button>
      <div ref={ref(id)} className="imm-couch__slider" role="slider" tabIndex={current === id ? 0 : -1} aria-labelledby={`${uid}-${id}`} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={text}>
        <span className="imm-couch__track">
          <span className="imm-couch__fill" style={{ transform: `scaleX(${(value - min) / (max - min)})` }} />
        </span>
        <span className="imm-couch__value num">{text}</span>
      </div>
      <button type="button" className="imm-couch__step" tabIndex={-1} aria-label={`More ${label.toLowerCase()}`} onClick={() => change(id, 1)}>
        <Plus size="1em" aria-hidden />
      </button>
    </div>
  );

  return (
    <motion.div
      className="imm-couch imm-voice"
      data-dialog-open={present || undefined}
      inert={!present || undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.16, ease: ease.in } }}
      transition={pick(reduce, spring.effect)}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
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
        <h2 id={`${uid}-title`} className="imm-couch__title">Voice-over &amp; captions</h2>
        <p className="imm-couch__hint">
          {noVoices
            ? 'No Windows voices are installed on this PC, so this shows captions only. Add a voice in Windows Settings › Time & language › Speech.'
            : 'Reads out the game, row or menu item you’re on, with captions. Uses the voices installed in Windows — nothing goes online.'}
        </p>
        {sw('enabled', noVoices ? 'Captions' : 'Voice-over', prefs.enabled)}
        {!noVoices && sw('captions', 'Captions only', prefs.captionsOnly, 'Show the words without speaking.')}
        {!noVoices && (
          <div className="imm-couch__row" data-focused={current === 'voice'} onPointerEnter={focusRow('voice')}>
            <span className="imm-couch__label" id={`${uid}-voice`}>Voice</span>
            <button type="button" className="imm-couch__step" tabIndex={-1} aria-label="Previous voice" onClick={() => change('voice', -1)}>
              <ChevronLeft size="1em" aria-hidden />
            </button>
            <div ref={ref('voice')} className="imm-voice__pick" role="button" tabIndex={current === 'voice' ? 0 : -1} aria-labelledby={`${uid}-voice ${uid}-voice-name`} aria-roledescription="picker">
              <span id={`${uid}-voice-name`} className="imm-voice__name">{voice ? voiceLabel(voice) : 'Windows default'}</span>
              <span className="imm-voice__count num" aria-hidden>{voices.length > 1 ? `${voices.findIndex((v) => v.voiceURI === voice?.voiceURI) + 1} / ${voices.length}` : ''}</span>
            </div>
            <button type="button" className="imm-couch__step" tabIndex={-1} aria-label="Next voice" onClick={() => change('voice', 1)}>
              <ChevronRight size="1em" aria-hidden />
            </button>
          </div>
        )}
        {!noVoices && slider('rate', 'Speed', prefs.rate, RATE.min, RATE.max, `${Math.round(prefs.rate * 100)}%`)}
        {!noVoices && slider('volume', 'Volume', prefs.volume, 0, 1, `${Math.round(prefs.volume * 100)}%`)}
        <div className="imm-couch__row imm-voice__row--test" data-focused={current === 'test'} onPointerEnter={focusRow('test')}>
          <button ref={ref('test')} type="button" className="imm-btn imm-voice__test" tabIndex={current === 'test' ? 0 : -1} onClick={test}>
            {noVoices || prefs.captionsOnly ? 'Show a test caption' : 'Test the voice'}
          </button>
        </div>
        <footer className="imm-couch__hints" aria-hidden>
          <PadHint button="A">{current === 'test' ? 'Test' : 'Change'}</PadHint>
          <PadHint button="DpadH">Adjust</PadHint>
          <PadHint button="B">Close</PadHint>
        </footer>
      </motion.div>
    </motion.div>
  );
}
