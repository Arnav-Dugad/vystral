/** Track D6: the crash-free streak's words. */
import type { StreakSummary } from '../bridge/types';
import { formatDate } from './format';

/** The words under the big number ("42 days"): "without a failed start", or what today looks like. */
export function streakHeadline(s: Pick<StreakSummary, 'days' | 'failedStarts' | 'startsCounted' | 'sinceHistoryBegan'>): string {
  if (s.startsCounted === 0) return 'Counting starts from today';
  if (s.days === 0) return s.failedStarts > 0 && !s.sinceHistoryBegan ? 'A start failed today' : 'No failed starts so far';
  return 'without a failed start';
}

/** "42 days without a failed start" in one sentence (for the screen-reader summary and What's new). */
export function streakSentence(s: Pick<StreakSummary, 'days' | 'failedStarts' | 'startsCounted' | 'sinceHistoryBegan'>): string {
  const h = streakHeadline(s);
  return s.days > 0 ? `${s.days.toLocaleString()} ${s.days === 1 ? 'day' : 'days'} ${h}` : h;
}

/** Where the number comes from, honestly. */
export function streakSub(s: Pick<StreakSummary, 'since' | 'sinceHistoryBegan' | 'startsCounted' | 'failedStarts' | 'unexpectedCloses'>): string {
  if (s.startsCounted === 0) return 'VYSTRAL notes each start on this PC and whether it got to a working window. Nothing is sent anywhere.';
  const since = s.since ? formatDate(`${s.since}T12:00:00`, { dateStyle: 'medium' }) : null;
  const base = s.sinceHistoryBegan
    ? `Every start since VYSTRAL began keeping count${since ? ` on ${since}` : ''} reached a working window.`
    : `The last failed start was on ${since}.`;
  const tail = ` ${s.startsCounted.toLocaleString()} start${s.startsCounted === 1 ? '' : 's'} recorded${s.unexpectedCloses ? `, ${s.unexpectedCloses} unexpected close${s.unexpectedCloses === 1 ? '' : 's'}` : ''}.`;
  return base + tail;
}
