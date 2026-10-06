import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, ArrowDown, ArrowUp, Cpu, Equal, Eye, EyeOff, GitCompareArrows, Info, Layers, MemoryStick, Settings2 } from 'lucide-react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { BackgroundAppStat, BackgroundImpact, DriverGameComparison, DriverInsight, Game } from '../../bridge/types';
import { Badge, Button, IconButton, SectionHead, Skeleton } from '../../components/ui/primitives';
import { plural } from '../../lib/format';
import { spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { GameThumb } from './kit';
import { gameTitle } from './text';
import { driverDelta, driverHeadline, formatMb, formatPct, presence, suspectReason, type Better } from './dataInsights';
import './data-insights.css';

const fmtDate = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(t) : '—';
};

function useBridge<T>(method: string, params: unknown, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  // Only the newest request may answer: a slow reply for a previous game/filter is dropped.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    try {
      const data = await call<T>(method, params);
      if (mine === seq.current) setState({ data, error: null, loading: false });
    } catch (err) {
      if (mine === seq.current) setState((s) => ({ ...s, error: errorMessage(err), loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    // New parameters: don't keep showing the previous answer while the new one loads.
    setState({ data: null, error: null, loading: true });
    void load();
    const off = on('launch.state', (l) => {
      if (l.phase === 'ended' && l.sessionId) void load();
    });
    return () => {
      seq.current++;
      off();
    };
  }, [load]);
  return {
    ...state,
    reload: load,
    set: (data: T) => {
      seq.current++;
      setState({ data, error: null, loading: false });
    },
  };
}

/* ------------------------------------------------------------------ driver comparison */

/**
 * FPS before and after a GPU driver change, per game. With `gameId`, only that game; `hideWhenEmpty`
 * renders nothing when there is no comparison or driver change to talk about (used on game pages).
 */
export function DriverChangeCard({ gameId, hideWhenEmpty }: { gameId?: string | null; hideWhenEmpty?: boolean }) {
  const { data, error, loading } = useBridge<DriverInsight>('insights.driverComparison', { gameId: gameId ?? null }, [gameId]);
  const gamesById = useStore((s) => s.gamesById);
  const navigate = useStore((s) => s.navigate);
  const fpsOn = useStore((s) => s.settings?.['fps.captureEnabled'] ?? false);

  if (loading) return hideWhenEmpty ? null : <Skeleton height={180} radius={22} />;
  if (error || !data) return hideWhenEmpty ? null : (
    <section className="surface vx-card di-card"><p className="di-muted">Driver history couldn’t be loaded: {error}</p></section>
  );
  const changed = data.drivers.length >= 2;
  if (hideWhenEmpty && data.games.length === 0 && !changed) return null;
  const last = data.drivers[data.drivers.length - 1];
  const prev = data.drivers[data.drivers.length - 2];

  return (
    <section className="surface vx-card di-card" aria-labelledby={`di-driver-${gameId ?? 'all'}`}>
      <SectionHead
        title={<span id={`di-driver-${gameId ?? 'all'}`}><GitCompareArrows size={16} aria-hidden className="di-title-icon" />GPU driver changes</span>}
        meta="Frame rate before and after"
      />
      {data.games.length > 0 ? (
        <div className="di-driver-list">
          {data.games.slice(0, gameId ? 1 : 4).map((c) => (
            <DriverComparisonView key={c.gameId} c={c} game={gamesById.get(c.gameId)} showGame={!gameId} />
          ))}
          <p className="di-foot">
            <Info size={13} aria-hidden />
            <span>
              Medians of sessions longer than two minutes. Resolution and in-game settings aren’t recorded, so changing them — or a game update — also moves these numbers. Differences under 3% are normal run-to-run variation.
            </span>
          </p>
        </div>
      ) : changed ? (
        <div className="di-empty">
          <p className="di-change">
            Driver changed on <strong>{fmtDate(last.firstSeen)}</strong>: <span className="num">{prev.version}</span> → <span className="num">{last.version}</span>
            {last.gpuName && <span className="di-muted"> · {last.gpuName}</span>}
          </p>
          <p className="di-muted">
            {data.sessionsWithFps === 0
              ? 'Frame rate wasn’t measured in these sessions, so VYSTRAL can’t say whether the new driver is faster. Frame-rate capture is optional; with it on, this card compares average FPS, 1% lows and frame-time spikes.'
              : 'There isn’t frame-rate data for the same game on both drivers yet. Play a game you played before the update to see a comparison.'}
          </p>
          {data.sessionsWithFps === 0 && !fpsOn && (
            <Button size="sm" icon={<Settings2 size={14} />} onClick={() => navigate({ name: 'settings', section: 'launching' })}>
              Frame-rate capture settings
            </Button>
          )}
        </div>
      ) : (
        <p className="di-muted">
          {last
            ? <>Every session so far ran on driver <strong className="num">{last.version}</strong>{last.gpuName ? ` (${last.gpuName})` : ''}. When the driver changes, VYSTRAL compares your frame rates before and after.</>
            : 'VYSTRAL records the graphics driver version with each new session (read-only). When it changes, this card compares your frame rates before and after.'}
        </p>
      )}
    </section>
  );
}

const DRIVER_ROWS: { key: 'fpsAvg' | 'fps1Low' | 'frameTimeP99Ms'; label: string; unit: string; better: Better; digits: number }[] = [
  { key: 'fpsAvg', label: 'Average FPS', unit: 'fps', better: 'higher', digits: 0 },
  { key: 'fps1Low', label: '1% low', unit: 'fps', better: 'higher', digits: 0 },
  { key: 'frameTimeP99Ms', label: 'Frame time p99', unit: 'ms', better: 'lower', digits: 1 },
];

function DriverComparisonView({ c, game, showGame }: { c: DriverGameComparison; game: Game | undefined; showGame: boolean }) {
  const reduce = useReducedMotion();
  return (
    <motion.div className="di-driver" initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring.panel}>
      <div className="di-driver__head">
        {showGame && <GameThumb game={game} size={30} />}
        <div className="di-driver__titles">
          {showGame && <span className="di-driver__game truncate">{gameTitle(game)}</span>}
          <span className="di-change">
            Driver changed on <strong>{fmtDate(c.changedAt)}</strong>: <span className="num">{c.before.version}</span> → <span className="num">{c.after.version}</span>
          </span>
        </div>
        {c.smallSample && <Badge tone="warn" icon={<AlertTriangle size={11} />}>Small sample</Badge>}
      </div>
      <p className="di-headline">{driverHeadline(c)}</p>
      <div className="di-table-wrap" tabIndex={0} role="region" aria-label={`Frame rate before and after driver ${c.after.version}`}>
        <table className="di-table">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Before<span className="di-sub num">{c.before.version} · {plural(c.before.sessions, 'session')}</span></th>
              <th scope="col">After<span className="di-sub num">{c.after.version} · {plural(c.after.sessions, 'session')}</span></th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {DRIVER_ROWS.map((r) => {
              const b = c.before[r.key];
              const a = c.after[r.key];
              const d = driverDelta(b, a, r.better);
              const Icon = d.verdict === 'same' ? Equal : d.diff != null && d.diff > 0 ? ArrowUp : ArrowDown;
              return (
                <tr key={r.key}>
                  <th scope="row">{r.label}</th>
                  <td className="num">{b == null ? <span className="di-muted">—</span> : `${b.toFixed(r.digits)} ${r.unit}`}</td>
                  <td className="num">{a == null ? <span className="di-muted">—</span> : `${a.toFixed(r.digits)} ${r.unit}`}</td>
                  <td>
                    {d.verdict === 'unknown' ? (
                      <span className="di-muted">Not measured</span>
                    ) : (
                      <span className="di-delta" data-verdict={d.verdict}>
                        <Icon size={13} aria-hidden />
                        <span className="num">{formatPct(d.pct)}</span>
                        <span className="di-delta__word">{d.verdict === 'same' ? 'about the same' : d.verdict}</span>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(c.smallSample || c.gpuChanged) && (
        <p className="di-warn">
          <AlertTriangle size={13} aria-hidden />
          <span>
            {c.smallSample && `Only ${plural(Math.min(c.before.sessions, c.after.sessions), 'session')} on one side — treat this as a hint, not a verdict. `}
            {c.gpuChanged && `The graphics card name also changed (${c.before.gpuName} → ${c.after.gpuName}), so the GPU itself may explain the difference.`}
          </span>
        </p>
      )}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ background apps */

/** Which other apps tend to run during rough sessions — correlation only, with hide controls. */
export function BackgroundAppsCard() {
  const { data, error, loading, set } = useBridge<BackgroundImpact>('insights.backgroundApps', undefined, []);
  const navigate = useStore((s) => s.navigate);
  const [busy, setBusy] = useState<string | null>(null);

  const hide = async (name: string, hidden: boolean) => {
    setBusy(name);
    try {
      set(await call<BackgroundImpact>('insights.hideBackgroundApp', { name, hidden }));
    } catch (err) {
      useStore.getState().toast({ tone: 'danger', title: hidden ? 'Couldn’t hide that app' : 'Couldn’t show that app again', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Skeleton height={220} radius={22} />;
  if (error || !data) return <section className="surface vx-card di-card"><p className="di-muted">Background apps couldn’t be loaded: {error}</p></section>;

  const roughWord = data.mode === 'memory' ? 'memory-pressure sessions' : 'rough sessions';
  let body: ReactNode;
  if (data.sessionsAnalyzed === 0) {
    body = (
      <p className="di-muted">
        {data.collecting
          ? 'During your next sessions, VYSTRAL notes which other apps are among the heaviest about every 30 seconds. Once there are a few sessions, this card shows which ones tend to be running when a game plays badly.'
          : 'Background-app notes are off, or performance recording is off. Turn them on in Settings › Launching & sessions to see which apps run alongside your games.'}
      </p>
    );
  } else {
    body = (
      <>
        <p className="di-mode">
          {data.mode === 'fps'
            ? 'A rough session here is one where the 1% lows fell under half the average frame rate, stutters came more than once a minute, or the CPU averaged above 85%.'
            : 'There isn’t enough frame-rate data yet, so a rough session here is one where memory was more than 90% full — a rougher signal. With frame-rate capture on, this uses stutter and 1% lows instead.'}
        </p>
        {!data.enough ? (
          <p className="di-notice">
            <Info size={14} aria-hidden />
            <span>
              Not enough to compare yet: {plural(data.roughSessions, roughWord.replace('sessions', 'session'), roughWord)} and {plural(data.cleanSessions, 'smooth session')} so far.
              VYSTRAL needs at least 3 of each before it points at anything.
            </span>
          </p>
        ) : data.suspects.length === 0 ? (
          <p className="di-notice di-notice--ok">
            <Info size={14} aria-hidden />
            <span>No app stands out: the same apps were running in your {roughWord} ({data.roughSessions}) and smooth ones ({data.cleanSessions}).</span>
          </p>
        ) : (
          <div className="di-suspects">
            <h3 className="di-h3">Often running during your {roughWord}</h3>
            <ul className="di-apps">
              {data.suspects.map((a) => (
                <AppRow key={a.name} a={a} busy={busy === a.name} onHide={() => void hide(a.name, true)} reason={suspectReason(a, data.mode)} compare />
              ))}
            </ul>
            <p className="di-foot">
              <AlertTriangle size={13} aria-hidden />
              <span>
                This is correlation, not cause: these apps were running more often when games played badly ({data.roughSessions} rough vs {data.cleanSessions} smooth sessions). Closing them may help, or the cause may be something else entirely. VYSTRAL never closes apps.
              </span>
            </p>
          </div>
        )}
        {data.common.some((a) => !data.suspects.some((s) => s.name === a.name)) && (
          <div className="di-common">
            <h3 className="di-h3">Usually running while you play</h3>
            <ul className="di-apps">
              {data.common.filter((a) => !data.suspects.some((s) => s.name === a.name)).map((a) => (
                <AppRow key={a.name} a={a} busy={busy === a.name} onHide={() => void hide(a.name, true)} reason={`In ${presence(a.presence)} of ${plural(data.sessionsAnalyzed, 'session')}`} />
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }

  return (
    <section className="surface vx-card di-card" aria-labelledby="di-bg-title">
      <SectionHead
        title={<span id="di-bg-title"><Layers size={16} aria-hidden className="di-title-icon" />Background apps</span>}
        meta="Correlation, not cause"
        action={!data.collecting && data.sessionsAnalyzed > 0 ? <Button size="sm" variant="ghost" onClick={() => navigate({ name: 'settings', section: 'launching' })}>Turn on</Button> : undefined}
      />
      {body}
      {data.hidden.length > 0 && (
        <div className="di-hidden">
          <span className="di-muted">Hidden:</span>
          {data.hidden.map((name) => (
            <button key={name} type="button" className="di-chip" disabled={busy === name} onClick={() => void hide(name, false)} aria-label={`Show ${name} again`}>
              <Eye size={12} aria-hidden /> {name}
            </button>
          ))}
        </div>
      )}
      <p className="di-privacy">
        Stored on this PC only: program file names, their memory and CPU share — no window titles, paths or contents. Your game, VYSTRAL and core Windows processes are left out. Deleting tracked history removes all of it.
      </p>
    </section>
  );
}

function AppRow({ a, reason, busy, onHide, compare }: { a: BackgroundAppStat; reason: string; busy: boolean; onHide: () => void; compare?: boolean }) {
  return (
    <li className="di-app">
      <span className="di-app__badge" aria-hidden>{a.displayName.slice(0, 1).toUpperCase()}</span>
      <span className="di-app__main">
        <span className="di-app__name">{a.displayName}</span>
        <span className="di-app__reason">{reason}</span>
        {compare && a.roughPresence != null && a.cleanPresence != null && (
          <span className="di-app__bars" aria-hidden>
            <span className="di-bar di-bar--rough" style={{ width: `${Math.max(3, a.roughPresence * 100)}%` }} />
            <span className="di-bar di-bar--clean" style={{ width: `${Math.max(3, a.cleanPresence * 100)}%` }} />
          </span>
        )}
      </span>
      <span className="di-app__stats num">
        <span title="Average private memory while it was among the heaviest apps"><MemoryStick size={12} aria-hidden /> {formatMb(a.avgMb)}</span>
        {a.avgCpu != null && <span title="Average share of total CPU"><Cpu size={12} aria-hidden /> {a.avgCpu.toFixed(a.avgCpu < 10 ? 1 : 0)}%</span>}
      </span>
      <IconButton label={`Hide ${a.displayName} from this report`} size="sm" disabled={busy} onClick={onHide}>
        <EyeOff size={14} />
      </IconButton>
    </li>
  );
}
