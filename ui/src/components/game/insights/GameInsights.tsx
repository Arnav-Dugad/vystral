import { useEffect } from 'react';
import { call, errorMessage } from '../../../bridge/bridge';
import type { AchievementProgress, Compat, Deals, Enrichment, Game, ReviewsSnapshot, Session, StoreFacts } from '../../../bridge/types';
import { ratingRows } from '../../../lib/gamePage';
import { updateForGame } from '../../../lib/diskForecast';
import { primaryInstallation } from '../../../lib/format';
import { ensureDiskForecast, useDiskForecast } from '../../../state/diskForecast';
import { useTimeToBeat } from '../../../state/recap';
import { useStore } from '../../../state/store';
import { AchievementsTile, CompatTile, DiskTile, PlaytimeTile, PriceTile, RatingsTile, ReleaseTile, ReviewsTile, SessionsTile } from './Tiles';
import { TileSkeleton } from './StatTile';
import { useBridgeData } from './useBridgeData';
import './insights.css';

/** Settings that change what the tiles may fetch: any change reloads them. */
export function useInsightSettingsKey() {
  return useStore((s) => ['dataSources.steamReviews', 'dataSources.steamTags', 'library.fetchMetadata', 'privacy.localOnly', 'dataSources.storePrices',
    'dataSources.priceCountry', 'dataSources.cheapshark', 'dataSources.enrichment', 'dataSources.steamDeck', 'dataSources.antiCheat']
    .map((k) => String(s.settings?.[k as keyof NonNullable<typeof s.settings>] ?? '')).join('|'));
}

export const openOnSteam = (params: Record<string, unknown>) => () =>
  void call('reviews.open', params).catch((err) => useStore.getState().toast({ tone: 'info', title: errorMessage(err) }));

/**
 * Track C4: the library game page's "At a glance" grid. Each tile appears only when there's something true to show
 * (a non-Steam game has no Steam reviews tile, a game nobody rated has no ratings tile), and each names its source.
 */
export function GameInsights({ game, onOpenAchievements }: { game: Game; onOpenAchievements: () => void }) {
  const steam = game.installations.some((i) => i.platform === 'steam');
  const settingsKey = useInsightSettingsKey();
  const key = `${game.id}|${settingsKey}`;
  const ttb = useTimeToBeat(game.id);
  const p = { gameId: game.id };
  const reviews = useBridgeData<ReviewsSnapshot>('reviews.get', steam ? p : null, key);
  const facts = useBridgeData<StoreFacts>('store.facts', steam ? p : null, key);
  const deals = useBridgeData<Deals>('deals.get', steam ? p : null, key);
  const enrichment = useBridgeData<Enrichment>('enrichment.get', p, key);
  const compat = useBridgeData<Compat>('compat.get', steam ? p : null, key);
  const ach = useBridgeData<AchievementProgress | null>('gamePage.achievements', steam ? p : null, `${game.id}`);
  const sessions = useBridgeData<Session[]>('sessions.list', game.sessionCount ? { gameId: game.id, limit: 200 } : null, `${game.id}|${game.sessionCount}`);
  const forecast = useDiskForecast((s) => s.forecast);
  const drives = useStore((s) => s.drives);
  useEffect(() => void ensureDiskForecast(), [game.id]);

  const igdb = enrichment.data?.sources.find((s) => s.source === 'igdb' && s.matched)?.facts;
  const rawg = enrichment.data?.sources.find((s) => s.source === 'rawg' && s.matched)?.facts;
  const r = reviews.data;
  const showReviews = r && r.allTime && r.allTime.total > 0 && r.status !== 'off' && r.status !== 'notSteam';
  const rows = ratingRows({
    igdbCritics: igdb?.criticRating, igdbCriticsCount: igdb?.criticRatingCount, igdbTotal: igdb?.totalRating, igdbTotalCount: igdb?.totalRatingCount,
    rawgUsers: rawg?.userRating, rawgUsersCount: rawg?.userRatingCount, metacritic: facts.data?.metacritic,
    steamPercent: showReviews ? r!.allTime!.percent : null, steamTotal: showReviews ? r!.allTime!.total : null,
  });
  const f = facts.data;
  const showPrice = f && (f.sold || f.status === 'ok') && f.status !== 'off' && f.status !== 'notSteam';
  const hit = updateForGame(forecast, game.id);
  const inst = primaryInstallation(game);
  const driveName = hit?.drive.drive ?? inst?.drive ?? null;
  const drive = driveName ? drives.find((d) => d.name.toUpperCase().startsWith(driveName.replace(/\\$/, '').toUpperCase())) : undefined;
  const c = compat.data;
  let i = 0;

  return (
    <section className="gi" aria-labelledby={`gi-${game.id}`}>
      <h2 className="gi__title" id={`gi-${game.id}`}>At a glance</h2>
      <div className="gi__grid">
        <PlaytimeTile game={game} ttb={ttb} index={i++} />
        {sessions.data && sessions.data.length > 0 && <SessionsTile sessions={sessions.data} index={i++} />}
        {ach.data && ach.data.total > 0 && <AchievementsTile p={ach.data} onOpen={onOpenAchievements} index={i++} />}
        {showReviews ? <ReviewsTile r={r!} onOpen={openOnSteam(p)} index={i++} /> : steam && reviews.loading ? <TileSkeleton label="Steam reviews" /> : null}
        {rows.length > 0 && <RatingsTile rows={rows} index={i++} />}
        {showPrice ? <PriceTile facts={f} deals={deals.data} index={i++} /> : steam && facts.loading ? <TileSkeleton wide label="Price" /> : null}
        {c && (c.deck || c.antiCheat) && <CompatTile deck={c.deck} antiCheat={c.antiCheat} index={i++} />}
        <DiskTile game={game} update={hit ? { needBytes: hit.update.needBytes, fit: hit.update.fit } : null}
          freeBytes={hit?.drive.freeBytes ?? drive?.freeBytes ?? null} totalBytes={hit?.drive.totalBytes ?? drive?.totalBytes ?? null} drive={driveName} index={i++} />
        {(game.releaseDate || f?.releaseText) && (
          <ReleaseTile date={game.releaseDate} storeText={f?.releaseText} comingSoon={f?.comingSoon} developer={game.developer} publisher={game.publisher} index={i++}
            source={f?.releaseText && !game.releaseDate ? 'Steam store' : game.metadataSource ? `From ${game.metadataSource}` : 'From your store app'} />
        )}
      </div>
    </section>
  );
}
