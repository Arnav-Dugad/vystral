import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle, ArrowLeft, Check, Cloud, CloudOff, Compass, ExternalLink, Eye, Info, LibraryBig,
  RefreshCw, ShoppingBag, Tag, TrendingDown,
} from 'lucide-react';
import { call, errorMessage } from '../bridge/bridge';
import type { Deals, DiscoverDetails, DiscoverLink } from '../bridge/types';
import { noteText, SOURCE_NAMES } from '../lib/discover';
import { useMoney } from '../state/money'; // Track D6
import { Price } from '../components/ui/Price';
import { formatDate, formatRelative, PLATFORM_NAMES } from '../lib/format';
import { ease, spring } from '../lib/motion';
import { captureFlight, useFlightLanding } from '../lib/flight';
import { useDiscoverImage } from '../state/discover';
import { useReducedMotion, useStore } from '../state/store';
import { Badge, Button, EmptyState, PlatformBadge, Skeleton } from '../components/ui/primitives';
import { StoreLogo } from '../components/ui/StoreLogo';
import { ServiceLogo } from '../components/ui/ServiceLogo';
import { Menu, type MenuEntry } from '../components/ui/Menu';
import { HeroTrailer } from '../components/game/HeroTrailer';
import { DiscoverCover, pseudoGame } from '../components/discover/DiscoverBits';
import './detail.css';
import '../components/game/game-data.css';
import './discover-game.css';
import { CommunityTags, DiscoverInsights, FranchiseTimeline } from '../components/game/insights/lazy'; // Track C4

const openExternal = (method: string, params: Record<string, unknown>) => () => {
  void call(method, params).catch((err) => useStore.getState().toast({ tone: 'info', title: errorMessage(err) }));
};

/**
 * Track U: the page for a game that isn't in your library — art, trailer, details, time to beat, compatibility,
 * prices, cloud availability and where to get it. Everything opens in your browser; nothing is installed or launched.
 */
export function DiscoverGameView({ itemKey, title: hint }: { itemKey: string; title?: string }) {
  const [details, setDetails] = useState<DiscoverDetails | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const seq = useRef(0);
  const offline = useStore((s) => !!s.settings?.['privacy.localOnly']);

  const load = useCallback(async (refresh = false) => {
    const mine = ++seq.current;
    try {
      const d = await call<DiscoverDetails>('discover.details', { key: itemKey, refresh }, 60_000);
      if (mine !== seq.current) return;
      setDetails(d);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      const code = (err as { code?: string }).code ?? 'unavailable';
      setError({ code, message: errorMessage(err) });
    }
  }, [itemKey]);

  useEffect(() => { void load(); }, [load, offline]);

  if (error && !details) {
    return (
      <div className="detail ddetail">
        <HeroShell itemKey={itemKey} title={hint ?? 'This game'} />
        <div className="page">
          <EmptyState
            art="none"
            icon={error.code === 'offline' ? <CloudOff size={32} /> : <AlertTriangle size={32} />}
            title={error.code === 'offline' ? 'Offline mode is on' : 'This game couldn’t be looked up'}
            body={error.message}
            actions={error.code === 'offline'
              ? <Button onClick={() => useStore.getState().navigate({ name: 'settings', section: 'privacy' })}>Privacy settings</Button>
              : <Button icon={<RefreshCw size={14} />} onClick={() => void load(true)}>Try again</Button>}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="detail ddetail">
      <Hero itemKey={itemKey} hint={hint} d={details} onChange={setDetails} />
      <div className="page detail__body">
        {details ? <Body d={details} onRefresh={() => load(true)} /> : <BodySkeleton />}
      </div>
    </div>
  );
}

/** While the details load (or failed): the art we may already have, the title, the back button. */
function HeroShell({ itemKey, title }: { itemKey: string; title: string }) {
  const goBack = useStore((s) => s.goBack);
  return (
    <section className="dhero ddhero">
      <div className="dhero__art"><DiscoverCover itemKey={itemKey} title={title} kind="hero" eager /></div>
      <div className="dhero__scrim" />
      <div className="dhero__top ddhero__top">
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={16} />} onClick={goBack} className="dhero__back">Back</Button>
        <RouteMarker owned={false} />
      </div>
      <div className="dhero__content"><div className="dhero__info"><h1 className="dhero__title">{title}</h1></div></div>
    </section>
  );
}

