import { useId, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { useReducedMotion } from '../../../state/store';
import { Skeleton } from '../../ui/primitives';

export type TileTone = 'ok' | 'warn' | 'danger' | 'accent';

/**
 * Track C4: the stat tile every game page uses. A caps label with an icon, one headline value (proportional
 * figures), a short line under it, an optional visual (meter, ring, sparkline, chart), and — always — where the
 * numbers come from. Tone tints only a hairline and the icon; the words carry the meaning.
 */
export function StatTile({
  label, icon, value, sub, visual, source, tone, wide, index = 0, testId, action,
}: {
  label: string;
  icon: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  visual?: ReactNode;
  /** Where the numbers come from, in plain words. Required: no number without a source. */
  source: ReactNode;
  tone?: TileTone;
  /** Takes two columns where there's room (the price chart). */
  wide?: boolean;
  /** Order in the grid, for the entrance stagger. */
  index?: number;
  testId?: string;
  action?: ReactNode;
}) {
  const reduce = useReducedMotion();
  const id = useId();
  return (
    <motion.section
      className={`gi-tile${wide ? ' gi-tile--wide' : ''}`}
      data-tone={tone}
      data-testid={testId}
      aria-labelledby={id}
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1], delay: Math.min(index, 10) * 0.045 }}
    >
      <header className="gi-tile__head">
        <span className="gi-tile__icon" aria-hidden>{icon}</span>
        <h3 className="gi-tile__label" id={id}>{label}</h3>
        {action && <span className="gi-tile__action">{action}</span>}
      </header>
      <div className="gi-tile__value">{value}</div>
      {sub && <div className="gi-tile__sub">{sub}</div>}
      {visual && <div className="gi-tile__visual">{visual}</div>}
      <p className="gi-tile__src">{source}</p>
    </motion.section>
  );
}

/** The same footprint while a tile's data loads, so the grid never jumps. */
export function TileSkeleton({ wide, label }: { wide?: boolean; label: string }) {
  return (
    <div className={`gi-tile gi-tile--skeleton${wide ? ' gi-tile--wide' : ''}`} aria-busy="true" aria-label={`${label}: loading`}>
      <Skeleton height={11} width="45%" />
      <Skeleton height={28} width="60%" />
      <Skeleton height={12} width="80%" />
      <div style={{ marginTop: 'auto' }}><Skeleton height={8} /></div>
    </div>
  );
}

/** A thin meter: one hue on a lighter track, filled from the left. */
export function Meter({ value, label, tone }: { value: number; label: string; tone?: TileTone }) {
  const reduce = useReducedMotion();
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className="gi-meter" data-tone={tone} role="img" aria-label={label}>
      <motion.span className="gi-meter__fill" initial={reduce ? false : { scaleX: 0 }} animate={{ scaleX: v }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0.15 }} />
    </span>
  );
}

/** A progress ring with the percentage in the middle. */
export function Ring({ value, label, size = 64 }: { value: number; label: string; size?: number }) {
  const reduce = useReducedMotion();
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className="gi-ring" role="img" aria-label={label} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden focusable="false">
        <circle className="gi-ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <motion.circle
          className="gi-ring__fill" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" strokeLinecap="round"
          strokeDasharray={c} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          initial={reduce ? false : { strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - v) }} transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
        />
      </svg>
      <span className="gi-ring__pct">{Math.round(v * 100)}%</span>
    </span>
  );
}
