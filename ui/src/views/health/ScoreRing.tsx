import { useEffect, useRef, useState } from 'react';
import { animate } from 'motion/react';
import { ringDash, tier, TIER_LABEL } from '../../lib/health';
import { useReducedMotion } from '../../state/store';

/**
 * Track Q: the library health score. The arc fills from where it was (or empty, on first show) with a slow ease-out
 * while the number counts up with it; a soft glow lands when it settles. Reduced motion: drawn at once.
 * The ring is an image with a spoken name; the number is also live text.
 */
export function ScoreRing({ score, size = 168, busy }: { score: number | null; size?: number; busy?: boolean }) {
  const reduce = useReducedMotion();
  const r = size / 2 - 12;
  const { circumference } = ringDash(0, r);
  const [shown, setShown] = useState(reduce || score === null ? score ?? 0 : 0);
  const from = useRef(0);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (score === null || reduce) return;
    setSettled(false); // eslint-disable-line react-hooks/set-state-in-effect -- restarts the settle glow for a new score
    const controls = animate(from.current, score, {
      duration: Math.min(1.6, 0.6 + Math.abs(score - from.current) / 80),
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        from.current = v;
        setShown(v);
      },
      onComplete: () => setSettled(true),
    });
    return () => controls.stop();
  }, [score, reduce]);

  // Reduced motion: no count-up, the ring is simply drawn at the score.
  const value = reduce ? score ?? 0 : shown;
  const done = reduce || settled;
  const t = tier(score ?? 100);
  const { offset } = ringDash(value, r);
  return (
    <div
      className="hring"
      data-tier={t}
      data-settled={done || undefined}
      data-busy={busy || undefined}
      style={{ width: size, height: size }}
      role="img"
      aria-label={score === null ? 'Checking your library' : `Health score ${score} out of 100: ${TIER_LABEL[t]}`}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden>
        <defs>
          <linearGradient id="hring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" className="hring__stop1" />
            <stop offset="100%" className="hring__stop2" />
          </linearGradient>
        </defs>
        <circle className="hring__track" cx={size / 2} cy={size / 2} r={r} />
        {[...Array(40)].map((_, i) => {
          const a = (i / 40) * Math.PI * 2 - Math.PI / 2;
          const inner = r - 17, outer = r - 13;
          return (
            <line key={i} className="hring__tick" data-on={i / 40 < value / 100 || undefined}
              x1={size / 2 + Math.cos(a) * inner} y1={size / 2 + Math.sin(a) * inner} x2={size / 2 + Math.cos(a) * outer} y2={size / 2 + Math.sin(a) * outer} />
          );
        })}
        <circle
          className="hring__fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="url(#hring-grad)"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="hring__center" aria-hidden>
        <span className="hring__num num" data-digits={score !== null && Math.round(value) >= 100 ? 3 : undefined}>{score === null ? '–' : Math.round(value)}</span>
        <span className="hring__of">of 100</span>
      </div>
    </div>
  );
}
