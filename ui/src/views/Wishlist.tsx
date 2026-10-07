import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle, CalendarClock, CloudOff, ExternalLink, Gift, KeyRound, Library, RefreshCw, Search, ShieldAlert, Sparkles, TrendingDown, UserX,
} from 'lucide-react';
import { call, errorMessage, on } from '../bridge/bridge';
import type { Wishlist, WishlistItem, WishlistRefreshResult } from '../bridge/types';
import { formatRelative } from '../lib/format';
import { spring } from '../lib/motion';
import { titleHue } from '../lib/palette';
import {
  filterWishlist, formatMoney, priceVerdict, releaseBadge, releaseLabel, sortWishlist, wishlistSummary, type WishlistFilter, type WishlistSort,
} from '../lib/wishlist';
import { useReducedMotion, useStore } from '../state/store';
import { Badge, Button, EmptyState, IconButton, Segmented, Skeleton } from '../components/ui/primitives';
import { PriceSparkline } from './wishlist/PriceSparkline';
import './wishlist/wishlist.css';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; data: Wishlist };

const SORTS: { value: WishlistSort; label: string }[] = [
  { value: 'priority', label: 'Your order' },
  { value: 'drop', label: 'Price drop' },
  { value: 'release', label: 'Release date' },
  { value: 'added', label: 'Date added' },
];

const SORT_KEY = 'vystral.wishlist.sort';

function readSort(): WishlistSort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return SORTS.some((s) => s.value === v) ? (v as WishlistSort) : 'priority';
  } catch {
    return 'priority';
  }
}

/**
 * Track W: the Steam wishlist (opt-in, Settings → Library & stores → Steam extras). Read natively with the
 * user's own key; prices from Steam's store in the price country; the lowest price ever from
 * IsThereAnyDeal (with the user's key) or CheapShark; price history is what VYSTRAL has recorded itself.
 */
