import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, CalendarClock, Compass, Eye, Flame, Gift, History, KeyRound, Percent, RefreshCw, Layers, Settings2, Sparkles, Store, Tag, X,
} from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { DiscoverFeatured, DiscoverShelf as Shelf, DiscoverSimilar, DiscoverStatus, DiscoverWatch } from '../../bridge/types';
import { becauseLine, cardPrice, DISCOVER_GENRES, genreById, heroPicks, type ResultGroup } from '../../lib/discover';
import { formatDate, formatRelative, plural } from '../../lib/format';
import { useDiscoverGenre, useDiscoverShelves, useWatching, useWishlistSale, type BrowseState } from '../../state/discover';
import { useStore } from '../../state/store';
import { Button, EmptyState, IconButton } from '../ui/primitives';
import { DiscoverCover, openResult, ResultCard, ResultSkeletons } from './DiscoverBits';
import { DiscoverHero, DiscoverHeroSkeleton } from './DiscoverHero';
import { DiscoverShelf, DiscoverShelfSkeleton } from './DiscoverShelf';
import './discover-browse.css';
import { RecommendedShelf, useRanked } from '../recommend/RecommendedShelf'; // Track D5
import { FreeShelf } from '../recommend/FreeShelf'; // Track D5

const STORE_ICONS: Record<string, ReactNode> = {
  trending: <Flame size={18} aria-hidden />,
  specials: <Percent size={18} aria-hidden />,
  newReleases: <Sparkles size={18} aria-hidden />,
  comingSoon: <CalendarClock size={18} aria-hidden />,
  free: <Gift size={18} aria-hidden />,
};

/**
 * Track C3: Discover before anything is typed — featured picks, games like the ones you play, wishlist deals,
 * Steam's store shelves (opt-in), genres and tags, and what you're watching. Every row says where it comes from.
 */
export function DiscoverBrowse({ status }: { status: DiscoverStatus | null }) {
  const featured = useDiscoverShelves<DiscoverFeatured>('discover.featured');
  const similar = useDiscoverShelves<DiscoverSimilar>('discover.similar');
  const wish = useWishlistSale();
  const watching = useWatching();
  const storeOn = useStore((s) => !!s.settings?.['discover.storeShelves']);

  const storeShelves = useMemo(() => featured.data?.shelves ?? [], [featured.data]);
  const becauseShelves = useMemo(() => similar.data?.shelves ?? [], [similar.data]);
  const picks = useMemo(() => heroPicks(becauseShelves, storeShelves, wish.items), [becauseShelves, storeShelves, wish.items]);
  const heroLoading = picks.length === 0 && ((storeOn && featured.loading) || (similar.loading && !similar.data));
  const missingKeys = status?.sources.filter((s) => s.reason === 'noKey') ?? [];
  const offline = status?.reason === 'offline';

  // The calm "search for any game" state only when nothing else (rows or invitations) fills the page.
  const invited = (!offline && (!storeOn || featured.data?.state === 'off')) || similar.data?.state === 'noSource';
  const nothing = !invited && !heroLoading && picks.length === 0 && storeShelves.length === 0 && becauseShelves.length === 0 && wish.items.length === 0 &&
    !(watching && watching.length) && !featured.loading && !similar.loading;

  return (
    <div className="disc-browse">
      {picks.length > 0 ? <DiscoverHero picks={picks} /> : heroLoading ? <DiscoverHeroSkeleton /> : null}

      <GenreChips active={null} />

      {/* Track D5: every source ranked by recommend.v2, each pick with its reason. */}
      <RecommendedShelf src={{ because: becauseShelves, store: storeShelves, wishlist: wish.items, watching }} />

      {watching && watching.length > 0 && (
        <DiscoverShelf id="watching" title="Watching" icon={<Eye size={18} aria-hidden />} count={watching.length}
          reason={`${plural(watching.length, 'game')} you’re keeping an eye on. Prices are checked when you open a page.`}>
          {watching.map((w, i) => <WatchCard key={w.key} w={w} i={i} />)}
        </DiscoverShelf>
      )}

      <BecauseSection state={similar} offline={offline} />

      {wish.items.length > 0 && (
        <DiscoverShelf id="wishlist-sale" title="From your wishlist, on sale" icon={<Tag size={18} aria-hidden />} items={wish.items}
          reason="Today’s Steam prices in your price country, biggest discount first" />
      )}

      {/* Track D5: public giveaways (opt-in; an invitation while it's off). */}
      <FreeShelf place="discover" />

      <StoreSection state={featured} on={storeOn} offline={offline} />

      {nothing && (
        <EmptyState
          art="constellation"
          icon={<Compass size={32} />}
          title="Search for any game"
          body="Type a name above. You’ll see games you own first, then everything the connected sources know, with prices, time to beat and where to get it. Nothing is installed or launched from here."
        />
      )}

      {missingKeys.length > 0 && status?.reason == null && <MissingKeys names={missingKeys.map((s) => s.name)} igdb={missingKeys.some((s) => s.id === 'igdb')} />}
    </div>
  );
}

