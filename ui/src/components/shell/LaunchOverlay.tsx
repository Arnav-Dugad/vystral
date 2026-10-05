import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Gauge, X } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { LaunchState, PerfSummary } from '../../bridge/types';
import { formatDuration, PLATFORM_NAMES } from '../../lib/format';
import { ease, spring } from '../../lib/motion';
import { findCoverElement, launchOriginFor } from '../../lib/flight';
import type { Game } from '../../bridge/types';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../game/GameCover';
import { Button } from '../ui/primitives';
import { PreflightCard } from './PreflightCard';

const ACTIVE = ['validating', 'starting', 'waiting', 'notDetected', 'failed'];

/**
 * The launch sequence. Status text follows the real native phases (no fake countdown):
 * validating → starting the store client → waiting for the game process → running.
 * It never claims success before VYSTRAL actually sees the game running.
 */
export function LaunchOverlay() {
  const launch = useStore((s) => s.launch);
  const game = useStore((s) => (launch ? s.gamesById.get(launch.gameId) : undefined));
  const cinematic = useStore((s) => s.settings?.['launch.cinematic'] ?? true);
  const reduce = useReducedMotion();
  const toast = useStore((s) => s.toast);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [enjoy, setEnjoy] = useState<string | null>(null);
  const [returning, setReturning] = useState<{ game: Game; ticket: string } | null>(null);

  // Brief "Enjoy" beat when the game is detected, then get out of the way.
  useEffect(() => {
    if (launch?.phase === 'running') {
      setEnjoy(launch.ticket);
      const t = window.setTimeout(() => setEnjoy(null), 1400);
      return () => window.clearTimeout(t);
    }
  }, [launch?.phase, launch?.ticket]);

  // Returning from a game: the art closes back into the game's cover (the launch, reversed).
  useEffect(() => {
    if (launch?.phase === 'ended' && launch.sessionId && game && cinematic && !reduce) {
      setReturning({ game, ticket: launch.ticket });
      const t = window.setTimeout(() => setReturning(null), 1500);
      return () => window.clearTimeout(t);
    }
  }, [launch?.phase, launch?.ticket]); // eslint-disable-line react-hooks/exhaustive-deps

  // Session summary when we return from a game.
  useEffect(() => {
    if (launch?.phase === 'ended' && launch.sessionId && launch.durationSeconds != null && game) {
      let perf = '';
      try {
        const p = launch.perfSummary ? (JSON.parse(launch.perfSummary) as PerfSummary) : null;
        if (p?.fpsAvg != null) perf = ` · ${Math.round(p.fpsAvg)} FPS average`;
        else if (p?.gpuAvg != null) perf = ` · GPU avg ${Math.round(p.gpuAvg)}%`;
        if (p?.thermalNote) {
          toast({ tone: 'warning', title: 'Your GPU ran hot during that session', body: p.thermalNote });
        }
      } catch {
        // summary is optional
      }
      toast({ tone: 'success', title: `Played ${game.title} for ${formatDuration(launch.durationSeconds)}`, body: `Session saved to your journal${perf}.` });
    } else if (launch?.phase === 'ended' && launch.message) {
      toast({ tone: 'info', title: launch.message });
    }
  }, [launch?.phase, launch?.ticket]); // eslint-disable-line react-hooks/exhaustive-deps

  const show = !!launch && !!game && dismissed !== launch.ticket && (ACTIVE.includes(launch.phase) || enjoy === launch.ticket);

  // The interface recedes into depth behind the portal, and comes forward again on return.
  useEffect(() => {
    const root = document.documentElement;
    if (show && cinematic && !reduce) root.dataset.launching = 'true';
    else delete root.dataset.launching;
    return () => {
      delete root.dataset.launching;
    };
  }, [show, cinematic, reduce]);
  const close = () => launch && setDismissed(launch.ticket);
  const stop = () => void call('game.stopTracking').catch(() => {});

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!cinematic || reduce) {
    return (
      <AnimatePresence>
        {show && launch && game && (
          <motion.div className="launch-pill" role="status" aria-live="polite" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={reduce ? { duration: 0.15 } : spring.panel}>
            <StatusIcon launch={launch} />
            <span><strong>{game.title}</strong> — {statusText(launch)}</span>
            {(launch.phase === 'waiting' || launch.phase === 'notDetected') && <Button size="sm" variant="ghost" onClick={stop}>Stop waiting</Button>}
            <Button size="sm" variant="ghost" onClick={close} aria-label="Dismiss"><X size={14} /></Button>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <>
      <AnimatePresence>{returning && <ReturnIris key={returning.ticket} game={returning.game} />}</AnimatePresence>
      <AnimatePresence>
      {show && launch && game && (
        <PortalShell key={launch.ticket} gameId={game.id} title={game.title}>
          <motion.div className="launch__art" initial={{ scale: 1.08, opacity: 0 }} animate={{ scale: 1.0, opacity: 1 }} transition={{ duration: 1.2, ease: ease.cinematic }}>
            <motion.div style={{ height: '100%' }} animate={{ scale: [1, 1.04] }} transition={{ duration: 9, ease: 'linear' }}>
              <GameCover game={game} kind="hero" eager />
            </motion.div>
          </motion.div>
          <motion.div className="launch__flood" initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} transition={{ duration: 0.9, ease: ease.out }} />
          <div className="launch__content" aria-live="polite">
            <motion.div initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ ...spring.hero, delay: 0.12 }}>
              {game.art.logo ? <img className="launch__logo" src={game.art.logo} alt={game.title} /> : <h1 className="launch__title">{game.title}</h1>}
            </motion.div>
            <motion.div className="launch__status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 }}>
              <StatusIcon launch={launch} />
              <span>{statusText(launch)}</span>
            </motion.div>
            {launch.message && launch.phase !== 'starting' && launch.phase !== 'waiting' && <p className="launch__message">{launch.message}</p>}
            {(launch.phase === 'starting' || launch.phase === 'waiting' || launch.phase === 'notDetected') && <PreflightCard launch={launch} />}
            <div className="launch__actions">
              {launch.phase === 'failed' && launch.actions?.map((a, i) => (
                <FixButton key={a.id} ticket={launch.ticket} fix={a} primary={i === 0} />
              ))}
              {launch.phase === 'failed' && <Button variant={launch.actions?.length ? 'ghost' : 'primary'} onClick={close} data-autofocus={!launch.actions?.length || undefined}>Close</Button>}
              {(launch.phase === 'waiting' || launch.phase === 'starting') && (
                <Button variant="ghost" onClick={close} data-autofocus>Hide</Button>
              )}
              {launch.phase === 'notDetected' && (
                <>
                  <Button variant="secondary" onClick={close} data-autofocus>Keep waiting in the background</Button>
                  <Button variant="ghost" onClick={stop}>Stop waiting</Button>
                </>
              )}
            </div>
          </div>
        </PortalShell>
      )}
      </AnimatePresence>
    </>
  );
}

