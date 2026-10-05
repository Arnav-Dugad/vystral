/**
 * Play status vocabulary shared by the detail page, Library filters and the Journal.
 * Every status has an icon and a label as well as a colour, so it is never colour-only.
 */
import { Ban, Flag, Gamepad2, Layers, Trophy, type LucideIcon } from 'lucide-react';
import type { Game, GameStatus } from '../bridge/types';

export interface StatusMeta {
  value: GameStatus;
  label: string;
  /** Phrase for toasts and summaries ("Marked as …"). */
  phrase: string;
  /** Short help text for tooltips and screen readers. */
  hint: string;
  icon: LucideIcon;
  /** CSS colour (a design token) used for the status dot/tint. */
  color: string;
}

export const STATUSES: readonly StatusMeta[] = [
  { value: 'backlog', label: 'Backlog', phrase: 'in your backlog', hint: 'Want to play it', icon: Layers, color: 'var(--info)' },
  { value: 'playing', label: 'Playing', phrase: 'Playing', hint: 'Currently playing', icon: Gamepad2, color: 'var(--violet)' },
  { value: 'beaten', label: 'Beaten', phrase: 'Beaten', hint: 'Finished the main story', icon: Flag, color: 'var(--ok)' },
  { value: 'completed', label: 'Completed 100%', phrase: 'Completed 100%', hint: 'Done everything', icon: Trophy, color: 'var(--warn)' },
  { value: 'abandoned', label: 'Abandoned', phrase: 'Abandoned', hint: 'Stopped for good', icon: Ban, color: 'var(--text-3)' },
];

export const STATUS_META: Record<GameStatus, StatusMeta> = Object.fromEntries(STATUSES.map((s) => [s.value, s])) as Record<GameStatus, StatusMeta>;

export const isStatus = (v: unknown): v is GameStatus => typeof v === 'string' && v in STATUS_META;

/** Statuses that mean "finished". */
export const FINISHED: readonly GameStatus[] = ['beaten', 'completed'];

/**
 * Sort rank for "Sort by status": what you're playing first, then the backlog, then finished,
 * then abandoned, then games without a status.
 */
const RANK: Record<GameStatus, number> = { playing: 0, backlog: 1, beaten: 2, completed: 3, abandoned: 4 };
export function statusRank(game: Pick<Game, 'status'>): number {
  return game.status ? RANK[game.status] : 5;
}