export function WishlistView() {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const enabled = useStore((s) => s.settings?.['wishlist.sync'] ?? false);
  const localOnly = useStore((s) => s.settings?.['privacy.localOnly'] ?? false);
  const toast = useStore((s) => s.toast);

  // Only the newest answer counts (a settings change and an event can ask at the same time).
  const seq = useRef(0);
  const load = useCallback(async (quiet = false) => {
    const mine = ++seq.current;
    if (!quiet) setState((s) => (s.kind === 'done' ? s : { kind: 'loading' }));
    try {
      const data = await call<Wishlist>('wishlist.get');
      if (mine === seq.current) setState({ kind: 'done', data });
    } catch (err) {
      if (!quiet && mine === seq.current) setState({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void load();
    return on('wishlist.changed', () => void load(true));
  }, [load, enabled, localOnly]);

  // The first look after turning it on starts a refresh (the native side decides whether it may).
  const data = state.kind === 'done' ? state.data : null;
  useEffect(() => {
    if (data?.status === 'notLoaded' && !data.refreshing) void call<WishlistRefreshResult>('wishlist.refresh').then((r) => setState({ kind: 'done', data: r.wishlist })).catch(() => {});
  }, [data?.status, data?.refreshing]);

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await call<WishlistRefreshResult>('wishlist.refresh');
      setState({ kind: 'done', data: r.wishlist });
      if (!r.started && r.reason === 'recent') toast({ tone: 'info', title: 'Checked a moment ago', body: 'VYSTRAL asks Steam again in a couple of minutes.' });
      else if (!r.started && r.reason === 'gameRunning') toast({ tone: 'info', title: 'Waiting for your game to close', body: 'VYSTRAL doesn’t contact Steam while a game is running.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t refresh the wishlist', body: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page wish">
      <header className="wish__head">
        <div className="wish__head-text">
          <span className="caps wish__eyebrow"><Gift size={13} aria-hidden /> Steam</span>
          <h1 className="wish__title">Wishlist</h1>
          <p className="wish__lede">Games you’ve wishlisted on Steam, with today’s price, the lowest price ever and when they come out.</p>
        </div>
        {data && data.status !== 'off' && data.status !== 'notConnected' && (
          <div className="wish__tools">
            {data.fetchedAt && (
              <span className="wish__when" data-stale={data.stale || undefined}>
                {data.refreshing ? 'Updating…' : `${data.stale ? 'Last updated' : 'Updated'} ${formatRelative(data.fetchedAt).toLowerCase()}`}
              </span>
            )}
            <Button size="sm" variant="ghost" icon={<RefreshCw size={14} className={data.refreshing || busy ? 'wish__spin' : undefined} />}
              disabled={busy || data.refreshing || localOnly} onClick={() => void refresh()}>
              Refresh
            </Button>
          </div>
        )}
      </header>
      {state.kind === 'loading' && <WishlistSkeleton />}
      {state.kind === 'error' && (
        <EmptyState art="none" icon={<AlertTriangle size={30} />} title="The wishlist couldn’t be loaded" body={state.message}
          actions={<Button icon={<RefreshCw size={15} />} onClick={() => void load()}>Try again</Button>} />
      )}
      {data && <WishlistBody data={data} busy={busy} onRetry={() => void refresh()} onReload={() => void load()} />}
    </div>
  );
}

function WishlistBody({ data, busy, onRetry, onReload }: { data: Wishlist; busy: boolean; onRetry: () => void; onReload: () => void }) {
  const navigate = useStore((s) => s.navigate);
  const setSetting = useStore((s) => s.setSetting);
  const toSettings = (section: string) => navigate({ name: 'settings', section });
  const retry = data.retryAt ? `VYSTRAL tries again ${formatRelative(data.retryAt).toLowerCase()}.` : '';

  switch (data.status) {
    case 'off':
      return (
        <EmptyState
          art="shelf"
          icon={<Gift size={30} />}
          title="Bring your Steam wishlist into VYSTRAL"
          body="See what’s on sale, which games just came out and the lowest price each one has ever had, next to your library. VYSTRAL reads your own wishlist with your Steam Web API key; nothing is shared."
          actions={<>
            <Button variant="primary" icon={<Gift size={15} />} onClick={() => void Promise.resolve(setSetting('wishlist.sync', true)).then(onReload)}>Show my wishlist</Button>
            <Button variant="ghost" onClick={() => toSettings('library')}>Settings</Button>
          </>}
        />
      );
    case 'notConnected':
      return (
        <EmptyState
          icon={<KeyRound size={30} />}
          title="Connect Steam to see your wishlist"
          body="Add your own free Steam Web API key in Settings. It stays in Windows Credential Manager on this PC, and VYSTRAL only talks to Steam with it."
          actions={<Button variant="primary" onClick={() => toSettings('library')}>Set up in Settings</Button>}
        />
      );
    case 'noAccount':
      return <EmptyState icon={<UserX size={30} />} title="No Steam account found on this PC" body={data.message ?? 'Sign in to Steam once on this PC, then come back.'} />;
    case 'offline':
      return (
        <EmptyState icon={<CloudOff size={30} />} title="Offline mode is on" body="VYSTRAL isn’t contacting Steam, and no wishlist was saved on this PC yet."
          actions={<Button onClick={() => toSettings('privacy')}>Privacy settings</Button>} />
      );
    case 'invalidKey':
      return (
        <EmptyState art="none" icon={<ShieldAlert size={30} />} title="Steam didn’t accept your key" body={`${data.message ?? ''} ${retry}`.trim()}
          actions={<Button onClick={() => toSettings('library')}>Check the key</Button>} />
      );
    case 'unavailable':
    case 'rateLimited':
      return (
        <EmptyState art="none" icon={<AlertTriangle size={30} />} title={data.status === 'rateLimited' ? 'Steam asked VYSTRAL to slow down' : 'Steam didn’t answer'}
          body={`${data.message ?? 'Try again in a little while.'} ${retry}`.trim()}
          actions={<Button icon={<RefreshCw size={15} />} loading={busy} onClick={onRetry}>Try again</Button>} />
      );
    case 'notLoaded':
      return <WishlistSkeleton label="Reading your wishlist from Steam…" />;
    case 'empty':
      return <EmptyState art="shelf" icon={<Gift size={30} />} title="Your wishlist is empty" body={data.message ?? 'Games you wishlist on Steam appear here.'} />;
    default:
      return <WishlistList data={data} />;
  }
}

function WishlistList({ data }: { data: Wishlist }) {
  const [sort, setSortState] = useState<WishlistSort>(readSort);
  const [filter, setFilter] = useState<WishlistFilter>('all');
  const [query, setQuery] = useState('');
  const setSort = (s: WishlistSort) => {
    setSortState(s);
    try { localStorage.setItem(SORT_KEY, s); } catch { /* remembered for this visit only */ }
  };
  const summary = useMemo(() => wishlistSummary(data.items), [data.items]);
  const list = useMemo(() => sortWishlist(filterWishlist(data.items, filter, query), sort), [data.items, filter, query, sort]);
  const steamLabel = `Steam (${data.country} store)`;

  return (
    <>
      <div className="wish__stats" role="group" aria-label="Wishlist at a glance">
        <Stat label="games" value={data.count} />
        <Stat label="on sale" value={summary.onSale} tone="accent" onClick={summary.onSale ? () => setFilter('sale') : undefined} />
        <Stat label="at their lowest price ever" value={summary.atLowest} tone="ok" onClick={summary.atLowest ? () => setFilter('lowest') : undefined} />
        <Stat label="out today" value={summary.outToday} tone="warm" hideWhenZero />
        <Stat label="coming soon" value={summary.upcoming} onClick={summary.upcoming ? () => setFilter('upcoming') : undefined} />
      </div>

      {data.message && <p className="wish__note" role="status"><AlertTriangle size={14} aria-hidden /> {data.message}</p>}

      <div className="wish__toolbar">
        <Segmented label="Show" value={filter} onChange={setFilter}
          options={[{ value: 'all', label: 'All' }, { value: 'sale', label: 'On sale' }, { value: 'lowest', label: 'Lowest ever' }, { value: 'upcoming', label: 'Coming soon' }]} />
        <label className="wish__sort">
          <span className="caps">Sort</span>
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value as WishlistSort)} aria-label="Sort wishlist">
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label className="wish__search">
          <Search size={15} aria-hidden />
          <input type="search" value={query} placeholder="Search your wishlist" aria-label="Search your wishlist" maxLength={80} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      {list.length === 0 ? (
        <p className="wish__empty">{query ? `Nothing on your wishlist matches “${query}”.` : 'Nothing here right now.'}</p>
      ) : (
        <ul className="wish__list" aria-label={`${list.length} wishlisted ${list.length === 1 ? 'game' : 'games'}`}>
          {list.map((item, i) => <WishCard key={item.appId} item={item} index={i} />)}
        </ul>
      )}

      <p className="wish__sources">
        Prices from {steamLabel}. {data.lowestSource ? <>Lowest price ever from {data.lowestSource}{data.lowestSource === 'CheapShark' ? ', in US dollars' : ''}.</> : <>Add an IsThereAnyDeal key or turn on CheapShark in Settings → Data sources to see the lowest price ever.</>}{' '}
        The price lines show what VYSTRAL has seen since you turned this on. Release dates and art from Steam.
      </p>
    </>
  );
}

function Stat({ label, value, tone, onClick, hideWhenZero }: { label: string; value: number; tone?: 'accent' | 'ok' | 'warm'; onClick?: () => void; hideWhenZero?: boolean }) {
  if (hideWhenZero && value === 0) return null;
  const body = <><b className="num">{value.toLocaleString()}</b> <span>{label}</span></>;
  return onClick
    ? <button type="button" className="wish-stat" data-tone={tone} onClick={onClick}>{body}</button>
    : <span className="wish-stat" data-tone={tone}>{body}</span>;
}

function WishCard({ item, index }: { item: WishlistItem; index: number }) {
  const reduce = useReducedMotion();
  const navigate = useStore((s) => s.navigate);
  const toast = useStore((s) => s.toast);
  const badge = releaseBadge(item);
  const verdict = priceVerdict(item);
  const open = () => void call('wishlist.openStore', { appId: item.appId }).catch((err) => toast({ tone: 'info', title: errorMessage(err) }));
  const titleId = `wish-${item.appId}`;

  return (
    <motion.li
      className="wish-card surface"
      aria-labelledby={titleId}
      data-badge={badge ?? undefined}
      style={{ ['--wish-hue' as string]: titleHue(item.name) }}
      initial={reduce || index > 16 ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0.15 } : { ...spring.panel, delay: Math.min(index, 16) * 0.03 }}
    >
      <div className="wish-card__art">
        {item.header ? <img src={item.header} alt="" loading="lazy" decoding="async" draggable={false} /> : <span className="wish-card__art-blank" aria-hidden><Gift size={22} /></span>}
        {badge === 'today' && <span className="wish-card__ribbon"><Sparkles size={13} aria-hidden /> Released!</span>}
        {item.discount > 0 && <span className="wish-card__cut num">−{item.discount}%</span>}
      </div>

      <div className="wish-card__body">
        <div className="wish-card__titles">
          <h2 id={titleId} className="wish-card__title truncate" title={item.name}>{item.name}</h2>
          <span className="wish-card__release" data-soon={badge === 'soon' || undefined}>
            <CalendarClock size={13} aria-hidden /> {releaseLabel(item)}
          </span>
        </div>

        <div className="wish-card__price">
          <PriceLine item={item} />
          {verdict.atLowest ? (
            <Badge tone="ok" icon={<TrendingDown size={12} />}>{verdict.belowLowest ? 'New lowest price' : 'Lowest price ever'}</Badge>
          ) : item.lowestCents != null && item.lowestCurrency ? (
            <span className="wish-card__low">
              Lowest ever <b className="num">{formatMoney(item.lowestCents, item.lowestCurrency)}</b>
              {verdict.aboveLowest != null && verdict.aboveLowest > 0 && <span className="wish-card__above"> · {Math.round(verdict.aboveLowest * 100)}% higher now</span>}
            </span>
          ) : null}
        </div>

        <PriceSparkline item={item} />

        <div className="wish-card__actions">
          {item.gameId && (
            <Button size="sm" variant="ghost" icon={<Library size={14} />} onClick={() => navigate({ name: 'game', id: item.gameId! })}>In your library</Button>
          )}
          <IconButton label={`Open ${item.name} on the Steam store`} size="sm" onClick={open}><ExternalLink size={15} /></IconButton>
        </div>
      </div>
    </motion.li>
  );
}

function PriceLine({ item }: { item: WishlistItem }) {
  if (item.isFree) return <span className="wish-card__now">Free to play</span>;
  if (item.notSold || item.priceCents == null) return <span className="wish-card__now wish-card__now--muted">{item.comingSoon ? 'Not for sale yet' : 'No price on Steam'}</span>;
  return (
    <span className="wish-card__pricing">
      <span className="wish-card__now num">{item.priceText ?? formatMoney(item.priceCents, item.currency)}</span>
      {item.discount > 0 && item.regularCents != null && (
        <s className="wish-card__was num" aria-label={`was ${formatMoney(item.regularCents, item.currency)}`}>{formatMoney(item.regularCents, item.currency)}</s>
      )}
    </span>
  );
}

function WishlistSkeleton({ label = 'Loading your wishlist' }: { label?: string }) {
  return (
    <div className="wish__skeleton" aria-busy="true" aria-label={label}>
      {label !== 'Loading your wishlist' && <p className="wish__note" role="status"><RefreshCw size={14} className="wish__spin" aria-hidden /> {label} This can take a minute for a long wishlist.</p>}
      <div className="wish__list">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="wish-card surface">
            <Skeleton height={112} radius={12} />
            <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
              <Skeleton width="55%" height={18} />
              <Skeleton width="35%" height={12} />
              <Skeleton width="45%" height={22} />
              <Skeleton width={168} height={44} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
