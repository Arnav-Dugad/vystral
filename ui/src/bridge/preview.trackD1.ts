/**
 * Track D1 preview: Library bulk actions with undo, and the game versions the update timeline shows. Fictional data
 * for the browser preview only; the app records real Steam builds and Xbox package versions after each scan.
 * URL switches:
 *   ?bulk           start with two collections ("Couch co-op", and a smart one), for trying bulk collection actions
 *   ?bulkFail       library.bulkEdit fails (nothing changes; the page must put every game back)
 *   ?noVersions     no versions recorded yet (a fresh install of VYSTRAL)
 */
import type { BulkEditResult, BulkUndoResult, Game, GameStatus, LibrarySnapshot, Session, StatusHistoryEntry, VersionHistoryEntry } from './types';
import { BridgeError } from './bridge';
import { MAX_BULK_GAMES } from './types.trackD1';
import { userHiddenOf } from '../lib/bulk';

type Emit = (name: string, payload: unknown) => void;

const STATUSES: GameStatus[] = ['backlog', 'playing', 'beaten', 'completed', 'abandoned'];
const DAY = 86_400_000;

interface Before {
  gameId: string;
  status: GameStatus | null;
  statusChangedAt: string | null;
  favorite: boolean;
  userHidden: boolean;
  playedMarkedAt: string | null;
  member: boolean | null;
  history: StatusHistoryEntry[];
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Fictional versions: a baseline when VYSTRAL first saw the copy, then an update a couple of days before some sessions. */
export function previewVersions(g: Game, sessions: readonly Session[], now = Date.now()): VersionHistoryEntry[] {
  const out: VersionHistoryEntry[] = [];
  const own = sessions.filter((s) => s.gameId === g.id).map((s) => Date.parse(s.start)).filter(Number.isFinite).sort((a, b) => a - b);
  for (const inst of g.installations) {
    if (inst.state !== 'installed' || (inst.platform !== 'steam' && inst.platform !== 'xbox')) continue;
    const h = hash(inst.id);
    const first = Math.min(own[0] ?? now - 40 * DAY, now - 40 * DAY) - (20 + (h % 30)) * DAY;
    const updates = own.length >= 3 ? own.filter((_, i) => i % 3 === 2).map((t) => t - 2 * DAY) : [now - 70 * DAY, now - 21 * DAY];
    const times = [first, ...updates.filter((t) => t > first && t < now)];
    times.forEach((t, i) => {
      const value = inst.platform === 'steam' ? String(14_200_000 + (h % 90_000) + i * 381_117) : `1.${4 + i}.${(h % 300) + i * 17}.0`;
      out.push({
        installationId: inst.id, platform: inst.platform, kind: inst.platform === 'steam' ? 'steamBuild' : 'xboxPackage', value,
        seen: new Date(i === 0 ? t : t + 3 * 3600_000).toISOString(), storeUpdated: i === 0 ? null : new Date(t).toISOString(), baseline: i === 0,
      });
    });
  }
  return out;
}

export function trackD1PreviewHandlers(ctx: {
  lib: { games: Game[]; sessions: Session[] };
  collections: LibrarySnapshot['collections'];
  statusHistory: StatusHistoryEntry[];
  emit: () => Emit;
}) {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const undo = new Map<string, { kind: string; collectionId: string | null; before: Before[]; at: number }>();
  const find = (id: string) => ctx.lib.games.find((g) => g.id === id);
  const replace = (g: Game, patch: Partial<Game>) => {
    // A new object, as the native bridge would send, so views keyed on the game see the change.
    const i = ctx.lib.games.indexOf(g);
    if (i >= 0) ctx.lib.games[i] = { ...g, ...patch };
  };

  if (params.has('bulk') && ctx.collections.length === 0) {
    ctx.collections.push(
      { id: 'c011ec7100000000000000000000c0c0', name: 'Couch co-op', icon: null, sortOrder: 0, rule: null, count: 0 },
      { id: 'c011ec7100000000000000000000face', name: 'Short and sweet', icon: null, sortOrder: 1, rule: JSON.stringify({ v: 1, ttbMaxHours: 8 }), count: 0 },
    );
  }

  return {
    'library.bulkEdit': (p: { gameIds: string[]; action: string; status?: GameStatus | null; value?: boolean; collectionId?: string | null }): BulkEditResult => {
      if (params.has('bulkFail')) throw new BridgeError('unavailable', 'The library database is busy (preview: ?bulkFail). Nothing was changed.');
      if (!Array.isArray(p.gameIds) || p.gameIds.length === 0) throw new BridgeError('invalid', 'Choose at least one game.');
      if (p.gameIds.length > MAX_BULK_GAMES) throw new BridgeError('invalid', 'Too many games.');
      const kind = p.action;
      if (!['status', 'favorite', 'hidden', 'collection', 'played'].includes(kind)) throw new BridgeError('invalid', 'Unknown action.');
      if (kind === 'status' && p.status != null && !STATUSES.includes(p.status)) throw new BridgeError('invalid', 'Unknown status.');
      if (kind !== 'status' && typeof p.value !== 'boolean') throw new BridgeError('invalid', 'Say whether to turn it on or off.');
      const col = kind === 'collection' ? ctx.collections.find((c) => c.id === p.collectionId) : null;
      if (kind === 'collection' && !col) throw new BridgeError('invalid', 'That collection no longer exists.');
      if (col?.rule) throw new BridgeError('invalid', 'Smart collections choose their own games, so games can’t be added or removed by hand.');
      const at = new Date().toISOString();
      const before: Before[] = [];
      const ids = [...new Set(p.gameIds)];
      let found = 0;
      for (const id of ids) {
        const g = find(id);
        if (!g) continue;
        found++;
        const userHidden = userHiddenOf(g);
        const b: Before = { gameId: g.id, status: g.status ?? null, statusChangedAt: g.statusChangedAt ?? null, favorite: g.favorite, userHidden, playedMarkedAt: g.playedMarkedAt ?? null, member: col ? g.collections.includes(col.id) : null, history: [] };
        let patch: Partial<Game> | null = null;
        if (kind === 'status' && (g.status ?? null) !== (p.status ?? null)) {
          patch = { status: p.status ?? null, statusChangedAt: at };
          const entry = { gameId: g.id, status: p.status ?? null, at };
          ctx.statusHistory.push(entry);
          b.history.push(entry);
        } else if (kind === 'favorite' && g.favorite !== p.value) patch = { favorite: !!p.value };
        else if (kind === 'hidden' && userHidden !== p.value) patch = { userHidden: !!p.value, hidden: !!p.value || !!g.notOwned };
        else if (kind === 'played' && !!g.playedMarkedAt !== p.value) patch = { playedMarkedAt: p.value ? at : null };
        else if (col && b.member !== p.value) patch = { collections: p.value ? [...g.collections, col.id] : g.collections.filter((c) => c !== col.id) };
        if (!patch) continue;
        replace(g, patch);
        before.push(b);
      }
      let token: string | null = null;
      if (before.length) {
        token = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        undo.set(token, { kind, collectionId: col?.id ?? null, before, at: Date.now() });
        ctx.emit()('library.changed', { reason: 'bulk' });
      }
      return { token, requested: ids.length, found, changed: before.length };
    },
    'library.bulkUndo': (p: { token: string }): BulkUndoResult => {
      const entry = undo.get(p.token);
      undo.delete(p.token);
      if (!entry || Date.now() - entry.at > 15 * 60_000) throw new BridgeError('expired', 'That change can’t be undone any more. Change the games back from the Library.');
      let restored = 0;
      for (const b of entry.before) {
        for (const h of b.history) {
          const i = ctx.statusHistory.indexOf(h);
          if (i >= 0) ctx.statusHistory.splice(i, 1);
        }
        const g = find(b.gameId);
        if (!g) continue;
        const patch: Partial<Game> =
          entry.kind === 'status' ? { status: b.status, statusChangedAt: b.statusChangedAt }
          : entry.kind === 'favorite' ? { favorite: b.favorite }
          : entry.kind === 'hidden' ? { userHidden: b.userHidden, hidden: b.userHidden || !!g.notOwned }
          : entry.kind === 'played' ? { playedMarkedAt: b.playedMarkedAt }
          : { collections: b.member ? [...new Set([...g.collections, entry.collectionId!])] : g.collections.filter((c) => c !== entry.collectionId) };
        replace(g, patch);
        restored++;
      }
      ctx.emit()('library.changed', { reason: 'bulk' });
      return { restored };
    },
    'versions.history': (p: { gameId: string }): VersionHistoryEntry[] => {
      const g = find(p.gameId);
      if (!g) throw new BridgeError('notFound', 'That item no longer exists.');
      return params.has('noVersions') ? [] : previewVersions(g, ctx.lib.sessions);
    },
  };
}
