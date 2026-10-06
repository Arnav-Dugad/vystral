import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDownAZ, ArrowDownToLine, Check, Gamepad2, RefreshCw } from 'lucide-react';
import { formatBytes, formatClock, PLATFORM_NAMES } from '../../lib/format';
import { etaSeconds, formatEta, formatRate, progressFraction } from '../../lib/installProgress';
import { pick, spring } from '../../lib/motion';
import { useInstalls } from '../../state/installs';
import { useReducedMotion } from '../../state/store';
import { GameCover } from '../../components/game/GameCover';
import { GameLogo } from '../../components/game/GameLogo';
import { PadHint } from '../../components/ui/primitives';
import { StoreLogo } from '../../components/ui/StoreLogo';
import { SORT_LABEL, type Jump, type Tile } from './rows';

/* Track T: the faces and info blocks for live tiles (Now playing, Downloads) and toolbar chips. */

type PlayingTile = Extract<Tile, { kind: 'playing' }>;
type DownloadTile = Extract<Tile, { kind: 'download' }>;
type ToolTile = Extract<Tile, { kind: 'tool' }>;

/** A session clock that ticks once a second (only while it's on screen). */
export function SessionClock({ start }: { start: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const t = start ? Date.parse(start) : NaN;
  if (!Number.isFinite(t)) return null;
  return <span className="num">{formatClock(Math.max(0, (now - t) / 1000))}</span>;
}

export function PlayingFace({ tile }: { tile: PlayingTile }) {
  return (
    <>
      <GameCover game={tile.game} kind="hero" />
      <span className="imm-live__badge" data-phase={tile.phase}>
        <span className="imm-sys__pulse" aria-hidden />
        {tile.phase === 'running' ? <SessionClock start={tile.startedAt} /> : 'Starting…'}
      </span>
    </>
  );
}

export function PlayingInfo({ tile }: { tile: PlayingTile }) {
  const game = tile.game;
  const platforms = [...new Set(game.installations.map((i) => i.platform))];
  return (
    <>
      <span className="imm__pinned imm-live__eyebrow">
        <span className="imm-sys__pulse" aria-hidden /> {tile.phase === 'running' ? 'Now playing' : 'Starting'}
      </span>
      {game.art.logo ? <GameLogo className="imm__logo" src={game.art.logo} alt={game.title} /> : <h1 className="imm__title">{game.title}</h1>}
      <div className="imm__meta">
        {tile.phase === 'running' && (
          <span className="imm-live__clock">
            <Gamepad2 size="0.95em" aria-hidden /> <SessionClock start={tile.startedAt} /> this session
          </span>
        )}
        <span className="imm__meta-stores">
          {platforms.map((p) => (
            <span key={p} className="imm__store">
              <StoreLogo platform={p} size={20} decorative />
              {PLATFORM_NAMES[p]}
            </span>
          ))}
        </span>
        <span>{tile.phase === 'running' ? <PadHint button="A">Return to game</PadHint> : 'Waiting for the game window…'}</span>
      </div>
    </>
  );
}

/** The live progress for a download tile (the store keeps it fresh between row rebuilds). */
function useLiveProgress(tile: DownloadTile) {
  return useInstalls((s) => s.byGame[tile.game.id]) ?? tile.progress;
}

export function DownloadFace({ tile }: { tile: DownloadTile }) {
  const p = useLiveProgress(tile);
  const f = progressFraction(p);
  return (
    <>
      <GameCover game={tile.game} />
      <span className="imm-dl" data-phase={p.phase}>
        <span className="imm-dl__label num">
          {p.kind === 'update' ? <RefreshCw size="0.9em" aria-hidden /> : <ArrowDownToLine size="0.9em" aria-hidden />}
          {f != null ? `${Math.round(f * 100)}%` : p.phase === 'paused' ? 'Paused' : 'Queued'}
        </span>
        <span className="imm-dl__track">
          <span className="imm-dl__fill" data-indeterminate={f == null || undefined} style={{ transform: `scaleX(${f ?? 0.3})` }} />
        </span>
      </span>
    </>
  );
}

export function DownloadInfo({ tile }: { tile: DownloadTile }) {
  const p = useLiveProgress(tile);
  const f = progressFraction(p);
  const eta = formatEta(etaSeconds(p));
  const rate = formatRate(p.rate);
  const game = tile.game;
  return (
    <>
      <span className="imm__pinned imm-live__eyebrow">
        {p.kind === 'update' ? <RefreshCw size="0.9em" aria-hidden /> : <ArrowDownToLine size="0.9em" aria-hidden />}
        {p.kind === 'update' ? 'Updating in Steam' : p.phase === 'paused' ? 'Paused in Steam' : 'Installing in Steam'}
      </span>
      {game.art.logo ? <GameLogo className="imm__logo" src={game.art.logo} alt={game.title} /> : <h1 className="imm__title">{game.title}</h1>}
      <div className="imm__meta">
        {f != null && <span className="num">{Math.round(f * 100)}%</span>}
        {p.bytesTotal > 0 && <span className="num">{formatBytes(p.bytesDone)} of {formatBytes(p.bytesTotal)}</span>}
        {rate && <span className="num">{rate}</span>}
        {eta && <span>{eta}</span>}
        <span className="imm-live__source">Read from Steam’s own download files</span>
      </div>
    </>
  );
}

export function ToolChip({ tile }: { tile: ToolTile }) {
  const t = tile.tool;
  if (t.type === 'sort') {
    return (
      <span className="imm-chip__face">
        <ArrowDownAZ size="1.05em" aria-hidden />
        <span className="imm-chip__text"><span className="imm-chip__eyebrow">Sort</span>{SORT_LABEL[t.sort]}</span>
      </span>
    );
  }
  const store = t.filter?.kind === 'store' ? t.filter.platform : null;
  return (
    <span className="imm-chip__face" data-active={t.active || undefined}>
      {store ? <StoreLogo platform={store} size={20} decorative brand={t.active} /> : t.active ? <Check size="1em" aria-hidden /> : null}
      <span className="imm-chip__text">{t.label}</span>
      <span className="imm-chip__count num">{t.count}</span>
    </span>
  );
}

/**
 * The quick-jump rail (A–Z sort): every letter in the grid down the right edge, the current one
 * lit; LT/RT step through them. Other sorts show their bands as a short list.
 */
export function JumpRail({ jumps, current, onJump, below }: { jumps: Jump[]; current: Jump | null; onJump: (j: Jump) => void; below?: boolean }) {
  if (jumps.length < 2) return null;
  const letters = jumps.every((j) => j.label.length <= 1);
  return (
    <nav className="imm-rail" data-kind={letters ? 'letters' : 'bands'} data-below={below || undefined} aria-label="Jump to">
      {jumps.map((j) => (
        <button
          key={j.label}
          type="button"
          tabIndex={-1}
          className="imm-rail__item"
          aria-current={current?.label === j.label ? 'true' : undefined}
          onClick={() => onJump(j)}
        >
          {j.label}
        </button>
      ))}
    </nav>
  );
}

/** The big letter (or band) that flashes in the middle on a quick jump. */
export function JumpFlash({ flash }: { flash: { label: string; n: number } | null }) {
  const reduce = useReducedMotion();
  return (
    <div className="imm-flash" aria-hidden>
      <AnimatePresence>
        {flash && (
          <motion.span
            key={flash.n}
            className="imm-flash__label"
            data-long={flash.label.length > 2 || undefined}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.86 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.08, transition: { duration: 0.3 } }}
            transition={pick(reduce, spring.panel)}
          >
            {flash.label}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