function RouteMarker({ owned }: { owned: boolean }) {
  return (
    <span className="ddhero__route" data-owned={owned || undefined}>
      <Compass size={14} aria-hidden />
      <span>Discover</span>
      <span className="ddhero__route-sep" aria-hidden>·</span>
      <span>{owned ? 'In your library' : 'Not in your library'}</span>
    </span>
  );
}

function Hero({ itemKey, hint, d, onChange }: { itemKey: string; hint?: string; d: DiscoverDetails | null; onChange: (d: DiscoverDetails) => void }) {
  const goBack = useStore((s) => s.goBack);
  const navigate = useStore((s) => s.navigate);
  const toast = useStore((s) => s.toast);
  const owned = useStore((s) => (d?.libraryGameId ? s.gamesById.get(d.libraryGameId) ?? null : null));
  const reduce = useReducedMotion();
  const coverRef = useRef<HTMLDivElement>(null);
  const getRef = useRef<HTMLButtonElement>(null);
  const [getAt, setGetAt] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const flightId = `discover:${itemKey}`;
  useFlightLanding(flightId, coverRef, true, 0, reduce); // Track D5: reduced motion crossfades
  // Track D5: the return flight starts the moment the route changes (the card mounts before this page finishes leaving).
  useEffect(() => useStore.subscribe((s, prev) => {
    if (s.route === prev.route) return;
    const r = s.route;
    if (r.name !== 'discoverGame' || r.key !== itemKey) captureFlight(flightId, coverRef.current);
  }), [flightId, itemKey]);

  const title = d?.title ?? hint ?? '';
  const logo = useDiscoverImage(d?.hasLogo ? itemKey : null, 'logo');
  const trailerGame = useMemo(() => (d?.trailerId ? pseudoGame(d.trailerId, title, {}, d.genres) : null), [d?.trailerId, title, d?.genres]);
  const stores = d?.links.filter((l) => l.kind === 'store') ?? [];
  const info = d?.links.filter((l) => l.kind === 'info') ?? [];

  const watch = async () => {
    if (!d) return;
    setBusy(true);
    try {
      await call('discover.watch', { key: itemKey, on: !d.watching });
      onChange({ ...d, watching: !d.watching });
      toast(d.watching
        ? { tone: 'info', title: `Stopped watching ${d.title}` }
        : { tone: 'success', title: `Watching ${d.title}`, body: 'It’s on your Watching list in Discover. Prices are checked when you open its page; nothing runs in the background.' });
    } catch (err) {
      toast({ tone: 'warning', title: 'Couldn’t update Watching', body: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const linkEntry = (l: DiscoverLink): MenuEntry => ({
    label: l.kind === 'store' ? `${l.label} store page` : `${l.label} page`,
    icon: l.platform ? <StoreLogo platform={l.platform} size={16} decorative /> : l.id === 'igdb' || l.id === 'rawg' || l.id === 'wikidata' ? <ServiceLogo service={l.id} size={16} decorative /> : <ExternalLink size={16} />,
    onSelect: openExternal('discover.openLink', { key: itemKey, link: l.id }),
  });
  const getEntries: MenuEntry[] = [
    { kind: 'label', label: 'Opens in your browser' },
    ...stores.map(linkEntry),
    ...(info.length ? [{ kind: 'separator' } as MenuEntry, ...info.map(linkEntry)] : []),
  ];

  return (
    <section className="dhero ddhero" aria-label={title}>
      <motion.div className="dhero__art" initial={reduce ? false : { opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.9, ease: ease.cinematic }}>
        <DiscoverCover itemKey={itemKey} title={title} kind="hero" eager genres={d?.genres} />
        {trailerGame && <HeroTrailer game={trailerGame} active />}
      </motion.div>
      <div className="dhero__scrim" />
      <div className="dhero__top ddhero__top">
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={16} />} onClick={goBack} className="dhero__back">Back</Button>
        <RouteMarker owned={!!owned} />
      </div>
      <motion.div className="dhero__content" initial={reduce ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.hero, delay: 0.05 }}>
        <div className="dhero__cover" ref={coverRef} data-discover-key={itemKey}>
          <DiscoverCover itemKey={itemKey} title={title} eager genres={d?.genres} />
        </div>
        <div className="dhero__info">
          {logo.url ? <img className="dhero__logo" src={logo.url} alt={title} /> : <h1 className="dhero__title">{title}</h1>}
          {logo.url && <h1 className="visually-hidden">{title}</h1>}
          <div className="dhero__badges">
            {(d?.stores ?? []).map((p) => <PlatformBadge key={p} platform={p} />)}
            {(d?.genres ?? []).slice(0, 3).map((g) => <Badge key={g}>{g}</Badge>)}
          </div>
          <div className="dhero__status" role="status">
            {owned ? <LibraryBig size={15} aria-hidden /> : <Info size={15} aria-hidden />}
            <span>
              {owned ? 'In your library' : 'Not in your library'}
              {d?.releaseDate ? ` · ${new Date(d.releaseDate) > new Date() ? 'Coming' : 'Released'} ${formatDate(d.releaseDate)}` : d?.year ? ` · ${d.year}` : ''}
              {d?.developers.length ? ` · ${d.developers[0]}` : ''}
            </span>
          </div>
          <div className="dhero__actions">
            {owned && (
              <Button variant="primary" size="lg" icon={<LibraryBig size={18} />} onClick={() => navigate({ name: 'game', id: owned.id })}>Open in your library</Button>
            )}
            {stores.length > 0 && (
              <Button
                ref={getRef}
                variant={owned ? 'secondary' : 'primary'}
                size="lg"
                icon={<ShoppingBag size={18} />}
                aria-haspopup="menu"
                onClick={() => { const r = getRef.current!.getBoundingClientRect(); setGetAt({ x: r.left, y: r.bottom + 6 }); }}
                autoFocus
              >
                Where to get it
              </Button>
            )}
            {d && !owned && (
              <Button variant="secondary" size="lg" loading={busy} aria-pressed={d.watching} icon={d.watching ? <Check size={18} /> : <Eye size={18} />} onClick={() => void watch()}>
                {d.watching ? 'Watching' : 'Watch price'}
              </Button>
            )}
          </div>
        </div>
      </motion.div>
      <Menu at={getAt} entries={getEntries} onClose={() => setGetAt(null)} label="Where to get it" />
    </section>
  );
}

function BodySkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading details">
      <div className="stats-row">{[0, 1, 2, 3].map((i) => <div key={i} className="stat"><Skeleton height={12} width="50%" /><Skeleton height={24} width="70%" /></div>)}</div>
      <div className="overview" style={{ marginTop: 'var(--s-8)' }}>
        <div><Skeleton height={18} /><Skeleton height={18} width="92%" /><Skeleton height={18} width="70%" /></div>
        <div className="surface" style={{ padding: 'var(--s-5)', display: 'grid', gap: 10 }}><Skeleton height={14} width="40%" /><Skeleton height={14} /><Skeleton height={14} width="60%" /></div>
      </div>
    </div>
  );
}

