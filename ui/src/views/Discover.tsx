import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CloudOff, Compass, Eye, KeyRound, Loader2, Search, Settings2, SlidersHorizontal, X } from 'lucide-react';
import { call, errorMessage } from '../bridge/bridge';
import type { DiscoverSourceState, DiscoverStatus, DiscoverWatch, PlatformKey } from '../bridge/types';
import {
  activeFilterCount, applyFilters, DECADE_LABEL, filterOptions, NO_FILTERS, PLATFORM_GROUP_LABEL, sourceLine, splitByLibrary,
  type Decade, type DiscoverFilters, type PlatformGroup,
} from '../lib/discover';
import { formatDate, PLATFORM_NAMES, plural } from '../lib/format';
import { searchGames } from '../lib/search';
import { useDiscoverSearch, useDiscoverStatus, useWatching } from '../state/discover';
import { useStore } from '../state/store';
import { Badge, Button, EmptyState, IconButton, SectionHead, Toggle } from '../components/ui/primitives';
import { StoreLogo } from '../components/ui/StoreLogo';
import { ServiceLogo } from '../components/ui/ServiceLogo';
import { GameCard } from '../components/game/GameCard';
import { DiscoverCover, openResult, ResultCard, ResultSkeletons } from '../components/discover/DiscoverBits';
import './discover-page.css';

/**
 * Track U: search every connected source for any game, owned or not. Your library comes first ("In your library"),
 * then everything Steam's store search, IGDB, RAWG and Wikidata found, merged into one result per game.
 */
