import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, CircleStop, Cloud, ExternalLink, Info, Radio } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { CloudGame, CloudOption, CloudServiceHealth, CloudSession, Game } from '../../bridge/types';
import { clock, healthTone, playTypeLabel, preferredOption, sessionLeft, SERVICE_SHORT } from '../../lib/cloud';
import { exit, pick, spring } from '../../lib/motion';
import { endCloudSession, launchCloud, useCloudActive, useCloudEnabled, useCloudMap, useCloudStore } from '../../state/cloud';
import { useReducedMotion } from '../../state/store';
import { CloudMark, CloudMeterView, XboxCloudTime } from './CloudBits';
import './cloud.css';

/** Loads the game's cloud options when cloud play is on and the map lists it; reloads on cloud changes. */
export function useCloudGame(game: Game): CloudGame | null {
  const enabled = useCloudEnabled();
  const listed = !!useCloudMap()?.[game.id]?.length;
  const version = useCloudStore((s) => s.version);
  const [data, setData] = useState<CloudGame | null>(null);
  useEffect(() => {
    if (!enabled || !listed) {
      setData(null);
      return;
    }
    let alive = true;
    call<CloudGame>('cloud.forGame', { gameId: game.id }).then((d) => alive && setData(d)).catch(() => alive && setData(null));
    return () => { alive = false; };
  }, [enabled, listed, game.id, version]);
  return data;
}

/** A live "m:ss" for a running session. */
export function useElapsed(session: CloudSession | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (session?.state !== 'running') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [session?.state]);
  return session?.start ? Math.max(0, (now - Date.parse(session.start)) / 1000) : 0;
}

/**
 * Game page: "Play in the cloud" split button. The main part starts the preferred service (verified matches first);
 * the caret opens every option with honest requirement hints, the hours meter and service status. While a cloud
 * session for this game runs, it shows the live time and "I'm done".
 */
export function CloudPlayButton({ game }: { game: Game }) {
  const data = useCloudGame(game);
  const active = useCloudActive();
  const mine = active?.gameId === game.id ? active : null;
  const elapsed = useElapsed(mine);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const caret = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  if (!data || data.options.length === 0) return null;
  const preferred = preferredOption(data.options)!;

  const start = async (o: CloudOption) => {
    setOpen(false);
    setBusy(true);
    await launchCloud(game.id, o.service);
    setBusy(false);
  };

  const mainLabel = mine
    ? mine.state === 'running' ? `Streaming · ${clock(elapsed)}` : `Waiting for ${SERVICE_SHORT[mine.service]}…`
    : 'Play in the cloud';
  return (
    <div className="cloud-split" data-active={mine ? mine.state : undefined}>
      <button
        className="cloud-split__main"
        onClick={() => (mine ? setOpen(true) : void start(preferred))}
        aria-busy={busy || undefined}
        aria-label={mine ? `${mainLabel}. Open cloud options` : `Play in the cloud with ${preferred.serviceName}`}
        aria-describedby={`${menuId}-sub`}
      >
        <span className="cloud-split__icon" aria-hidden>
          {mine?.state === 'running' ? <Radio size={18} /> : <Cloud size={19} strokeWidth={2.1} />}
        </span>
        <span className="cloud-split__text">
          <span className="cloud-split__label">{mainLabel}</span>
          <span className="cloud-split__sub" id={`${menuId}-sub`}>
            {mine ? `${SERVICE_SHORT[mine.service]} · ${mine.surface === 'browser' ? 'in your browser' : mine.surface === 'edge' ? 'in Edge' : 'in the app'}` : `${SERVICE_SHORT[preferred.service]} · ${playTypeLabel(preferred)}`}
          </span>
        </span>
      </button>
      <button
        ref={caret}
        className="cloud-split__more"
        aria-label="More ways to play in the cloud"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={17} />
      </button>
      <CloudMenu id={menuId} anchor={caret} open={open} onClose={() => setOpen(false)} data={data} active={mine} elapsed={elapsed} onStart={start} />
    </div>
  );
}

