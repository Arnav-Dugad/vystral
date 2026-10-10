/** Presentational pieces shared by the Journal and Performance views: stat tiles and game thumbnails. */
import type { ReactNode } from 'react';
import { Gamepad2 } from 'lucide-react';
import type { Game } from '../../bridge/types';
import { GameCover } from '../../components/game/GameCover';
import './kit.css';
import './viz-tokens.css';

export function StatTile({ label, value, sub, icon, unavailable }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; unavailable?: boolean }) {
  return (
    <div className="vx-tile surface" data-unavailable={unavailable || undefined}>
      <div className="vx-tile__label">
        {icon && <span className="vx-tile__icon" aria-hidden>{icon}</span>}
        <span className="caps">{label}</span>
      </div>
      <div className="vx-tile__value">{value}</div>
      {sub && <div className="vx-tile__sub">{sub}</div>}
    </div>
  );
}

/** Cover thumbnail; a neutral tile when the game is no longer in the library. */
export function GameThumb({ game, size = 40 }: { game: Game | undefined; size?: number }) {
  return (
    <span className="vx-thumb" style={{ width: size, height: Math.round(size * 1.5) }} aria-hidden>
      {game ? <GameCover game={game} kind="cover" /> : <span className="vx-thumb__missing"><Gamepad2 size={Math.round(size * 0.45)} /></span>}
    </span>
  );
}
