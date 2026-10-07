/**
 * Track W: pure helpers for the game-page extras — friends who played a game, the achievement guide
 * and news posts.
 */
import type { FriendPlayed, NewsBlock, NewsPost } from '../bridge/types';

/** "Rook played this", "Rook and Juniper played this", "Rook, Juniper and Atlas…", "5 friends played this". */
export function friendsPlayedHeadline(friends: Pick<FriendPlayed, 'name'>[]): string {
  const n = friends.length;
  if (n === 0) return 'None of your friends played this recently';
  if (n === 1) return `${friends[0].name} played this recently`;
  if (n === 2) return `${friends[0].name} and ${friends[1].name} played this recently`;
  return `${n} friends played this recently`;
}

/** 45 → "45 min", 185 → "3 h 5 min", 600 → "10 h". */
export function formatMinutes(min: number): string {
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Words for how common an achievement is (by the share of Steam players who have it). */
export function commonness(pct: number | null): { label: string; tone: 'easy' | 'medium' | 'hard' | 'unknown' } {
  if (pct == null) return { label: 'Rarity unknown', tone: 'unknown' };
  if (pct >= 50) return { label: 'Most players get this', tone: 'easy' };
  if (pct >= 20) return { label: 'Common', tone: 'easy' };
  if (pct >= 5) return { label: 'Uncommon', tone: 'medium' };
  if (pct >= 1) return { label: 'Rare', tone: 'hard' };
  return { label: 'Ultra rare', tone: 'hard' };
}

export function formatPercent(p: number): string {
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

export type NewsGroup =
  | { kind: 'list'; items: NewsBlock[] }
  | { kind: 'block'; block: NewsBlock };

/** Consecutive list items render as one list. */
export function groupNewsBlocks(blocks: NewsBlock[]): NewsGroup[] {
  const out: NewsGroup[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.kind === 'li') {
      if (last?.kind === 'list') last.items.push(b);
      else out.push({ kind: 'list', items: [b] });
    } else out.push({ kind: 'block', block: b });
  }
  return out;
}

/** Posts newer than the last time you played (an update you haven't seen in game yet). */
export function updatedSince(post: Pick<NewsPost, 'date'>, lastPlayed: string | null | undefined): boolean {
  if (!lastPlayed) return false;
  const a = Date.parse(post.date);
  const b = Date.parse(lastPlayed);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

/** How many posts since you last played, and whether any of them are patch notes. */
export function sinceLastPlayed(posts: Pick<NewsPost, 'date' | 'patch'>[], lastPlayed: string | null | undefined) {
  const fresh = posts.filter((p) => updatedSince(p, lastPlayed));
  return { count: fresh.length, patches: fresh.filter((p) => p.patch).length };
}
