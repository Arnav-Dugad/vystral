import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CloudOff, Compass, Eye, Loader2, Plus, Puzzle, RefreshCw, Search, SearchX, Sparkles } from 'lucide-react';
import type { Game } from '../../bridge/types';
import { PLATFORM_NAMES } from '../../lib/format';
import { useDiscoverImage } from '../../state/discover';
import { DiscoverCover, pseudoGame } from '../../components/discover/DiscoverBits';
import { GameCover } from '../../components/game/GameCover';
import { StoreLogo } from '../../components/ui/StoreLogo';
import { PadGlyph, PadHint } from '../../components/ui/primitives';
import type { Tile } from './rows';
import './immersive-discover.css';

type DiscoverTile = Extract<Tile, { kind: 'discover' }>;
type SearchTile = Extract<Tile, { kind: 'search' }>;
type NoteTile = Extract<Tile, { kind: 'note' }>;

/** Track C6: a game you don't own, as a card — its cover (asked for once on screen), price and Watching mark. */
export function DiscoverFace({ tile, watching }: { tile: DiscoverTile; watching: boolean }) {
  const it = tile.item;
  return (
    <div className="imm-dcard">
      <DiscoverCover itemKey={it.key} title={it.title} known={it.cover} genres={it.genres} />
      {(watching || it.extra) && (
        <span className="imm-dcard__flags">
          {watching && <span className="imm-dcard__flag" title="On your Watching list"><Eye size="0.95em" aria-hidden /></span>}
          {it.extra && <span className="imm-dcard__flag"><Puzzle size="0.95em" aria-hidden /> Add-on</span>}
        </span>
      )}
      {it.price && (
        <span className="imm-dcard__price num" data-sale={it.cut > 0 || undefined}>
          {it.cut > 0 && <span className="imm-dcard__cut">−{it.cut}%</span>}
          {it.price}
        </span>
      )}
    </div>
  );
}

/** The search card ("Search any game"), or a suggested search over the art of the game it comes from. */
export function SearchFace({ tile }: { tile: SearchTile }) {
  return (
    <div className="imm-dsearch" data-idea={tile.query ? true : undefined}>
      {tile.sample && (
        <div className="imm-dsearch__art" aria-hidden>
          <GameCover game={tile.sample} kind="cover" />
        </div>
      )}
      <div className="imm-dsearch__face">
        <span className="imm-dsearch__icon" aria-hidden>{tile.query ? <Sparkles /> : <Search />}</span>
        <span className="imm-dsearch__label">{tile.query ? <>More <strong>{tile.label}</strong></> : tile.label}</span>
        {!tile.query && <span className="imm-dsearch__glyph" aria-hidden><PadGlyph button="Y" /></span>}
      </div>
    </div>
  );
}

/** A status card: searching (shimmering), nothing found, offline, search off, show more. */
export function NoteFace({ tile }: { tile: NoteTile }) {
  const icon = tile.busy ? <Loader2 className="imm-dnote__spin" /> : tile.action === 'more' ? <Plus /> : tile.action === 'retry' ? <RefreshCw /> : tile.action === 'turnOn' ? <Compass />
    : tile.key === 'offline' ? <CloudOff /> : tile.key === 'none' ? <SearchX /> : tile.key === 'error' ? <AlertTriangle /> : tile.key === 'watch-empty' ? <Eye /> : <Compass />;
  return (
    <div className="imm-dnote" data-busy={tile.busy || undefined}>
      <span className="imm-dnote__icon" aria-hidden>{icon}</span>
      {!tile.busy && <span className="imm-dnote__title">{tile.title}</span>}
    </div>
  );
}

const ACTION_LABEL = { turnOn: 'Turn on', retry: 'Try again', more: 'Show more', search: 'Search again' } as const;

/** The info area above the rows for a Discover tile. */
export function DiscoverInfo({ tile, watching }: { tile: DiscoverTile | SearchTile | NoteTile; watching: boolean }) {
  if (tile.kind === 'note') {
    return (
      <>
        <h1 className="imm__title imm__title--section">{tile.title}</h1>
        {!tile.busy && <p className="imm__desc imm-dinfo__body">{tile.body}</p>}
        {tile.action && !tile.busy && <div className="imm__meta"><PadHint button="A">{ACTION_LABEL[tile.action]}</PadHint></div>}
      </>
    );
  }
  if (tile.kind === 'search') {
    return (
      <>
        <h1 className="imm__title imm__title--section">{tile.query ? `More ${tile.query}` : 'Search any game'}</h1>
        <div className="imm__meta">
          <span>{tile.query ? `From ${tile.sample?.title ?? 'your library'} · sequels, prequels and spin-offs` : 'Games you own and games you don’t: prices, time to beat and where to get them'}</span>
          <PadHint button="A">{tile.query ? 'Search' : 'Type'}</PadHint>
        </div>
      </>
    );
  }
  const it = tile.item;
  return (
    <>
      <span className="imm-dinfo__kicker"><Compass size="0.95em" aria-hidden /> Not in your library{it.source === 'wishlist' ? ' · on your Steam wishlist' : ''}</span>
      <h1 className="imm__title">{it.title}</h1>
      <div className="imm__meta">
        {it.year && <span className="num">{it.year}</span>}
        {it.stores.length > 0 && (
          <span className="imm__meta-stores">
            {it.stores.slice(0, 4).map((p) => (
              <span key={p} className="imm__store"><StoreLogo platform={p} size={20} decorative />{PLATFORM_NAMES[p]}</span>
            ))}
          </span>
        )}
        {it.price && <span className="num">{it.cut ? `${it.price} · −${it.cut}%` : it.price}</span>}
        {watching && <span className="imm-dinfo__watch"><Eye size="0.95em" aria-hidden /> Watching</span>}
        {it.genres.length > 0 && <span className="imm__genres">{it.genres.slice(0, 3).join(' · ')}</span>}
      </div>
      {it.note && !watching && <p className="imm__desc">{it.note}</p>}
    </>
  );
}

/**
 * The hero art for a focused Discover card: a stand-in game carrying the result's hero (asked for once focus rests),
 * never added to the library and never launched.
 */
export function useDiscoverStage(tile: Tile | null): Game | null {
  const key = tile?.kind === 'discover' ? tile.item.key : null;
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!key) return;
    const t = window.setTimeout(() => setSettled(key), 220);
    return () => window.clearTimeout(t);
  }, [key]);
  const hero = useDiscoverImage(settled === key ? key : null, 'hero');
  const item = tile?.kind === 'discover' ? tile.item : null;
  return useMemo(
    () => (item ? pseudoGame(`discover:${item.key}`, item.title, { cover: item.cover, hero: settled === item.key ? hero.url ?? null : null }, item.genres) : null),
    [item, hero.url, settled],
  );
}
