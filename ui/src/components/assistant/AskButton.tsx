import { Sparkles } from 'lucide-react';
import { openAssistant } from '../../state/assistant';
import { useStore } from '../../state/store';
import { Button, IconButton } from '../ui/primitives';

/**
 * Track D3: a small inline way into the one Assistant (a game page's "Ask", a session's "Explain this stutter"). It opens
 * the side panel; with `send`, the question is asked straight away. Hidden when the Assistant is turned off.
 */
export function AskAssistantButton({ label, prompt, send, icon, className, sessionId }: { label: string; prompt?: string; send?: boolean; icon?: boolean; className?: string; sessionId?: string }) {
  const on = useStore((s) => s.settings?.['ai.features.assistant'] ?? true);
  if (!on) return null;
  const open = () => openAssistant(prompt, send, sessionId);
  return icon ? (
    <IconButton label={label} onClick={open} className={className}>
      <Sparkles size={18} />
    </IconButton>
  ) : (
    <Button size="sm" icon={<Sparkles size={14} aria-hidden />} onClick={open} className={className}>
      {label}
    </Button>
  );
}
