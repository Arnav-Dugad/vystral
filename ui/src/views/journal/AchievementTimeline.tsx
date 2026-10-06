import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, Award, CloudOff, EyeOff, Gem, KeyRound, RefreshCw, Sparkles, Target, Trophy } from 'lucide-react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { AchievementFeed, AchievementFeedItem, AchievementOverview, Game, NearCompletion } from '../../bridge/types';
import { Button, EmptyState, SectionHead, Skeleton } from '../../components/ui/primitives';
import { ProgressRing } from '../../components/game/InstallProgress';
import { formatPercent, groupFeedByDay, mergeFeed, rarity, sortNearCompletion } from '../../lib/achievements';
import { formatRelative, plural } from '../../lib/format';
import { spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { GameThumb, StatTile } from '../perf/kit';
import { dayLabel, timeOfDay } from '../perf/text';
import { isFresh, shimmerTier, takeLastSeen } from '../../lib/shimmer';
import '../../components/ui/shimmer.css';
import './achievement-timeline.css';

const PAGE = 40;
/** Largest page the backend serves in one `achievements.feed` call. */
const MAX_PAGE = 100;

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; overview: AchievementOverview; feed: AchievementFeed };

function useAchievementData() {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [items, setItems] = useState<AchievementFeedItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const loaded = useRef(0);
  const seq = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const mine = ++seq.current;
    if (!quiet) setState({ kind: 'loading' });
    try {
      // Reload everything already on screen (including pages from "Show more"), a page at a time.
      const want = Math.max(PAGE, loaded.current);
      const pages: Promise<AchievementFeed>[] = [];
      for (let offset = 0; offset < want; offset += MAX_PAGE) pages.push(call<AchievementFeed>('achievements.feed', { offset, limit: Math.min(MAX_PAGE, want - offset) }));
      const [overview, ...feeds] = await Promise.all([call<AchievementOverview>('achievements.overview'), ...pages]);
      if (mine !== seq.current) return; // a newer reload is on its way
      const all = feeds.reduce<AchievementFeedItem[]>((acc, f) => mergeFeed(acc, f.items), []);
      const feed: AchievementFeed = { ...feeds[0], items: all, hasMore: feeds[feeds.length - 1].hasMore };
      loaded.current = all.length;
      setItems(all);
      setState({ kind: 'ready', overview, feed });
    } catch (err) {
      if (!quiet && mine === seq.current) setState({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  const more = useCallback(async () => {
    if (state.kind !== 'ready') return;
    setLoadingMore(true);
    try {
      const feed = await call<AchievementFeed>('achievements.feed', { offset: items.length, limit: PAGE });
      setItems((cur) => {
        const merged = mergeFeed(cur, feed.items);
        loaded.current = merged.length;
        return merged;
      });
      setState((s) => (s.kind === 'ready' ? { ...s, feed: { ...s.feed, total: feed.total, hasMore: feed.hasMore } } : s));
    } catch (err) {
      useStore.getState().toast({ tone: 'danger', title: 'Couldn’t load more achievements', body: errorMessage(err) });
    } finally {
      setLoadingMore(false);
    }
  }, [state.kind, items.length]);

  useEffect(() => {
    void load();
    const offs = [
      on('achievements.unlocked', () => void load(true)),
      on('steam.achievementsUpdated', () => void load(true)),
      on('achievements.iconsReady', () => void load(true)),
    ];
    return () => offs.forEach((off) => off());
  }, [load]);

  return { state, items, more, loadingMore, reload: load };
}

/** Steam achievements across every game: unlocks grouped by day, and the games closest to 100%. */
export function AchievementTimeline() {
  const { state, items, more, loadingMore, reload } = useAchievementData();
  const gamesById = useStore((s) => s.gamesById);

  if (state.kind === 'loading') return <TimelineSkeleton />;
  if (state.kind === 'error')
    return (
      <EmptyState
        art="none"
        icon={<AlertTriangle size={30} />}
        title="Achievements couldn’t be loaded"
        body={state.message}
        actions={<Button icon={<RefreshCw size={15} />} onClick={() => void reload()}>Try again</Button>}
      />
    );

  const { overview, feed } = state;
  if (overview.status !== 'ok' && items.length === 0) return <TimelineEmpty status={overview.status} />;

  return (
    <div className="at">
      <div className="vx-tiles at-tiles">
        <StatTile icon={<Trophy size={13} />} label="Unlocked" value={<span className="num">{overview.totalUnlocked.toLocaleString()}</span>} sub={`Across ${plural(overview.gamesWithData, 'Steam game')}`} />
        <StatTile icon={<Gem size={13} />} label="Rare" value={<span className="num">{overview.rare.toLocaleString()}</span>} sub="Unlocked by 5% of players or fewer" />
        <StatTile icon={<Sparkles size={13} />} label="Ultra rare" value={<span className="num">{overview.ultraRare.toLocaleString()}</span>} sub="1% of players or fewer" />
        <StatTile icon={<Target size={13} />} label="Nearly done" value={<span className="num">{overview.nearCompletion.length.toLocaleString()}</span>} sub="Games at 70% or more" />
      </div>

      <p className="at-source">
        From Steam, through your own Web API key{overview.lastFetched ? ` · updated ${formatRelative(overview.lastFetched).toLowerCase()}` : ''}. Rarity is the share of all Steam players who unlocked it.
        {overview.message && <> {overview.message}</>}
      </p>

      <NearCompletionShelf list={overview.nearCompletion} gamesById={gamesById} />

      <section className="surface vx-card" aria-labelledby="at-feed-title">
        <SectionHead
          title={<span id="at-feed-title">Unlock timeline</span>}
          meta={feed.total > 0 ? `${plural(feed.total, 'unlock')} with a date · newest first` : undefined}
        />
        {items.length === 0 ? (
          <p className="at-muted">Steam hasn’t reported any unlocks with a date yet.</p>
        ) : (
          <FeedList items={items} gamesById={gamesById} />
        )}
        {feed.hasMore && (
          <div className="at-more">
            <Button onClick={() => void more()} loading={loadingMore}>Show more</Button>
            <span className="at-muted num">{(feed.total - items.length).toLocaleString()} earlier</span>
          </div>
        )}
      </section>
    </div>
  );
}

function NearCompletionShelf({ list, gamesById }: { list: NearCompletion[]; gamesById: Map<string, Game> }) {
  const sorted = useMemo(() => sortNearCompletion(list), [list]);
  const reduce = useReducedMotion();
  return (
    <section className="surface vx-card" aria-labelledby="at-near-title">
      <SectionHead title={<span id="at-near-title">Nearly complete</span>} meta="Steam games at 70% or more, closest first" />
      {sorted.length === 0 ? (
        <p className="at-muted">No game is at 70% yet. Games appear here once most of their achievements are unlocked.</p>
      ) : (
        <ul className="at-near-list">
          {sorted.map((n, i) => {
            const game = n.gameId ? gamesById.get(n.gameId) : undefined;
            const label = `${n.gameTitle}: ${n.unlocked} of ${n.total} unlocked, ${plural(n.remaining, 'achievement')} left${
              n.rarestRemainingPercent != null ? `. Rarest left: ${n.rarestRemainingName ?? 'a hidden achievement'}, ${formatPercent(n.rarestRemainingPercent)} of players` : ''
            }`;
            const body = (
              <>
                <GameThumb game={game} size={40} />
                <span className="at-near__body">
                  <span className="at-near__title truncate">{n.gameTitle}</span>
                  <span className="at-near__left">
                    <strong className="num">{n.remaining}</strong> left <span className="at-muted num">· {n.unlocked}/{n.total}</span>
                  </span>
                  {n.rarestRemainingPercent != null && (
                    <span className="at-near__rarest" title={n.rarestRemainingHidden ? 'Hidden achievements stay secret until you unlock them.' : undefined}>
                      {n.rarestRemainingHidden ? <EyeOff size={11} aria-hidden /> : <Gem size={11} aria-hidden />}
                      <span className="truncate">{n.rarestRemainingName ?? 'Hidden achievement'}</span>
                      <span className="num">{formatPercent(n.rarestRemainingPercent)}</span>
                    </span>
                  )}
                </span>
                <ProgressRing fraction={n.fraction} size={46} stroke={4} label={`${Math.round(n.fraction * 100)}% complete`} tone={n.remaining <= 3 ? 'ok' : 'accent'} />
              </>
            );
            return (
              <motion.li
                key={n.appId}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...spring.panel, delay: reduce ? 0 : Math.min(i, 10) * 0.035 }}
              >
                {game ? (
                  <button type="button" className="at-near" aria-label={label} onClick={() => useStore.getState().navigate({ name: 'game', id: game.id })}>
                    {body}
                  </button>
                ) : (
                  <div className="at-near">{body}</div>
                )}
              </motion.li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function FeedList({ items, gamesById }: { items: AchievementFeedItem[]; gamesById: Map<string, Game> }) {
  const days = useMemo(() => groupFeedByDay(items), [items]);
  const reduce = useReducedMotion();
  const now = Date.now();
  // Track K: unlocks you haven't seen here before shimmer once, tinted by rarity.
  const [since] = useState(() => takeLastSeen('timeline'));
  let index = 0;
  let fresh = 0;
  return (
    <div className="at-days">
      {days.map((d) => (
        <section key={d.dayStart} className="at-day" aria-label={`${dayLabel(d.dayStart, now)}, ${plural(d.items.length, 'unlock')}`}>
          <header className="at-day__head">
            <span className="at-day__dot" aria-hidden />
            <h3>{dayLabel(d.dayStart, now)}</h3>
            <span className="at-day__meta num">
              {plural(d.items.length, 'unlock')}
              {d.rare > 0 && <> · {d.rare} rare</>}
            </span>
          </header>
          <ul className="at-day__list">
            {d.items.map((a) => {
              const i = index++;
              const isNew = isFresh(a.unlockedAt, since, now);
              const order = isNew ? fresh++ : 0;
              return (
                <motion.li
                  key={`${a.appId}/${a.apiName}`}
                  className={`at-row${isNew ? ' shimmer' : ''}`}
                  data-rarity={rarity(a.globalPercent) ?? undefined}
                  data-tier={isNew ? shimmerTier(a.globalPercent) : undefined}
                  data-new={isNew || undefined}
                  style={isNew ? { ['--shimmer-delay' as string]: `${0.35 + Math.min(order, 8) * 0.14}s` } : undefined}
                  initial={reduce || i > 30 ? false : { opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ ...spring.panel, delay: reduce ? 0 : Math.min(i, 30) * 0.02 }}
                >
                  <FeedRow a={a} game={a.gameId ? gamesById.get(a.gameId) : undefined} />
                </motion.li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function FeedRow({ a, game }: { a: AchievementFeedItem; game: Game | undefined }) {
  const tier = rarity(a.globalPercent);
  const at = Date.parse(a.unlockedAt);
  return (
    <>
      <span className="at-row__icon" aria-hidden>
        {a.icon ? <img src={a.icon} alt="" loading="lazy" decoding="async" draggable={false} /> : <Trophy size={18} />}
      </span>
      <span className="at-row__main">
        <span className="at-row__name">
          <span className="at-row__title">{a.name}</span>
          {tier === 'ultra' && <span className="at-badge at-badge--ultra"><Sparkles size={11} aria-hidden />Ultra rare</span>}
          {tier === 'rare' && <span className="at-badge at-badge--rare"><Gem size={11} aria-hidden />Rare</span>}
        </span>
        {a.description && <span className="at-row__desc">{a.description}</span>}
        <span className="at-row__meta">
          {game ? (
            <button type="button" className="at-row__game" onClick={() => useStore.getState().navigate({ name: 'game', id: game.id })}>
              <GameThumb game={game} size={14} />
              <span className="truncate">{a.gameTitle}</span>
            </button>
          ) : (
            <span className="at-row__game at-row__game--plain truncate">{a.gameTitle}</span>
          )}
          {Number.isFinite(at) && <time className="num" dateTime={a.unlockedAt}>{timeOfDay(at)}</time>}
        </span>
      </span>
      {a.globalPercent != null && (
        <span className="at-row__rarity" title={`${formatPercent(a.globalPercent)} of Steam players unlocked this`}>
          <span className="at-row__pct num">{formatPercent(a.globalPercent)}</span>
          <span className="at-row__bar" aria-hidden>
            <span style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, a.globalPercent / 100))})` }} />
          </span>
          <span className="visually-hidden">of players</span>
        </span>
      )}
    </>
  );
}

function TimelineEmpty({ status }: { status: AchievementOverview['status'] }) {
  const navigate = useStore((s) => s.navigate);
  if (status === 'notConnected')
    return (
      <EmptyState
        icon={<KeyRound size={30} />}
        title="Connect Steam to see your achievement timeline"
        body="VYSTRAL reads achievements with your own free Steam Web API key. Add it in Settings › Library & stores; it stays in Windows Credential Manager on this PC and VYSTRAL only talks to api.steampowered.com. Other stores don’t share achievements, so they aren’t included."
        actions={<Button variant="primary" onClick={() => navigate({ name: 'settings', section: 'library' })}>Set up in Settings</Button>}
      />
    );
  if (status === 'localOnly')
    return (
      <EmptyState
        icon={<CloudOff size={30} />}
        title="Offline mode is on"
        body="VYSTRAL isn’t contacting Steam, and no achievements are saved on this PC yet. Turn off Offline mode to fetch them."
        actions={<Button onClick={() => navigate({ name: 'settings', section: 'privacy' })}>Privacy settings</Button>}
      />
    );
  return (
    <EmptyState
      art="trophy"
      icon={<Award size={30} />}
      title="No achievements yet"
      body="Steam hasn’t reported any unlocked achievements for your games yet. VYSTRAL refreshes played games in the background every few hours, and checks again right after each Steam session you start from VYSTRAL."
      actions={<Button onClick={() => navigate({ name: 'settings', section: 'library' })}>Steam settings</Button>}
    />
  );
}

function TimelineSkeleton() {
  return (
    <div className="at" role="status" aria-label="Loading achievements">
      <div className="vx-tiles">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} height={96} radius={16} />
        ))}
      </div>
      <Skeleton height={150} radius={22} />
      <div className="surface vx-card" style={{ display: 'grid', gap: 12 }}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Skeleton width={44} height={44} radius={10} />
            <div style={{ display: 'grid', gap: 6, flex: 1 }}>
              <Skeleton width="40%" height={13} />
              <Skeleton width="70%" height={11} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