// ---------------- Because you played ----------------

function BecauseSection({ state, offline }: { state: BrowseState<DiscoverSimilar>; offline: boolean }) {
  const d = state.data;
  if (!d) return state.loading ? <DiscoverShelfSkeleton id="because" /> : state.error ? <InlineError text={state.error} onRetry={state.refresh} /> : null;
  if (d.state === 'noSource') return <BecauseInvite />;
  return (
    <>
      {d.shelves.map((s) => <RankedBecause key={s.id} shelf={s} />)}
      {state.loading && d.shelves.length === 0 && <DiscoverShelfSkeleton id="because" />}
      {d.shelves.length > 0 && d.stale && !offline && d.reason && (
        <StaleNote what="These suggestions" fetched={d.fetched} reason={d.reason} source={d.source === 'igdb' ? 'IGDB' : 'Steam'} onRetry={state.refresh} />
      )}
      {d.state === 'failed' && <InlineError text={reasonText(d.reason, d.source === 'igdb' ? 'IGDB' : 'Steam')} onRetry={state.refresh} />}
    </>
  );
}

/** Track D5: a "Because you played" row, re-ranked by recommend.v2 and without games you said "Not interested" to. */
function RankedBecause({ shelf }: { shelf: Shelf }) {
  const items = useRanked(shelf.items, shelf.seed?.gameId ?? null);
  return <DiscoverShelf id={shelf.id} title={shelf.title} items={items} icon={<History size={18} aria-hidden />} reason={becauseLine(shelf)} />;
}

function BecauseInvite() {
  const navigate = useStore((s) => s.navigate);
  const setSetting = useStore((s) => s.setSetting);
  return (
    <div className="disc-banner disc-banner--soft surface" data-invite="because">
      <History size={20} aria-hidden />
      <div>
        <strong>See games like the ones you play</strong>
        <p>“Because you played …” rows suggest games you don’t own yet, like the ones you play most. Connect your own free IGDB key, or show Steam’s store shelves to use Steam’s tags instead.</p>
      </div>
      <div className="disc-banner__actions">
        <Button size="sm" icon={<KeyRound size={14} />} onClick={() => navigate({ name: 'settings', section: 'library' })}>Connect IGDB</Button>
        <Button size="sm" variant="ghost" onClick={() => void setSetting('discover.storeShelves', true)}>Use Steam tags</Button>
      </div>
    </div>
  );
}

// ---------------- Steam store shelves ----------------

