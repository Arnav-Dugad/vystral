import { useMemo } from 'react';
import { Sparkles } from 'lucide-react';
import type { DiscoverResult, DiscoverShelf as Shelf, DiscoverWatch, SubsPick } from '../../bridge/types';
import { titleKey } from '../../lib/discover';
import type { DiscoverCandidate, Recommendation } from '../../lib/recommendV2';
import { useDiscoverPicks, useFriendsElsewhere, useDismissedList } from '../../state/recommend';
import { useSubsIncluded } from '../../state/subs';
import { DiscoverShelf } from '../discover/DiscoverShelf';
import { ResultCard } from '../discover/DiscoverBits';
import { PickCaption } from './PickCaption';
import './recommend.css';

export interface DiscoverSources {
  because: Shelf[];
  store: Shelf[];
  wishlist: DiscoverResult[];
  watching: DiscoverWatch[] | null;
}

const toCandidate = (r: DiscoverResult, via: DiscoverCandidate['via'][number], seedGameId: string | null, plans: Map<string, string>): DiscoverCandidate => ({
  key: r.key, title: r.title, genres: r.genres, year: r.year, seedGameId, via: [via], free: r.free, discountPercent: r.discountPercent ?? discountOf(r),
  comingSoon: r.comingSoon, libraryGameId: r.libraryGameId, planName: plans.get(titleKey(r.title)) ?? null,
});

function discountOf(r: DiscoverResult): number {
  const p = r.price;
  return p && p.initialCents > 0 && p.finalCents < p.initialCents ? Math.round((1 - p.finalCents / p.initialCents) * 100) : 0;
}

/** Every Discover source as candidates for recommend.v2, plus the result cards to draw them with. */
export function useDiscoverCandidates(src: DiscoverSources): { candidates: DiscoverCandidate[]; results: Map<string, DiscoverResult> } {
  const included = useSubsIncluded();
  const friends = useFriendsElsewhere();
  return useMemo(() => {
    const plans = new Map<string, string>((included ?? []).map((p: SubsPick) => [titleKey(p.title), p.planName]));
    const results = new Map<string, DiscoverResult>();
    const candidates: DiscoverCandidate[] = [];
    const add = (r: DiscoverResult, via: DiscoverCandidate['via'][number], seed: string | null) => {
      if (r.kind === 'extra') return;
      if (!results.has(r.key)) results.set(r.key, r);
      candidates.push(toCandidate(r, via, seed, plans));
    };
    for (const s of src.because) for (const r of s.items) add(r, 'because', s.seed?.gameId ?? null);
    for (const s of src.store) for (const r of s.items) add(r, 'store', null);
    for (const r of src.wishlist) add(r, 'wishlist', null);
    for (const w of src.watching ?? []) {
      const known = results.get(w.key);
      candidates.push({ key: w.key, title: w.title, genres: known?.genres ?? [], year: w.year, via: ['watching'], planName: plans.get(titleKey(w.title)) ?? null });
      if (!known) results.set(w.key, stub(w.key, w.title, w.year, w.steamAppId, w.cover));
    }
    for (const f of friends) {
      const key = `steam-${f.appId}`;
      const known = results.get(key);
      candidates.push({ key, title: known?.title ?? f.title, genres: known?.genres ?? [], via: ['friends'], friends: f.count, libraryGameId: known?.libraryGameId ?? null });
      if (!known) results.set(key, stub(key, f.title, null, f.appId, null));
    }
    return { candidates, results };
  }, [src.because, src.store, src.wishlist, src.watching, included, friends]);
}

function stub(key: string, title: string, year: number | null, steamAppId: string | null, cover: string | null): DiscoverResult {
  return {
    key, title, year, stores: steamAppId ? ['steam'] : [], platforms: [], genres: [], sources: steamAppId ? ['steam'] : [], steamAppId,
    libraryGameId: null, price: null, hasCover: true, cover, score: 0, kind: 'game',
  };
}

/**
 * Track D5: Discover's "Recommended for you" — every source (games like the ones you play, Steam's shelves, your
 * wishlist and Watching list, friends playing, your plans) ranked by recommend.v2, varied, each card with its reason
 * and "Not interested".
 */
export function RecommendedShelf({ src }: { src: DiscoverSources }) {
  const { candidates, results } = useDiscoverCandidates(src);
  const picks = useDiscoverPicks(candidates, 14);
  const shown = picks.filter((p) => results.has(p.id));
  // Only worth a row when there's a real choice (and something to explain beyond "it's on a shelf below").
  if (shown.length < 3) return null;
  return (
    <DiscoverShelf
      id="recommended"
      title="Recommended for you"
      icon={<Sparkles size={18} aria-hidden />}
      count={shown.length}
      reason="Picked on this PC from what you play, your wishlist and what you’re watching. Nothing is sent anywhere."
    >
      {shown.map((p, i) => <RecommendedCell key={p.id} pick={p} result={results.get(p.id)!} index={i} />)}
    </DiscoverShelf>
  );
}

function RecommendedCell({ pick, result, index }: { pick: Recommendation; result: DiscoverResult; index: number }) {
  return (
    <div className="shelf__item drec" role="listitem" data-shelf-card data-rec-key={pick.id} style={{ ['--i' as string]: Math.min(index, 10) }}>
      <ResultCard r={result} query={null} showSources={false} />
      <PickCaption pick={pick} />
    </div>
  );
}

/**
 * Track D5: a "Because you played" row re-ranked by recommend.v2 (best fit first), without anything you said
 * "Not interested" to. The row's own order is kept for ties.
 */
export function useRanked(items: DiscoverResult[], seedGameId: string | null): DiscoverResult[] {
  const dismissed = useDismissedList();
  const candidates = useMemo<DiscoverCandidate[]>(() => items.map((r) => ({
    key: r.key, title: r.title, genres: r.genres, year: r.year, seedGameId, via: ['because'], free: r.free, comingSoon: r.comingSoon, libraryGameId: r.libraryGameId,
  })), [items, seedGameId]);
  const picks = useDiscoverPicks(candidates, items.length);
  return useMemo(() => {
    const gone = new Set(dismissed.map((d) => d.key));
    const order = new Map(picks.map((p, i) => [p.id, i]));
    // Owned games (the engine skips them) keep their place at the end; dismissed ones leave.
    return items
      .filter((r) => !gone.has(`discover:${r.key}`))
      .map((r, i) => ({ r, i, o: order.get(r.key) ?? 1000 + i }))
      .sort((a, b) => a.o - b.o)
      .map((x) => x.r);
  }, [items, picks, dismissed]);
}
