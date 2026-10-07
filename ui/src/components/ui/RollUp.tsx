import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { hasRolled, markRolled, planRoll, rollDuration, shouldRoll } from '../../lib/rollup';
import { useReducedMotion, useStore } from '../../state/store';
import './rollup.css';

type Phase = 'static' | 'armed' | 'rolling';

/**
 * Track Y: a formatted number that counts up digit by digit (odometer style) the first time it comes
 * into view: once per app session per `id`, never under reduced motion or while a game runs, and only
 * transform animations. Screen readers always get the final text; the rolling copy is hidden from them.
 * Once the roll lands, the plain text replaces it, so the DOM is the same as without the effect.
 */
export function RollUp({ id, children, className }: { id: string; children: string | number; className?: string }) {
  const text = typeof children === 'number' ? children.toLocaleString() : children;
  const reduce = useReducedMotion();
  const gameRunning = useStore((s) => s.launch?.phase === 'running');
  const ref = useRef<HTMLSpanElement>(null);
  const [phase, setPhase] = useState<Phase>(() => (shouldRoll(id, text, reduce || gameRunning) ? 'armed' : 'static'));
  const [rolledText, setRolledText] = useState(text);
  const tokens = useMemo(() => planRoll(rolledText), [rolledText]);

  // The value changed before the roll started or while it ran: show it plainly.
  if (phase !== 'static' && text !== rolledText) {
    setPhase('static');
    setRolledText(text);
  }
  if ((reduce || gameRunning) && phase !== 'static') setPhase('static');

  useEffect(() => {
    if (phase !== 'armed') return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setPhase('static');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        if (hasRolled(id)) {
          setPhase('static');
          return;
        }
        markRolled(id);
        setPhase('rolling');
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [phase, id]);

  useEffect(() => {
    if (phase !== 'rolling') return;
    const t = window.setTimeout(() => setPhase('static'), rollDuration(tokens) + 80);
    return () => window.clearTimeout(t);
  }, [phase, tokens]);

  if (phase === 'static') return <span ref={ref} className={className}>{text}</span>;

  return (
    <span ref={ref} className={`rollup${className ? ` ${className}` : ''}`} data-rolling={phase === 'rolling' || undefined}>
      <span className="visually-hidden">{text}</span>
      <span className="rollup__anim" aria-hidden>
        {tokens.map((t, i) =>
          t.kind === 'text' ? (
            <span key={i}>{t.text}</span>
          ) : (
            <span
              key={i}
              className="rollup__digit"
              style={{ ['--to' as string]: t.target, ['--dur' as string]: `${t.durationMs}ms`, ['--delay' as string]: `${t.delayMs}ms` } as CSSProperties}
            >
              <span className="rollup__ghost">{t.digit}</span>
              <span className="rollup__strip">
                {Array.from({ length: (t.turns + 1) * 10 }, (_, k) => (
                  <span key={k}>{k % 10}</span>
                ))}
              </span>
            </span>
          ),
        )}
      </span>
    </span>
  );
}
