import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, Cpu, Info, Sparkles } from 'lucide-react';
import './ai.css';

/**
 * Track C5: who wrote a piece of text. "VYSTRAL" when it's VYSTRAL's own deterministic answer, otherwise the
 * engine label ("Claude · Claude Sonnet 5.5", "Local AI · qwen3:4b"). Always visible next to AI text.
 */
export function AiByline({ label, cloud }: { label: string | null; cloud?: boolean }) {
  return (
    <span className="ai-byline" data-ai={label ? (cloud === false ? 'local' : 'cloud') : 'none'}>
      {label ? <Sparkles size={12} aria-hidden /> : <Cpu size={12} aria-hidden />}
      {label ? <>Worded by {label}</> : <>Calculated by VYSTRAL on this PC</>}
    </span>
  );
}

/** "What was sent" disclosure: exactly what left the PC (or that nothing did). */
export function WhatWasSent({ sent, compact }: { sent: string | null; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!sent) return compact ? null : <p className="ai-sent ai-sent--local"><Info size={12} aria-hidden /> Nothing left this PC.</p>;
  return (
    <div className="ai-sent">
      <button type="button" className="ai-sent__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={12} aria-hidden data-open={open || undefined} /> What was sent
      </button>
      {open && <p id={id} className="ai-sent__body">{sent}</p>}
    </div>
  );
}

/** A small, calm note (fallback reasons and the like). */
export function AiNote({ children }: { children: ReactNode }) {
  return (
    <p className="ai-note" role="note">
      <Info size={13} aria-hidden />
      <span>{children}</span>
    </p>
  );
}