function StoreSection({ state, on, offline }: { state: BrowseState<DiscoverFeatured>; on: boolean; offline: boolean }) {
  const d = state.data;
  if (!on || d?.state === 'off') return offline ? null : <StoreInvite />;
  if (!d || (state.loading && d.shelves.length === 0 && d.state !== 'failed')) {
    if (state.error && !state.loading) return <InlineError text={state.error} onRetry={state.refresh} />;
    return <>{['trending', 'specials', 'newReleases'].map((id) => <DiscoverShelfSkeleton key={id} id={id} />)}</>;
  }
  if (d.state === 'failed') return <InlineError text={reasonText(d.reason, 'Steam')} onRetry={state.refresh} busy={state.loading} />;
  return (
    <>
      {d.shelves.map((s: Shelf) => (
        <DiscoverShelf key={s.id} id={s.id} title={s.title} items={s.items} icon={STORE_ICONS[s.id] ?? <Store size={18} aria-hidden />}
          reason={s.reason} />
      ))}
      {d.stale && !offline && d.reason && <StaleNote what="Steam’s shelves" fetched={d.fetched} reason={d.reason} source="Steam" onRetry={state.refresh} />}
      {d.shelves.length > 0 && !d.stale && d.fetched && (
        <p className="disc-credit">From Steam’s public store lists in your price country, updated {formatRelative(d.fetched).toLowerCase()}. Only games anyone can see are shown.</p>
      )}
    </>
  );
}

function StoreInvite() {
  const setSetting = useStore((s) => s.setSetting);
  const [busy, setBusy] = useState(false);
  return (
    <div className="disc-invite surface" data-invite="store">
      <div className="disc-invite__art" aria-hidden>
        <Flame size={22} /><Percent size={22} /><Sparkles size={22} /><Gift size={22} />
      </div>
      <div className="disc-invite__text">
        <strong>Bring Steam’s store shelves into Discover</strong>
        <p>Trending games, deals, new releases, what’s coming soon and free-to-play picks, plus browsing by genre. VYSTRAL reads Steam’s public store lists for your price country at most every few hours, only while this is on, and never sends anything about you.</p>
      </div>
      <Button variant="primary" loading={busy} onClick={() => { setBusy(true); void Promise.resolve(setSetting('discover.storeShelves', true)).finally(() => setBusy(false)); }}>
        Show Steam shelves
      </Button>
    </div>
  );
}

// ---------------- genres and tags ----------------

export function GenreChips({ active }: { active: string | null }) {
  const navigate = useStore((s) => s.navigate);
  const open = (id: string | null) => navigate(id ? { name: 'discover', genre: id } : { name: 'discover' });
  const genres = DISCOVER_GENRES.filter((g) => g.kind === 'genre');
  const tags = DISCOVER_GENRES.filter((g) => g.kind === 'tag');
  return (
    <nav className="disc-genres" aria-label="Browse by genre or tag">
      <div className="disc-genres__row" role="group" aria-label="Genres">
        <span className="disc-genres__label caps" aria-hidden>Genres</span>
        {genres.map((g) => (
          <button key={g.id} type="button" className="dchip" aria-pressed={active === g.id} onClick={() => open(active === g.id ? null : g.id)}>{g.label}</button>
        ))}
      </div>
      <div className="disc-genres__row" role="group" aria-label="Tags">
        <span className="disc-genres__label caps" aria-hidden>Tags</span>
        {tags.map((g) => (
          <button key={g.id} type="button" className="dchip dchip--tag" aria-pressed={active === g.id} onClick={() => open(active === g.id ? null : g.id)}>#{g.label}</button>
        ))}
      </div>
    </nav>
  );
}

