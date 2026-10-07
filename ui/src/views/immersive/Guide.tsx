import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { AudioLines, Gamepad2, Monitor, MonitorCog, Power, Settings as SettingsIcon } from 'lucide-react';
import type { GamepadButton } from '../../bridge/types';
import { haptic } from '../../lib/haptics';
import { pushPadHandler } from '../../lib/input';
import { ease, pick, spring } from '../../lib/motion';
import { sound } from '../../lib/sound';
import { useReducedMotion, useStore } from '../../state/store';
import { HoldToConfirm } from '../../components/controller/HoldToConfirm';
import { GameCover } from '../../components/game/GameCover';
import { PadGlyph, PadHint } from '../../components/ui/primitives';
import { greeting } from './rows';
import { clockParts } from './screensaver';
import { useSystemStatus } from './useSystemStatus';

export type GuideAction = 'resume' | 'desktop' | 'display' | 'voice' | 'settings' | 'close';

interface Item {
  id: GuideAction;
  label: string;
  detail?: string;
  icon: ReactNode;
  hold?: boolean;
}

/**
 * The guide (Track T): Menu in Immersive opens it — the things you'd otherwise need a mouse or a
 * keyboard for. Return to a running game, Desktop mode (Menu again), Display & text size,
 * Voice-over & captions, Settings (in desktop mode) and Close VYSTRAL (hold A: it closes the
 * app, nothing else — VYSTRAL never shuts down, restarts or sleeps the PC). Up/Down move, A picks,
 * B closes. It owns all input while open.
 */
export function Guide({ onAction, onClose, voiceState }: { onAction: (a: GuideAction) => void; onClose: () => void; voiceState: string }) {
  const reduce = useReducedMotion();
  const present = useIsPresent();
  const uid = useId();
  const launch = useStore((s) => s.launch);
  const playing = useStore((s) => (s.launch && ['starting', 'waiting', 'running'].includes(s.launch.phase) ? s.gamesById.get(s.launch.gameId) ?? null : null));
  const items: Item[] = [
    ...(playing ? [{ id: 'resume' as const, label: launch?.phase === 'running' ? `Return to ${playing.title}` : `${playing.title} is starting…`, icon: <Gamepad2 size="1.15em" aria-hidden /> }] : []),
    { id: 'desktop', label: 'Desktop mode', detail: 'Or press Menu again', icon: <Monitor size="1.15em" aria-hidden /> },
    { id: 'display', label: 'Display & text size', icon: <MonitorCog size="1.15em" aria-hidden /> },
    { id: 'voice', label: 'Voice-over & captions', detail: voiceState, icon: <AudioLines size="1.15em" aria-hidden /> },
    { id: 'settings', label: 'Settings', detail: 'Opens in desktop mode', icon: <SettingsIcon size="1.15em" aria-hidden /> },
    { id: 'close', label: 'Close VYSTRAL', detail: 'Hold A. Your PC stays on.', icon: <Power size="1.15em" aria-hidden />, hold: true },
  ];
  const [index, setIndex] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const restore = useRef<HTMLElement | null>(null);
  const now = new Date();
  // Track Z: 12- or 24-hour time as Windows' regional format says.
  const status = useSystemStatus();
  const time = clockParts(now, status?.clock24h == null ? null : !status.clock24h);

  useLayoutEffect(() => {
    restore.current ??= document.activeElement as HTMLElement | null;
    refs.current[index]?.focus({ preventScroll: true });
  }, [index]);
  useEffect(
    () => () => {
      const back = restore.current;
      if (back?.isConnected) back.focus({ preventScroll: true });
    },
    [],
  );

  const pickItem = (i: number) => {
    const item = items[i];
    if (!item || item.hold) return;
    sound.select();
    haptic('tick');
    onAction(item.id);
  };

  const handle = (button: string, repeat: boolean): boolean => {
    if (!present) return true;
    switch (button) {
      case 'Up': case 'ArrowUp':
        if (index > 0) setIndex(index - 1);
        else haptic('edge');
        sound.focus();
        return true;
      case 'Down': case 'ArrowDown':
        if (index < items.length - 1) setIndex(index + 1);
        else haptic('edge');
        sound.focus();
        return true;
      case 'A': case 'Enter': case ' ':
        if (!repeat) pickItem(index);
        return true;
      case 'Menu':
        if (!repeat) onAction('desktop');
        return true;
      case 'B': case 'Escape':
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

  return (
    <motion.div
      className="imm-guide"
      data-dialog-open={present || undefined}
      inert={!present || undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18, ease: ease.in } }}
      transition={pick(reduce, spring.effect)}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        className="imm-guide__panel"
        initial={reduce ? { opacity: 0 } : { opacity: 0, x: '-40%' }}
        animate={{ opacity: 1, x: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, x: '-30%', transition: { duration: 0.2, ease: ease.in } }}
        transition={pick(reduce, spring.panel)}
        onKeyDown={(e) => {
          if (!present) return;
          if (e.key === 'Tab') {
            e.preventDefault();
            setIndex((i) => (i + (e.shiftKey ? items.length - 1 : 1)) % items.length);
            return;
          }
          // The hold item handles its own Enter/Space (press and hold).
          if ((e.key === 'Enter' || e.key === ' ') && items[index]?.hold) return;
          if (handle(e.key, e.repeat)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <header className="imm-guide__head">
          <img src="./vystral-mark.svg" alt="" className="imm-guide__mark" />
          <div className="imm-guide__when">
            <h2 id={`${uid}-title`} className="imm-guide__title">{greeting(now.getHours())}</h2>
            <span className="imm-guide__time num">
              {time.label} · {time.date}
            </span>
          </div>
        </header>
        {playing && (
          <div className="imm-guide__playing" aria-hidden>
            <span className="imm-guide__thumb"><GameCover game={playing} /></span>
            <span>
              <span className="imm-guide__eyebrow">{launch?.phase === 'running' ? 'Now playing' : 'Starting'}</span>
              <strong>{playing.title}</strong>
            </span>
          </div>
        )}
        <div className="imm-guide__list" role="menu" aria-labelledby={`${uid}-title`}>
          {items.map((item, i) => {
            const icon = <span className="imm-guide__icon">{item.icon}</span>;
            const text = (
              <span className="imm-guide__text">
                <span className="imm-guide__label">{item.label}</span>
                {item.detail && <span className="imm-guide__detail">{item.detail}</span>}
              </span>
            );
            return item.hold ? (
              <HoldToConfirm
                key={item.id}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                bare
                role="menuitem"
                className="imm-guide__item imm-guide__item--hold"
                data-selected={i === index}
                tabIndex={i === index ? 0 : -1}
                aria-label={`${item.label}. ${item.detail ?? ''}`}
                onMouseEnter={() => setIndex(i)}
                onConfirm={() => onAction('close')}
                icon={icon}
              >
                {text}
              </HoldToConfirm>
            ) : (
              <button
                key={item.id}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                className="imm-guide__item"
                data-selected={i === index}
                tabIndex={i === index ? 0 : -1}
                aria-label={item.detail ? `${item.label}. ${item.detail}` : item.label}
                onMouseEnter={() => setIndex(i)}
                onClick={() => pickItem(i)}
              >
                {icon}
                {text}
                {item.id === 'desktop' && <PadGlyph button="Menu" />}
              </button>
            );
          })}
        </div>
        <footer className="imm-guide__hints" aria-hidden>
          <PadHint button="A">Select</PadHint>
          <PadHint button="B">Back</PadHint>
        </footer>
      </motion.div>
    </motion.div>
  );
}
