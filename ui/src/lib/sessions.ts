/**
 * Track H: where a session came from. Everything VYSTRAL observed itself ('tracked', 'detected',
 * 'background') counts the same in the journal, statistics and performance views; only store-imported
 * playtime is kept apart.
 */
import type { SessionSource } from '../bridge/types';

export type ObservedSource = Exclude<SessionSource, 'imported'>;

/** True for sessions VYSTRAL recorded itself, however it noticed the game. */
export function isObserved(source: string | null | undefined): source is ObservedSource {
  return source === 'tracked' || source === 'detected' || source === 'background';
}

/** A short, honest note for sessions VYSTRAL didn't launch; null for launches from VYSTRAL. */
export function sessionOrigin(source: string | null | undefined): { label: string; title: string } | null {
  if (source === 'background') return { label: 'Background', title: 'Tracked by the background tracker while VYSTRAL was closed' };
  if (source === 'detected') return { label: 'Detected', title: 'Started outside VYSTRAL and noticed while VYSTRAL was open' };
  return null;
}
