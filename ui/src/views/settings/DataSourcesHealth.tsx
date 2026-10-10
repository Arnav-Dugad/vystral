import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Bot, CheckCircle2, CircleDashed, Clock, Coins, Database, Hourglass, KeyRound, PauseCircle, RefreshCw, Settings2, XCircle } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { ProviderHealthEntry, ProviderHealthSnapshot } from '../../bridge/types';
import { formatRelative } from '../../lib/format';
import { SERVICE_MARKS, type ServiceId } from '../../lib/serviceMarks';
import { healthSummary, providerStatusLabel, untilText } from '../../lib/providerHealth';
import { useStore } from '../../state/store';
import { Button, EmptyState, Skeleton } from '../../components/ui/primitives';
import { ServiceLogo } from '../../components/ui/ServiceLogo';
import { StoreLogo } from '../../components/ui/StoreLogo';
import './data-sources-health.css';

const STATE_ICON = { ok: CheckCircle2, error: XCircle, backoff: PauseCircle, idle: CircleDashed, off: CircleDashed } as const;

function Mark({ p }: { p: ProviderHealthEntry }) {
  if (p.logo === 'steam') return <StoreLogo platform="steam" size={20} decorative />;
  if (p.logo && p.logo in SERVICE_MARKS) return <ServiceLogo service={p.logo as ServiceId} size={20} decorative motion />;
  if (p.id === 'fx') return <Coins size={18} aria-hidden />;
  if (p.id.startsWith('ai-')) return <Bot size={18} aria-hidden />;
  return <Database size={18} aria-hidden />;
}

/**
 * Track D6: Settings › Data sources. Every online source VYSTRAL can use, at a glance: whether it's on (and why not),
 * the last answer and the last problem in plain words, any pause it asked for, how many requests went out today and
 * how old its cache is. Read from the backend's shared provider health registry; nothing here sends a request.
 */
export function DataSourcesHealth() {
  const [snap, setSnap] = useState<ProviderHealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useStore((s) => s.navigate);
  const settingsKey = useStore((s) => JSON.stringify(s.settings ?? {}).length);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSnap(await call<ProviderHealthSnapshot>('providers.health'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load, settingsKey]);
  // Pauses count down and "2 min ago" ages while the page is open; refresh quietly every 20 s when visible.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      tick((n) => n + 1);
      void call<ProviderHealthSnapshot>('providers.health').then(setSnap).catch(() => {});
    }, 20_000);
    return () => window.clearInterval(id);
  }, []);

  const groups = useMemo(() => {
    const map = new Map<string, ProviderHealthEntry[]>();
    for (const p of snap?.providers ?? []) map.set(p.group, [...(map.get(p.group) ?? []), p]);
    return [...map.entries()];
  }, [snap]);
  const summary = snap ? healthSummary(snap.providers) : null;

  return (
    <section className="sgroup dsh" aria-labelledby="dsh-title" data-testid="sources-health">
      <h2 className="sgroup__title" id="dsh-title">Data sources at a glance</h2>
      <p className="sgroup__desc">
        Every online source VYSTRAL can use, and how it’s doing. Each one is asked politely (one request at a time, and it waits when a source asks it
        to slow down), and Offline mode stops them all. Counts reset at midnight and stay on this PC.
      </p>
      <div className="dsh__bar surface">
        {summary ? (
          <div className="dsh__summary" role="status">
            <span className="dsh__chip" data-tone="ok"><CheckCircle2 size={14} aria-hidden /> {summary.on} on</span>
            {summary.attention > 0 && <span className="dsh__chip" data-tone="warn"><AlertTriangle size={14} aria-hidden /> {summary.attention} need{summary.attention === 1 ? 's' : ''} attention</span>}
            {summary.paused > 0 && <span className="dsh__chip" data-tone="info"><Hourglass size={14} aria-hidden /> {summary.paused} paused</span>}
            <span className="dsh__chip">{summary.off} off</span>
            <span className="dsh__chip num">{summary.requests.toLocaleString()} request{summary.requests === 1 ? '' : 's'} today</span>
          </div>
        ) : <Skeleton height={28} width="60%" />}
        <div className="dsh__actions">
          <Button size="sm" variant="ghost" icon={<Settings2 size={14} />} onClick={() => navigate({ name: 'settings', section: 'library', row: 'data-sources' })}>Keys and switches</Button>
          <Button size="sm" icon={<RefreshCw size={14} />} loading={loading} onClick={() => void load()}>Refresh</Button>
        </div>
      </div>
      {snap?.offline && (
        <p className="dsh__offline" role="note"><AlertTriangle size={14} aria-hidden /> Offline mode is on, so none of these are used right now. Cached answers stay visible.</p>
      )}
      {error && !snap && <EmptyState icon={<Database size={28} />} title="Couldn’t read the data sources" body={error} art="none" />}
      {!snap && !error && <div className="dsh__group"><Skeleton height={64} /><Skeleton height={64} /><Skeleton height={64} /></div>}
      {groups.map(([group, list]) => (
        <div key={group} className="dsh__group">
          <h3 className="dsh__grouphead">{group}</h3>
          <ul className="dsh__list surface">
            {list.map((p, i) => <ProviderRow key={p.id} p={p} index={i} />)}
          </ul>
        </div>
      ))}
    </section>
  );
}

