import { memo, useMemo, useRef, type ReactNode } from 'react';
import { CalendarClock, Check, Cloud, Puzzle } from 'lucide-react';
import type { DiscoverResult, DiscoverSourceId, Game, PlatformKey } from '../../bridge/types';
import { cardPrice, highlightParts, releaseLabel, SOURCE_NAMES } from '../../lib/discover';
import { captureFlight, useFlightLanding } from '../../lib/flight';
import { useDiscoverCloud } from '../../state/discoverCloud'; // Track D5
import { SERVICE_SHORT } from '../../lib/cloud';
import { PLATFORM_NAMES } from '../../lib/format';
import { useDiscoverImage } from '../../state/discover';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../game/GameCover';
import { StoreLogo, StoreLogos } from '../ui/StoreLogo';
import { ServiceLogo } from '../ui/ServiceLogo';
import './discover.css';
import '../cloud/cloud-plus.css'; // Track D5: the card's cloud badge

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

/**
 * Opens a result: a library game's own page, else the Discover page for it, flying the cover across. A Steam game you
 * own is found by its app ID even when the result didn't know (Watching, the wishlist, store shelves).
 */
export function openResult(r: Pick<DiscoverResult, 'key' | 'title' | 'libraryGameId'>, coverEl: Element | null | undefined) {
  const s = useStore.getState();
  const steamApp = /^steam-(\d{1,10})$/.exec(r.key)?.[1];
  const owned = r.libraryGameId && s.gamesById.has(r.libraryGameId) ? r.libraryGameId : steamApp ? libraryIdForSteamApp(steamApp) : null;
  if (owned) {
    captureFlight(owned, coverEl);
    s.navigate({ name: 'game', id: owned });
  } else {
    captureFlight(`discover:${r.key}`, coverEl);
    s.navigate({ name: 'discoverGame', key: r.key, title: r.title });
  }
}

/** Track C3: the library game with this Steam app ID (on the game or any Steam copy), if you have it. */
export function libraryIdForSteamApp(appId: string): string | null {
  const { library } = useStore.getState();
  const g = library.games.find((x) => x.installations.some((i) => i.platform === 'steam' && i.platformGameId === appId));
  return g?.id ?? null;
}

/** Track C3: opens a Steam game's VYSTRAL page (yours when you own it, else its Discover page). Never the store. */
export function openSteamApp(appId: string, title: string, libraryGameId: string | null | undefined, coverEl?: Element | null) {
  if (!/^\d{1,10}$/.test(appId)) return;
  openResult({ key: `steam-${appId}`, title, libraryGameId: libraryGameId ?? null }, coverEl);
}

export function storeNames(stores: PlatformKey[]): string {
  return listWords(stores.map((p) => PLATFORM_NAMES[p] ?? p));
}

/** A card in the Discover grid. */
export const ResultCard = memo(function ResultCard({ r, query, extra, showSources = true }: { r: DiscoverResult; query: string | null; extra?: ReactNode; showSources?: boolean }) {
  const coverRef = useRef<HTMLDivElement>(null);
  const price = cardPrice(r);
  const owned = !!r.libraryGameId;
  const release = releaseLabel(r);
  // Track D5: coming back from a game's page, its cover flies back into this card (a crossfade with reduced motion).
  const reduce = useReducedMotion();
  useFlightLanding(`discover:${r.key}`, coverRef, !owned, 1, reduce);
  // Track D5: which cloud services list it (from catalogues already downloaded; only while cloud play is on).
  const cloud = useDiscoverCloud(owned ? null : r.key);
  const cloudNames = cloud ? [...new Set(cloud.map((c) => SERVICE_SHORT[c.service]))] : [];
  const label = [
    r.title, release ?? (r.year ? String(r.year) : null), owned ? 'in your library' : null, r.kind === 'extra' ? 'add-on or extra' : null,
    r.stores.length ? `sold on ${storeNames(r.stores)}` : null,
    price ? (price.now === 'Free' ? 'free to play' : `${price.now} on Steam${price.cut ? `, ${price.cut}% off` : ''}`) : null,
    showSources && r.sources.length ? `found on ${listWords(r.sources.map((s) => SOURCE_NAMES[s]))}` : null,
    cloudNames.length ? `playable in the cloud with ${listWords(cloudNames)}${cloud!.every((c) => c.match === 'title') ? ' (likely match)' : ''}` : null,
  ].filter(Boolean).join(', ');
  return (
    <button className="dcard" data-discover-key={r.key} data-owned={owned || undefined} aria-label={label} onClick={() => openResult(r, coverRef.current)}>
      <div className="dcard__cover" ref={coverRef}>
        <DiscoverCover itemKey={r.key} title={r.title} known={r.cover} genres={r.genres} />
        {owned && <span className="dcard__owned"><Check size={12} aria-hidden /> In your library</span>}
        {!owned && price && (
          <span className="dcard__price num" data-free={price.now === 'Free' || undefined}>{price.cut > 0 && <span className="dcard__cut">−{price.cut}%</span>}{price.now}</span>
        )}
        {r.kind === 'extra' && <span className="dcard__extra"><Puzzle size={11} aria-hidden /> Extra</span>}
        {r.kind !== 'extra' && r.comingSoon && <span className="dcard__extra dcard__soon"><CalendarClock size={11} aria-hidden /> Soon</span>}
        {cloudNames.length > 0 && (
          <span className="dcard__cloud" title={`Playable in the cloud: ${listWords(cloudNames)}`} data-likely={cloud!.every((c) => c.match === 'title') || undefined} aria-hidden>
            <Cloud size={11} strokeWidth={2.4} /> Cloud
          </span>
        )}
      </div>
      <div className="dcard__body">
        <div className="dcard__title"><Highlight text={r.title} query={query} /></div>
        <div className="dcard__meta">
          {release ? <span className="dcard__release">{release}</span> : r.year && <span className="num">{r.year}</span>}
          {r.stores.length > 0 && <StoreLogos platforms={r.stores} size={14} decorative />}
          <span className="dcard__spacer" />
          {showSources && <SourceMarks sources={r.sources} size={12} label={false} />}
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
