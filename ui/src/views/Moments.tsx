import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Camera, Clapperboard, Film, FolderCog, FolderPlus, Gamepad2, Images, Info, Play, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { Game, MediaFolder, MediaItem } from '../bridge/types';
import { call, errorMessage } from '../bridge/bridge';
import { Button, EmptyState, IconButton, Segmented, Skeleton } from '../components/ui/primitives';
import { useReducedMotion, useStore } from '../state/store';
import { formatDate, plural } from '../lib/format';
import { pick, spring } from '../lib/motion';
import { titleHue } from '../lib/palette';
import {
  buildRows, columnsFor, flatten, gameFacets, groupByMonth, matchLabel, monthLabel, filterItems,
  type GameFilter, type GridRow, type KindFilter,
} from './moments/grouping';
import { Lightbox } from './moments/Lightbox';
import { FoldersDialog } from './moments/FoldersDialog';
import './moments/moments.css';

export function MomentsView() {
  const enabled = useStore((s) => s.settings?.['moments.enabled'] ?? false);
  const settingsLoaded = useStore((s) => s.settings != null);
  if (!settingsLoaded) {
    return (
      <div className="page mv-page">
        <Skeleton height={40} width={260} />
      </div>
    );
  }
  return <div className="page mv-page">{enabled ? <Vault /> : <OptIn />}</div>;
}

/* ------------------------------------------------------------------------------------------ */

