import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Compass, Library, MapPin, Sparkles } from 'lucide-react';
import { call } from '../../../bridge/bridge';
import type { Franchise, FranchiseEntry } from '../../../bridge/types';
import { formatRelative } from '../../../lib/format';
import { useReducedMotion, useStore } from '../../../state/store';
import { GameCover } from '../GameCover';
import { ServiceLogo } from '../../ui/ServiceLogo';
import { Button, IconButton } from '../../ui/primitives';
import { useBridgeData } from './useBridgeData';
import './insights.css';

const TYPE_LABEL: Record<FranchiseEntry['type'], string | null> = { main: null, expansion: 'Expansion', remake: 'Remake', remaster: 'Remaster', expanded: 'Expanded edition' };

/**
 * Track C4: every game in this game's series (IGDB, with your own Twitch app) on a horizontal timeline by release
 * year. Games you own are lit and open their page; the others open their Discover page. Arrow keys move between
 * games (Home/End jump to the ends); the row scrolls to keep the focused game in view.
 */
export function FranchiseTimeline({ params, cacheKey }: { params: { gameId: string } | { key: string; appId: string | null }; cacheKey: string }) {
  const enrichment = useStore((s) => `${s.settings?.['dataSources.enrichment']}${s.settings?.['privacy.localOnly']}`);
  const { data } = useBridgeData<Franchise>('franchise.get', params, `${cacheKey}|${enrichment}`);
  const navigate = useStore((s) => s.navigate);
  if (!data) return null;
  if (data.status === 'noKey' && 'gameId' in params) {
    return (
      <aside className="gi-ft gi-ft--quiet surface" aria-label="Series timeline">
        <Sparkles size={16} aria-hidden />
        <span>Connect IGDB to see every game in this one’s series on a timeline.</span>
        <Button size="sm" variant="ghost" onClick={() => navigate({ name: 'settings', section: 'library' })}>Data sources</Button>
      </aside>
    );
  }
  if (!data.entries.length || data.entries.length < 2) return null;
  return <Timeline f={data} />;
}

