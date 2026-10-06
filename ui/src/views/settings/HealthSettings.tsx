import { useEffect, useState } from 'react';
import { NewBadge } from '../../whatsnew/NewBadge';
import { HeartPulse } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { HealthReport } from '../../bridge/types';
import { tier, TIER_LABEL } from '../../lib/health';
import { useStore } from '../../state/store';
import { Badge, Button } from '../../components/ui/primitives';

/** Settings › Library & stores: the library health check (Track Q) — a quick score and a way in. */
export function HealthSettings() {
  const [report, setReport] = useState<HealthReport | null>(null);
  useEffect(() => {
    let live = true;
    call<HealthReport>('health.check', undefined, 120_000).then((r) => live && setReport(r)).catch(() => {});
    return () => { live = false; };
  }, []);
  const n = report?.issues.length ?? 0;
  return (
    <section className="sgroup">
      <h2 className="sgroup__title">Library health<NewBadge k="settings.library.health" variant="pill" seenWhenVisible /></h2>
      <p className="sgroup__desc">
        Finds games that can’t start, drives that aren’t connected, duplicates, missing or blurry art and sessions that never ended — each with a safe
        fix. The check reads only this PC and never deletes anything.
      </p>
      <div className="sgroup__rows surface">
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">Health check</span>
            <div className="srow__hint" aria-live="polite">
              {!report ? 'Checking…' : n === 0 ? 'Everything looks healthy.' : `${n.toLocaleString()} ${n === 1 ? 'thing' : 'things'} to look at.`}
            </div>
          </div>
          <div className="srow__control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {report && <Badge tone={report.score >= 90 ? 'ok' : report.score >= 45 ? 'accent' : 'warn'}>{report.score} · {TIER_LABEL[tier(report.score)]}</Badge>}
            <Button size="sm" icon={<HeartPulse size={14} />} onClick={() => useStore.getState().navigate({ name: 'health' })}>Open health check</Button>
          </div>
        </div>
      </div>
    </section>
  );
}