/** Radius that covers the whole viewport from a point. */
function coverRadius(x: number, y: number) {
  return Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))) + 8;
}

function PortalShell({ gameId, title, children }: { gameId: string; title: string; children: React.ReactNode }) {
  const origin = useMemo(() => launchOriginFor(gameId), [gameId]);
  const r = coverRadius(origin.x, origin.y);
  return (
    <motion.div
      className="launch"
      role="dialog"
      aria-modal="true"
      aria-label={`Launching ${title}`}
      data-nav-scope="overlay"
      initial={{ clipPath: `circle(0px at ${origin.x}px ${origin.y}px)` }}
      animate={{ clipPath: `circle(${r}px at ${origin.x}px ${origin.y}px)` }}
      exit={{ opacity: 0, transition: { duration: 0.45, ease: ease.in } }}
      transition={{ duration: 0.85, ease: ease.cinematic }}
    >
      {/* Light sweep: a burst of the game's accent from the Play button. */}
      <motion.div
        className="launch__burst"
        aria-hidden
        style={{ left: origin.x, top: origin.y }}
        initial={{ scale: 0.1, opacity: 0.9 }}
        animate={{ scale: 9, opacity: 0 }}
        transition={{ duration: 1.1, ease: ease.out }}
      />
      {children}
    </motion.div>
  );
}

