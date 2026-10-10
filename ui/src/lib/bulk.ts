/**
 * Track D1: Library bulk actions, the pure part — what each action changes on a game (for the optimistic update and
 * its exact revert) and the words for the toast. The backend applies the same rules in one transaction and keeps the
 * previous values for Undo (LibraryRepository.BulkEdit / BulkRestore).
 */
import type { BulkActionKind, Game, GameStatus } from '../bridge/types';
import { STATUS_META } from './status';
import { plural } from './format';

export type BulkAction =
  | { kind: 'status'; status: GameStatus | null }
  | { kind: 'favorite' | 'hidden' | 'played'; value: boolean }
  | { kind: 'collection'; collectionId: string; value: boolean };

/**
 * The user's own hidden flag. Games Steam no longer lists arrive hidden whatever it says (`userHidden` keeps it);
 * for every other game the two are the same, and `hidden` is the one the rest of the page keeps current.
 */
export const userHiddenOf = (g: Game): boolean => (g.notOwned ? !!g.userHidden : g.hidden);

type Patch = Partial<Pick<Game, 'status' | 'statusChangedAt' | 'favorite' | 'hidden' | 'userHidden' | 'playedMarkedAt' | 'collections'>>;

/** The change `action` makes to `g`, or null when it's already that way (the backend skips it too). */
export function bulkPatch(g: Game, action: BulkAction, nowIso: string): Patch | null {
  switch (action.kind) {
    case 'status':
      return (g.status ?? null) === action.status ? null : { status: action.status, statusChangedAt: nowIso };
    case 'favorite':
      return g.favorite === action.value ? null : { favorite: action.value };
    case 'hidden': {
      const user = userHiddenOf(g);
      // Games Steam no longer lists stay out of view whatever the user's own flag says.
      return user === action.value ? null : { userHidden: action.value, hidden: action.value || !!g.notOwned };
    }
    case 'played':
      return !!g.playedMarkedAt === action.value ? null : { playedMarkedAt: action.value ? nowIso : null };
    case 'collection': {
      const member = g.collections.includes(action.collectionId);
      if (member === action.value) return null;
      return { collections: action.value ? [...g.collections, action.collectionId] : g.collections.filter((c) => c !== action.collectionId) };
    }
  }
}

/** The fields of `g` a patch would overwrite, so a failed or undone change can put them back exactly. */
export function snapshotOf(g: Game, patch: Patch): Patch {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch) as (keyof Patch)[]) out[k] = k === 'userHidden' ? userHiddenOf(g) : g[k] ?? null;
  return out as Patch;
}

export interface BulkPlan {
  /** Game id → its change. Only games that change are listed. */
  patches: Map<string, Patch>;
  /** Game id → what it was. */
  before: Map<string, Patch>;
}

export function planBulk(games: readonly Game[], action: BulkAction, nowIso: string): BulkPlan {
  const patches = new Map<string, Patch>();
  const before = new Map<string, Patch>();
  for (const g of games) {
    const p = bulkPatch(g, action, nowIso);
    if (!p) continue;
    patches.set(g.id, p);
    before.set(g.id, snapshotOf(g, p));
  }
  return { patches, before };
}

/** The bridge parameters for an action. */
export function bulkParams(ids: readonly string[], action: BulkAction): { gameIds: string[]; action: BulkActionKind; status?: GameStatus | null; value?: boolean; collectionId?: string } {
  switch (action.kind) {
    case 'status': return { gameIds: [...ids], action: 'status', status: action.status };
    case 'collection': return { gameIds: [...ids], action: 'collection', value: action.value, collectionId: action.collectionId };
    default: return { gameIds: [...ids], action: action.kind, value: action.value };
  }
}

/** The toast's title: "12 games marked Beaten", "Added 3 games to Couch co-op", "One game hidden". */
export function bulkTitle(action: BulkAction, changed: number, collectionName?: string): string {
  const n = changed === 1 ? 'One game' : plural(changed, 'game');
  const n2 = changed === 1 ? 'one game' : plural(changed, 'game');
  switch (action.kind) {
    case 'status': return action.status ? `${n} marked ${STATUS_META[action.status].label}` : `Status cleared for ${n2}`;
    case 'favorite': return action.value ? `${n} added to favorites` : `${n} removed from favorites`;
    case 'hidden': return action.value ? `${n} hidden` : `${n} back in your library`;
    case 'played': return action.value ? `${n} marked as played` : `Played mark cleared for ${n2}`;
    case 'collection': return action.value ? `Added ${n2} to ${collectionName ?? 'the collection'}` : `Removed ${n2} from ${collectionName ?? 'the collection'}`;
  }
}

/** The toast's line under the title, or undefined. Says when some games were already that way. */
export function bulkBody(action: BulkAction, changed: number, selected: number): string | undefined {
  const same = selected - changed;
  const parts: string[] = [];
  if (same > 0) parts.push(`${same === 1 ? 'One was' : `${same} were`} already that way.`);
  if (action.kind === 'hidden' && action.value) parts.push('Find them with the “Hidden” filter.');
  if (action.kind === 'played' && action.value) parts.push('They leave “Never played”. No playtime is added.');
  return parts.length ? parts.join(' ') : undefined;
}

/** What to say when nothing changed at all. */
export function nothingToChange(action: BulkAction): string {
  switch (action.kind) {
    case 'status': return action.status ? `They’re all ${STATUS_META[action.status].label} already.` : 'None of them has a status.';
    case 'favorite': return action.value ? 'They’re all favorites already.' : 'None of them is a favorite.';
    case 'hidden': return action.value ? 'They’re all hidden already.' : 'None of them is hidden.';
    case 'played': return action.value ? 'They’re all marked as played already.' : 'None of them is marked as played.';
    case 'collection': return action.value ? 'They’re all in that collection already.' : 'None of them is in that collection.';
  }
}
