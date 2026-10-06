import { memo, useCallback, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { CloudDownload, Heart } from 'lucide-react';
import type { Game } from '../../bridge/types';
import { formatRelative, isInstalled, lastPlayed } from '../../lib/format';
import { peekPalette, titleHue } from '../../lib/palette';
import { captureFlight, useFlightLanding } from '../../lib/flight';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from './GameCover';
import { useGameMenu } from './useGameMenu';
import { InstallBadge } from './InstallProgress';
import { LiveLayer } from './LiveTile';
import { StoreLogos } from '../ui/StoreLogo';
import { TimeToBeatBar } from './TimeToBeatBar';
import { CloudBadge } from '../cloud/CloudBits';

/** Portrait library card. Hover/focus lifts and tilts it; Enter opens; context menu has quick actions. */
export const GameCard = memo(function GameCard({
  game,
  focused,
  showMeta = true,
  onFocusGame,
  tabIndex,
  live,
}: {
  game: Game;
  focused?: boolean;
  showMeta?: boolean;
  onFocusGame?: (id: string) => void;
  tabIndex?: number;
  /** Track K: animate with the game's Steam micro-trailer while visible (Home shelves). */
  live?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const navigate = useStore((s) => s.navigate);
  const setFocusGame = useStore((s) => s.setFocusGame);
  const reduce = useReducedMotion();
  const { open: openMenu, element: menu } = useGameMenu(game);
  const frameRef = useRef<HTMLDivElement>(null);
  // Returning from the detail page, the cover springs back into this card.
  useFlightLanding(game.id, frameRef, !reduce, 1);
  const [tilt, setTilt] = useState<CSSProperties>({});
  const installed = isInstalled(game);
  const lp = lastPlayed(game);
  const accent = peekPalette(game)?.accent ?? `oklch(0.72 0.15 ${titleHue(game.title)})`;
  const platforms = [...new Set(game.installations.map((i) => i.platform))];

  const onMove = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (reduce) return;
      const r = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      setTilt({ ['--rx' as string]: `${(-y * 6).toFixed(2)}deg`, ['--ry' as string]: `${(x * 7).toFixed(2)}deg`, ['--sheen' as string]: (x * 60).toFixed(1) });
    },
    [reduce],
  );

  const activate = () => {
    setFocusGame(game.id);
    onFocusGame?.(game.id);
  };

  return (
    <div>
      <button
        ref={ref}
        className="card"
        data-focused={focused || undefined}
        data-dim={!installed || undefined}
        data-game-id={game.id}
        tabIndex={tabIndex}
        style={{ ['--card-accent' as string]: accent, ...tilt }}
        aria-label={`${game.title}${installed ? '' : ', not installed'}${game.favorite ? ', favorite' : ''}`}
        onMouseMove={onMove}
        onMouseEnter={activate}
        onFocus={activate}
        onMouseLeave={() => setTilt({})}
        onClick={() => {
          // Card → page flight: the detail cover starts from this card's rect.
          captureFlight(game.id, frameRef.current);
          navigate({ name: 'game', id: game.id });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu({ x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            const r = ref.current!.getBoundingClientRect();
            openMenu({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }
        }}
      >
        <div className="card__frame" ref={frameRef} data-live={live || undefined}>
          <GameCover game={game} />
          {live && <LiveLayer game={game} />}
          {/* Track M: playtime vs IGDB time-to-beat (renders nothing without an estimate). */}
          {showMeta && <TimeToBeatBar game={game} variant="card" />}
        </div>
        <div className="card__badges">
          <span />
          {game.favorite && <Heart className="card__fav" size={16} fill="currentColor" aria-hidden />}
        </div>
        {!installed && (
          // A quiet chip that names itself on hover/focus, so it never sits on top of the cover's logo.
          <div className="card__state" aria-hidden>
            <span className="card__chip">
              <CloudDownload size={13} strokeWidth={2.2} />
              <span className="card__chip-label">Not installed</span>
            </span>
          </div>
        )}
        <InstallBadge gameId={game.id} />
      </button>
      {showMeta && (
        <div className="card__meta">
          <div className="card__title truncate" title={game.title}>
            {game.title}
          </div>
          <div className="card__sub">
            <StoreLogos platforms={platforms} />
            <CloudBadge gameId={game.id} />
            {lp.at && <span className="truncate">{formatRelative(lp.at)}</span>}
          </div>
        </div>
      )}
      {menu}
    </div>
  );
});
