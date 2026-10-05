import { memo, useId, useMemo, type ReactNode } from 'react';
import { parseOklch } from '../../lib/color';
import { artKindFor, constellation, hills, illustrationPalette, type ArtKind, type ArtTheme, type IllustrationPalette } from '../../lib/illustration';
import { useStore } from '../../state/store';
import './empty-art.css';

export type { ArtKind };

/** The live accent (artwork-derived or chosen in Settings), as the Living Canvas left it. */
function currentAccent() {
  if (typeof document === 'undefined') return null;
  return parseOklch(getComputedStyle(document.documentElement).getPropertyValue('--game'));
}

/**
 * A small procedurally drawn scene for empty states (constellation, hills, orbits, tide, a fanned
 * shelf, a trophy wreath), tinted from the current game's accent and redrawn for each theme.
 * Decorative: the empty state's heading and text carry the meaning. The original icon sits in the
 * middle so the scene still says what kind of emptiness this is.
 */
export const EmptyArt = memo(function EmptyArt({ kind, seed, icon }: { kind?: ArtKind; seed: string; icon?: ReactNode }) {
  const theme = (useStore((s) => s.settings?.['appearance.theme']) ?? 'obsidian') as ArtTheme;
  const focus = useStore((s) => s.focusGameId);
  const art = kind ?? artKindFor(seed);
  // Re-read the accent when the focused game or theme changes (cheap: one computed-style read).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const palette = useMemo(() => illustrationPalette(currentAccent(), theme), [theme, focus]);
  const uid = useId().replace(/:/g, '');

  return (
    <div className="empty-art" data-kind={art} data-flat={palette.flat || undefined} aria-hidden>
      <svg viewBox="0 0 168 120" className="empty-art__svg" focusable="false">
        <defs>
          <radialGradient id={`g-${uid}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={palette.glow} />
            <stop offset="100%" stopColor={palette.glow} stopOpacity={0} />
          </radialGradient>
          <linearGradient id={`f-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={palette.mid} stopOpacity={0.55} />
            <stop offset="100%" stopColor={palette.faint} stopOpacity={0.1} />
          </linearGradient>
        </defs>
        {!palette.flat && <ellipse cx={84} cy={60} rx={70} ry={50} fill={`url(#g-${uid})`} />}
        <Scene kind={art} seed={seed} p={palette} fill={`url(#f-${uid})`} />
      </svg>
      {icon && <div className="empty-art__icon">{icon}</div>}
    </div>
  );
});

function Scene({ kind, seed, p, fill }: { kind: ArtKind; seed: string; p: IllustrationPalette; fill: string }) {
  switch (kind) {
    case 'constellation': {
      const { stars, links } = constellation(seed);
      return (
        <g>
          {links.map(([a, b]) => (
            <line key={`${a}-${b}`} x1={stars[a].x} y1={stars[a].y} x2={stars[b].x} y2={stars[b].y} stroke={p.mid} strokeOpacity={p.flat ? 1 : 0.55} strokeWidth={0.8} />
          ))}
          {stars.map((s, i) => (
            <circle key={i} className={s.bright ? 'empty-art__twinkle' : undefined} style={{ animationDelay: `${(i * 0.37) % 3}s` }} cx={s.x} cy={s.y} r={s.r} fill={s.bright ? p.star : p.ink} />
          ))}
        </g>
      );
    }
    case 'hills': {
      const [back, middle, front] = hills(seed);
      return (
        <g>
          <circle cx={122} cy={30} r={11} fill="none" stroke={p.ink} strokeWidth={1.2} />
          <circle cx={122} cy={30} r={5} fill={p.star} opacity={p.flat ? 1 : 0.8} />
          <path d={back} fill={p.flat ? 'none' : p.faint} stroke={p.flat ? p.faint : 'none'} opacity={0.7} />
          <path d={middle} fill={p.flat ? 'none' : fill} stroke={p.mid} strokeWidth={0.8} strokeOpacity={0.7} />
          <path d={front} fill="none" stroke={p.ink} strokeWidth={1.2} />
        </g>
      );
    }
    case 'orbits':
      return (
        <g fill="none">
          <g className="empty-art__spin">
            {[0, 1, 2].map((i) => (
              <ellipse key={i} cx={84} cy={60} rx={34 + i * 18} ry={14 + i * 8} transform={`rotate(${-18 + i * 9} 84 60)`} stroke={i === 0 ? p.ink : p.mid} strokeOpacity={p.flat ? 1 : 0.8 - i * 0.2} strokeWidth={1} />
            ))}
          </g>
          <circle cx={84 + 52 * Math.cos(0.6)} cy={60 + 22 * Math.sin(0.6)} r={3} fill={p.star} />
          <circle cx={84 - 70 * Math.cos(0.3)} cy={60 - 30 * Math.sin(0.3)} r={2} fill={p.ink} />
          <circle cx={84 + 34} cy={60 - 10} r={1.6} fill={p.mid} />
        </g>
      );
    case 'tide':
      return (
        <g fill="none" className="empty-art__drift">
          {[0, 1, 2, 3, 4].map((i) => (
            <path
              key={i}
              d={`M -20 ${70 + i * 9} q 21 -${7 - i} 42 0 t 42 0 t 42 0 t 42 0 t 42 0`}
              stroke={i === 0 ? p.ink : i < 3 ? p.mid : p.faint}
              strokeOpacity={p.flat ? 1 : 0.9 - i * 0.14}
              strokeWidth={i === 0 ? 1.3 : 1}
            />
          ))}
          <circle cx={46} cy={34} r={2} fill={p.star} />
          <circle cx={128} cy={26} r={1.4} fill={p.ink} />
        </g>
      );
    case 'shelf':
      return (
        <g>
          {[-2, -1, 1, 2].map((i) => (
            <rect
              key={i}
              x={84 - 13 + Math.sign(i) * (Math.abs(i) * 34 + 2)}
              y={38 + Math.abs(i) * 7}
              width={26}
              height={40}
              rx={5}
              transform={`rotate(${i * 6} ${84 + Math.sign(i) * (Math.abs(i) * 34 + 2)} ${96})`}
              fill={p.flat ? 'none' : fill}
              stroke={Math.abs(i) === 1 ? p.ink : p.mid}
              strokeOpacity={p.flat ? 1 : Math.abs(i) === 1 ? 0.9 : 0.55}
              strokeWidth={1}
            />
          ))}
          <line x1={22} y1={100} x2={146} y2={100} stroke={p.faint} strokeWidth={1.2} strokeLinecap="round" />
        </g>
      );
    case 'trophy':
      return (
        <g fill="none" strokeLinecap="round">
          {[-1, 1].map((side) => (
            <g key={side}>
              <path d={`M ${84 + side * 6} 96 C ${84 + side * 44} 92 ${84 + side * 52} 56 ${84 + side * 34} 24`} stroke={p.mid} strokeWidth={1} strokeOpacity={p.flat ? 1 : 0.7} />
              {[0, 1, 2, 3, 4].map((k) => {
                const t = 0.15 + k * 0.17;
                const x = 84 + side * (6 + 44 * Math.sin(t * Math.PI * 0.9));
                const y = 96 - t * 72;
                return <ellipse key={k} cx={x} cy={y} rx={4.2} ry={2} transform={`rotate(${side * (40 + k * 12)} ${x} ${y})`} fill={k % 2 ? p.ink : p.faint} />;
              })}
            </g>
          ))}
          <path className="empty-art__twinkle" d="M84 10 l1.6 4.4 4.4 1.6 -4.4 1.6 -1.6 4.4 -1.6 -4.4 -4.4 -1.6 4.4 -1.6z" fill={p.star} />
        </g>
      );
  }
}
