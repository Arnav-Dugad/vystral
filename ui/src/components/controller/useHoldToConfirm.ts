import {
  useCallback, useEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import { animate, useMotionValue, useTransform, type AnimationPlaybackControls } from 'motion/react';
import { on } from '../../bridge/bridge';
import { haptic, lastInputWasPad, stopHaptics } from '../../lib/haptics';
import { pushPadHandler } from '../../lib/input';
import { ease } from '../../lib/motion';
import { sound } from '../../lib/sound';
import { useReducedMotion } from '../../state/store';

/** How long a hold takes to confirm. Matches the native "hold" vibration ramp. */
export const HOLD_MS = 900;
/** Releasing before this fraction counts as a tap and shows the "hold" hint. */
const TAP_FRACTION = 0.35;

export type HoldPhase = 'idle' | 'holding' | 'done';

export interface HoldOptions {
  onConfirm: () => void;
  /**
   * 'all': every input must hold (used for the final button of a destructive confirmation).
   * 'pad': only a controller must hold A; a mouse click or Enter confirms immediately, so
   * one-click actions keep working exactly as before for keyboard and mouse users.
   */
  holdFor?: 'all' | 'pad';
  durationMs?: number;
  disabled?: boolean;
}

/**
 * Hold-to-confirm behaviour for a button: the ring fills while A (controller), Enter/Space or
 * the pointer is held; letting go early springs it back. Assistive technology that activates
 * buttons with a synthetic click (no key or pointer down first) confirms directly, because
 * holding isn't something a screen reader can do.
 */
export function useHoldToConfirm({ onConfirm, holdFor = 'all', durationMs = HOLD_MS, disabled }: HoldOptions) {
  const reduce = useReducedMotion();
  const raw = useMotionValue(0);
  // Springing back may overshoot below zero; the ring never draws a negative arc.
  const progress = useTransform(raw, (v) => Math.max(0, Math.min(1, v)));
  const [phase, setPhase] = useState<HoldPhase>('idle');
  const [nudge, setNudge] = useState(0);
  const [focused, setFocused] = useState(false);
  const anim = useRef<AnimationPlaybackControls | null>(null);
  const holding = useRef(false);
  const done = useRef(false);
  const engaged = useRef(false);
  const timers = useRef<number[]>([]);
  const confirmRef = useRef(onConfirm);
  useEffect(() => {
    confirmRef.current = onConfirm;
  }, [onConfirm]);
  useEffect(
    () => () => {
      anim.current?.stop();
      timers.current.forEach(clearTimeout);
      if (holding.current) stopHaptics();
    },
    [],
  );

  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));

  const confirm = useCallback(() => {
    if (done.current) return;
    done.current = true;
    holding.current = false;
    setPhase('done');
    haptic('confirm');
    sound.select();
    // Let the full ring and the pop register before the action (which often closes a dialog).
    later(() => confirmRef.current(), reduce ? 60 : 170);
    later(() => {
      done.current = false;
      raw.set(0);
      setPhase('idle');
    }, 900);
  }, [raw, reduce]);

  const start = useCallback(() => {
    if (disabled || holding.current || done.current) return;
    holding.current = true;
    setPhase('holding');
    haptic('hold');
    anim.current?.stop();
    const remaining = ((1 - raw.get()) * durationMs) / 1000;
    // Ease-in-out: a gentle start (so a tap barely moves it), a steady middle, a soft landing.
    anim.current = animate(raw, 1, { duration: Math.max(0.05, remaining), ease: ease.inOut, onComplete: confirm });
  }, [confirm, disabled, durationMs, raw]);

  const release = useCallback(() => {
    // Any click that follows this pointer/key release belongs to it, not to assistive tech.
    window.setTimeout(() => (engaged.current = false), 0);
    if (!holding.current) return;
    holding.current = false;
    anim.current?.stop();
    stopHaptics();
    if (raw.get() < TAP_FRACTION) setNudge((n) => n + 1);
    setPhase('idle');
    anim.current = animate(raw, 0, reduce ? { duration: 0.15, ease: 'linear' } : { type: 'spring', stiffness: 520, damping: 24, restDelta: 0.002 });
  }, [raw, reduce]);

  // Controller: while focused, A starts the hold and releasing A ends it.
  useEffect(() => {
    if (!focused || disabled) return;
    const offPress = pushPadHandler((button, repeat) => {
      if (button !== 'A') return false;
      if (!repeat) start();
      return true;
    });
    const offRelease = on('gamepad.button', ({ button, pressed }) => {
      if (button === 'A' && !pressed) release();
    });
    // A controller disconnecting mid-hold never sends the release: treat it as one.
    const offConnection = on('gamepad.connection', () => release());
    return () => {
      offPress();
      offRelease();
      offConnection();
    };
  }, [focused, disabled, start, release]);

  const isActivationKey = (key: string) => key === 'Enter' || key === ' ';

  const bind = {
    onPointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
      if (holdFor === 'pad' || e.button !== 0) return;
      engaged.current = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      start();
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: release,
    onKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
      if (holdFor === 'pad' || !isActivationKey(e.key)) return;
      e.preventDefault();
      engaged.current = true;
      if (!e.repeat) start();
    },
    onKeyUp(e: ReactKeyboardEvent<HTMLButtonElement>) {
      if (holdFor === 'pad' || !isActivationKey(e.key)) return;
      e.preventDefault();
      release();
    },
    onClick(e: ReactMouseEvent<HTMLButtonElement>) {
      e.preventDefault();
      if (disabled) return;
      if (holdFor === 'pad') return confirmRef.current();
      // A click with no press before it is assistive technology activating the button; a
      // controller must always hold (A is intercepted above, this guards the first frame).
      if (!engaged.current && !lastInputWasPad()) confirmRef.current();
    },
    onContextMenu(e: ReactMouseEvent) {
      if (holding.current) e.preventDefault(); // touch long-press
    },
    onFocus: () => setFocused(true),
    onBlur() {
      setFocused(false);
      release();
    },
  };

  return { progress, phase, nudge, bind };
}