function OptIn() {
  const reduce = useReducedMotion();
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    await useStore.getState().setSetting('moments.enabled', true);
    setBusy(false);
  };
  const sources = [
    { icon: <Camera size={18} aria-hidden />, title: 'Steam screenshots', body: 'From the screenshot folders Steam keeps for each of your accounts.' },
    { icon: <Clapperboard size={18} aria-hidden />, title: 'Xbox Game Bar captures', body: 'Screenshots and clips saved with Win + Alt + PrtScn or Win + G.' },
    { icon: <FolderPlus size={18} aria-hidden />, title: 'Folders you choose', body: 'Add any folder where you keep captures, such as NVIDIA or OBS recordings.' },
  ];
  return (
    <motion.section
      className="mv-optin"
      aria-labelledby="mv-optin-title"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={pick(reduce, spring.page)}
    >
      <div className="mv-optin__art" aria-hidden>
        <span className="mv-optin__frame mv-optin__frame--a" />
        <span className="mv-optin__frame mv-optin__frame--b" />
        <span className="mv-optin__frame mv-optin__frame--c">
          <Images size={30} />
        </span>
      </div>
      <div className="caps">Moments</div>
      <h1 id="mv-optin-title" className="mv-optin__title">Your best moments, in one place</h1>
      <p className="mv-optin__lead">
        VYSTRAL can gather the screenshots and clips already on this PC and sort them by game — so the moment you beat that boss is one click from the game itself.
      </p>
      <ul className="mv-optin__sources">
        {sources.map((s) => (
          <li key={s.title}>
            <span className="mv-optin__source-icon">{s.icon}</span>
            <span>
              <strong>{s.title}</strong>
              <span>{s.body}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mv-optin__privacy">
        <ShieldCheck size={16} aria-hidden />
        Files stay on this PC. They’re never uploaded, moved or modified — VYSTRAL only reads them to show previews.
      </p>
      <div className="mv-optin__actions">
        <Button variant="primary" size="lg" icon={<Images size={18} aria-hidden />} loading={busy} onClick={() => void enable()}>
          Turn on Moments
        </Button>
      </div>
      <p className="mv-optin__foot">You can turn it off any time.</p>
    </motion.section>
  );
}

/* ------------------------------------------------------------------------------------------ */

const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Screenshots' },
  { value: 'video', label: 'Clips' },
];

function Vault() {
  const gamesById = useStore((s) => s.gamesById);
  const [folders, setFolders] = useState<MediaFolder[] | null>(null);
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [chosenFilter, setGameFilter] = useState<GameFilter>({ type: 'all' });
  const [kind, setKind] = useState<KindFilter>('all');
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);

  // Only the newest scan answers (a folder change can start a new one while the last is running).
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++loadSeq.current;
    setRefreshing(true);
    setError(null);
    try {
      const [f, list] = await Promise.all([call<MediaFolder[]>('media.folders'), call<MediaItem[]>('media.list', undefined, 180_000)]);
      if (mine !== loadSeq.current) return;
      setFolders(f ?? []);
      setItems(list ?? []);
    } catch (err) {
      if (mine === loadSeq.current) setError(errorMessage(err));
    } finally {
      if (mine === loadSeq.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadSeq.current++;
    };
  }, [load]);

  const facets = useMemo(() => gameFacets(items ?? []), [items]);
  // A filter pointing at a game that no longer has captures falls back to everything.
  const gameFilter = useMemo<GameFilter>(
    () =>
      (chosenFilter.type === 'game' && !facets.some((f) => f.gameId === chosenFilter.id)) || (chosenFilter.type === 'unsorted' && !facets.some((f) => f.gameId == null))
        ? { type: 'all' }
        : chosenFilter,
    [chosenFilter, facets],
  );
  const filtered = useMemo(() => filterItems(items ?? [], gameFilter, kind), [items, gameFilter, kind]);
  const groups = useMemo(() => groupByMonth(filtered), [filtered]);
  const flat = useMemo(() => flatten(groups), [groups]);


  const onFoldersChanged = (next: MediaFolder[] | null) => {
    if (next) setFolders(next);
    void load();
  };

  const counts = useMemo(() => {
    let images = 0, videos = 0;
    for (const i of items ?? []) {
      if (i.kind === 'video') videos++;
      else images++;
    }
    return { images, videos };
  }, [items]);

  const activeFacet = gameFilter.type === 'all' ? null : facets.find((f) => (gameFilter.type === 'unsorted' ? f.gameId == null : f.gameId === gameFilter.id)) ?? null;
  const missingFolders = (folders ?? []).filter((f) => !f.exists);

  return (
    <>
      <header className="mv-head">
        <div>
          <div className="caps">Screenshots &amp; clips</div>
          <h1 className="mv-title">Moments</h1>
          <p className="mv-sub">
            {items ? (
              <>
                <span className="num">{counts.images.toLocaleString()}</span> {counts.images === 1 ? 'screenshot' : 'screenshots'} ·{' '}
                <span className="num">{counts.videos.toLocaleString()}</span> {counts.videos === 1 ? 'clip' : 'clips'} · grouped by file date
              </>
            ) : (
              'Looking through your capture folders…'
            )}
          </p>
        </div>
        <div className="mv-toolbar">
          <Segmented label="Show" value={kind} options={KIND_OPTIONS} onChange={setKind} />
          <IconButton label="Refresh" onClick={() => void load()} disabled={refreshing}>
            <RefreshCw size={18} className={refreshing ? 'mv-spin' : undefined} />
          </IconButton>
          <Button variant="secondary" icon={<FolderCog size={16} aria-hidden />} onClick={() => setFoldersOpen(true)}>
            Folders{folders ? <span className="mv-count num">{folders.length}</span> : null}
          </Button>
        </div>
      </header>

      {missingFolders.length > 0 && (
        <div className="mv-banner" role="status">
          <TriangleAlert size={16} aria-hidden />
          <span>
            {missingFolders.length === 1 ? `${missingFolders[0].label} can’t be found.` : `${missingFolders.length} capture folders can’t be found.`} It may be on a drive that isn’t connected.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setFoldersOpen(true)}>
            Manage folders
          </Button>
        </div>
      )}

      {items && items.length > 0 && facets.length > 0 && (
        <GameChips facets={facets} total={items.length} value={gameFilter} onChange={setGameFilter} gamesById={gamesById} />
      )}

      {activeFacet && (
        <p className="mv-match">
          <Info size={14} aria-hidden />
          {activeFacet.gameId == null
            ? 'These files couldn’t be matched to a game in your library from their folder or file name.'
            : [
                activeFacet.steamAppId > 0 && `${plural(activeFacet.steamAppId, 'file')} matched by Steam app ID (from the screenshot folder)`,
                activeFacet.filename > 0 && `${plural(activeFacet.filename, 'file')} matched by file name`,
              ]
                .filter(Boolean)
                .join(' · ')}
        </p>
      )}

      {error ? (
        <EmptyState
          art="none"
          icon={<TriangleAlert size={34} aria-hidden />}
          title="Couldn’t read your captures"
          body={error}
          actions={
            <Button variant="primary" icon={<RefreshCw size={16} aria-hidden />} onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : !items ? (
        <GridSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          art="hills"
          icon={<Images size={34} aria-hidden />}
          title="No captures found yet"
          body="VYSTRAL looks in Steam’s screenshot folders, Xbox Game Bar captures and any folders you add. Take a screenshot in a game, or add the folder where you keep them."
          actions={
            <>
              <Button variant="primary" icon={<FolderPlus size={16} aria-hidden />} onClick={() => setFoldersOpen(true)}>
                Manage folders
              </Button>
            </>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Film size={34} aria-hidden />}
          title="Nothing matches these filters"
          body="Try showing all captures or another game."
          actions={
            <Button
              variant="secondary"
              onClick={() => {
                setKind('all');
                setGameFilter({ type: 'all' });
              }}
            >
              Show everything
            </Button>
          }
        />
      ) : (
        <MomentGrid groups={groups} showGame={gameFilter.type === 'all'} onOpen={setViewing} gamesById={gamesById} />
      )}

      <Lightbox items={flat} index={viewing} folders={folders ?? []} onIndex={setViewing} onClose={() => setViewing(null)} />
      <FoldersDialog open={foldersOpen} folders={folders ?? []} onClose={() => setFoldersOpen(false)} onChanged={onFoldersChanged} />
    </>
  );
}

