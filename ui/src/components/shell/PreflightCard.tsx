import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Download, Gamepad2, HardDrive, Info, Layers, Monitor, ShieldCheck } from 'lucide-react';
import { call, on } from '../../bridge/bridge';
import type { LaunchState, PreflightCheck, PreflightResult, PreflightStatus } from '../../bridge/types';
import { spring } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';
import './preflight.css';

const CHECK_ICONS: Record<string, ReactNode> = {
  disk: <HardDrive size={15} />,
  steamUpdate: <Download size={15} />,
  controller: <Gamepad2 size={15} />,
  display: <Monitor size={15} />,
  launchers: <Layers size={15} />,
};

const STATUS: Record<PreflightStatus, { icon: ReactNode; word: string }> = {
  ok: { icon: <CheckCircle2 size={14} />, word: 'Good' },
  info: { icon: <Info size={14} />, word: 'Note' },
  warn: { icon: <AlertTriangle size={14} />, word: 'Heads-up' },
};

/**
 * Pre-flight: a compact, read-only look at things that commonly spoil a launch (low disk
 * space, a pending Steam update, controller battery, display mode, other store apps using
 * memory). It is computed natively in parallel when the launch starts and never delays it.
 */
export function PreflightCard({ launch }: { launch: LaunchState }) {
  const reduce = useReducedMotion();
  const [result, setResult] = useState<PreflightResult | null>(null);
  const ticket = launch.ticket;

  useEffect(() => {
    let alive = true;
    const off = on('launch.preflight', (r) => {
      if (r?.ticket === ticket && Array.isArray(r.checks)) setResult(r);
    });
    // The event can arrive before this card mounts; ask for the stored result as well.
    call<PreflightResult | null>('launch.preflightResult', { ticket })
      .then((r) => {
        if (alive && r && r.ticket === ticket && Array.isArray(r.checks)) setResult((cur) => cur ?? r);
      })
      .catch(() => {});
    return () => {
      alive = false;
      off();
    };
  }, [ticket]);

  const checks = result?.ticket === ticket ? result.checks : [];
  const warnings = checks.filter((c) => c.status === 'warn').length;

  return (
    <AnimatePresence>
      {checks.length > 0 && (
        <motion.section
          key={ticket}
          className="preflight"
          aria-labelledby={`preflight-${ticket}`}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          transition={reduce ? { duration: 0.15 } : spring.panel}
        >
          <header className="preflight__head">
            <ShieldCheck size={14} aria-hidden />
            <h2 id={`preflight-${ticket}`} className="preflight__title">Before you play</h2>
            <span className="preflight__summary">
              {warnings === 0 ? 'All clear' : `${warnings} ${warnings === 1 ? 'thing' : 'things'} to know`}
            </span>
          </header>
          <ul className="preflight__rows">
            {checks.map((c, i) => (
              <PreflightRow key={c.id} check={c} index={i} reduce={reduce} />
            ))}
          </ul>
          <p className="preflight__foot">Read-only checks. Nothing was changed, and your game is starting regardless.</p>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function PreflightRow({ check, index, reduce }: { check: PreflightCheck; index: number; reduce: boolean }) {
  const status = STATUS[check.status] ?? STATUS.info;
  return (
    <motion.li
      className="preflight__row"
      data-status={check.status}
      initial={reduce ? { opacity: 0 } : { opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={reduce ? { duration: 0.15, delay: index * 0.03 } : { ...spring.panel, delay: 0.08 + index * 0.06 }}
    >
      <span className="preflight__icon" aria-hidden>{CHECK_ICONS[check.id] ?? <Info size={15} />}</span>
      <span className="preflight__text">
        <span className="preflight__label">{check.label}</span>
        {check.detail && check.status !== 'ok' && <span className="preflight__detail">{check.detail}</span>}
      </span>
      <span className="preflight__value">
        <span className="preflight__status" aria-hidden>{status.icon}</span>
        <span className="visually-hidden">{status.word}: </span>
        {check.value}
      </span>
    </motion.li>
  );
}
