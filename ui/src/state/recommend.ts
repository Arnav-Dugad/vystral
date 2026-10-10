/**
 * Track D5: what recommend.v2 needs from the rest of the app, gathered once and shared — "Not interested" memory,
 * recent sessions (for the time you usually have), Steam tags, time to beat, cloud lists, friends playing now and
 * free space — plus hooks that run the engine for Home, Discover and Immersive. Nothing here asks the network for
 * anything new: every input is something VYSTRAL already has (or asks only of features you turned on).
 */
import { useCallback, useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { call, errorMessage, on } from '../bridge/bridge';
import type { FriendsActivity, Game, RecommendDismissal, Session } from '../bridge/types';
import {
  buildTasteProfile, recommendDiscover, recommendLibrary, type DiscoverCandidate, type LibraryOptions, type RecSignals, type Recommendation,
  type SessionLite, type TasteProfile,
} from '../lib/recommendV2';
import { useLibraryTags } from './libraryTags';
import { useTimeToBeatMap } from './recap';
import { useCloudMap } from './cloud';
import { useStore } from './store';

interface RecommendState {
  dismissed: RecommendDismissal[];
  sessions: SessionLite[] | null;
  friends: FriendsActivity | null;
  loadDismissed(): Promise<void>;
  loadSessions(): Promise<void>;
  loadFriends(): Promise<void>;
}

let started = false;
let sessionsTimer: number | undefined;
let friendsAt = 0;

export const useRecommendStore = create<RecommendState>((set) => ({
  dismissed: [],
  sessions: null,
  friends: null,
  async loadDismissed() {
    try {
      const list = await call<RecommendDismissal[]>('recommend.dismissed');
      set({ dismissed: Array.isArray(list) ? list.filter(validDismissal) : [] });
    } catch {
      set({ dismissed: [] });
    }
  },
  async loadSessions() {
    try {
      const list = await call<Session[]>('sessions.list', { limit: 400 });
      set({ sessions: Array.isArray(list) ? list.filter((s) => s && typeof s.start === 'string').map((s) => ({ gameId: s.gameId, start: s.start, durationSeconds: s.durationSeconds })) : [] });
    } catch {
      set({ sessions: [] });
    }
  },
  async loadFriends() {
    const s = useStore.getState().settings;
    if (!s?.['home.friendsActivity'] || s['privacy.localOnly']) {
      set({ friends: null });
      return;
    }
    // Friends playing now changes slowly enough for suggestions; the Home card keeps its own faster view.
    if (Date.now() - friendsAt < 3 * 60_000) return;
    friendsAt = Date.now();
    try {
      set({ friends: await call<FriendsActivity>('friends.activity', { force: false }) });
    } catch {
      set({ friends: null });
    }
  },
}));

function validDismissal(d: unknown): d is RecommendDismissal {
  const x = d as RecommendDismissal;
  return !!x && typeof x.key === 'string' && typeof x.title === 'string' && Array.isArray(x.features) && typeof x.at === 'string';
}

function ensureStarted() {
  if (started) return;
  started = true;
  const s = useRecommendStore.getState();
  void s.loadDismissed();
  void s.loadSessions();
  void s.loadFriends();
  on('recommend.dismissed', (list) => useRecommendStore.setState({ dismissed: Array.isArray(list) ? list.filter(validDismissal) : [] }));
  on('library.changed', (e) => {
    if (e && e.reason !== 'session') return;
    window.clearTimeout(sessionsTimer);
    sessionsTimer = window.setTimeout(() => void useRecommendStore.getState().loadSessions(), 600);
  });
  let last: unknown;
  on('settings.changed', (st) => {
    const key = `${st?.['home.friendsActivity']}|${st?.['privacy.localOnly']}`;
    if (key === last) return;
    last = key;
    friendsAt = 0;
    void useRecommendStore.getState().loadFriends();
  });
}

/** Everything the engine can use right now, memoised (identity changes only when an input does). */
export function useRecommendSignals(): Omit<RecSignals, 'now'> {
  useEffect(ensureStarted, []);
  const dismissed = useRecommendStore((s) => s.dismissed);
  const sessions = useRecommendStore((s) => s.sessions);
  const friends = useRecommendStore((s) => s.friends);
  const tagsData = useLibraryTags();
  const ttbMap = useTimeToBeatMap();
  const cloud = useCloudMap();
  const drives = useStore((s) => s.drives);

  const tags = useMemo(() => {
    if (!tagsData?.tags?.length) return undefined;
    const names = new Map(tagsData.tags.map((t) => [t.id, t.name]));
    const out: Record<string, string[]> = {};
    for (const [gameId, ids] of Object.entries(tagsData.games ?? {})) {
      const list = (Array.isArray(ids) ? ids : []).map((id) => names.get(id)).filter((n): n is string => !!n);
      if (list.length) out[gameId] = list.slice(0, 12);
    }
    return out;
  }, [tagsData]);
  const ttb = useMemo(() => {
    if (!ttbMap?.games) return undefined;
    const out: Record<string, { main: number | null; extras: number | null; completionist: number | null }> = {};
    for (const [id, t] of Object.entries(ttbMap.games)) out[id] = { main: t.main, extras: t.extras, completionist: t.completionist };
    return out;
  }, [ttbMap]);
  const friendsPlaying = useMemo(() => {
    if (!friends || friends.status !== 'ok') return undefined;
    const out: Record<string, number> = {};
    for (const f of friends.friends) if (f.state === 'play' && f.gameId) out[f.gameId] = (out[f.gameId] ?? 0) + 1;
    return out;
  }, [friends]);
  const freeBytes = useMemo(() => {
    if (!drives?.length) return undefined;
    return Object.fromEntries(drives.map((d) => [d.name, d.freeBytes]));
  }, [drives]);

  return useMemo(() => ({
    dismissed, sessions: sessions ?? undefined, tags, ttb, cloud: cloud ?? undefined, friendsPlaying, freeBytes,
  }), [dismissed, sessions, tags, ttb, cloud, friendsPlaying, freeBytes]);
}

/** Friends playing games you don't own (Steam app id → count and the name Steam sent). */
export function useFriendsElsewhere(): { appId: string; title: string; count: number }[] {
  useEffect(ensureStarted, []);
  const friends = useRecommendStore((s) => s.friends);
  return useMemo(() => {
    if (!friends || friends.status !== 'ok') return [];
    const by = new Map<string, { appId: string; title: string; count: number }>();
    for (const f of friends.friends) {
      if (f.state !== 'play' || f.gameId || !f.appId || !/^\d{1,10}$/.test(f.appId) || !f.gameName) continue;
      const e = by.get(f.appId) ?? { appId: f.appId, title: f.gameName, count: 0 };
      e.count++;
      by.set(f.appId, e);
    }
    return [...by.values()];
  }, [friends]);
}

/** One timestamp per library change (so rows don't re-sort on every render, and stay put within a visit). */
function useNow(dep: unknown): number {
  return useMemo(() => Date.now(), [dep]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The taste profile for the visible library and the current signals. */
export function useTasteProfile(visible: readonly Game[]): { profile: TasteProfile; signals: RecSignals } {
  const base = useRecommendSignals();
  const now = useNow(visible);
  const signals = useMemo<RecSignals>(() => ({ ...base, now }), [base, now]);
  const profile = useMemo(() => buildTasteProfile(visible, signals), [visible, signals]);
  return { profile, signals };
}

/** Library picks ("Picked for you", "Play in the cloud"), each with its reason. */
export function useLibraryPicks(visible: readonly Game[], opts: LibraryOptions = {}): Recommendation[] {
  const { profile, signals } = useTasteProfile(visible);
  const { limit, mode, diversify } = opts;
  return useMemo(() => recommendLibrary(visible, profile, signals, { limit, mode, diversify }), [visible, profile, signals, limit, mode, diversify]);
}

/** Discover picks among candidates you don't own. */
export function useDiscoverPicks(candidates: readonly DiscoverCandidate[], limit = 16): Recommendation[] {
  const games = useStore((s) => s.library.games);
  const gamesById = useStore((s) => s.gamesById);
  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);
  const { profile, signals } = useTasteProfile(visible);
  return useMemo(() => recommendDiscover(candidates, profile, signals, { limit, games: gamesById }), [candidates, profile, signals, limit, gamesById]);
}

/**
 * "Not interested": remembered on this PC (ui-state/recommend.json), learned from, and undoable from the toast.
 * Returns a callback for one recommendation.
 */
export function useDismiss(): (r: Pick<Recommendation, 'dismissKey' | 'title' | 'features'>) => void {
  const toast = useStore((s) => s.toast);
  return useCallback((r) => {
    const before = useRecommendStore.getState().dismissed;
    // Optimistic: the pick leaves its row at once.
    useRecommendStore.setState({ dismissed: [{ key: r.dismissKey, title: r.title, features: r.features.slice(0, 12), at: new Date().toISOString() }, ...before.filter((d) => d.key !== r.dismissKey)] });
    call<RecommendDismissal[]>('recommend.dismiss', { key: r.dismissKey, title: r.title.slice(0, 200), features: r.features.slice(0, 12) })
      .then((list) => { if (Array.isArray(list)) useRecommendStore.setState({ dismissed: list.filter(validDismissal) }); })
      .catch((err) => {
        useRecommendStore.setState({ dismissed: before });
        toast({ tone: 'warning', title: 'Couldn’t save “Not interested”', body: errorMessage(err) });
      });
    toast({
      tone: 'info',
      title: `You won’t see ${r.title} in suggestions`,
      body: 'Suggestions learn from this, on this PC only. You can bring it back in Settings → Library & stores.',
      action: { label: 'Undo', run: () => void undismiss(r.dismissKey) },
    });
  }, [toast]);
}

export async function undismiss(key: string): Promise<void> {
  const before = useRecommendStore.getState().dismissed;
  useRecommendStore.setState({ dismissed: before.filter((d) => d.key !== key) });
  try {
    const list = await call<RecommendDismissal[]>('recommend.undismiss', { key });
    if (Array.isArray(list)) useRecommendStore.setState({ dismissed: list.filter(validDismissal) });
  } catch (err) {
    useRecommendStore.setState({ dismissed: before });
    useStore.getState().toast({ tone: 'warning', title: 'Couldn’t bring it back', body: errorMessage(err) });
  }
}

export async function clearDismissed(): Promise<void> {
  try {
    await call('recommend.clearDismissed');
    useRecommendStore.setState({ dismissed: [] });
  } catch (err) {
    useStore.getState().toast({ tone: 'warning', title: 'Couldn’t clear the list', body: errorMessage(err) });
  }
}

export function useDismissedList(): RecommendDismissal[] {
  useEffect(ensureStarted, []);
  return useRecommendStore((s) => s.dismissed);
}

/** For the assistant (Track D3) and other non-React callers: the current picks, computed on demand. */
export function currentRecommendations(opts: LibraryOptions = {}): Recommendation[] {
  ensureStarted();
  const { library } = useStore.getState();
  const st = useRecommendStore.getState();
  const visible = library.games.filter((g) => !g.hidden);
  const signals: RecSignals = { now: Date.now(), dismissed: st.dismissed, sessions: st.sessions ?? undefined };
  return recommendLibrary(visible, buildTasteProfile(visible, signals), signals, opts);
}