function Body({ d, onRefresh }: { d: DiscoverDetails; onRefresh: () => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  const notes = d.notes.map(noteText).filter((n): n is string => !!n);
  return (
    <>
      {/* Track C4: the same "At a glance" tiles as a library game page, each with its source. */}
      <DiscoverInsights d={d} />

      {(notes.length > 0 || d.reason === 'offline') && (
        <ul className="ddetail__notes" aria-label="About these details">
          {d.reason === 'offline' && <li><CloudOff size={14} aria-hidden /> Offline mode is on: showing what VYSTRAL found earlier.</li>}
          {notes.map((n) => <li key={n}><Info size={14} aria-hidden /> {n}</li>)}
        </ul>
      )}

      <div className="overview ddetail__overview">
        <div className="ddetail__main">
          {d.description
            ? <p className="overview__desc">{d.description}</p>
            : <p className="overview__desc ddetail__muted">None of the connected sources has a description for this game.</p>}
          {d.descriptionSource && <p className="provenance">Description from {SOURCE_NAMES[d.descriptionSource]}{d.descriptionSource === 'steam' ? ' (the store page)' : ''}.</p>}

          {d.steamAppId && <CommunityTags params={{ key: d.key, appId: d.steamAppId }} cacheKey={d.key} />}
          <CloudRow d={d} />
          {d.steamAppId && <DealsCard itemKey={d.key} />}
        </div>

        <aside className="overview__side surface ddetail__side" aria-label="Details">
          <dl className="facts">
            {d.developers.length > 0 && <Fact label={d.developers.length > 1 ? 'Developers' : 'Developer'} value={d.developers.join(', ')} />}
            {d.publishers.length > 0 && <Fact label={d.publishers.length > 1 ? 'Publishers' : 'Publisher'} value={d.publishers.join(', ')} />}
            {d.platforms.length > 0 && <Fact label="Platforms" value={d.platforms.join(', ')} />}
            {d.genres.length > 0 && <Fact label="Genres" value={d.genres.join(', ')} />}
            {d.stores.length > 0 && <Fact label="Sold on" value={d.stores.map((s) => PLATFORM_NAMES[s]).join(', ')} />}
          </dl>
          <WhereToGet d={d} />
          <div className="ddetail__credits">
            {d.credits.map((c) => (
              <p key={c.id} className="provenance">
                {c.id === 'steam' ? <StoreLogo platform="steam" size={12} decorative /> : <ServiceLogo service={c.id} size={12} decorative />}
                {c.id === 'rawg'
                  ? <>Data from <button className="gx-link" onClick={openExternal('dataSources.openLink', { provider: 'rawg', link: 'home' })}>RAWG.io <ExternalLink size={11} aria-hidden /></button></>
                  : c.note}
              </p>
            ))}
            <p className="provenance">
              Looked up {formatRelative(d.fetched).toLowerCase()} ·{' '}
              <button className="gx-link" disabled={refreshing || d.reason === 'offline'} onClick={async () => { setRefreshing(true); await onRefresh(); setRefreshing(false); }}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </p>
          </div>
        </aside>
      </div>
      <FranchiseTimeline params={{ key: d.key, appId: d.steamAppId }} cacheKey={d.key} />
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="caps">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function WhereToGet({ d }: { d: DiscoverDetails }) {
  const stores = d.links.filter((l) => l.kind === 'store');
  const info = d.links.filter((l) => l.kind === 'info');
  return (
    <section className="ddetail__get" aria-labelledby="dd-get">
      <h2 id="dd-get" className="caps">Where to get it</h2>
      {stores.length === 0 && <p className="ddetail__muted">No official store page is known for this game yet.</p>}
      <ul className="ddetail__links">
        {stores.map((l) => (
          <li key={l.id}>
            <button className="ddetail__link" onClick={openExternal('discover.openLink', { key: d.key, link: l.id })} aria-label={`${l.label} store page. Opens in your browser.`}>
              {l.platform ? <StoreLogo platform={l.platform} size={18} decorative motion /> : <ShoppingBag size={18} aria-hidden />}
              <span>{l.label}</span>
              <ExternalLink size={13} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {info.length > 0 && (
        <p className="ddetail__info">
          Also on{' '}
          {info.map((l, i) => (
            <span key={l.id}>
              {i > 0 && ', '}
              <button className="gx-link" onClick={openExternal('discover.openLink', { key: d.key, link: l.id })}>{l.label} <ExternalLink size={11} aria-hidden /></button>
            </span>
          ))}
        </p>
      )}
      <p className="provenance">Store pages open in your browser. VYSTRAL never buys, installs or launches anything from here.</p>
    </section>
  );
}

function CloudRow({ d }: { d: DiscoverDetails }) {
  const navigate = useStore((s) => s.navigate);
  if (d.cloud.length > 0) {
    return (
      <section className="ddetail__cloud" aria-label="Cloud play">
        {d.cloud.map((c) => (
          <div key={c.service} className="ddetail__cloud-item surface">
            <ServiceLogo service={c.service === 'gfn' ? 'geforce-now' : 'xbox-cloud'} size={20} decorative />
            <div>
              <strong>Streamable on {c.serviceName}</strong>
              {c.match === 'title' && <Badge>Likely match</Badge>}
              <p>{c.note}</p>
            </div>
          </div>
        ))}
      </section>
    );
  }
  if (d.cloudReason === 'off') {
    return (
      <p className="ddetail__muted ddetail__cloud-off">
        <Cloud size={14} aria-hidden /> Turn on cloud play to see whether GeForce NOW or Xbox Cloud Gaming lists it.{' '}
        <button className="gx-link" onClick={() => navigate({ name: 'settings', section: 'cloud' })}>Cloud play settings</button>
      </p>
    );
  }
  if (d.cloudReason === 'none') return <p className="ddetail__muted ddetail__cloud-off"><Cloud size={14} aria-hidden /> Not listed on GeForce NOW or Xbox Cloud Gaming in your region.</p>;
  return null;
}

function DealsCard({ itemKey }: { itemKey: string }) {
  const money = useMoney(); // Track D6: every price in the chosen currency
  const settingsKey = useStore((s) => `${s.settings?.['dataSources.cheapshark']}${s.settings?.['privacy.localOnly']}${s.settings?.['dataSources.priceCountry']}`);
  const [data, setData] = useState<Deals | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (refresh = false) => {
    try {
      setData(await call<Deals>('discover.deals', { key: itemKey, refresh }, 60_000));
      setFailed(false);
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  }, [itemKey]);
  useEffect(() => { void load(); }, [load, settingsKey]);
  if (!data) return failed ? null : <div className="gx-card surface"><Skeleton height={18} width="30%" /><Skeleton height={44} /></div>;
  if (data.reason === 'noSteamId' || data.reason === 'disabled' || !data.quotes.length) return null;
  return (
    <section className="gx-card surface gx-deals" aria-labelledby="dd-deals">
      <header className="gx-card__head">
        <h3 id="dd-deals"><Tag size={15} aria-hidden /> Prices and deals</h3>
        <span className="gx-card__meta">Looked up by Steam app ID · opens in your browser</span>
        <Button size="sm" variant="ghost" loading={refreshing} icon={<RefreshCw size={13} />} aria-label="Refresh prices" disabled={data.reason === 'offline'}
          onClick={async () => { setRefreshing(true); const ok = await load(true); setRefreshing(false); if (!ok) useStore.getState().toast({ tone: 'warning', title: 'Couldn’t refresh prices' }); }} />
      </header>
      {data.quotes.map((q) => {
        const best = q.offers[0];
        return (
          <div key={q.provider} className="gx-quote">
            {best ? (
              <div className="gx-quote__best">
                <div>
                  <span className="caps">Best price now</span>
                  <div className="gx-quote__price num"><Price amount={best.price} currency={q.currency} /></div>
                  <span className="gx-quote__shop">at {best.shop}{best.cut > 0 ? ` · −${best.cut}%` : ''}</span>
                </div>
                {q.historicalLow != null && (
                  <div className="gx-quote__low">
                    <span className="caps"><TrendingDown size={12} aria-hidden /> Lowest ever</span>
                    <div className="num"><Price amount={q.historicalLow} currency={q.currency} /></div>
                    {q.historicalLowAt && <span className="gx-quote__shop">{formatDate(q.historicalLowAt)}</span>}
                  </div>
                )}
              </div>
            ) : <p className="gx-pop__muted">{q.error ?? (data.reason === 'offline' ? 'Offline mode is on.' : 'No current deals listed.')}</p>}
            {q.offers.length > 0 && (
              <ul className="gx-offers">
                {q.offers.slice(0, 5).map((o) => (
                  <li key={o.id}>
                    <button className="gx-offer" onClick={openExternal('discover.openOffer', { key: itemKey, offerId: o.id })}
                      aria-label={`${o.shop}: ${money.label(o.price, q.currency)}${o.cut ? `, ${o.cut}% off` : ''}. Opens in your browser.`}>
                      <span>{o.shop}</span>
                      {o.cut > 0 && <Badge tone="ok">−{o.cut}%</Badge>}
                      <Price amount={o.price} currency={q.currency} />
                      <ExternalLink size={12} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="gx-attrib">
              Prices from <button className="gx-link" onClick={openExternal('dataSources.openLink', { provider: q.provider, link: 'home' })}>{q.provider === 'itad' ? 'IsThereAnyDeal.com' : 'CheapShark.com'} <ExternalLink size={11} aria-hidden /></button>
              {q.currency && (q.currency === money.target ? ` · ${q.currency}` : ` · ${q.currency}, shown in ${money.target} (approximate)`)}
              {q.fetched && ` · as of ${formatRelative(q.fetched).toLowerCase()}`}
              {q.stale && ' · couldn’t refresh, showing the last prices'}
            </p>
          </div>
        );
      })}
    </section>
  );
}

