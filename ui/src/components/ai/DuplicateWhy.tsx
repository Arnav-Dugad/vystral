import { useId, useState } from 'react';
import { Check, HelpCircle, Minus } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { DuplicateExplanation } from '../../bridge/types';
import { Button, Skeleton } from '../ui/primitives';
import { AiByline, WhatWasSent } from './AiBits';
import './ai.css';

const cache = new Map<string, DuplicateExplanation>();

/**
 * Track C5: "Why?" on a duplicate suggestion. The facts (same Steam app, same title without edition words, release
 * year, developer, stores) are always VYSTRAL's own; with AI on, one plain sentence weighs them up.
 */
export function DuplicateWhy({ gameIdA, gameIdB }: { gameIdA: string; gameIdB: string }) {
  const key = `${gameIdA}:${gameIdB}`;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DuplicateExplanation | null>(cache.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || data || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await call<DuplicateExplanation>('aix.explainDuplicate', { gameIdA, gameIdB }, 120_000);
      cache.set(key, r);
      setData(r);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-dup">
      <Button size="sm" variant="ghost" icon={<HelpCircle size={14} />} aria-expanded={open} aria-controls={id} onClick={() => void toggle()}>
        Why?
      </Button>
      {open && (
        <div id={id} className="ai-dup__panel" aria-live="polite" aria-busy={busy || undefined}>
          {busy && <><Skeleton height={14} width="80%" /><Skeleton height={14} width="60%" /></>}
          {error && <p className="ai-ask__error" role="alert">{error}</p>}
          {data && (
            <>
              {data.sentence && <p className="ai-dup__sentence selectable">{data.sentence}</p>}
              <ul className="ai-dup__facts">
                {data.facts.map((f) => (
                  <li key={f.kind + f.text} data-supports={f.supports || undefined}>
                    {f.supports ? <Check size={13} aria-hidden /> : <Minus size={13} aria-hidden />}
                    <span><span className="visually-hidden">{f.supports ? 'Alike: ' : 'Different: '}</span>{f.text}</span>
                  </li>
                ))}
              </ul>
              <div className="ai-ask__meta">
                <AiByline label={data.aiLabel} cloud={data.engine.cloud} />
                {data.note && <span className="ai-ask__note">{data.note}</span>}
              </div>
              <WhatWasSent sent={data.sent} compact />
            </>
          )}
        </div>
      )}
    </div>
  );
}
