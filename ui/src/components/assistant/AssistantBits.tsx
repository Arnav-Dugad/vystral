import { useId, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, EyeOff, Info, Loader2, Sparkles, Wand2, X } from 'lucide-react';
import type { AssistantToolCall } from '../../bridge/types';
import { providerMark } from '../../lib/assistant';
import { pick, spring } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';
import { ServiceLogo } from '../ui/ServiceLogo';
import { TOOL_ICONS } from './toolIcons';

/** The orb, or the answering provider's own mark inside it. */
export function AssistantAvatar({ provider, size = 'xs' }: { provider?: string | null; size?: 'xs' | 'sm' | 'md' }) {
  const mark = providerMark(provider ?? undefined);
  return (
    <span className={`asx-avatar asx-avatar--${size}`} data-mark={mark ?? undefined} aria-hidden>
      {mark ? <ServiceLogo service={mark} size={size === 'md' ? 24 : size === 'sm' ? 18 : 14} decorative brand /> : <Sparkles size={size === 'md' ? 26 : size === 'sm' ? 18 : 13} />}
    </span>
  );
}

/** "Thinking…" with a soft travelling shimmer; names the look-up in progress. Reduced motion: still text. */
export function Thinking({ label }: { label?: string | null }) {
  const reduce = useReducedMotion();
  return (
    <div className="asx-thinking" role="status" aria-live="polite">
      <span className="asx-thinking__orb" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={label ?? 'thinking'}
          className="asx-thinking__text"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={pick(reduce, spring.effect)}
        >
          {label ?? 'Thinking…'}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

const STATUS_ICON: Record<AssistantToolCall['status'], ReactNode> = {
  running: <Loader2 size={12} className="asx-spin" aria-hidden />,
  done: <Check size={12} aria-hidden />,
  error: <X size={12} aria-hidden />,
  declined: <EyeOff size={12} aria-hidden />,
  proposed: <Wand2 size={12} aria-hidden />,
};

const STATUS_WORD: Record<AssistantToolCall['status'], string> = {
  running: 'looking up',
  done: 'done',
  error: 'didn’t work',
  declined: 'not shared',
  proposed: 'waiting for you',
};

/** Small chips under an answer: which look-ups the assistant used, and how each went. */
export function ToolChips({ tools }: { tools: AssistantToolCall[] }) {
  if (!tools.length) return null;
  return (
    <ul className="asx-chips" aria-label="Look-ups used">
      {tools.map((t) => {
        const Icon = TOOL_ICONS[t.name] ?? Info;
        return (
          <li key={t.id} className="asx-chip" data-status={t.status} data-kind={t.kind} title={t.summary ?? undefined}>
            <Icon size={12} aria-hidden />
            <span>{t.label}</span>
            <span className="asx-chip__state">{STATUS_ICON[t.status]}<span className="visually-hidden">: {STATUS_WORD[t.status]}{t.summary ? `, ${t.summary}` : ''}</span></span>
          </li>
        );
      })}
    </ul>
  );
}

/** Who answered: the provider's mark and label, or "on this PC". */
export function Byline({ provider, engine, cloud }: { provider?: string; engine?: string; cloud?: boolean }) {
  const mark = providerMark(provider);
  return (
    <span className="asx-byline" data-cloud={cloud || undefined}>
      {mark ? <ServiceLogo service={mark} size={14} decorative /> : <Sparkles size={12} aria-hidden />}
      <span>{engine ?? 'Assistant'}</span>
      <span className="asx-byline__where">{cloud ? 'cloud' : 'on this PC'}</span>
    </span>
  );
}

/** "What was sent": exactly what left the PC for this answer. */
export function SentNote({ sent }: { sent: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!sent) return null;
  return (
    <div className="asx-sent">
      <button type="button" className="asx-sent__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={12} aria-hidden data-open={open || undefined} /> What was sent
      </button>
      {open && <p id={id} className="asx-sent__body">{sent}</p>}
    </div>
  );
}