function GameChips({
  facets,
  total,
  value,
  onChange,
  gamesById,
}: {
  facets: ReturnType<typeof gameFacets>;
  total: number;
  value: GameFilter;
  onChange: (f: GameFilter) => void;
  gamesById: Map<string, Game>;
}) {
  const isActive = (gameId: string | null | 'all') =>
    gameId === 'all' ? value.type === 'all' : gameId == null ? value.type === 'unsorted' : value.type === 'game' && value.id === gameId;
  return (
    <div className="mv-chips" role="group" aria-label="Filter by game">
      <button type="button" className="mv-chip" aria-pressed={isActive('all')} onClick={() => onChange({ type: 'all' })}>
        All games <span className="mv-chip__count num">{total.toLocaleString()}</span>
      </button>
      {facets.map((f) => {
        const game = f.gameId ? gamesById.get(f.gameId) : null;
        const label = f.gameId == null ? 'Unsorted' : game?.title ?? 'Unknown game';
        const how =
          f.gameId == null
            ? 'Not matched to a game'
            : [f.steamAppId && `${f.steamAppId} by Steam app ID`, f.filename && `${f.filename} by file name`].filter(Boolean).join(', ');
        return (
          <button
            key={f.gameId ?? '~unsorted'}
            type="button"
            className="mv-chip"
            data-unsorted={f.gameId == null}
            aria-pressed={isActive(f.gameId)}
            title={how}
            style={{ ['--h' as string]: game ? titleHue(game.title) : 260 }}
            onClick={() => onChange(f.gameId == null ? { type: 'unsorted' } : { type: 'game', id: f.gameId })}
          >
            {f.gameId != null && <span className="mv-chip__dot" aria-hidden />}
            <span className="truncate">{label}</span>
            <span className="mv-chip__count num">{f.count.toLocaleString()}</span>
          </button>
        );
      })}
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="mv-skeleton" aria-hidden>
      <Skeleton width={160} height={18} />
      <div className="mv-skeleton__grid">
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} className="mv-skeleton__tile" radius={14} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */

const MIN_TILE = 232;
const GAP = 12;
const HEADER_H = 64;

function MomentGrid({
  groups,
  showGame,
  onOpen,
  gamesById,
}: {
  groups: ReturnType<typeof groupByMonth>;
  showGame: boolean;
  onOpen: (index: number) => void;
  gamesById: Map<string, Game>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollMargin, setScrollMargin] = useState(0);
  const pendingFocus = useRef<number | null>(null);

  const getScrollElement = useCallback(() => listRef.current?.closest<HTMLElement>('[data-scroll-main]') ?? null, []);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      const scroller = getScrollElement();
      setWidth(el.clientWidth);
      if (scroller) setScrollMargin(Math.round(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const page = el.parentElement;
    if (page) ro.observe(page);
    return () => ro.disconnect();
  }, [getScrollElement]);

  const columns = columnsFor(width, MIN_TILE, GAP);
  const tileW = width > 0 ? (width - GAP * (columns - 1)) / columns : MIN_TILE;
  const tileH = Math.round((tileW * 9) / 16);
  const rows = useMemo(() => buildRows(groups, columns), [groups, columns]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement,
    estimateSize: (i) => (rows[i]?.type === 'header' ? HEADER_H : tileH + GAP),
    overscan: 4,
    scrollMargin,
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, tileH, rows]);

  // Row lookup for keyboard navigation: flat index → row number.
  const itemRows = useMemo(() => {
    const out: number[] = [];
    rows.forEach((r, i) => {
      if (r.type === 'items') out.push(i);
    });
    return out;
  }, [rows]);

  const locate = (flatIndex: number) => {
    let lo = 0, hi = itemRows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const r = rows[itemRows[mid]] as Extract<GridRow, { type: 'items' }>;
      if (r.startIndex <= flatIndex) lo = mid;
      else hi = mid - 1;
    }
    const row = rows[itemRows[lo]] as Extract<GridRow, { type: 'items' }>;
    return { pos: lo, col: flatIndex - row.startIndex };
  };

  const focusIndex = (flatIndex: number, rowIndex: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${flatIndex}"]`);
    if (el) {
      el.focus({ preventScroll: false });
      el.scrollIntoView({ block: 'nearest' });
    } else {
      pendingFocus.current = flatIndex;
      virtualizer.scrollToIndex(rowIndex, { align: 'auto' });
    }
  };

  useEffect(() => {
    if (pendingFocus.current == null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${pendingFocus.current}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
    }
  });

  const total = rows.reduce((n, r) => (r.type === 'items' ? n + r.items.length : n), 0);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const idx = Number(target.dataset.index);
    if (!Number.isFinite(idx) || !itemRows.length) return;
    const { pos, col } = locate(idx);
    let nextPos = pos, nextCol = col;
    if (e.key === 'ArrowRight') {
      if (idx + 1 >= total) return;
      const n = locate(idx + 1);
      nextPos = n.pos;
      nextCol = n.col;
    } else if (e.key === 'ArrowLeft') {
      if (idx === 0) return;
      const n = locate(idx - 1);
      nextPos = n.pos;
      nextCol = n.col;
    } else if (e.key === 'ArrowDown') nextPos = Math.min(itemRows.length - 1, pos + 1);
    else if (e.key === 'ArrowUp') nextPos = Math.max(0, pos - 1);
    else if (e.key === 'Home' && e.ctrlKey) nextPos = nextCol = 0;
    else if (e.key === 'End' && e.ctrlKey) {
      nextPos = itemRows.length - 1;
      nextCol = Infinity;
    } else return;
    e.preventDefault();
    const row = rows[itemRows[nextPos]] as Extract<GridRow, { type: 'items' }>;
    const c = Math.min(nextCol, row.items.length - 1);
    focusIndex(row.startIndex + c, itemRows[nextPos]);
  };

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div ref={listRef} className="mv-grid" style={{ height: virtualizer.getTotalSize() }} onKeyDown={onKeyDown} role="region" aria-label="Captures">
      {virtualRows.map((v) => {
        const row = rows[v.index];
        if (!row) return null;
        return (
          <div
            key={v.key}
            className={row.type === 'header' ? 'mv-row mv-row--header' : 'mv-row'}
            style={{ transform: `translate3d(0, ${v.start - scrollMargin}px, 0)`, height: v.size }}
          >
            {row.type === 'header' ? (
              <h2 className="mv-month">
                {monthLabel(row.group)}
                <span className="mv-month__count num">{row.group.items.length.toLocaleString()}</span>
              </h2>
            ) : (
              <div className="mv-row__tiles" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, height: tileH }}>
                {row.items.map((item, i) => (
                  <Tile
                    key={item.url}
                    item={item}
                    index={row.startIndex + i}
                    game={showGame && item.gameId ? gamesById.get(item.gameId) ?? null : null}
                    showGame={showGame}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const Tile = memo(function Tile({
  item,
  index,
  game,
  showGame,
  onOpen,
}: {
  item: MediaItem;
  index: number;
  game: Game | null;
  showGame: boolean;
  onOpen: (index: number) => void;
}) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>(item.thumbUrl ? 'loading' : 'failed');
  const label = [`${item.kind === 'video' ? 'Clip' : 'Screenshot'} ${item.name}`, game ? game.title : item.gameId ? null : 'unsorted', formatDate(item.modifiedAt)]
    .filter(Boolean)
    .join(', ');
  return (
    <button
      type="button"
      className="mv-tile"
      data-index={index}
      data-kind={item.kind}
      data-state={state}
      aria-label={label}
      title={`${item.name}\n${matchLabel(item.matchedBy)}`}
      onClick={() => onOpen(index)}
    >
      {state !== 'failed' && (
        <img
          className="mv-tile__img"
          src={item.thumbUrl}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setState('loaded')}
          onError={() => setState('failed')}
        />
      )}
      {state === 'failed' && (
        <span className="mv-tile__fallback" aria-hidden>
          {item.kind === 'video' ? <Film size={26} /> : <Images size={26} />}
        </span>
      )}
      {item.kind === 'video' && (
        <span className="mv-tile__play" aria-hidden>
          <Play size={16} fill="currentColor" />
        </span>
      )}
      {showGame && (
        <span className="mv-tile__caption" aria-hidden>
          {game ? <Gamepad2 size={12} /> : null}
          <span className="truncate">{game ? game.title : 'Unsorted'}</span>
        </span>
      )}
    </button>
  );
});
