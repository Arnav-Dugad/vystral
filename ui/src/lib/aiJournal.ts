/**
 * Track C5: "Ask the Journal" helpers. Ready-made questions are fixed query specs that run entirely on this PC
 * (they work without any AI and send nothing anywhere); the chart model and the query's readable form are pure.
 */
import type { JournalResult, JournalSpecInput } from '../bridge/types';
import { formatDuration } from './format';

export interface ReadyQuestion {
  id: string;
  label: string;
  spec: JournalSpecInput;
}

export const READY_QUESTIONS: ReadyQuestion[] = [
  { id: 'most-month', label: 'What did I play most this month?', spec: { metric: 'playtime', groupBy: 'game', preset: 'thisMonth', limit: 8 } },
  { id: 'most-last-month', label: 'What did I play most last month?', spec: { metric: 'playtime', groupBy: 'game', preset: 'lastMonth', limit: 8 } },
  { id: 'months', label: 'How much did I play each month this year?', spec: { metric: 'playtime', groupBy: 'month', preset: 'thisYear' } },
  { id: 'weekdays', label: 'Which days of the week do I play most?', spec: { metric: 'playtime', groupBy: 'weekday', preset: 'all' } },
  { id: 'hours', label: 'What time of day do I usually start playing?', spec: { metric: 'sessions', groupBy: 'hour', preset: 'all' } },
  { id: 'genres', label: 'Which genres did I play most this year?', spec: { metric: 'playtime', groupBy: 'genre', preset: 'thisYear', limit: 8 } },
  { id: 'longest', label: 'Where were my longest sessions?', spec: { metric: 'longest', groupBy: 'game', preset: 'all', limit: 8 } },
];

/** A value in the result's unit, as people read it ("3h 20m", "12 sessions", "4 days"). */
export function formatJournalValue(value: number, unit: JournalResult['unit']): string {
  if (unit === 'count') return `${Math.round(value).toLocaleString()} ${Math.round(value) === 1 ? 'session' : 'sessions'}`;
  if (unit === 'days') return `${Math.round(value).toLocaleString()} ${Math.round(value) === 1 ? 'day' : 'days'}`;
  return value > 0 && value < 60 ? 'under 1m' : formatDuration(value);
}

export interface ChartBar {
  key: string;
  label: string;
  value: number;
  /** 0..1 of the largest value (bars are scaled to the max; a zero stays empty). */
  share: number;
  text: string;
  gameId: string | null;
}

export function chartBars(r: JournalResult): ChartBar[] {
  const max = Math.max(0, ...r.rows.map((x) => x.value));
  return r.rows.map((x) => ({
    key: x.key,
    label: x.label,
    value: x.value,
    share: max > 0 ? Math.max(0, x.value) / max : 0,
    text: formatJournalValue(x.value, r.unit),
    gameId: x.gameId,
  }));
}

/** For column charts with many buckets (24 hours, 31 days), label every nth column only. */
export function labelEvery(count: number): number {
  return count <= 12 ? 1 : count <= 24 ? 3 : count <= 40 ? 5 : Math.ceil(count / 8);
}

/** The query as readable chips, shown under the answer ("Show the query that was used"). */
export function describeSpec(r: JournalResult, gameTitle: (id: string) => string): string[] {
  const s = r.spec;
  const metric = { playtime: 'Playtime', sessions: 'Sessions', days: 'Days played', average: 'Average session', longest: 'Longest session' }[s.metric];
  const by = { game: 'by game', genre: 'by genre', platform: 'by store', month: 'by month', weekday: 'by day of the week', hour: 'by hour started', day: 'by day', none: 'in total' }[s.groupBy];
  const chips = [`${metric} ${by}`, r.rangeLabel.charAt(0).toUpperCase() + r.rangeLabel.slice(1)];
  if (s.gameIds.length) chips.push(s.gameIds.map(gameTitle).join(', '));
  if (s.genres.length) chips.push(s.genres.join(' or '));
  if (s.platforms.length) chips.push(s.platforms.join(' or '));
  if (s.groupBy === 'game' || s.groupBy === 'genre' || s.groupBy === 'platform') chips.push(`${s.sort === 'asc' ? 'Bottom' : 'Top'} ${s.limit}`);
  return chips;
}