export function DiscoverView({ query: initial }: { query?: string }) {
  const [text, setText] = useState(initial ?? '');
  const [filters, setFilters] = useState<DiscoverFilters>(NO_FILTERS);
  const inputRef = useRef<HTMLInputElement>(null);
  const status = useDiscoverStatus();
  const games = useStore((s) => s.library.games);
  const navigate = useStore((s) => s.navigate);
  const online = useDiscoverSearch(text, 'page', { enabled: true, debounceMs: 220 });
  const q = online.query;

  // The address keeps the text, so Back returns to the same search.
  useEffect(() => {
    const r = useStore.getState().route;
    if (r.name === 'discover' && (r.query ?? '') !== (q ?? '')) navigate({ name: 'discover', query: q ?? undefined }, { replace: true });
  }, [q, navigate]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const local = useMemo(
    () => (q ? searchGames(games.filter((g) => !g.hidden), { intent: 'search', text: q, filters: {}, chips: [], structured: false }).slice(0, 12) : []),
    [games, q],
  );
  const localIds = useMemo(() => new Set(local.map((g) => g.id)), [local]);
  const remote = useMemo(() => online.search?.results ?? [], [online.search]);
  const { owned, rest } = useMemo(() => splitByLibrary(remote, localIds), [remote, localIds]);
  const options = useMemo(() => filterOptions(rest), [rest]);
  const shown = useMemo(() => applyFilters(rest, filters), [rest, filters]);
  const hiddenByFilters = rest.length - shown.length;
  const unavailable = status?.reason ?? online.search?.reason ?? null;

  return (
    <div className="page discover">
      <header className="disc-head">
        <div>
          <h1 className="disc-head__title"><Compass size={28} aria-hidden /> Discover</h1>
          <p className="disc-head__sub">Find any game, owned or not. Your library comes first, then Steam, IGDB, RAWG and Wikidata, merged into one result per game.</p>
        </div>
        {status?.preview && <Badge tone="warn">Preview · fictional results</Badge>}
      </header>

      <div className="disc-search" role="search">
        <label className="disc-search__field">
          <Search size={20} aria-hidden />
          <input
            ref={inputRef}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && text) { e.preventDefault(); e.stopPropagation(); setText(''); } }}
            placeholder="Search any game by name…"
            aria-label="Search every source"
            maxLength={100}
            spellCheck={false}
            data-osk-predict="games"
          />
          {online.busy && q && <Loader2 size={18} className="disc-spin" aria-hidden />}
          {text && <IconButton label="Clear search" size="sm" onClick={() => { setText(''); inputRef.current?.focus(); }}><X size={15} /></IconButton>}
        </label>
        <SourceStrip status={status} sources={q ? online.search?.sources ?? null : null} />
      </div>

      {unavailable === 'offline' ? (
        <OfflineState localCount={local.length} />
      ) : unavailable === 'off' ? (
        <OffState />
      ) : null}

      {!q && <StartState status={status} />}

      {q && (
        <>
          {(local.length > 0 || owned.length > 0) && (
            <section className="disc-section" aria-labelledby="disc-owned">
              <SectionHead title={<span id="disc-owned">In your library</span>} meta={plural(local.length + owned.length, 'game')} />
              <div className="dgrid">
                {local.map((g) => <GameCard key={g.id} game={g} />)}
                {owned.map((r, i) => <div key={r.key} style={{ ['--i' as string]: i }}><ResultCard r={r} query={q} /></div>)}
              </div>
            </section>
          )}

          {unavailable == null && (
            <section className="disc-section" aria-labelledby="disc-rest" aria-busy={online.busy}>
              <SectionHead
                title={<span id="disc-rest">Not in your library</span>}
                meta={online.search?.done ? `${plural(shown.length, 'game')}${hiddenByFilters > 0 ? ` · ${hiddenByFilters} hidden by filters` : ''}` : 'Searching…'}
              />
              {rest.length > 0 && <FilterBar filters={filters} onChange={setFilters} options={options} />}
              <div className="dgrid" aria-live="polite" aria-relevant="additions">
                {shown.map((r, i) => <div key={r.key} className="dgrid__cell" style={{ ['--i' as string]: i % 24 }}><ResultCard r={r} query={q} /></div>)}
                {(online.busy && rest.length === 0) && <ResultSkeletons count={12} />}
                {online.loadingMore && <ResultSkeletons count={6} />}
              </div>
              {online.search?.done && rest.length === 0 && !online.error && <NothingFound query={q} sources={online.search.sources} />}
              {online.search?.done && rest.length > 0 && shown.length === 0 && (
                <EmptyState art="none" icon={<SlidersHorizontal size={28} />} title="Your filters hide every result" body="Try another store, platform, decade or genre."
                  actions={<Button onClick={() => setFilters(NO_FILTERS)}>Clear filters</Button>} />
              )}
              {online.error && (
                <div className="disc-error surface" role="alert"><AlertTriangle size={18} aria-hidden /><span>{online.error}</span></div>
              )}
              {online.search?.hasMore && online.search.done && <MoreSentinel onMore={online.loadMore} busy={online.loadingMore} />}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Where each source stands: its mark, and a word or a spinner. */
function SourceStrip({ status, sources }: { status: DiscoverStatus | null; sources: DiscoverSourceState[] | null }) {
  const list = sources ?? status?.sources.map<DiscoverSourceState>((s) => ({
    id: s.id, name: s.name, state: s.state === 'ready' ? 'done' : 'skipped', reason: s.reason, count: -1, hasMore: false,
  })) ?? [];
  if (!list.length) return null;
  return (
    <ul className="disc-sources" aria-label="Sources">
      {list.map((s) => {
        const line = s.count < 0 ? (s.state === 'done' ? `${s.name}: ready` : sourceLine(s)) : sourceLine(s);
        return (
          <li key={s.id} className="disc-source" data-state={s.state} data-reason={s.reason ?? undefined} title={line}>
            {s.id === 'steam' ? <StoreLogo platform="steam" size={14} decorative /> : <ServiceLogo service={s.id} size={14} decorative />}
            <span>{line}</span>
            {s.state === 'pending' && <span className="disc-source__dot" aria-hidden />}
          </li>
        );
      })}
    </ul>
  );
}

function FilterBar({ filters, onChange, options }: { filters: DiscoverFilters; onChange: (f: DiscoverFilters) => void; options: ReturnType<typeof filterOptions> }) {
  const set = <K extends keyof DiscoverFilters>(k: K, v: DiscoverFilters[K]) => onChange({ ...filters, [k]: v });
  return (
    <div className="disc-filters" role="group" aria-label="Filter results">
      <div className="disc-filters__stores" role="group" aria-label="Store">
        <button className="dchip" aria-pressed={!filters.store} onClick={() => set('store', null)}>All stores</button>
        {options.stores.map((p: PlatformKey) => (
          <button key={p} className="dchip" aria-pressed={filters.store === p} onClick={() => set('store', filters.store === p ? null : p)}>
            <StoreLogo platform={p} size={14} decorative motion />{PLATFORM_NAMES[p]}
          </button>
        ))}
      </div>
      <div className="disc-filters__selects">
        {options.platforms.length > 0 && (
          <select className="input" aria-label="Platform" value={filters.platform ?? ''} onChange={(e) => set('platform', (e.target.value || null) as PlatformGroup | null)}>
            <option value="">Any platform</option>
            {options.platforms.map((p) => <option key={p} value={p}>{PLATFORM_GROUP_LABEL[p]}</option>)}
          </select>
        )}
        {options.decades.length > 0 && (
          <select className="input" aria-label="Release year" value={filters.decade ?? ''} onChange={(e) => set('decade', (e.target.value || null) as Decade | null)}>
            <option value="">Any year</option>
            {options.decades.map((d) => <option key={d} value={d}>{DECADE_LABEL[d]}</option>)}
          </select>
        )}
        {options.genres.length > 0 && (
          <select className="input" aria-label="Genre" value={filters.genre ?? ''} onChange={(e) => set('genre', e.target.value || null)}>
            <option value="">Any genre</option>
            {options.genres.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        )}
        <label className="disc-filters__toggle">
          <Toggle label="Games only" checked={filters.gamesOnly} onChange={(v) => set('gamesOnly', v)} />
          <span>Games only</span>
        </label>
        {activeFilterCount(filters) > 0 && <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => onChange({ ...NO_FILTERS, gamesOnly: filters.gamesOnly })}>Clear filters</Button>}
      </div>
    </div>
  );
}

/** Infinite scroll: asks for the next page when this comes near the screen (and offers a button for keyboards and controllers). */
function MoreSentinel({ onMore, busy }: { onMore: () => void; busy: boolean }) {
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
  return (
    <div ref={ref} className="disc-more">
      <Button variant="ghost" loading={busy} onClick={onMore}>Show more results</Button>
    </div>
  );
}

function NothingFound({ query, sources }: { query: string; sources: DiscoverSourceState[] }) {
  const failed = sources.filter((s) => s.state === 'failed');
  const asked = sources.filter((s) => s.state !== 'skipped');
  return (
    <EmptyState
      art="shelf"
      icon={<Search size={28} />}
      title={`Nothing found for “${query}”`}
      body={failed.length
        ? `${failed.map(sourceLine).join(' · ')}. The others found nothing. Try again in a moment, or with fewer words.`
        : asked.length
          ? `None of ${asked.map((s) => s.name).join(', ')} knows a game by that name. Check the spelling, or try fewer words.`
          : 'No source could be asked. Connect one in Settings → Library & stores → Data sources.'}
    />
  );
}

function OfflineState({ localCount }: { localCount: number }) {
  const navigate = useStore((s) => s.navigate);
  return (
    <div className="disc-banner surface" role="status">
      <CloudOff size={20} aria-hidden />
      <div>
        <strong>Offline mode is on</strong>
        <p>VYSTRAL doesn’t contact Steam or any game database, so only your library is searched{localCount ? '' : ' (and nothing there matches)'}. Pages you opened before still show what they knew.</p>
      </div>
      <Button size="sm" icon={<Settings2 size={14} />} onClick={() => navigate({ name: 'settings', section: 'privacy' })}>Privacy settings</Button>
    </div>
  );
}

function OffState() {
  const setSetting = useStore((s) => s.setSetting);
  return (
    <div className="disc-banner surface" role="status">
      <Search size={20} aria-hidden />
      <div>
        <strong>Searching stores and game databases is off</strong>
        <p>Only your library is searched. Turn it on to also ask Steam’s store search, Wikidata and, with your own keys, IGDB and RAWG.</p>
      </div>
      <Button size="sm" variant="primary" onClick={() => void setSetting('discover.searchOnline', true)}>Turn on</Button>
    </div>
  );
}

/** Nothing typed yet: what you're watching, and how to get more results. */
function StartState({ status }: { status: DiscoverStatus | null }) {
  const watching = useWatching();
  const navigate = useStore((s) => s.navigate);
  const missingKeys = status?.sources.filter((s) => s.reason === 'noKey') ?? [];
  return (
    <div className="disc-start">
      {watching && watching.length > 0 && (
        <section className="disc-section" aria-labelledby="disc-watching">
          <SectionHead title={<span id="disc-watching"><Eye size={18} aria-hidden /> Watching</span>} meta={plural(watching.length, 'game')} />
          <div className="dgrid">
            {watching.map((w, i) => <WatchCard key={w.key} w={w} i={i} />)}
          </div>
        </section>
      )}
      {(!watching || watching.length === 0) && (
        <EmptyState
          art="constellation"
          icon={<Compass size={32} />}
          title="Search for any game"
          body="Type a name above. You’ll see games you own first, then everything the connected sources know, with prices, time to beat and where to get it. Nothing is installed or launched from here."
        />
      )}
      {missingKeys.length > 0 && status?.reason == null && (
        <div className="disc-banner disc-banner--soft surface">
          <KeyRound size={20} aria-hidden />
          <div>
            <strong>Get more results with {missingKeys.map((s) => s.name).join(' and ')}</strong>
            <p>Steam and Wikidata work without a key. Connect your own free {missingKeys.map((s) => s.name).join(' or ')} key for more games, console releases{missingKeys.some((s) => s.id === 'igdb') ? ', time to beat' : ''} and fuller details.</p>
          </div>
          <Button size="sm" icon={<Settings2 size={14} />} onClick={() => navigate({ name: 'settings', section: 'library' })}>Connect sources</Button>
        </div>
      )}
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
    <div className="dwatch" style={{ ['--i' as string]: i }}>
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