function CloudMenu({ id, anchor, open, onClose, data, active, elapsed, onStart }: {
  id: string; anchor: React.RefObject<HTMLButtonElement | null>; open: boolean; onClose: () => void; data: CloudGame; active: CloudSession | null; elapsed: number;
  onStart: (o: CloudOption) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [pos, setPos] = useState<{ x: number; y: number; maxH: number; up: boolean } | null>(null);
  const [health, setHealth] = useState<CloudServiceHealth | null>(null);
  const hasGfn = data.options.some((o) => o.service === 'gfn');

  // Below the button when it fits, otherwise above it (whichever side has more room), never off screen.
  useLayoutEffect(() => {
    if (!open || !anchor.current) return setPos(null);
    const r = anchor.current.getBoundingClientRect();
    const w = Math.min(420, innerWidth - 16);
    const h = ref.current?.scrollHeight ?? 0;
    const below = innerHeight - r.bottom - 16;
    const above = r.top - 16;
    const down = h <= below || below >= above;
    const maxH = Math.max(160, down ? below : above);
    setPos({ x: Math.max(8, Math.min(r.right - w, innerWidth - w - 8)), y: down ? r.bottom + 8 : Math.max(8, r.top - 8 - Math.min(h, maxH)), maxH, up: !down });
  }, [open, anchor, data, active]);

  useEffect(() => {
    if (!open || !hasGfn) return;
    let alive = true;
    call<CloudServiceHealth>('cloud.serviceStatus').then((h) => alive && setHealth(h)).catch(() => {});
    return () => { alive = false; };
  }, [open, hasGfn]);

  const close = useCallback(() => {
    onClose();
    anchor.current?.focus();
  }, [onClose, anchor]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('button')?.focus());
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [open, onClose, anchor]);

  const onKey = (e: ReactKeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Tab') { e.preventDefault(); close(); }
  };

  const ht = healthTone(health);
  const left = active ? sessionLeft(active) : null;
  const surfaceNote = data.options.some((o) => o.surface === 'edge')
    ? 'Web games open in a separate Microsoft Edge window with its own sign-in. VYSTRAL never reads it.'
    : data.options.some((o) => o.surface === 'browser')
      ? 'Web games open in your browser. VYSTRAL can’t see browser tabs, so press “I’m done” when you finish.'
      : null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          id={id}
          className="cloud-menu"
          role="dialog"
          aria-label="Play in the cloud"
          style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, maxHeight: pos?.maxH, visibility: pos ? undefined : 'hidden', transformOrigin: pos?.up ? 'bottom right' : 'top right' }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, transition: exit }}
          transition={pick(reduce, spring.panel)}
          onKeyDown={onKey}
        >
          {active && (
            <div className="cloud-menu__active">
              <div className="cloud-menu__active-text">
                <strong>{active.state === 'running' ? `Streaming for ${clock(elapsed)}` : `Waiting for ${SERVICE_SHORT[active.service]} to start the stream…`}</strong>
                <span>{active.manual ? 'VYSTRAL can’t see when a browser tab closes.' : 'VYSTRAL ends the session when the stream closes.'}{left ? ` ${left.text}.` : ''}</span>
              </div>
              <button className="cloud-menu__done" onClick={() => { onClose(); void endCloudSession(); }}>
                <CircleStop size={15} aria-hidden /> I’m done
              </button>
            </div>
          )}
          <div className="cloud-menu__label caps">Play in the cloud</div>
          {data.options.map((o) => (
            <button key={o.service} className="cloud-opt" onClick={() => onStart(o)} data-service={o.service}
              aria-label={`${o.serviceName}: ${o.headline}.${o.match === 'title' ? ' Likely match.' : ''} ${o.requirement} Opens in ${o.surfaceLabel}.`}>
              <CloudMark service={o.service} size={18} />
              <span className="cloud-opt__body">
                <span className="cloud-opt__head">
                  <span className="cloud-opt__name">{o.serviceName}</span>
                  {o.match === 'title' && <span className="cloud-pill cloud-pill--likely">Likely match</span>}
                  {o.playType === 'install' && <span className="cloud-pill">Install-to-Play</span>}
                </span>
                <span className="cloud-opt__headline">{o.headline.replace(/^GeForce NOW · /, '')}</span>
                <span className="cloud-opt__req">{o.requirement}</span>
                {o.note && <span className="cloud-opt__note"><Info size={12} aria-hidden /> {o.note}</span>}
                <span className="cloud-opt__where"><ExternalLink size={12} aria-hidden /> Opens in {o.surfaceLabel}</span>
              </span>
            </button>
          ))}
          {(data.meter && (hasGfn || data.options.some((o) => o.service === 'xbox'))) && (
            <div className="cloud-menu__meter">
              {hasGfn && <CloudMeterView meter={data.meter} compact />}
              {data.options.some((o) => o.service === 'xbox') && <XboxCloudTime meter={data.meter} />}
            </div>
          )}
          <div className="cloud-menu__foot">
            {ht && (
              <span className="cloud-health" data-tone={ht.tone}>
                <span className="cloud-health__dot" aria-hidden /> GeForce NOW: {ht.text}
              </span>
            )}
            {surfaceNote && <span>{surfaceNote}</span>}
            <span>The vendor’s app or page shows the final answer on what you can play.</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/**
 * Immersive game page: one controller-friendly button per cloud option (rendered next to Play). Minimal on purpose;
 * the full menu lives on the desktop game page.
 */
export function ImmersiveCloudActions({ game, onClose }: { game: Game; onClose: () => void }) {
  const data = useCloudGame(game);
  const active = useCloudActive();
  if (!data?.options.length) return null;
  if (active?.gameId === game.id) {
    return (
      <button className="imm-btn" onClick={() => void endCloudSession()}>
        <CircleStop size="1em" /> I’m done streaming
      </button>
    );
  }
  return (
    <>
      {data.options.map((o) => (
        <button
          key={o.service}
          className="imm-btn"
          aria-label={`Play in the cloud with ${o.serviceName}. ${o.headline}. ${o.requirement}`}
          onClick={() => {
            onClose();
            void launchCloud(game.id, o.service);
          }}
        >
          <Cloud size="1em" /> {SERVICE_SHORT[o.service]}
        </button>
      ))}
    </>
  );
}

/**
 * Desktop shell: a small pill while a cloud session VYSTRAL started is open (any page), with the live time, the
 * session-length warning and "I'm done" — the only way to end a browser session VYSTRAL can't see.
 */
export function CloudSessionPill() {
  const active = useCloudActive();
  const elapsed = useElapsed(active);
  const reduce = useReducedMotion();
  const left = active ? sessionLeft(active) : null;
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          className="cloud-pillbar"
          role="status"
          aria-label="Cloud session"
          data-state={active.state}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: exit }}
          transition={pick(reduce, spring.panel)}
        >
          <span className="cloud-pillbar__dot" aria-hidden />
          <span className="cloud-pillbar__text">
            <strong>{active.state === 'running' ? `${active.title} · ${clock(elapsed)}` : `${active.title} · waiting for the stream`}</strong>
            <span data-tone={left?.tone}>{left?.text ?? `${SERVICE_SHORT[active.service]} · ${active.manual ? 'press I’m done when you finish' : 'ends when the stream closes'}`}</span>
          </span>
          <button className="btn btn--sm btn--secondary" onClick={() => void endCloudSession()}>
            <CircleStop size={14} aria-hidden /> <span>I’m done</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
