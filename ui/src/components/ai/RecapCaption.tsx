import { useEffect, useState } from 'react';
import { PenLine, RefreshCw, Sparkles } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { RecapCaption as Caption } from '../../bridge/types';
import { useAiFeatureOn, useAiStatus } from '../../state/ai';
import { Button, Skeleton } from '../ui/primitives';
import { WhatWasSent } from './AiBits';
import './ai.css';

/**
 * Track C5: a one-line story under a replay card, from that session's own stats. Automatic only with
 * "Session recap captions" on; otherwise there's a small "Write a caption" button (once AI is set up). Cached per
 * session. Optional and quiet: no AI means no caption, and nothing else changes.
 */
export function RecapCaption({ sessionId }: { sessionId: string }) {
  const status = useAiStatus();
  const auto = useAiFeatureOn('recapCaptions');
  const [data, setData] = useState<Caption | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = !!status?.active.ready;

  const run = async (opts: { ask?: boolean; refresh?: boolean }) => {
    setBusy(true);
    try {
      setData(await call<Caption>('aix.recapCaption', { sessionId, ...opts }, 120_000));
    } catch {
      setData(null);
    } finally {
      setBusy(false);
    }
  };

  // Shows a saved caption (or writes one when automatic captions are on).
  useEffect(() => {
    if (!status) return;
    void run({});
  }, [sessionId, status?.active.engine, auto]); // eslint-disable-line react-hooks/exhaustive-deps

  if (busy) return <div className="ai-caption" aria-busy="true"><Skeleton height={16} width="60%" /></div>;
  if (data?.caption)
    return (
      <div className="ai-caption">
        <p className="ai-caption__text selectable"><Sparkles size={13} aria-hidden /> {data.caption}</p>
        <span className="ai-caption__by">Caption by {data.aiLabel}</span>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void run({ ask: true, refresh: true })} aria-label="Write another caption">Another</Button>
        <WhatWasSent sent={data.sent} compact />
      </div>
    );
  if (!ready) return null;
  return (
    <div className="ai-caption ai-caption--idle">
      <Button size="sm" variant="ghost" icon={<PenLine size={13} />} onClick={() => void run({ ask: true })}>Write a caption</Button>
      {data?.note && <span className="ai-ask__note">{data.note}</span>}
    </div>
  );
}
