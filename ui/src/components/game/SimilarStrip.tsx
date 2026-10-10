import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Hourglass, Sparkles } from 'lucide-react';
import type { Enrichment, Game } from '../../bridge/types';
import { similarInLibrary } from '../../lib/similar';
import { useLibraryTags } from '../../state/libraryTags';
import { useReducedMotion, useStore } from '../../state/store';
import { useBridgeData } from './insights/useBridgeData';
import { GameCard } from './GameCard';
import { IconButton, SectionHead } from '../ui/primitives';
import './similar-strip.css';

/**
 * Track D1: "Similar in your library" on every game page — owned games that resemble this one (community tags, genres,
 * series, IGDB's similar games when cached), with forgotten ones first. Computed locally from data already on this PC.
 */
export function SimilarStrip({ game }: { game: Game }) {
  const library = useStore((s) => s.library.games);
  const tags = useLibraryTags();
  const reduce = useReducedMotion();
  // Cached IGDB facts only (enrichment.get reads the local database; it never fetches).
  const params = useMemo(() => ({ gameId: game.id }), [game.id]);
  const { data: enrichment } = useBridgeData<Enrichment>('enrichment.get', params, game.id);
  const facts = useMemo(() => {
    const f = enrichment?.sources?.find((s) => s.source === 'igdb' && s.matched)?.facts;
    return f ? { similar: f.similar ?? [], series: [...(f.series ?? []), ...(f.franchises ?? [])] } : null;
  }, [enrichment]);
  const picks = useMemo(() => similarInLibrary(game, library, { tags, facts, limit: 12 }), [game, library, tags, facts]);

  const rail = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = rail.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    const el = rail.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, picks.length]);
  const page = (dir: 1 | -1) => rail.current?.scrollBy({ left: dir * rail.current.clientWidth * 0.85, behavior: reduce ? 'auto' : 'smooth' });

  if (!picks.length) return null;
  const forgotten = picks.filter((p) => p.forgotten).length;
  return (
    <section className="similar" aria-labelledby={`similar-${game.id}`}>
      <SectionHead
        title={<span id={`similar-${game.id}`}>Similar in your library</span>}
        meta={forgotten ? `${forgotten === 1 ? 'One you haven’t played in a while' : `${forgotten} you haven’t played in a while`} first` : 'From the games you own'}
        action={
          <div className="similar__nav">
            <IconButton label="Scroll back" size="sm" onClick={() => page(-1)} disabled={edges.start}><ChevronLeft size={16} /></IconButton>
            <IconButton label="Scroll on" size="sm" onClick={() => page(1)} disabled={edges.end}><ChevronRight size={16} /></IconButton>
          </div>
        }
      />
      <div className="similar__rail" ref={rail} onScroll={measure} data-start={edges.start || undefined} data-end={edges.end || undefined} role="list" aria-label="Similar games you own">
        {picks.map((p) => (
          <div key={p.game.id} className="similar__item" role="listitem" data-forgotten={p.forgotten ?? undefined}>
            <GameCard game={p.game} />
            <p className="similar__why" title={p.why}>
              {p.forgotten ? <Hourglass size={12} aria-hidden /> : <Sparkles size={12} aria-hidden />}
              <span>{p.why}</span>
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
