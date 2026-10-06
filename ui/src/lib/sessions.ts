/**
 * Track H: where a session came from. Everything VYSTRAL observed itself ('tracked', 'detected',
 * 'background') counts the same in the journal, statistics and performance views; only store-imported
 * playtime is kept apart.
 */
import type { SessionSource } from '../bridge/types';

export type ObservedSource = Exclude<SessionSource, 'imported'>;

/** True for sessions VYSTRAL recorded itself, however it noticed the game. */
export function isObserved(source: string | null | undefined): source is ObservedSource {
  return source === 'tracked' || source === 'detected' || source === 'background' || isCloud(source);
}

/** Track O: a cloud stream started from VYSTRAL (time estimated from the app or window it saw; no performance data). */
export function isCloud(source: string | null | undefined): source is 'cloud-gfn' | 'cloud-xbox' {
  return source === 'cloud-gfn' || source === 'cloud-xbox';
}

/** A short, honest note for sessions VYSTRAL didn't launch; null for launches from VYSTRAL. */
export function sessionOrigin(source: string | null | undefined): { label: string; title: string } | null {
  if (source === 'background') return { label: 'Background', title: 'Tracked by the background tracker while VYSTRAL was closed' };
  if (source === 'detected') return { label: 'Detected', title: 'Started outside VYSTRAL and noticed while VYSTRAL was open' };
  if (source === 'cloud-gfn') return { label: 'GeForce NOW', title: 'Streamed with GeForce NOW from VYSTRAL; time estimated from what VYSTRAL saw' };
  if (source === 'cloud-xbox') return { label: 'Xbox Cloud', title: 'Streamed with Xbox Cloud Gaming from VYSTRAL; time estimated from what VYSTRAL saw' };
  return null;
}