/** Reverse of the portal: full-screen art closes into the game's cover (or the screen centre). */
function ReturnIris({ game }: { game: Game }) {
  const target = useMemo(() => {
    const el = findCoverElement(game.id);
    const rect = el?.getBoundingClientRect();
    const visible = rect && rect.width > 4 && rect.bottom > 0 && rect.top < innerHeight;
    return visible ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 };
  }, [game.id]);
  const r = coverRadius(target.x, target.y);
  useEffect(() => {
    // The interface comes forward from depth as the iris closes.
    const root = document.documentElement;
    root.dataset.launching = 'true';
    root.dataset.returning = 'true';
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.launching));
    const t = window.setTimeout(() => delete root.dataset.returning, 1200);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
      delete root.dataset.returning;
    };
  }, []);
  return (
    <motion.div
      className="launch launch--return"
      aria-hidden
      initial={{ clipPath: `circle(${r}px at ${target.x}px ${target.y}px)` }}
      animate={{ clipPath: `circle(0px at ${target.x}px ${target.y}px)` }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.95, ease: ease.inOut, delay: 0.15 }}
    >
      <div className="launch__art">
        <GameCover game={game} kind="hero" eager />
      </div>
      <div className="launch__flood" />
    </motion.div>
  );
}

function statusText(l: LaunchState): string {
  const platform = PLATFORM_NAMES[l.platform as keyof typeof PLATFORM_NAMES] ?? 'the store app';
  switch (l.phase) {
    case 'validating': return 'Checking the game…';
    case 'starting': return l.message ?? `Starting via ${platform}…`;
    case 'waiting': return l.message ?? 'Waiting for the game window…';
    case 'notDetected': return 'Still waiting for the game';
    case 'running': return 'Enjoy your game';
    case 'failed': return 'The game didn’t start';
    default: return '';
  }
}

/** A one-click fix the native side attached to this failure (it validates the ticket/action pair). */
function FixButton({ ticket, fix, primary }: { ticket: string; fix: NonNullable<LaunchState['actions']>[number]; primary: boolean }) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={primary ? 'primary' : 'secondary'}
      loading={busy}
      data-autofocus={primary || undefined}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await call<{ ok: boolean; message: string }>('launch.fix', { ticket, actionId: fix.id });
          toast({ tone: r.ok ? 'success' : 'warning', title: r.message });
        } catch (err) {
          toast({ tone: 'danger', title: 'That didn’t work', body: err instanceof Error ? err.message : undefined });
        } finally {
          setBusy(false);
        }
      }}
    >
      {fix.label}
    </Button>
  );
}

/**
 * Once VYSTRAL has learned how long this game usually takes to open (3+ launches), the spinner
 * becomes a real progress arc. It never reaches 100% on its own — only detection completes it.
 */
function LearnedProgress({ launch }: { launch: LaunchState }) {
  const [now, setNow] = useState(Date.now());
  const expected = launch.expectedDetectMs;
  const accepted = launch.acceptedAt ? Date.parse(launch.acceptedAt) : NaN;
  useEffect(() => {
    if (!expected || Number.isNaN(accepted)) return;
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(t);
  }, [expected, accepted]);
  if (!expected || Number.isNaN(accepted)) return null;
  const p = Math.min(0.97, Math.max(0, (now - accepted) / expected));
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg className="launch__ring" viewBox="0 0 24 24" role="progressbar" aria-label="Expected launch progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
      <circle cx="12" cy="12" r={r} fill="none" stroke="oklch(1 0 0 / 0.2)" strokeWidth="2.5" />
      <circle
        cx="12" cy="12" r={r} fill="none" stroke="var(--accent-hi)" strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={`${p * c} ${c}`} transform="rotate(-90 12 12)" style={{ transition: 'stroke-dasharray 120ms linear' }}
      />
    </svg>
  );
}

function StatusIcon({ launch }: { launch: LaunchState }) {
  if (launch.phase === 'failed') return <AlertTriangle size={20} color="var(--warn)" aria-hidden />;
  if (launch.phase === 'running') return <CheckCircle2 size={20} color="var(--ok)" aria-hidden />;
  if (launch.phase === 'notDetected') return <Gauge size={20} aria-hidden />;
  if ((launch.phase === 'waiting' || launch.phase === 'starting') && launch.expectedDetectMs && launch.acceptedAt) return <LearnedProgress launch={launch} />;
  return (
    <svg className="launch__ring" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="oklch(1 0 0 / 0.2)" strokeWidth="2.5" />
      <circle cx="12" cy="12" r="9" fill="none" stroke="var(--accent-hi)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="14 60">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
