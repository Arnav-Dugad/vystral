import { useEffect, useState } from 'react';
import { AlertTriangle, History, RotateCcw, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { StreakSummary } from '../../bridge/types';
import { formatDate } from '../../lib/format';
import { streakHeadline, streakSentence, streakSub } from '../../lib/streak';
import { useReducedMotion } from '../../state/store';
import './crash-free.css';

const KIND_ICON = { failedStart: XCircle, unexpectedClose: AlertTriangle, rollback: RotateCcw, selfCheck: ShieldCheck } as const;

/**
 * Track D6: Settings › About › the crash-free streak. From VYSTRAL's own start history (each start, and whether it got
 * to a steady interface), the after-update self-checks and the rollback record. Local only; nothing is sent.
 */
export function CrashFreeStreak() {
  const [s, setS] = useState<StreakSummary | null>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    let live = true;
    call<StreakSummary>('about.streak').then((r) => live && setS(r)).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!s) return null;
  const max = Math.max(1, ...s.recent.map((d) => d.starts));
  return (
    <section className="sgroup streak" aria-labelledby="streak-title" data-testid="crash-free-streak">
      <h2 className="sgroup__title" id="streak-title">Stability</h2>
      <div className="sgroup__rows surface streak__card">
        <div className="streak__hero">
          <span className="streak__badge" data-clean={s.failedStarts === 0 || undefined} aria-hidden>
            <Sparkles size={18} />
          </span>
          <div>
            {s.startsCounted > 0 && <div className="streak__big" aria-hidden><span className="num">{s.days.toLocaleString()}</span> {s.days === 1 ? 'day' : 'days'}</div>}
            <div className="srow__label"><span className="visually-hidden">{streakSentence(s)}</span><span aria-hidden>{streakHeadline(s)}</span></div>
            <div className="srow__hint">{streakSub(s)}</div>
          </div>
        </div>
        <figure className="streak__chart" aria-label={`Starts over the last 30 days: ${s.recent.reduce((n, d) => n + d.starts, 0)} starts, ${s.recent.reduce((n, d) => n + d.failed, 0)} failed.`} role="img">
          <div className="streak__bars" aria-hidden>
            {s.recent.map((d, i) => (
              <span key={d.day} className="streak__bar" data-failed={d.failed > 0 || undefined} data-unexpected={d.unexpected > 0 || undefined}
                title={`${formatDate(`${d.day}T12:00:00`, { day: 'numeric', month: 'short' })}: ${d.starts} start${d.starts === 1 ? '' : 's'}${d.failed ? `, ${d.failed} failed` : ''}${d.unexpected ? `, ${d.unexpected} closed unexpectedly` : ''}`}
                style={{ height: `${d.starts ? 18 + (d.starts / max) * 82 : 6}%`, animationDelay: reduce ? undefined : `${i * 14}ms` }} />
            ))}
          </div>
          <figcaption className="streak__axis" aria-hidden><span>30 days ago</span><span>Today</span></figcaption>
        </figure>
        <div className="streak__incidents">
          <h3 className="streak__subhead"><History size={13} aria-hidden /> {s.lastIncident ? 'Recent incidents' : 'No incidents on record'}</h3>
          {s.incidents.length > 0 ? (
            <ul>
              {s.incidents.slice(0, 4).map((i) => {
                const Icon = KIND_ICON[i.kind as keyof typeof KIND_ICON] ?? AlertTriangle;
                return (
                  <li key={`${i.at}-${i.kind}`} data-kind={i.kind}>
                    <Icon size={14} aria-hidden />
                    <span>{i.text}</span>
                    <span className="streak__when num">{formatDate(i.at, { dateStyle: 'medium' })}</span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="srow__hint">Nothing has gone wrong since VYSTRAL started keeping count.</p>}
        </div>
      </div>
    </section>
  );
}
