/** Small text helpers shared by the Journal and Performance views. */
import type { Game } from '../../bridge/types';

export const gameTitle = (game: Game | undefined) => game?.title ?? 'Removed game';

/** "Today", "Yesterday", or a full date. */
export function dayLabel(dayStart: number, now = Date.now()): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - dayStart) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const sameYear = new Date(dayStart).getFullYear() === today.getFullYear();
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: sameYear ? undefined : 'numeric' }).format(dayStart);
}

export const timeOfDay = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(ms);
export const shortDate = (ms: number, withYear = false) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: withYear ? 'numeric' : undefined }).format(ms);
