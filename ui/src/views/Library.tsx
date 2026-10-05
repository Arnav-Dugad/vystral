import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownWideNarrow, FilePlus2, Grid3x3, List, Pencil, Search, Trash2, X, Copy } from 'lucide-react';
import { call, errorMessage } from '../bridge/bridge';
import type { Game, GameStatus } from '../bridge/types';
import {
  formatBytes, formatDuration, formatRelative, importedMinutes, isInstalled, lastPlayed, PLATFORM_NAMES, plural, sizeOf,
} from '../lib/format';
import { parseQuery, searchGames, type ParsedQuery } from '../lib/search';
import { addManualGame } from '../state/actions';
import { STATUSES, statusRank } from '../lib/status';
import '../components/game/status.css';
import { useStore } from '../state/store';
import { GameCard } from '../components/game/GameCard';
import { GameCover } from '../components/game/GameCover';
import { Badge, Button, EmptyState, IconButton, PlatformBadge, Segmented, Slider } from '../components/ui/primitives';
import { Dialog } from '../components/ui/Dialog';
import './library.css';

type Sort = 'recent' | 'title' | 'playtime' | 'size' | 'added' | 'status';
type Quick = 'all' | 'installed' | 'favorites' | 'unplayed' | 'new' | 'client' | 'missing' | 'hidden' | `status:${GameStatus}`;

const QUICK: { value: Quick; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'installed', label: 'Installed' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'unplayed', label: 'Unplayed' },
  { value: 'new', label: 'New this month' },
  { value: 'client', label: 'Needs store app' },
  { value: 'missing', label: 'Missing' },
  { value: 'hidden', label: 'Hidden' },
];

const VIEW_KEY = 'vystral.library.view';