function Timeline({ f }: { f: Franchise }) {
  const navigate = useStore((s) => s.navigate);
  const gamesById = useStore((s) => s.gamesById);
  const reduce = useReducedMotion();
  const scroller = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, f.entries.findIndex((e) => e.current));
  const [focusIdx, setFocusIdx] = useState(current);
  const [edges, setEdges] = useState({ start: true, end: true });

  // Columns: each game, with a "…" between years more than two apart.
  const cols = useMemo(() => {
    const out: ({ kind: 'game'; e: FranchiseEntry; i: number } | { kind: 'gap'; from: number; to: number })[] = [];
    f.entries.forEach((e, i) => {
      const prev = f.entries[i - 1];
      if (prev?.year && e.year && e.year - prev.year > 2) out.push({ kind: 'gap', from: prev.year, to: e.year });
      out.push({ kind: 'game', e, i });
    });
    return out;
  }, [f.entries]);

  const updateEdges = () => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
  };
  useEffect(() => {
    const el = scroller.current;
    const cur = items.current[current];
    if (el && cur) el.scrollLeft = Math.max(0, cur.offsetLeft - el.clientWidth / 2 + cur.offsetWidth / 2);
    updateEdges();
  }, [current, f.entries.length]);

  const move = (to: number) => {
    const i = Math.max(0, Math.min(f.entries.length - 1, to));
    setFocusIdx(i);
    const el = items.current[i];
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', inline: 'center', block: 'nearest' });
  };
  const onKey = (e: KeyboardEvent) => {
    const map: Record<string, number> = { ArrowRight: focusIdx + 1, ArrowLeft: focusIdx - 1, Home: 0, End: f.entries.length - 1 };
    if (e.key in map) {
      e.preventDefault();
      move(map[e.key]);
    }
  };
  const page = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.8, behavior: reduce ? 'auto' : 'smooth' });
  const open = (e: FranchiseEntry) => {
    if (e.current) return;
    if (e.gameId && gamesById.has(e.gameId)) navigate({ name: 'game', id: e.gameId });
    else navigate({ name: 'discoverGame', key: e.discoverKey, title: e.name });
  };

  return (
    <section className="gi-ft surface" aria-labelledby="gi-ft-title" data-testid="franchise-timeline">
      <header className="gi-ft__head">
        <h2 id="gi-ft-title" className="gi-ft__title">{f.kind === 'series' ? `The ${f.name} series` : `The ${f.name} franchise`}</h2>
        <span className="gi-ft__meta">
          <Library size={13} aria-hidden /> {f.owned} of {f.entries.length} in your library
        </span>
        <span className="gi-ft__nav">
          <IconButton size="sm" label="Scroll back" disabled={edges.start} onClick={() => page(-1)}><ChevronLeft size={16} /></IconButton>
          <IconButton size="sm" label="Scroll on" disabled={edges.end} onClick={() => page(1)}><ChevronRight size={16} /></IconButton>
        </span>
      </header>
      <div className="gi-ft__scroller" ref={scroller} onScroll={updateEdges} data-start={edges.start || undefined} data-end={edges.end || undefined}>
        <ol className="gi-ft__track" aria-label={`${f.name}: ${f.entries.length} games by release year. Use the arrow keys to move between them.`} onKeyDown={onKey}>
          {cols.map((c, k) => c.kind === 'gap' ? (
            <li key={`gap-${k}`} className="gi-ft__gap" aria-hidden><span>{c.to - c.from - 1}-year gap</span></li>
          ) : (
            <motion.li key={c.e.igdbId} className="gi-ft__item" data-owned={c.e.gameId ? true : undefined} data-current={c.e.current || undefined}
              initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: Math.min(c.i, 12) * 0.04, ease: [0.16, 1, 0.3, 1] }}>
              <span className="gi-ft__year num" aria-hidden>{c.e.year ?? 'TBA'}</span>
              <span className="gi-ft__dot" aria-hidden />
              <button
                ref={(el) => { items.current[c.i] = el; }}
                className="gi-ft__card"
                tabIndex={c.i === focusIdx ? 0 : -1}
                aria-current={c.e.current ? 'page' : undefined}
                onFocus={() => setFocusIdx(c.i)}
                onClick={() => open(c.e)}
                aria-label={`${c.e.name}, ${c.e.year ?? 'release date not announced'}${TYPE_LABEL[c.e.type] ? `, ${TYPE_LABEL[c.e.type]}` : ''}. ${c.e.current ? 'This game.' : c.e.gameId ? 'In your library: opens its page.' : 'Not in your library: opens its Discover page.'}`}
              >
                <span className="gi-ft__cover">
                  {c.e.gameId && gamesById.get(c.e.gameId) ? <GameCover game={gamesById.get(c.e.gameId)!} /> : <SeriesCover entry={c.e} />}
                </span>
                <span className="gi-ft__name">{c.e.name}</span>
                <span className="gi-ft__tags">
                  {c.e.current ? <span className="gi-ft__badge gi-ft__badge--here"><MapPin size={11} aria-hidden /> You’re here</span>
                    : c.e.gameId ? <span className="gi-ft__badge gi-ft__badge--owned"><Library size={11} aria-hidden /> Owned</span>
                      : <span className="gi-ft__badge"><Compass size={11} aria-hidden /> Discover</span>}
                  {TYPE_LABEL[c.e.type] && <span className="gi-ft__badge">{TYPE_LABEL[c.e.type]}</span>}
                </span>
              </button>
            </motion.li>
          ))}
        </ol>
      </div>
      <p className="gi-tile__src gi-ft__src">
        <ServiceLogo service="igdb" size={14} decorative /> {f.kind === 'series' ? 'Series' : 'Franchise'} from IGDB.com (main games, remakes, remasters and standalone expansions)
        {f.fetchedAt ? ` · checked ${formatRelative(f.fetchedAt).toLowerCase()}` : ''}{f.stale ? ' · couldn’t refresh' : ''}. Owned games are matched by Steam app ID or exact title.
      </p>
    </section>
  );
}

/** IGDB's cover for a game you don't own, copied into the art cache when asked; a quiet initial tile otherwise. */
function SeriesCover({ entry }: { entry: FranchiseEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!entry.hasCover) return;
    call<{ url: string | null }>('franchise.cover', { igdbId: entry.igdbId }).then((r) => alive && setUrl(r?.url ?? null)).catch(() => {});
    return () => { alive = false; };
  }, [entry.igdbId, entry.hasCover]);
  return url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <span className="gi-ft__initial" aria-hidden>{entry.name.slice(0, 1)}</span>;
}