function Fact({ icon, label, children, tone }: { icon: ReactNode; label: string; children: ReactNode; tone?: 'warn' | 'danger' }) {
  return (
    <div className="dsh-fact" data-tone={tone}>
      <dt>{icon}{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ProviderRow({ p, index }: { p: ProviderHealthEntry; index: number }) {
  const Icon = STATE_ICON[p.state] ?? CircleDashed;
  const label = providerStatusLabel(p);
  return (
    <li className="dsh-row logo-host" data-state={p.state} data-testid={`health-${p.id}`} style={{ animationDelay: `${Math.min(index, 10) * 28}ms` }}>
      <span className="dsh-row__mark"><Mark p={p} /></span>
      <div className="dsh-row__main">
        <div className="dsh-row__head">
          <span className="dsh-row__name">{p.name}</span>
          <span className="dsh-pill" data-state={p.state}><Icon size={12} aria-hidden /> {label}</span>
          {p.optIn && <span className="dsh-row__optin" title="Used only after you turn it on or add your key">Opt-in</span>}
        </div>
        <p className="dsh-row__purpose">{p.purpose}</p>
        {p.state === 'off' ? (
          <p className="dsh-row__off">{p.disabledReason?.toLowerCase().includes('key') || p.disabledReason?.toLowerCase().includes('twitch') ? <KeyRound size={12} aria-hidden /> : null}{p.disabledReason ?? 'Off'}</p>
        ) : (
          <dl className="dsh-row__facts">
            <Fact icon={<CheckCircle2 size={12} aria-hidden />} label="Last answer">{p.lastSuccess ? formatRelative(p.lastSuccess) : 'None yet'}</Fact>
            <Fact icon={<XCircle size={12} aria-hidden />} label="Last problem" tone={p.state === 'error' ? 'danger' : undefined}>
              {p.lastError ? <>{p.lastErrorText ?? 'Something went wrong'} <span className="dsh-row__when">· {formatRelative(p.lastError).toLowerCase()}</span></> : 'None'}
            </Fact>
            {p.backoffUntil && (
              <Fact icon={<Hourglass size={12} aria-hidden />} label="Paused" tone="warn">{p.backoffReason ?? 'Asked to slow down'} · {untilText(p.backoffUntil)}</Fact>
            )}
            <Fact icon={<RefreshCw size={12} aria-hidden />} label="Requests today"><span className="num">{p.requestsToday.toLocaleString()}</span></Fact>
            <Fact icon={<Clock size={12} aria-hidden />} label="Cache">{p.cacheUpdated ? `Updated ${formatRelative(p.cacheUpdated).toLowerCase()}` : 'Nothing cached'}</Fact>
          </dl>
        )}
      </div>
    </li>
  );
}
