import { memo, useMemo, useRef, type ReactNode } from 'react';
import { Check, Puzzle } from 'lucide-react';
import type { DiscoverResult, DiscoverSourceId, Game, PlatformKey } from '../../bridge/types';
import { formatStorePrice, highlightParts, SOURCE_NAMES } from '../../lib/discover';
import { captureFlight } from '../../lib/flight';
import { PLATFORM_NAMES } from '../../lib/format';
import { useDiscoverImage } from '../../state/discover';
import { useStore } from '../../state/store';
import { GameCover } from '../game/GameCover';
import { StoreLogo, StoreLogos } from '../ui/StoreLogo';
import { ServiceLogo } from '../ui/ServiceLogo';
import './discover.css';

/**
 * A stand-in Game for components that draw one (covers, the hero trailer). It is never added to the library and
 * never launched: it only carries a title, art and an ID.
 */
export function pseudoGame(id: string, title: string, art: Partial<Game['art']> = {}, genres: string[] = []): Game {
  return {
    id, title, sortTitle: title.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null, genres,
    favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null, ...art }, installations: [], collections: [], trackedSeconds: 0,
    sessionCount: 0, lastTrackedPlay: null, added: '1970-01-01T00:00:00Z',
  };
}

/** Cover or hero art for a Discover result, fetched lazily (once on screen); a generated cover until then, or when there is none. */
export const DiscoverCover = memo(function DiscoverCover({
  itemKey, title, known, kind = 'cover', eager, genres,
}: { itemKey: string; title: string; known?: string | null; kind?: 'cover' | 'hero' | 'header'; eager?: boolean; genres?: string[] }) {
  const { url, ref } = useDiscoverImage(itemKey, kind, { known });
  const game = useMemo(
    () => pseudoGame(`discover:${itemKey}`, title, kind === 'cover' ? { cover: url ?? null } : { hero: url ?? null }, genres),
    [itemKey, title, url, kind, genres],
  );
  return (
    <div ref={ref} className="dcover" data-state={url === undefined ? 'loading' : url ? 'art' : 'generated'}>
      <GameCover game={game} kind={kind} eager={eager} />
    </div>
  );
});

/** The title with what was typed marked. */
export function Highlight({ text, query }: { text: string; query: string | null | undefined }) {
  const parts = useMemo(() => (query ? highlightParts(text, query) : [{ text, hit: false }]), [text, query]);
  return <>{parts.map((p, i) => (p.hit ? <mark key={i} className="hl">{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

/** Marks of the sources that found a game. Steam is a store, so it shows the store's mark. */
export function SourceMarks({ sources, size = 14, label = true }: { sources: DiscoverSourceId[]; size?: number; label?: boolean }) {
  if (!sources.length) return null;
  const names = sources.map((s) => SOURCE_NAMES[s]);
  return (
    <span className="dsrc-marks" role={label ? 'img' : undefined} aria-label={label ? `Found on ${listWords(names)}` : undefined} aria-hidden={label ? undefined : true}
      title={`Found on ${listWords(names)}`}>
      {sources.map((s) => (s === 'steam'
        ? <StoreLogo key={s} platform="steam" size={size} decorative />
        : <ServiceLogo key={s} service={s} size={size} decorative />))}
    </span>
  );
}

export function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Opens a result: a library game's own page, else the Discover page for it, flying the cover across. */
export function openResult(r: Pick<DiscoverResult, 'key' | 'title' | 'libraryGameId'>, coverEl: Element | null | undefined) {
  const s = useStore.getState();
  if (r.libraryGameId && s.gamesById.has(r.libraryGameId)) {
    captureFlight(r.libraryGameId, coverEl);
    s.navigate({ name: 'game', id: r.libraryGameId });
  } else {
    captureFlight(`discover:${r.key}`, coverEl);
    s.navigate({ name: 'discoverGame', key: r.key, title: r.title });
  }
}

export function storeNames(stores: PlatformKey[]): string {
  return listWords(stores.map((p) => PLATFORM_NAMES[p] ?? p));
}

/** A card in the Discover grid. */
export const ResultCard = memo(function ResultCard({ r, query, extra }: { r: DiscoverResult; query: string | null; extra?: ReactNode }) {
  const coverRef = useRef<HTMLDivElement>(null);
  const price = formatStorePrice(r.price);
  const owned = !!r.libraryGameId;
  const label = [
    r.title, r.year ? String(r.year) : null, owned ? 'in your library' : null, r.kind === 'extra' ? 'add-on or extra' : null,
    r.stores.length ? `sold on ${storeNames(r.stores)}` : null, price ? `${price.now} on Steam${price.cut ? `, ${price.cut}% off` : ''}` : null,
    `found on ${listWords(r.sources.map((s) => SOURCE_NAMES[s]))}`,
  ].filter(Boolean).join(', ');
  return (
    <button className="dcard" data-discover-key={r.key} data-owned={owned || undefined} aria-label={label} onClick={() => openResult(r, coverRef.current)}>
      <div className="dcard__cover" ref={coverRef}>
        <DiscoverCover itemKey={r.key} title={r.title} known={r.cover} genres={r.genres} />
        {owned && <span className="dcard__owned"><Check size={12} aria-hidden /> In your library</span>}
        {!owned && price && (
          <span className="dcard__price num">{price.cut > 0 && <span className="dcard__cut">−{price.cut}%</span>}{price.now}</span>
        )}
        {r.kind === 'extra' && <span className="dcard__extra"><Puzzle size={11} aria-hidden /> Extra</span>}
      </div>
      <div className="dcard__body">
        <div className="dcard__title"><Highlight text={r.title} query={query} /></div>
        <div className="dcard__meta">
          {r.year && <span className="num">{r.year}</span>}
          {r.stores.length > 0 && <StoreLogos platforms={r.stores} size={14} decorative />}
          <span className="dcard__spacer" />
          <SourceMarks sources={r.sources} size={12} label={false} />
        </div>
        {extra}
      </div>
    </button>
  );
});

/** Placeholder cards while sources answer. */
export function ResultSkeletons({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="dcard dcard--skeleton" aria-hidden style={{ ['--i' as string]: i }}>
          <div className="dcard__cover skeleton" />
          <div className="dcard__body"><div className="skeleton" style={{ height: 14, width: '80%' }} /><div className="skeleton" style={{ height: 11, width: '45%', marginTop: 8 }} /></div>
        </div>
      ))}
    </>
  );
}