/** One genre or tag's games, page by page. */
export function DiscoverGenreView({ genre }: { genre: string }) {
  const g = genreById(genre);
  const state = useDiscoverGenre(g ? genre : null);
  const navigate = useStore((s) => s.navigate);
  const setSetting = useStore((s) => s.setSetting);
  const page = state.page;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [genre]);

  if (!g) {
    return <EmptyState art="none" icon={<Compass size={28} />} title="That genre isn’t one Discover knows" body="Pick one of the genres or tags above." />;
  }
  const source = page?.source === 'igdb' ? 'IGDB, most-rated first' : page?.source === 'steam' ? 'Steam, most popular first' : null;
  return (
    <div className="disc-browse">
      <GenreChips active={genre} />
      <section className="disc-section" aria-labelledby="disc-genre-title" aria-busy={state.loading}>
        <div className="disc-genre-head">
          <h2 id="disc-genre-title" className="disc-genre-head__title" tabIndex={-1} ref={headingRef}>
            {g.kind === 'tag' ? `#${g.label}` : g.label}
          </h2>
          {source && <span className="section-head__meta">{source}{state.results.length ? ` · ${plural(state.results.length, 'game')}` : ''}</span>}
          <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => navigate({ name: 'discover' })}>All of Discover</Button>
        </div>
        {page?.state === 'noSource' ? (
          <div className="disc-banner disc-banner--soft surface">
            <Tag size={20} aria-hidden />
            <div>
              <strong>Browsing by genre needs Steam’s shelves or IGDB</strong>
              <p>Show Steam’s store shelves to browse by Steam’s tags, or connect your own free IGDB key to browse IGDB’s genres.</p>
            </div>
            <div className="disc-banner__actions">
              <Button size="sm" variant="primary" onClick={() => void setSetting('discover.storeShelves', true)}>Show Steam shelves</Button>
              <Button size="sm" icon={<KeyRound size={14} />} onClick={() => navigate({ name: 'settings', section: 'library' })}>Connect IGDB</Button>
            </div>
          </div>
        ) : page?.state === 'offline' ? (
          <EmptyState art="none" icon={<AlertTriangle size={28} />} title="Offline mode is on" body="Genres you opened before still show what they knew. Turn Offline mode off in Settings → Privacy to browse more." />
        ) : page?.state === 'off' ? (
          <EmptyState art="none" icon={<AlertTriangle size={28} />} title="Searching game databases is off" body="Turn on “Search stores and game databases” in Settings → Library & stores → Data sources to browse IGDB’s genres." />
        ) : (
          <>
            <div className="dgrid" aria-live="polite" aria-relevant="additions">
              {state.results.map((r, i) => <div key={r.key} className="dgrid__cell" style={{ ['--i' as string]: i % 24 }}><ResultCard r={r} query={null} showSources={false} /></div>)}
              {state.loading && <ResultSkeletons count={state.results.length ? 6 : 12} />}
            </div>
            {page?.state === 'failed' && <InlineError text={reasonText(page.reason, page.source === 'igdb' ? 'IGDB' : 'Steam')} onRetry={state.retry} />}
            {state.error && <InlineError text={state.error} />}
            {page?.state === 'ready' && !state.loading && state.results.length === 0 && (
              <EmptyState art="shelf" icon={<Compass size={28} />} title={`Nothing for ${g.label} right now`} body="Try another genre or tag, or search by name above." />
            )}
            {page?.hasMore && !state.loading && <MoreButton onMore={state.loadMore} />}
          </>
        )}
      </section>
    </div>
  );
}

