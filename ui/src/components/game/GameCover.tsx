import { memo, useState } from 'react';
import type { Game } from '../../bridge/types';
import { hashString } from '../../lib/color';
import { titleHue } from '../../lib/palette';
import './game.css';

/**
 * Cover art, or — when a game has none — an original typographic cover generated from the
 * title. It never borrows unrelated artwork to fill space.
 */
export const GameCover = memo(function GameCover({
  game,
  kind = 'cover',
  eager,
}: {
  game: Game;
  kind?: 'cover' | 'hero' | 'header';
  eager?: boolean;
}) {
  const src = kind === 'cover' ? game.art.cover : kind === 'hero' ? game.art.hero ?? game.art.header : game.art.header ?? game.art.hero;
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const showArt = src && !failed;

  return (
    <div className={`cover cover--${kind}`} data-loaded={loaded || !showArt}>
      {(!showArt || !loaded) && <GeneratedCover game={game} kind={kind} />}
      {showArt && (
        <img
          className="cover__img"
          src={src}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
      {kind === 'cover' && !showArt && game.art.icon && <img className="cover__icon" src={game.art.icon} alt="" loading="lazy" decoding="async" />}
    </div>
  );
});

const MOTIFS = ['rings', 'rays', 'grid', 'orbit', 'waves'] as const;

function GeneratedCover({ game, kind }: { game: Game; kind: string }) {
  const h = hashString(game.title);
  const hue = titleHue(game.title);
  const hue2 = (hue + 40 + (h % 80)) % 360;
  const motif = MOTIFS[h % MOTIFS.length];
  const words = game.title.split(/\s+/);
  const long = game.title.length > 22;
  const longestWord = Math.max(4, ...words.map((w) => w.length));
  return (
    <div
      className="gen-cover"
      style={{
        ['--h1' as string]: hue,
        ['--h2' as string]: hue2,
        ['--chars' as string]: longestWord,
      }}
      aria-hidden
    >
      <svg className="gen-cover__motif" viewBox="0 0 200 300" preserveAspectRatio="xMidYMid slice">
        {motif === 'rings' &&
          Array.from({ length: 7 }, (_, i) => <circle key={i} cx={150} cy={80} r={18 + i * 22} fill="none" stroke="currentColor" strokeOpacity={0.5 - i * 0.06} strokeWidth={1} />)}
        {motif === 'rays' &&
          Array.from({ length: 14 }, (_, i) => (
            <line key={i} x1={170} y1={40} x2={170 - 260 * Math.cos((i * Math.PI) / 26)} y2={40 + 260 * Math.sin((i * Math.PI) / 26)} stroke="currentColor" strokeOpacity={0.28} strokeWidth={1} />
          ))}
        {motif === 'grid' &&
          Array.from({ length: 70 }, (_, i) => <circle key={i} cx={14 + (i % 7) * 28} cy={14 + Math.floor(i / 7) * 28} r={1.4} fill="currentColor" fillOpacity={0.45 - Math.floor(i / 7) * 0.035} />)}
        {motif === 'orbit' && (
          <g fill="none" stroke="currentColor" strokeWidth={1}>
            <ellipse cx={100} cy={110} rx={120} ry={40} strokeOpacity={0.35} transform="rotate(-24 100 110)" />
            <ellipse cx={100} cy={110} rx={80} ry={24} strokeOpacity={0.3} transform="rotate(-24 100 110)" />
            <circle cx={100} cy={110} r={22} fill="currentColor" fillOpacity={0.18} />
          </g>
        )}
        {motif === 'waves' &&
          Array.from({ length: 9 }, (_, i) => (
            <path key={i} d={`M -10 ${60 + i * 18} Q 50 ${40 + i * 18} 100 ${60 + i * 18} T 210 ${60 + i * 18}`} fill="none" stroke="currentColor" strokeOpacity={0.4 - i * 0.035} strokeWidth={1} />
          ))}
      </svg>
      {/* Wide art is decorative: the surrounding UI always shows the title itself. */}
      {kind === 'cover' && (
        <div className={`gen-cover__title ${long ? 'gen-cover__title--long' : ''}`}>
          {words.map((w, i) => (
            <span key={i}>{w} </span>
          ))}
        </div>
      )}
    </div>
  );
}