export function LibraryView({ collectionId }: { collectionId?: string }) {
  const games = useStore((s) => s.library.games);
  const collections = useStore((s) => s.library.collections);
  const duplicates = useStore((s) => s.library.duplicateSuggestions);
  const drives = useStore((s) => s.drives);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const collection = collections.find((c) => c.id === collectionId);

  const [text, setText] = useState('');
  const query = useDeferredValue(text);
  const [quick, setQuick] = useState<Quick>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem(VIEW_KEY) as 'grid' | 'list') ?? 'grid');
  const [dupOpen, setDupOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const gridSize = settings?.['appearance.gridSize'] ?? 180;

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ }
  }, [view]);

  const genres = useMemo(() => [...new Set(games.flatMap((g) => g.genres))], [games]);
  const parsed: ParsedQuery = useMemo(() => parseQuery(query, { genres, drives }), [query, genres, drives]);

  const results = useMemo(() => {
    const now = Date.now();
    let base = collectionId ? games.filter((g) => g.collections.includes(collectionId)) : games;
    base = base.filter((g) => {
      switch (quick) {
        case 'hidden': return g.hidden;
        case 'installed': return !g.hidden && isInstalled(g);
        case 'favorites': return !g.hidden && g.favorite;
        case 'unplayed': return !g.hidden && !lastPlayed(g).at && g.trackedSeconds === 0;
        case 'new': return !g.hidden && now - Date.parse(g.added) < 30 * 86400000;
        case 'client': return !g.hidden && isInstalled(g) && g.installations.every((i) => i.state !== 'installed' || i.clientRequired);
        case 'missing': return !g.hidden && !isInstalled(g);
        default: return quick.startsWith('status:') ? !g.hidden && g.status === quick.slice(7) : true;
      }
    });
    const filters = { ...parsed.filters, hidden: quick === 'hidden' ? true : parsed.filters.hidden };
    let found = searchGames(base, { ...parsed, filters }, now);
    if (found.length === 0 && parsed.chips.length && query.trim()) {
      found = searchGames(base, { intent: 'search', text: query, filters: { hidden: quick === 'hidden' }, chips: [], structured: false }, now);
    }
    if (!parsed.text) {
      const playtime = (g: Game) => g.trackedSeconds + (importedMinutes(g) ?? 0) * 60;
      const cmp: Record<Sort, (a: Game, b: Game) => number> = {
        recent: (a, b) => (lastPlayed(b).at ?? '').localeCompare(lastPlayed(a).at ?? '') || a.sortTitle.localeCompare(b.sortTitle),
        title: (a, b) => a.sortTitle.localeCompare(b.sortTitle),
        playtime: (a, b) => playtime(b) - playtime(a),
        size: (a, b) => (sizeOf(b) ?? -1) - (sizeOf(a) ?? -1),
        added: (a, b) => b.added.localeCompare(a.added),
        status: (a, b) => statusRank(a) - statusRank(b) || (lastPlayed(b).at ?? '').localeCompare(lastPlayed(a).at ?? '') || a.sortTitle.localeCompare(b.sortTitle),
      };
      found = [...found].sort(cmp[sort]);
    }
    return found;
  }, [games, collectionId, quick, parsed, sort, query]);

  const title = collection ? collection.name : 'Library';
  const totalSize = useMemo(() => results.reduce((s, g) => s + (sizeOf(g) ?? 0), 0), [results]);

  return (
    <div className="page library">
      <header className="lib-head">
        <div>
          <h1 className="lib-head__title">{title}</h1>
          <p className="lib-head__meta">
            {plural(results.length, 'game')}
            {totalSize > 0 && <> · {formatBytes(totalSize)} installed</>}
          </p>
        </div>
        <div className="lib-head__actions">
          {collection && (
            <>
              <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => setRenameOpen(true)}>Rename</Button>
              <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setDeleteOpen(true)}>Delete collection</Button>
            </>
          )}
          {!collection && duplicates.length > 0 && (
            <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => setDupOpen(true)}>
              Review {plural(duplicates.length, 'possible duplicate')}
            </Button>
          )}
          <Button size="sm" icon={<FilePlus2 size={14} />} onClick={() => void addManualGame()}>Add a game</Button>
        </div>
      </header>

      <div className="lib-toolbar">
        <label className="lib-search">
          <Search size={16} aria-hidden />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter… try “steam racing under 30 gb” or “not played in 3 months”"
            aria-label="Filter library"
            spellCheck={false}
          />
          {text && (
            <IconButton label="Clear filter" size="sm" onClick={() => setText('')}>
              <X size={14} />
            </IconButton>
          )}
        </label>
        <div className="lib-toolbar__right">
          <label className="lib-sort">
            <ArrowDownWideNarrow size={15} aria-hidden />
            <select className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by" disabled={!!parsed.text}>
              <option value="recent">Recently played</option>
              <option value="title">Title A–Z</option>
              <option value="playtime">Most played</option>
              <option value="size">Largest</option>
              <option value="added">Recently added</option>
              <option value="status">Play status</option>
            </select>
          </label>
          {view === 'grid' && (
            <div className="lib-size" title="Card size">
              <Slider label="Card size" value={gridSize} min={120} max={280} step={10} onChange={(v) => void setSetting('appearance.gridSize', v)} />
            </div>
          )}
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'grid', label: <span className="visually-hidden">Grid</span>, icon: <Grid3x3 size={15} /> },
              { value: 'list', label: <span className="visually-hidden">List</span>, icon: <List size={15} /> },
            ]}
          />
        </div>
      </div>

      <div className="lib-quick" role="toolbar" aria-label="Quick filters">
        {QUICK.map((q) => (
          <button key={q.value} className="chip" aria-pressed={quick === q.value} onClick={() => setQuick(q.value)}>
            {q.label}
          </button>
        ))}
        <span className="lib-quick__sep" aria-hidden style={{ width: 1, alignSelf: 'stretch', margin: '4px 4px', background: 'var(--line-strong)' }} />
        {STATUSES.map((st) => {
          const Icon = st.icon;
          const value = `status:${st.value}` as const;
          return (
            <button key={value} className="chip status-mark" style={{ ['--st' as string]: st.color }} aria-pressed={quick === value} title={st.hint} onClick={() => setQuick(quick === value ? 'all' : value)}>
              <span className="status-mark__icon" aria-hidden><Icon size={13} /></span>
              {st.label}
            </button>
          );
        })}
      </div>

      {parsed.chips.length > 0 && (
        <div className="lib-chips" aria-live="polite">
          <span className="caps">Showing</span>
          {parsed.chips.map((c) => <Badge key={c} tone="accent">{c}</Badge>)}
          {parsed.text && <Badge>Title contains “{parsed.text}”</Badge>}
        </div>
      )}

      {results.length === 0 ? (
        <EmptyState
          icon={<Search size={32} />}
          title={games.length === 0 ? 'No games yet' : collection && !text ? 'This collection is empty' : 'Nothing matches'}
          body={
            games.length === 0
              ? 'Rescan your stores or add a game yourself.'
              : collection && !text
                ? 'Add games from their right-click menu, or from the Collections section of a game’s page.'
                : 'Try fewer words, a different quick filter, or clear the filter.'
          }
          actions={text || quick !== 'all' ? <Button onClick={() => { setText(''); setQuick('all'); }}>Clear filters</Button> : undefined}
        />
      ) : view === 'grid' ? (
        <VirtualGrid games={results} size={gridSize} />
      ) : (
        <VirtualList games={results} />
      )}

      <DuplicatesDialog open={dupOpen} onClose={() => setDupOpen(false)} />
      {collection && (
        <>
          <RenameDialog open={renameOpen} onClose={() => setRenameOpen(false)} id={collection.id} name={collection.name} />
          <Dialog
            open={deleteOpen}
            onClose={() => setDeleteOpen(false)}
            title={`Delete “${collection.name}”?`}
            actions={
              <>
                <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Keep it</Button>
                <Button
                  variant="danger"
                  onClick={async () => {
                    await call('collections.delete', { collectionId: collection.id }).catch(() => {});
                    setDeleteOpen(false);
                    await useStore.getState().refreshLibrary();
                    useStore.getState().navigate({ name: 'library' }, { replace: true });
                  }}
                >
                  Delete collection
                </Button>
              </>
            }
          >
            Only the collection is removed. The {plural(collection.count, 'game')} in it stay in your library.
          </Dialog>
        </>
      )}
    </div>
  );
}

