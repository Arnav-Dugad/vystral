import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, ChevronDown, CircleDashed, MinusCircle, RefreshCw, XCircle } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import { formatRelative } from '../../lib/format';
import { useStore } from '../../state/store';
import { Button } from '../../components/ui/primitives';
import { NewBadge } from '../../whatsnew/NewBadge';
import { overall, sparkPoints, STATUS_LABEL, type HealthProbeInfo, type HealthResult, type HealthStatus } from './networkHealth';
import './network-health.css';

const HISTORY = 12;

/** This session's results and latency history (never stored; checks run only on request). */
interface HealthSession {
  probes: HealthProbeInfo[];
  results: Record<string, HealthResult>;
  history: Record<string, (number | null)[]>;
  running: Set<string>;
  lastRun: string | null;
}

const useHealth = create<HealthSession>(() => ({ probes: [], results: {}, history: {}, running: new Set(), lastRun: null }));

async function loadProbes() {
  try {
    useHealth.setState({ probes: await call<HealthProbeInfo[]>('network.health.list') });
  } catch {
    // shown as empty; Check now still works
  }
}

async function check(id: string | null) {
  const { probes, running } = useHealth.getState();
  const ids = id ? [id] : probes.map((p) => p.id);
  if (ids.every((x) => running.has(x))) return;
  useHealth.setState({ running: new Set([...running, ...ids]) });
  // One call per service, in parallel, so each row updates the moment its answer arrives.
  await Promise.allSettled(ids.map(async (pid) => {
    try {
      const [r] = await call<HealthResult[]>('network.health.check', { id: pid }, 30_000);
      if (!r) return;
      const s = useHealth.getState();
      const series = r.status === 'skipped' ? s.history[pid] ?? [] : [...(s.history[pid] ?? []), r.status === 'down' ? null : r.ms].slice(-HISTORY);
      useHealth.setState({ results: { ...s.results, [pid]: r }, history: { ...s.history, [pid]: series }, lastRun: r.checkedAt });
    } catch (err) {
      useStore.getState().toast({ tone: 'danger', title: 'Couldn’t check the network', body: errorMessage(err) });
    } finally {
      const r = new Set(useHealth.getState().running);
      r.delete(pid);
      useHealth.setState({ running: r });
    }
  }));
}

const ICON: Record<HealthStatus, typeof CheckCircle2> = { ok: CheckCircle2, warn: AlertTriangle, down: XCircle, skipped: MinusCircle };

/** Settings → Privacy → Network health. */
export function NetworkHealthSettings() {
  const probes = useHealth((s) => s.probes);
  const results = useHealth((s) => s.results);
  const running = useHealth((s) => s.running);
  const lastRun = useHealth((s) => s.lastRun);
  const offline = useStore((s) => !!s.settings?.['privacy.localOnly']);
  const settings = useStore((s) => s.settings);

  // The list (which services, which are skipped) follows the settings; it never touches the network.
  useEffect(() => void loadProbes(), [settings]);

  const summary = overall(probes.map((p) => results[p.id]).filter((r): r is HealthResult => !!r));
  const busy = running.size > 0;

  return (
    <section className="sgroup" aria-labelledby="nh-title">
      <h2 className="sgroup__title" id="nh-title">
        Network health <NewBadge k="settings.privacy.network-health" variant="pill" seenWhenVisible />
      </h2>
      <p className="sgroup__desc">
        Checks every service VYSTRAL uses, from this PC: each of its addresses, then one small request. Only when you press Check now; never in the background.
        {offline && ' Offline mode is on, so only services on this PC are checked.'}
      </p>
      <div className="sgroup__rows surface nh">
        <div className="nh__head">
          <div className="nh__overall" aria-live="polite">
            {summary ? (
              <>
                <StatusIcon status={summary.status} />
                <span>{summary.text}</span>
              </>
            ) : (
              <span className="srow__hint">Not checked yet this session</span>
            )}
            {lastRun && <span className="srow__hint"> · {formatRelative(lastRun)}</span>}
          </div>
          <Button size="sm" variant="primary" icon={<RefreshCw size={14} />} loading={busy} onClick={() => void check(null)} disabled={probes.length === 0}>
            Check now
          </Button>
        </div>
        <ul className="nh__list">
          {probes.map((p) => (
            <ProbeRow key={p.id} probe={p} result={results[p.id]} running={running.has(p.id)} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function StatusIcon({ status, size = 16 }: { status: HealthStatus; size?: number }) {
  const Icon = ICON[status];
  return <Icon size={size} className="nh__icon" data-status={status} aria-label={STATUS_LABEL[status]} role="img" />;
}

function ProbeRow({ probe, result, running }: { probe: HealthProbeInfo; result?: HealthResult; running: boolean }) {
  const [open, setOpen] = useState(false);
  const history = useHealth((s) => s.history[probe.id]) ?? [];
  const status: HealthStatus | null = result?.status ?? (probe.skipped ? 'skipped' : null);
  const summary = result?.summary ?? probe.skipped ?? 'Not checked yet';
  const addresses = result?.addresses ?? [];
  const detailsId = `nh-addr-${probe.id.replace(/\W/g, '-')}`;

  return (
    <li className="nh-row" data-status={status ?? 'none'} data-testid={`health-${probe.id}`}>
      <div className="nh-row__status">
        {running ? <span className="spinner nh__spinner" aria-label="Checking" role="img" /> : status ? <StatusIcon status={status} /> : <CircleDashed size={16} className="nh__icon" aria-label="Not checked" role="img" />}
      </div>
      <div className="nh-row__text">
        <div className="nh-row__label">
          {probe.label} <span className="nh-row__purpose">· {probe.purpose}</span>
        </div>
        <div className="nh-row__summary">{summary}</div>
        {result?.detail && <div className="nh-row__detail">{result.detail}</div>}
        {addresses.length > 0 && (
          <>
            <button className="nh-row__toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
              <ChevronDown size={13} aria-hidden style={{ transform: open ? 'rotate(180deg)' : undefined }} />
              {probe.host} · {addresses.filter((a) => a.reachable).length} of {addresses.length} addresses reachable
            </button>
            {open && (
              <ul className="nh-addr" id={detailsId}>
                {addresses.map((a) => (
                  <li key={a.address} className="nh-addr__item" data-ok={a.reachable}>
                    {a.reachable ? <CheckCircle2 size={12} aria-hidden /> : <XCircle size={12} aria-hidden />}
                    <span className="num">{a.address}</span>
                    <span className="nh-addr__meta">{a.family} · {a.reachable ? `${a.ms} ms` : a.error}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <Sparkline values={history} label={`${probe.label} response times this session`} />
      <div className="nh-row__ms num">{result?.ms != null && result.status !== 'skipped' ? `${result.ms} ms` : ''}</div>
      <Button size="sm" variant="ghost" onClick={() => void check(probe.id)} disabled={running} aria-label={`Check ${probe.label} now`}>
        Check
      </Button>
    </li>
  );
}

/** Latency of this session's checks, oldest → newest (failed checks are left out). */
function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const w = 72, h = 24;
  const pts = sparkPoints(values, w, h, 3);
  const nums = values.filter((v): v is number => v !== null);
  const text = nums.length ? `${label}: ${nums.map((v) => `${v} ms`).join(', ')}` : `${label}: none yet`;
  return (
    <svg className="nh-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={text}>
      <title>{text}</title>
      {pts.length > 1 && <polyline points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" />}
      {pts.length > 0 && <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r={2.5} />}
    </svg>
  );
}
