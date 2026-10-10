/** Track C6: the words on each personal-record badge. Pure (formatting only), so it's unit-tested. */
import { formatDuration, plural } from '../../lib/format';
import type { PersonalRecord, RecordId } from './records';

export interface RecordCopy {
  /** The badge's name ("Marathon"). */
  name: string;
  /** What it measures ("Longest session"). */
  what: string;
  /** The record itself, short ("4h 20m"), or '' while locked. */
  value: string;
  /** How to earn it, while locked. */
  locked: string;
  /** A short line for a toast: "a 4h 20m session". */
  brag: string;
}

const clock = (minute: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60));
const day = (ms: number) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(ms);

export function recordText(id: RecordId, r: PersonalRecord | undefined): RecordCopy {
  const v = r?.value ?? 0;
  switch (id) {
    case 'longestSession':
      return { name: 'Marathon', what: 'Longest session', value: r ? formatDuration(v) : '', locked: 'Finish a session to set it.', brag: `a ${formatDuration(v)} session` };
    case 'bestDay':
      return { name: 'Big day', what: 'Most play in one day', value: r ? formatDuration(v) : '', locked: 'Play on any day to set it.', brag: `${formatDuration(v)} in one day` };
    case 'bestWeek':
      return { name: 'Big week', what: 'Most play in one week', value: r ? formatDuration(v) : '', locked: 'Play this week to set it.', brag: `${formatDuration(v)} in one week` };
    case 'varietyWeek':
      return { name: 'Explorer', what: 'Most games in one week', value: r ? plural(v, 'game') : '', locked: 'Play a few different games in a week.', brag: `${plural(v, 'game')} in one week` };
    case 'streak':
      return { name: 'On a roll', what: 'Longest streak', value: r ? plural(v, 'day') : '', locked: 'Play two days in a row.', brag: `${plural(v, 'day')} in a row` };
    case 'nightOwl':
      return { name: 'Night owl', what: 'Latest finish', value: r ? clock(v) : '', locked: 'Finish a session after 9 pm.', brag: `a finish at ${clock(v)}` };
    case 'earlyBird':
      return { name: 'Early bird', what: 'Earliest start', value: r ? clock(v) : '', locked: 'Start a session between 4 and 9 in the morning.', brag: `a start at ${clock(v)}` };
    case 'comeback':
      return { name: 'Comeback', what: 'Longest time away from a game', value: r ? plural(v, 'day') : '', locked: 'Return to a game after 30 days or more.', brag: `back after ${plural(v, 'day')}` };
    case 'first':
      return { name: 'First steps', what: 'First session tracked', value: r ? day(v) : '', locked: 'Your first session earns it.', brag: 'your first session' };
  }
}