function MoreButton({ onMore }: { onMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const more = useRef(onMore);
  more.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) more.current(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className="disc-more"><Button variant="ghost" onClick={onMore}>Show more</Button></div>;
}

// ---------------- editions under their game (search results) ----------------

/** A result with its editions and add-ons folded underneath (a disclosure, so the card itself stays one button). */
export function ResultGroupCell({ group, query, index }: { group: ResultGroup; query: string; index: number }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (group.children.length === 0) {
    return <div className="dgrid__cell" style={{ ['--i' as string]: index % 24 }}><ResultCard r={group.base} query={query} /></div>;
  }
  const editions = group.children.filter((c) => c.kind === 'game').length;
  const addOns = group.children.length - editions;
  const words = [editions ? plural(editions, 'edition') : null, addOns ? plural(addOns, 'add-on') : null].filter(Boolean).join(' · ');
  return (
    <div className="dgroup" style={{ ['--i' as string]: index % 24 }} data-open={open || undefined}>
      <ResultCard r={group.base} query={query} />
      <button type="button" className="dgroup__toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        <Layers size={12} aria-hidden /> {open ? 'Hide' : 'Also'} {words}
      </button>
      {open && (
        <ul id={listId} className="dgroup__list" aria-label={`Editions and add-ons of ${group.base.title}`}>
          {group.children.map((c) => {
            const price = cardPrice(c);
            return (
              <li key={c.key}>
                <button type="button" className="dgroup__item" onClick={() => openResult(c, null)}>
                  <span className="dgroup__name">{c.title}</span>
                  <span className="dgroup__kind">{c.kind === 'extra' ? 'Add-on' : 'Edition'}{price ? ` · ${price.now}` : ''}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------- small pieces ----------------

function reasonText(reason: string | null | undefined, source: string): string {
  switch (reason) {
    case 'rateLimited': return `${source} asked VYSTRAL to slow down. VYSTRAL tries again in a little while.`;
    case 'invalidKey': return `${source} didn’t accept your key. Check it in Settings → Library & stores → Data sources.`;
    case 'empty': return `${source}’s lists were empty just now. VYSTRAL tries again later.`;
    case 'offline': return 'Offline mode is on.';
    default: return `${source} couldn’t be reached. Check your connection, then try again.`;
  }
}

function StaleNote({ what, fetched, reason, source, onRetry }: { what: string; fetched: string | null; reason: string; source: string; onRetry: () => void }) {
  return (
    <p className="disc-stale" role="status">
      <History size={14} aria-hidden />
      <span>{what} are from {fetched ? formatRelative(fetched).toLowerCase() : 'earlier'}. {reasonText(reason, source)}</span>
      <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={onRetry}>Try again</Button>
    </p>
  );
}

function InlineError({ text, onRetry, busy }: { text: string; onRetry?: () => void; busy?: boolean }) {
  return (
    <div className="disc-error surface" role="alert">
      <AlertTriangle size={18} aria-hidden />
      <span>{text}</span>
      {onRetry && <Button size="sm" variant="ghost" loading={busy} icon={<RefreshCw size={13} />} onClick={onRetry}>Try again</Button>}
    </div>
  );
}

function MissingKeys({ names, igdb }: { names: string[]; igdb: boolean }) {
  const navigate = useStore((s) => s.navigate);
  return (
    <div className="disc-banner disc-banner--soft surface">
      <KeyRound size={20} aria-hidden />
      <div>
        <strong>Get more results with {names.join(' and ')}</strong>
        <p>Steam and Wikidata work without a key. Connect your own free {names.join(' or ')} key for more games, console releases{igdb ? ', time to beat, “Because you played” rows' : ''} and fuller details.</p>
      </div>
      <Button size="sm" icon={<Settings2 size={14} />} onClick={() => navigate({ name: 'settings', section: 'library' })}>Connect sources</Button>
    </div>
  );
}

function WatchCard({ w, i }: { w: DiscoverWatch; i: number }) {
  const coverRef = useRef<HTMLDivElement>(null);
  const toast = useStore((s) => s.toast);
  const remove = async () => {
    try { await call('discover.watch', { key: w.key, on: false }); }
    catch (err) { toast({ tone: 'warning', title: 'Couldn’t update Watching', body: errorMessage(err) }); }
  };
  return (
    <div className="dwatch shelf__item" role="listitem" data-shelf-card style={{ ['--i' as string]: Math.min(i, 10) }}>
      <button className="dcard" aria-label={`${w.title}${w.year ? `, ${w.year}` : ''}. Watching since ${formatDate(w.addedAt)}.`}
        onClick={() => openResult({ key: w.key, title: w.title, libraryGameId: null }, coverRef.current)}>
        <div className="dcard__cover" ref={coverRef}><DiscoverCover itemKey={w.key} title={w.title} known={w.cover} /></div>
        <div className="dcard__body">
          <div className="dcard__title">{w.title}</div>
          <div className="dcard__meta">{w.priceWhenAdded ? <span>{w.priceWhenAdded} when added</span> : <span>Since {formatDate(w.addedAt)}</span>}</div>
        </div>
      </button>
      <IconButton label={`Stop watching ${w.title}`} size="sm" className="dwatch__remove" onClick={() => void remove()}><X size={14} /></IconButton>
    </div>
  );
}


