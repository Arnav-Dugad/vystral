import { useEffect, useState, type CSSProperties } from 'react';
import { clockDrift, clockParts, minuteOf } from './screensaver';

/** Ticks on each minute boundary (never drifts against the wall clock). */
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let t = 0;
    const schedule = () => {
      const d = new Date();
      t = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, (60 - d.getSeconds()) * 1000 - d.getMilliseconds() + 30);
    };
    schedule();
    return () => window.clearTimeout(t);
  }, []);
  return now;
}

/**
 * Track Z: the screensaver's big clock, for TVs across the room. Light, wide-set digits with a
 * soft glow that breathes in the showcased game's colour; no weather, no feeds, nothing online.
 * Burn-in protection: the whole clock drifts to a new spot every minute (a slow 9 s glide; a
 * jump under reduced motion). 12/24-hour follows Windows' regional format.
 */
export function BigClock({ tint, hour12 }: { tint: string; hour12: boolean | null }) {
  const now = useMinute();
  const parts = clockParts(now, hour12);
  const drift = clockDrift(minuteOf(now.getTime()));
  return (
    <div className="attract-clock" style={{ ['--clock-tint' as string]: tint } as CSSProperties}>
      <div
        className="attract-clock__face"
        data-drift={`${drift.x},${drift.y}`}
        style={{ transform: `translate3d(${drift.x}vw, ${drift.y}vh, 0)` }}
      >
        <span className="attract-clock__glow" aria-hidden />
        <span className="attract-clock__time">
          {parts.time}
          {parts.period && <span className="attract-clock__period">{parts.period}</span>}
        </span>
        <span className="attract-clock__date">{parts.date}</span>
      </div>
    </div>
  );
}

/** The small corner clock (when the big one is off). */
export function CornerClock({ hour12 }: { hour12: boolean | null }) {
  const now = useMinute();
  const parts = clockParts(now, hour12);
  return (
    <div className="attract__clock">
      <span className="num">{parts.label}</span>
      <span>{parts.date}</span>
    </div>
  );
}
