import { useMemo } from 'react';
import { motion } from 'motion/react';
import type { DriveForecast } from '../../bridge/types';
import { barSegments } from '../../lib/diskForecast';
import { formatBytes } from '../../lib/format';
import { useReducedMotion, useStore } from '../../state/store';
import './update-space.css';

/**
 * Track P: a drive's free space as a stacked bar — each pending update's room (striped red where
 * it won't fit), then what stays free, with a tick where "nearly full" begins. Segments grow in from the left one after another; static under
 * reduced motion. The bar is an image with a full spoken summary.
 */
export function UpdateSpaceBar({ drive, compact = false }: { drive: DriveForecast; compact?: boolean }) {
  const reduce = useReducedMotion();
  const gamesById = useStore((s) => s.gamesById);
  const { segments, tightAt } = useMemo(() => barSegments(drive, gamesById), [drive, gamesById]);
  const summary =
    `${drive.drive} has ${formatBytes(drive.freeBytes)} free of ${formatBytes(drive.totalBytes)}. ` +
    `Pending updates need ${formatBytes(drive.needBytes)}` +
    (drive.afterBytes < 0 ? `, ${formatBytes(-drive.afterBytes)} more than is free.` : `, leaving ${formatBytes(drive.afterBytes)} free.`);

  return (
    <div className={`usbar${compact ? ' usbar--compact' : ''}`} role="img" aria-label={summary} data-status={drive.status}>
      {segments.map((s, i) => (
        <motion.span
          key={s.key}
          className={`usbar__seg usbar__seg--${s.kind}`}
          style={{ width: `${s.fraction * 100}%`, transformOrigin: 'left center' }}
          title={s.label}
          initial={reduce ? false : { scaleX: 0, opacity: 0.4 }}
          animate={{ scaleX: 1, opacity: 1 }}
          transition={reduce ? { duration: 0 } : { type: 'spring', visualDuration: 0.5, bounce: 0.08, delay: 0.08 + i * 0.09 }}
        />
      ))}
      {/* Where the "nearly full" zone starts. */}
      {tightAt != null && <span className="usbar__tight" style={{ left: `${tightAt * 100}%` }} aria-hidden />}
    </div>
  );
}
