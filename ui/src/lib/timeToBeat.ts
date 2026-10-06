/**
 * Track M: IGDB time-to-beat bars. Pure and unit-tested (the native side applies the same "first known
 * estimate" rule in TimeToBeatData.Progress). Nothing here fetches anything: estimates come from the
 * IGDB facts VYSTRAL already cached during enrichment, and only with the user's own IGDB key.
 */
import type { Game, TimeToBeat } from '../bridge/types';
import { formatHours } from './dataSources';
import { importedMinutes } from './format';

export type TtbKey = 'main' | 'extras' | 'completionist';

export const TTB_LABEL: Record<TtbKey, string> = {
  main: 'Main story',
  extras: 'Main + extras',
  completionist: 'Completionist',
};

/** IGDB's own definitions, shown in the tooltip so the label never over-claims. */
export const TTB_HINT: Record<TtbKey, string> = {
  main: 'to the credits, without notable side content (IGDB “hastily”)',
  extras: 'with some extras such as side quests (IGDB “normally”)',
  completionist: 'to 100% completion (IGDB “completely”)',
};

export const TTB_SOURCE = 'IGDB estimate';

/**
 * Your playtime for the bar: the larger of VYSTRAL-tracked time and store-reported time. Store playtime
 * (e.g. Steam's) already includes sessions VYSTRAL tracked for that store, so adding them would count
 * the same hours twice.
 */
export function playedSeconds(game: Pick<Game, 'trackedSeconds' | 'installations'>): number {
  const store = (importedMinutes(game as Game) ?? 0) * 60;
  return Math.max(Math.max(0, game.trackedSeconds || 0), store);
}

export interface TtbMarker {
  key: TtbKey;
  label: string;
  seconds: number;
  /** Position on the bar, 0..1 (the bar's full width is the largest known estimate). */
  pos: number;
  reached: boolean;
}

export interface TtbProgress {
  /** Played time as a fraction of the bar (0..1). */
  fill: number;
  /** Played time against the first known estimate (main, else extras, else completionist), 0..1. */
  fraction: number;
  target: TtbKey;
  targetSeconds: number;
  played: number;
  markers: TtbMarker[];
  /** The next estimate not reached yet, or null when all are passed. */
  next: TtbMarker | null;
  state: 'notStarted' | 'inProgress' | 'pastEstimate';
}

const KEYS: TtbKey[] = ['main', 'extras', 'completionist'];

/** Null when the estimate has no usable numbers. */
export function ttbProgress(played: number, ttb: TimeToBeat | null | undefined): TtbProgress | null {
  if (!ttb) return null;
  const known = KEYS.map((key) => ({ key, seconds: ttb[key] })).filter((k): k is { key: TtbKey; seconds: number } => typeof k.seconds === 'number' && k.seconds > 0 && Number.isFinite(k.seconds));
  if (!known.length) return null;
  const p = Math.max(0, Number.isFinite(played) ? played : 0);
  const max = Math.max(...known.map((k) => k.seconds));
  const markers = known.map((k) => ({ key: k.key, label: TTB_LABEL[k.key], seconds: k.seconds, pos: k.seconds / max, reached: p >= k.seconds }));
  const target = known[0];
  const fraction = Math.min(1, p / target.seconds);
  return {
    fill: Math.min(1, p / max),
    fraction,
    target: target.key,
    targetSeconds: target.seconds,
    played: p,
    markers,
    next: markers.find((m) => !m.reached) ?? null,
    state: p <= 0 ? 'notStarted' : p >= target.seconds ? 'pastEstimate' : 'inProgress',
  };
}

/** One-line summary for tooltips and screen readers. */
export function ttbSummary(pr: TtbProgress, playedLabel: string): string {
  const est = pr.markers.map((m) => `${m.label} ${formatHours(m.seconds)}`).join(', ');
  const where = pr.state === 'notStarted'
    ? 'Not started'
    : pr.next
      ? `${playedLabel} played, ${Math.round((pr.played / pr.next.seconds) * 100)}% of ${pr.next.label.toLowerCase()}`
      : `${playedLabel} played, past every estimate`;
  return `${where}. ${TTB_SOURCE}: ${est}.`;
}

const DONE = new Set(['beaten', 'completed', 'abandoned']);

/**
 * "Closest to finishing": games in progress with the least time left to their first estimate come
 * first; then games not started yet (shortest first); then games past their estimate or already
 * finished; games without an estimate last, by title.
 */
export function closestToFinishing(map: Record<string, TimeToBeat> | null | undefined) {
  return (a: Game, b: Game): number => {
    const rank = (g: Game): [number, number] => {
      const pr = ttbProgress(playedSeconds(g), map?.[g.id]);
      if (!pr) return [4, 0];
      if (g.status && DONE.has(g.status)) return [3, 0];
      if (pr.state === 'inProgress') return [0, pr.targetSeconds - pr.played];
      if (pr.state === 'notStarted') return [1, pr.targetSeconds];
      return [2, -pr.played];
    };
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || a.sortTitle.localeCompare(b.sortTitle);
  };
}
