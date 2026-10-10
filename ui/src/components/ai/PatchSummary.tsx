import { useState } from 'react';
import { motion } from 'motion/react';
import { ListChecks, RefreshCw, Sparkles } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { PatchSummary as Summary } from '../../bridge/types';
import { pick, spring } from '../../lib/motion';
import { useAiFeatureOn, useAiStatus } from '../../state/ai';
import { useReducedMotion } from '../../state/store';
import { Button, Skeleton } from '../ui/primitives';
import { AiByline, AiNote, WhatWasSent } from './AiBits';
import './ai.css';

const seen = new Map<string, Summary>();

/**
 * Track C5: a post condensed into three bullets, on request. With AI it's worded by the chosen model (checked so it
 * only repeats numbers from the post) and cached per post; without AI, VYSTRAL shows the post's first key lines.
 */
export function PatchSummary({ gameId, gid }: { gameId: string; gid: string }) {
  const status = useAiStatus();
  const featureOn = useAiFeatureOn('patchNotes');
  const reduce = useReducedMotion();
  const key = `${gameId}:${gid}`;
  const [data, setData] = useState<Summary | null>(seen.get(key) ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withAi = !!status?.active.ready && featureOn;

  const run = async (refresh = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await call<Summary>('aix.patchSummary', { gameId, gid, refresh }, 150_000);
      seen.set(key, r);
      setData(r);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!data && !busy)
    return (
      <div className="ai-patch ai-patch--idle">
        <Button size="sm" variant="ghost" icon={withAi ? <Sparkles size={14} /> : <ListChecks size={14} />} onClick={() => void run()}>
          {withAi ? `Summarize in three bullets (${status!.active.label.split(' · ')[0]})` : 'Show the key lines'}
        </Button>
        {error && <span className="ai-ask__error" role="alert">{error}</span>}
      </div>
    );

  return (
    <motion.aside
      className="ai-patch surface"
      aria-label={data?.ai ? 'Summary' : 'Key lines'}
      aria-busy={busy || undefined}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={pick(reduce, spring.panel)}
    >
      <div className="ai-patch__head">
        <span className="ai-patch__title">{data?.ai ? <><Sparkles size={13} aria-hidden /> In three bullets</> : <><ListChecks size={13} aria-hidden /> Key lines</>}</span>
        {data?.ai && !busy && (
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void run(true)} aria-label="Summarize again">Again</Button>
        )}
      </div>
      {busy ? (
        <div className="ai-patch__loading"><Skeleton height={13} width="92%" /><Skeleton height={13} width="80%" /><Skeleton height={13} width="70%" /></div>
      ) : data && (
        <>
          <ul className="ai-patch__list selectable">{data.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
          <div className="ai-ask__meta">
            <AiByline label={data.aiLabel} cloud={data.engine.cloud} />
            {data.cached && <span className="ai-ask__note">Saved summary</span>}
            {data.trimmed && <span className="ai-ask__note">A long post: the first part was summarized.</span>}
          </div>
          {data.note && !data.ai && <AiNote>{data.note}</AiNote>}
          <WhatWasSent sent={data.sent} compact />
        </>
      )}
      {error && <p className="ai-ask__error" role="alert">{error}</p>}
    </motion.aside>
  );
}
