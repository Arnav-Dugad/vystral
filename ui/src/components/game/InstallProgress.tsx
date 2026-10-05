import { useEffect, type ReactNode } from 'react';
import { motion, useSpring, useTransform } from 'motion/react';
import { ArrowDownToLine, RefreshCw } from 'lucide-react';
import type { Game, InstallProgress } from '../../bridge/types';
import { phaseLabel, progressDetail, progressFraction } from '../../lib/installProgress';
import { useInstallFor } from '../../state/installs';
import { useReducedMotion } from '../../state/store';
import './install.css';

/**
 * Circular progress that glides between Steam's (infrequent) manifest updates with a spring.
 * With no known total it shows a slow indeterminate arc (static under reduced motion).
 */
export function ProgressRing({
  fraction,
  size = 44,
  stroke = 4,
  label,
  showPercent = true,
  tone = 'accent',
}: {
  fraction: number | null;
  size?: number;
  stroke?: number;
  label: string;
  showPercent?: boolean;
  tone?: 'accent' | 'ok' | 'muted';
}) {
  const reduce = useReducedMotion();
  const value = useSpring(fraction ?? 0, { stiffness: 70, damping: 20, restDelta: 0.0005 });
  useEffect(() => {
    if (fraction == null) return;
    if (reduce) value.jump(fraction);
    else value.set(fraction);
  }, [fraction, reduce, value]);
  const percent = useTransform(value, (v) => `${Math.round(v * 100)}%`);
  const r = (size - stroke) / 2;
  const indeterminate = fraction == null;
  return (
    <span
      className={`pring pring--${tone}`}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(fraction * 100)}
      data-indeterminate={indeterminate || undefined}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden>
        <circle className="pring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        {indeterminate ? (
          <circle className="pring__spin" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" pathLength={1} strokeDasharray="0.22 0.78" />
        ) : (
          <motion.circle
            className="pring__fill"
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
            fill="none"
            style={{ pathLength: value, rotate: -90, transformOrigin: '50% 50%' }}
          />
        )}
      </svg>
      {showPercent && !indeterminate && <motion.span className="pring__pct num">{percent}</motion.span>}
    </span>
  );
}

function kindVerb(p: InstallProgress) {
  return p.kind === 'update' ? 'Updating' : p.kind === 'uninstall' ? 'Uninstalling' : 'Installing';
}

/** Small ring for a GameCard while Steam installs, updates or uninstalls the game. */
export function InstallBadge({ gameId }: { gameId: string }) {
  const p = useInstallFor(gameId);
  if (!p || (p.phase === 'installed' && p.kind !== 'install')) return null;
  if (p.phase === 'removed') return null;
  const fraction = progressFraction(p);
  const done = p.phase === 'installed';
  const text = done ? 'Ready' : p.phase === 'paused' ? 'Paused' : fraction != null ? `${Math.round(fraction * 100)}%` : p.kind === 'update' ? 'Update' : '…';
  return (
    <span className="install-badge" data-kind={p.kind} data-done={done || undefined} title={`${phaseLabel(p)}${progressDetail(p) ? ` · ${progressDetail(p)}` : ''}`}>
      <ProgressRing fraction={done ? 1 : fraction} size={18} stroke={2.5} showPercent={false} tone={done ? 'ok' : 'accent'} label={`${kindVerb(p)} in Steam`} />
      <span className="install-badge__text num">{text}</span>
    </span>
  );
}

/**
 * Progress panel used in the detail hero: for installs (from InstallButton) and for updates or
 * uninstalls Steam is doing to an installed game.
 */
export function InstallProgressPanel({ progress, size = 'md', actions }: { progress: InstallProgress; size?: 'md' | 'lg' | 'xl'; actions?: ReactNode }) {
  const fraction = progressFraction(progress);
  const detail = progressDetail(progress);
  const ring = size === 'xl' ? 52 : size === 'lg' ? 44 : 36;
  const Icon = progress.kind === 'update' ? RefreshCw : ArrowDownToLine;
  return (
    <div className={`install-panel install-panel--${size}`} data-phase={progress.phase}>
      <ProgressRing fraction={fraction} size={ring} stroke={size === 'xl' ? 4.5 : 3.5} label={`${phaseLabel(progress)}${fraction != null ? `, ${Math.round(fraction * 100)} percent` : ''}`} tone={progress.phase === 'installed' ? 'ok' : progress.phase === 'paused' ? 'muted' : 'accent'} showPercent={size !== 'md'} />
      <div className="install-panel__text" aria-live="polite">
        <div className="install-panel__label">
          <Icon size={14} aria-hidden />
          {phaseLabel(progress)}
        </div>
        {detail && <div className="install-panel__detail">{detail}</div>}
        {!detail && progress.phase === 'queued' && <div className="install-panel__detail">Confirm the install in Steam’s window. Progress appears here once Steam starts.</div>}
      </div>
      {actions && <div className="install-panel__actions">{actions}</div>}
    </div>
  );
}

/** Update/uninstall status for an installed game, shown in the detail hero. */
export function HeroInstallStatus({ game }: { game: Game }) {
  const p = useInstallFor(game.id);
  if (!p || p.kind === 'install') return null;
  if (p.kind === 'update' && p.phase === 'installed' && !p.watching) return null;
  return <InstallProgressPanel progress={p} size="md" />;
}
