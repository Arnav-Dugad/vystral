import type { Deals, DiscoverDetails, ReviewsSnapshot, StoreFacts } from '../../../bridge/types';
import { ratingRows } from '../../../lib/gamePage';
import { CompatTile, PriceTile, RatingsTile, ReleaseTile, ReviewsTile, TtbTile } from './Tiles';
import { TileSkeleton } from './StatTile';
import { openOnSteam, useInsightSettingsKey } from './GameInsights';
import { useBridgeData } from './useBridgeData';
import './insights.css';

/**
 * Track C4: the same "At a glance" grid for a game you don't own (Discover page): release, price with history,
 * time to beat, ratings, the Steam review snapshot and compatibility, each with its source.
 */
export function DiscoverInsights({ d }: { d: DiscoverDetails }) {
  const settingsKey = useInsightSettingsKey();
  const key = `${d.key}|${d.steamAppId}|${settingsKey}`;
  const p = d.steamAppId ? { key: d.key, appId: d.steamAppId } : null;
  const reviews = useBridgeData<ReviewsSnapshot>('reviews.get', p, key);
  const facts = useBridgeData<StoreFacts>('store.facts', p, key);
  const deals = useBridgeData<Deals>('discover.deals', d.steamAppId ? { key: d.key } : null, key);
  const r = reviews.data;
  const showReviews = r && r.allTime && r.allTime.total > 0 && r.status !== 'off';
  const f = facts.data;
  const rows = ratingRows({
    igdbTotal: d.rating, igdbTotalCount: d.ratingCount, metacritic: d.metacritic ?? f?.metacritic,
    steamPercent: showReviews ? r!.allTime!.percent : null, steamTotal: showReviews ? r!.allTime!.total : null,
  });
  const price = d.price;
  const hasPrice = (f && f.sold) || price?.formatted || price?.comingSoon || price?.free;
  const future = d.releaseDate ? new Date(d.releaseDate) > new Date() : false;
  let i = 0;
  return (
    <section className="gi" aria-labelledby={`gi-${d.key}`}>
      <h2 className="gi__title" id={`gi-${d.key}`}>At a glance</h2>
      <div className="gi__grid">
        <ReleaseTile
          date={d.releaseDate ?? (d.year ? String(d.year) : null)} storeText={f?.releaseText} comingSoon={future || price?.comingSoon} index={i++}
          developer={d.developers[0]} publisher={d.publishers[0]}
          source={f?.releaseText ? 'Steam store' : d.credits.length ? `From ${d.credits.map((c) => c.name).join(', ')}` : 'From the connected sources'}
        />
        {hasPrice ? (
          <PriceTile facts={f && f.status !== 'off' ? f : null} deals={deals.data} index={i++}
            fallback={price ? { text: price.formatted, initial: price.initial, discount: price.discountPercent, comingSoon: price.comingSoon, free: price.free } : null} />
        ) : p && facts.loading ? <TileSkeleton wide label="Price" /> : null}
        {d.timeToBeat && <TtbTile ttb={d.timeToBeat} index={i++} />}
        {showReviews ? <ReviewsTile r={r!} onOpen={openOnSteam(p!)} index={i++} /> : p && reviews.loading ? <TileSkeleton label="Steam reviews" /> : null}
        {rows.length > 0 && <RatingsTile rows={rows} index={i++} />}
        {(d.deck || d.antiCheat) && <CompatTile deck={d.deck} antiCheat={d.antiCheat} index={i++} />}
      </div>
    </section>
  );
}
