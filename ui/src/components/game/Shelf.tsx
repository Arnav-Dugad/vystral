import { useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Game } from '../../bridge/types';
import { formatDuration, formatRelative, lastPlayed, PLATFORM_NAMES } from '../../lib/format';
import { peekPalette, titleHue } from '../../lib/palette';
import { useStore } from '../../state/store';
import { IconButton, SectionHead } from '../ui/primitives';
import { GameCard } from './GameCard';
import { GameCover } from './GameCover';
import { useGameMenu } from './useGameMenu';
import './shelf.css';

/** Horizontal row of games with scroll buttons; native scrolling with snap (touchpad-friendly). */
export function Shelf({ title, meta, games, variant = 'portrait', caption, action }: {
  title: ReactNode;
  meta?: ReactNode;
  games: Game[];
  variant?: 'portrait' | 'landscape';
  caption?: (g: Game) => ReactNode;
  action?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  if (games.length === 0) return null;

  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setEdge({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 });
  };

  return (
    <section className="shelf" aria-label={typeof title === 'string' ? title : undefined}>
      <SectionHead
        title={title}
        meta={meta}
        action={
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {action}
            <IconButton label="Scroll left" size="sm" disabled={edge.start} onClick={() => scroll(-1)}>
              <ChevronLeft size={16} />
            </IconButton>
            <IconButton label="Scroll right" size="sm" disabled={edge.end} onClick={() => scroll(1)}>
              <ChevronRight size={16} />
            </IconButton>
          </div>
        }
      />
      <div className={`shelf__track shelf__track--${variant}`} ref={ref} onScroll={onScroll}>
        {games.map((g) =>
          variant === 'landscape' ? <LandscapeTile key={g.id} game={g} caption={caption?.(g)} /> : (
            <div key={g.id} className="shelf__item">
              <GameCard game={g} />
              {caption && <div className="shelf__caption">{caption(g)}</div>}
            </div>
          ),
        )}
      </div>
    </section>
  );
}

function LandscapeTile({ game, caption }: { game: Game; caption?: ReactNode }) {
  const navigate = useStore((s) => s.navigate);
  const setFocusGame = useStore((s) => s.setFocusGame);
  const { open, element } = useGameMenu(game);
  const lp = lastPlayed(game);
  const accent = peekPalette(game)?.accent ?? `oklch(0.72 0.15 ${titleHue(game.title)})`;
  return (
    <div className="shelf__item shelf__item--landscape">
      <button
        className="tile"
        data-game-id={game.id}
        style={{ ['--card-accent' as string]: accent }}
        onClick={() => navigate({ name: 'game', id: game.id })}
        onMouseEnter={() => setFocusGame(game.id)}
        onFocus={() => setFocusGame(game.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          open({ x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu') {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            open({ x: r.left + 40, y: r.top + 40 });
          }
        }}
        aria-label={`${game.title}${lp.at ? `, last played ${formatRelative(lp.at)}` : ''}`}
      >
        <div className="card__frame">
          <GameCover game={game} kind="hero" />
        </div>
        <div className="tile__overlay">
          {game.art.logo ? <img className="tile__logo" src={game.art.logo} alt="" loading="lazy" /> : null}
          <div className="tile__title truncate">{game.art.logo ? '' : game.title}</div>
          <div className="tile__sub">
            {caption ?? (
              <>
                <span>{lp.at ? formatRelative(lp.at) : 'Not played yet'}</span>
                {game.trackedSeconds > 0 && <span>{formatDuration(game.trackedSeconds)} tracked</span>}
                <span>{[...new Set(game.installations.map((i) => PLATFORM_NAMES[i.platform]))].join(' · ')}</span>
              </>
            )}
          </div>
        </div>
      </button>
      {element}
    </div>
  );
}
