import { useEffect } from 'react';
import { create } from 'zustand';
import { call, errorMessage, on } from '../bridge/bridge';
import type { Game, ResolvedIdentity } from '../bridge/types';
import { isSteamGame, steamLinkOf, type SteamLink } from '../lib/identity';

/**
 * Track D4: each library game's cross-store identity (its Steam app, IGDB/RAWG/GOG/Wikidata IDs, how sure VYSTRAL is),
 * shared by the game page's Steam sections, the hero trailer and the "Matched IDs" card. Loaded on first use per game;
 * the native `identity.changed` event (a lookup finished, you corrected a match, a setting changed) refreshes it.
 */
interface IdentityState {
  byGame: Record<string, ResolvedIdentity>;
  errors: Record<string, string>;
  loading: Record<string, boolean>;
  set(identity: ResolvedIdentity): void;
}

export const useIdentityStore = create<IdentityState>((set) => ({
  byGame: {},
  errors: {},
  loading: {},
  set(identity) {
    set((s) => ({ byGame: { ...s.byGame, [identity.gameId]: identity }, errors: { ...s.errors, [identity.gameId]: '' } }));
  },
}));

const inflight = new Map<string, Promise<ResolvedIdentity | null>>();
let subscribed = false;

function subscribe() {
  if (subscribed) return;
  subscribed = true;
  on('identity.changed', (e) => {
    const known = Object.keys(useIdentityStore.getState().byGame);
    for (const id of e?.gameId ? [e.gameId] : known) if (known.includes(id)) void loadIdentity(id, false, true);
  });
}

/** Asks the host (which may look the game up first). Concurrent asks for one game share a request. */
export function loadIdentity(gameId: string, refresh = false, force = false): Promise<ResolvedIdentity | null> {
  subscribe();
  if (!force && !refresh && useIdentityStore.getState().byGame[gameId]) return Promise.resolve(useIdentityStore.getState().byGame[gameId]);
  const key = `${gameId}|${refresh}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  useIdentityStore.setState((s) => ({ loading: { ...s.loading, [gameId]: true } }));
  const p = call<ResolvedIdentity>('identity.resolved', { gameId, refresh }, 90_000)
    .then((r) => {
      useIdentityStore.getState().set(r);
      return r;
    })
    .catch((err) => {
      useIdentityStore.setState((s) => ({ errors: { ...s.errors, [gameId]: errorMessage(err) } }));
      return null;
    })
    .finally(() => {
      inflight.delete(key);
      useIdentityStore.setState((s) => ({ loading: { ...s.loading, [gameId]: false } }));
    });
  inflight.set(key, p);
  return p;
}

/** The game's resolved identity (null until loaded). A Steam game is never looked up for this. */
export function useResolvedIdentity(game: Game, enabled = true): { identity: ResolvedIdentity | null; loading: boolean; error: string | null } {
  const identity = useIdentityStore((s) => s.byGame[game.id] ?? null);
  const loading = useIdentityStore((s) => !!s.loading[game.id]);
  const error = useIdentityStore((s) => s.errors[game.id] || null);
  useEffect(() => {
    if (enabled) void loadIdentity(game.id);
  }, [game.id, enabled]);
  return { identity, loading, error };
}

/**
 * The Steam app a game page's Steam sections use: a Steam game's own (immediately), or a matched/chosen one once the
 * identity has loaded. `pending` is true while a non-Steam game's identity is still being looked up.
 */
export function useSteamLink(game: Game): { link: SteamLink | null; pending: boolean } {
  const steam = isSteamGame(game);
  const { identity, loading } = useResolvedIdentity(game, !steam);
  return { link: steamLinkOf(game, identity), pending: !steam && !identity && loading };
}
