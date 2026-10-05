import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Sparkles, X } from 'lucide-react';
import { call, on } from '../../bridge/bridge';
import type { Game, GameStatus, Session } from '../../bridge/types';
import { formatRelative } from '../../lib/format';
import { exit, spring } from '../../lib/motion';
import { STATUS_META, STATUSES } from '../../lib/status';
import { dismiss, isDismissed, suggestStatus } from '../../lib/statusSuggest';
import { setGameStatus } from '../../state/statusActions';
import { useReducedMotion } from '../../state/store';
import './status.css';

/** Tracked session start times for one game, refreshed when a session ends. */
function useSessionStarts(gameId: string): number[] | null {
  const [starts, setStarts] = useState<number[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      call<Session[]>('sessions.list', { gameId, limit: 60 })
        .then((list) => alive && setStarts(list.filter((s) => s.source === 'tracked').map((s) => Date.parse(s.start)).filter(Number.isFinite)))
        .catch(() => alive && setStarts([]));
    setStarts(null);
    void load();
    const off = on('launch.state', (l) => {
      if (l.phase === 'ended' && l.gameId === gameId) void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [gameId]);
  return starts;
}

/**
 * Play status for the detail page sidebar: five labelled, icon-marked options (never colour
 * alone), arrow keys to move, Enter/Space or A to choose, choosing the current one again clears it.
 * Changes apply instantly with an Undo toast. A suggestion chip may offer a status, but nothing
 * is ever changed without a click.
 */
export function StatusPicker({ game }: { game: Game }) {
  const id = useId();
  const reduce = useReducedMotion();
  const current = game.status ?? null;
  const starts = useSessionStarts(game.id);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const suggestion = useMemo(() => {
    if (!starts) return null;
    const s = suggestStatus({ game, sessionStarts: starts, now: Date.now() });
    return s && s.id !== dismissedId && !isDismissed(game.id, s.id) ? s : null;
  }, [game, starts, dismissedId]);

  const choose = (value: GameStatus) => void setGameStatus(game, value === current ? null : value);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = refs.current.findIndex((el) => el === document.activeElement);
    if (i < 0) return;
    const n = STATUSES.length;
    const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (i + 1) % n
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? (i - 1 + n) % n
      : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    refs.current[next]?.focus();
  };

  const focusIndex = Math.max(0, STATUSES.findIndex((s) => s.value === current));
  const meta = current ? STATUS_META[current] : null;

  return (
    <section className="status-picker" aria-labelledby={`${id}-label`}>
      <div className="status-picker__head">
        <span className="field__label" id={`${id}-label`}>Status</span>
        <span className="status-picker__since" aria-live="polite">
          {meta ? <>{meta.label}{game.statusChangedAt ? ` · since ${formatRelative(game.statusChangedAt).toLowerCase()}` : ''}</> : 'Not set'}
        </span>
      </div>
      <div className="status-picker__options" role="group" aria-labelledby={`${id}-label`} onKeyDown={onKeyDown}>
        {STATUSES.map((s, i) => {
          const active = s.value === current;
          const Icon = s.icon;
          return (
            <button
              key={s.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              className="status-opt"
              aria-pressed={active}
              tabIndex={i === focusIndex ? 0 : -1}
              title={active ? `${s.hint}. Choose again to clear.` : s.hint}
              style={{ ['--st' as string]: s.color }}
              onClick={() => choose(s.value)}
            >
              {active && (
                <motion.span layoutId={`${id}-pill`} className="status-opt__pill" transition={reduce ? { duration: 0 } : spring.focus} aria-hidden />
              )}
              <span className="status-opt__icon" aria-hidden>
                <Icon size={15} strokeWidth={2.2} />
              </span>
              <span className="status-opt__label">{s.label}</span>
              {active && <Check size={14} className="status-opt__check" aria-hidden />}
            </button>
          );
        })}
      </div>
      <AnimatePresence initial={false}>
        {suggestion && (
          <motion.div
            key={suggestion.id}
            className="status-suggest"
            role="note"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: exit }}
            transition={reduce ? { duration: 0.15 } : spring.panel}
          >
            <Sparkles size={14} className="status-suggest__icon" aria-hidden />
            <span className="status-suggest__text">{suggestion.text}</span>
            <span className="status-suggest__actions">
              <button
                type="button"
                className="status-suggest__yes"
                style={{ ['--st' as string]: STATUS_META[suggestion.status].color }}
                onClick={() => void setGameStatus(game, suggestion.status)}
              >
                Mark {STATUS_META[suggestion.status].label}
              </button>
              <button
                type="button"
                className="status-suggest__no"
                aria-label="Dismiss suggestion"
                title="Not now"
                onClick={() => {
                  dismiss(game.id, suggestion.id);
                  setDismissedId(suggestion.id);
                }}
              >
                <X size={14} />
              </button>
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
