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
    // Track D1
    case 'weekendWarrior':
      return { name: 'Weekend warrior', what: 'Most play in one weekend', value: r ? formatDuration(v) : '', locked: 'Play on a Saturday or a Sunday.', brag: `${formatDuration(v)} in one weekend` };
    case 'marathonMonth':
      return { name: 'Marathon month', what: 'Most play in one month', value: r ? formatDuration(v) : '', locked: 'Play this month to set it.', brag: `${formatDuration(v)} in one month` };
    case 'gameStreak':
      return { name: 'Devoted', what: 'Longest streak with one game', value: r ? plural(v, 'day') : '', locked: 'Play the same game two days in a row.', brag: `${plural(v, 'day')} in a row with one game` };
    case 'varietyMonth':
      return { name: 'Sampler', what: 'Most games in one month', value: r ? plural(v, 'game') : '', locked: 'Play two or more different games in a month.', brag: `${plural(v, 'game')} in one month` };
    case 'achievementDay':
      return { name: 'Trophy day', what: 'Most achievements in one day', value: r ? plural(v, 'achievement') : '', locked: 'Unlock achievements in a Steam game (Settings › Steam account).', brag: `${plural(v, 'achievement')} in one day` };
    case 'speedrun':
      return { name: 'Speedrunner', what: `Fastest finish against the ${r?.label ?? 'IGDB'} estimate`, value: r ? `${v}% of the usual time` : '', locked: 'Mark a game Beaten that has an IGDB time to beat, after playing it here.', brag: `a finish in ${v}% of the usual time` };
    case 'century':
      return { name: 'Centurion', what: 'First 100 hours in one game', value: r ? day(v) : '', locked: 'Play one game for 100 hours.', brag: '100 hours in one game' };
    case 'genreHours':
      return { name: 'Genre devotee', what: r?.label ? `Most hours in one genre: ${r.label}` : 'Most hours in one genre', value: r ? formatDuration(v) : '', locked: 'Play games that have genres in your library.', brag: `${formatDuration(v)} of ${r?.label ?? 'one genre'}` };
    case 'oldestGame':
      return { name: 'Time traveller', what: 'Oldest game played, by release year', value: r ? String(v) : '', locked: 'Play a game whose release year is known.', brag: `a game from ${v}` };
    case 'bestFps':
      return { name: 'Silky', what: 'Best average frame rate', value: r ? `${Math.round(v)} fps` : '', locked: 'Measure frame rate in a session of 20 minutes or more (Settings › Launching & sessions).', brag: `${Math.round(v)} fps on average` };
    case 'coolest':
      return { name: 'Cool customer', what: 'Coolest-running session (GPU average)', value: r ? `${Math.round(v)} °C` : '', locked: 'Play for 20 minutes or more with GPU temperature recorded.', brag: `a ${Math.round(v)} °C session` };
    case 'first':
      return { name: 'First steps', what: 'First session tracked', value: r ? day(v) : '', locked: 'Your first session earns it.', brag: 'your first session' };
  }
}