/** Row-virtualized responsive grid: only visible rows are mounted, so 10k games stay fast. */
function VirtualGrid({ games, size }: { games: Game[]; size: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const gap = 20;

  useLayoutEffect(() => {
    setScrollEl(ref.current?.closest('[data-scroll-main]') as HTMLElement | null);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const columns = Math.max(2, Math.floor((width + gap) / (size + gap)));
  const cardW = (width - gap * (columns - 1)) / columns;
  const rowH = cardW * 1.5 + 58 + gap;
  const rows = Math.ceil(games.length / columns);

  const virtual = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollEl,
    estimateSize: () => rowH,
    overscan: 3,
    scrollMargin: ref.current?.offsetTop ?? 0,
  });

  useEffect(() => virtual.measure(), [rowH, virtual]);

  return (
    <div ref={ref} className="vgrid" style={{ height: virtual.getTotalSize() }} role="list" aria-label="Games">
      {virtual.getVirtualItems().map((row) => (
        <div
          key={row.key}
          className="vgrid__row"
          style={{ transform: `translateY(${row.start - (virtual.options.scrollMargin ?? 0)}px)`, gridTemplateColumns: `repeat(${columns}, 1fr)`, gap }}
        >
          {games.slice(row.index * columns, row.index * columns + columns).map((g) => (
            <div key={g.id} role="listitem">
              <GameCard game={g} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function VirtualList({ games }: { games: Game[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const navigate = useStore((s) => s.navigate);
  useLayoutEffect(() => setScrollEl(ref.current?.closest('[data-scroll-main]') as HTMLElement | null), []);
  const virtual = useVirtualizer({ count: games.length, getScrollElement: () => scrollEl, estimateSize: () => 64, overscan: 8, scrollMargin: ref.current?.offsetTop ?? 0 });

  return (
    <div className="vlist" role="table" aria-label="Games" aria-rowcount={games.length}>
      <div className="vlist__head" role="row">
        <span role="columnheader">Title</span>
        <span role="columnheader">Store</span>
        <span role="columnheader">Last played</span>
        <span role="columnheader">Playtime</span>
        <span role="columnheader">Size</span>
        <span role="columnheader">Drive</span>
      </div>
      <div ref={ref} style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {virtual.getVirtualItems().map((item) => {
          const g = games[item.index];
          const lp = lastPlayed(g);
          const imported = importedMinutes(g);
          const inst = g.installations.find((i) => i.state === 'installed');
          return (
            <button
              key={g.id}
              role="row"
              className="vlist__row"
              data-game-id={g.id}
              data-dim={!isInstalled(g) || undefined}
              style={{ transform: `translateY(${item.start - (virtual.options.scrollMargin ?? 0)}px)` }}
              onClick={() => navigate({ name: 'game', id: g.id })}
              onFocus={() => useStore.getState().setFocusGame(g.id)}
            >
              <span role="cell" className="vlist__title">
                <span className="vlist__thumb"><GameCover game={g} /></span>
                <span className="truncate">{g.title}</span>
              </span>
              <span role="cell" className="vlist__stores">
                {[...new Set(g.installations.map((i) => i.platform))].map((p) => <PlatformBadge key={p} platform={p} compact />)}
                <span className="truncate">{[...new Set(g.installations.map((i) => PLATFORM_NAMES[i.platform]))].join(', ')}</span>
              </span>
              <span role="cell">{lp.at ? formatRelative(lp.at) : '—'}</span>
              <span role="cell" className="num">
                {g.trackedSeconds > 0 ? formatDuration(g.trackedSeconds) : imported ? <span title="Reported by the store">{formatDuration(imported * 60)}*</span> : '—'}
              </span>
              <span role="cell" className="num">{formatBytes(sizeOf(g))}</span>
              <span role="cell">{inst?.drive ?? (isInstalled(g) ? '—' : 'Not installed')}</span>
            </button>
          );
        })}
      </div>
      <p className="vlist__foot">* Playtime reported by the store. Other values were tracked by VYSTRAL.</p>
    </div>
  );
}

function RenameDialog({ open, onClose, id, name }: { open: boolean; onClose: () => void; id: string; name: string }) {
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name, open]);
  const save = async () => {
    try {
      await call('collections.rename', { collectionId: id, name: value.trim() });
      await useStore.getState().refreshLibrary();
      onClose();
    } catch (err) {
      useStore.getState().toast({ tone: 'danger', title: 'Couldn’t rename', body: errorMessage(err) });
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Rename collection" actions={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!value.trim()} onClick={save}>Save</Button></>}>
      <input className="input" data-autofocus value={value} maxLength={60} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} aria-label="Collection name" />
    </Dialog>
  );
}

/** Possible duplicates that were deliberately not merged automatically; the user decides. */
function DuplicatesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const suggestions = useStore((s) => s.library.duplicateSuggestions);
  const byId = useStore((s) => s.gamesById);
  const toast = useStore((s) => s.toast);
  const refresh = useStore((s) => s.refreshLibrary);

  const merge = async (a: string, b: string) => {
    try {
      await call('game.merge', { targetGameId: a, sourceGameId: b });
      toast({ tone: 'success', title: 'Merged into one entry', body: 'Both versions keep their own install details. You can separate them again from the game’s Versions tab.' });
      await refresh();
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t merge', body: errorMessage(err) });
    }
  };
  const dismiss = async (a: string, b: string) => {
    await call('game.dismissDuplicate', { gameIdA: a, gameIdB: b }).catch(() => {});
    await refresh();
  };

  return (
    <Dialog open={open} onClose={onClose} title="Possible duplicates" wide actions={<Button onClick={onClose}>Done</Button>}>
      <p style={{ marginBottom: 16 }}>
        These look related but differ in edition or store, so VYSTRAL kept them apart. Merging only combines how they appear here — nothing on disk changes.
      </p>
      <div style={{ display: 'grid', gap: 12 }}>
        {suggestions.length === 0 && <p>No suggestions left.</p>}
        {suggestions.map((s) => {
          const a = byId.get(s.gameIdA), b = byId.get(s.gameIdB);
          if (!a || !b) return null;
          return (
            <div key={`${s.gameIdA}-${s.gameIdB}`} className="dup-row surface">
              {[a, b].map((g) => (
                <div key={g.id} className="dup-row__game">
                  <span className="vlist__thumb"><GameCover game={g} /></span>
                  <div>
                    <div>{g.title}</div>
                    <div className="cmd__meta">{g.installations.map((i) => PLATFORM_NAMES[i.platform]).join(', ')}</div>
                  </div>
                </div>
              ))}
              <div className="dup-row__actions">
                <Button size="sm" variant="primary" onClick={() => void merge(a.id, b.id)}>Merge</Button>
                <Button size="sm" variant="ghost" onClick={() => void dismiss(a.id, b.id)}>Keep separate</Button>
              </div>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
