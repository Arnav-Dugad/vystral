import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Maximize2, Plus, X } from 'lucide-react';
import { exit, pick, spring } from '../../lib/motion';
import { useAssistant } from '../../state/assistant';
import { useReducedMotion, useStore } from '../../state/store';
import { IconButton } from '../ui/primitives';
import { AssistantChat } from './AssistantChat';
import { ProviderSwitcher } from './ProviderSwitcher';
import './assistant-ui.css';

/** Track D3: the side panel itself (loaded the first time it opens, so the launcher costs almost nothing at startup). */
export default function Panel({ open }: { open: boolean }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const close = useAssistant((s) => s.closePanel);
  const newChat = useAssistant((s) => s.newChat);
  const hasMessages = useAssistant((s) => s.conversation.messages.length > 0);
  const busy = useAssistant((s) => !!s.activeRequest);
  const navigate = useStore((s) => s.navigate);

  useEffect(() => {
    if (!open) return;
    previous.current = document.activeElement as HTMLElement | null;
    void useAssistant.getState().refreshStatus();
    // Focus moves into the panel (the composer takes it when it can; otherwise the panel itself).
    const t = window.setTimeout(() => {
      if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    }, 120);
    return () => {
      window.clearTimeout(t);
      const p = previous.current;
      if (p && document.contains(p) && !p.closest('.asx-panel')) requestAnimationFrame(() => p.focus());
      else requestAnimationFrame(() => document.querySelector<HTMLElement>('.asx-launcher')?.focus());
    };
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !document.querySelector('[data-menu-open]')) {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.aside
          ref={ref}
          className="asx-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="asx-panel-title"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: 28, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={reduce ? { opacity: 0, transition: exit } : { opacity: 0, x: 24, scale: 0.98, transition: exit }}
          transition={pick(reduce, spring.panel)}
        >
          <header className="asx-panel__head">
            <div className="asx-panel__id">
              <h2 id="asx-panel-title" className="asx-panel__title">Assistant</h2>
              <ProviderSwitcher compact />
            </div>
            <div className="asx-panel__actions">
              {hasMessages && (
                <IconButton size="sm" label="New chat" onClick={newChat} disabled={busy}><Plus size={16} /></IconButton>
              )}
              <IconButton size="sm" label="Open full Assistant" onClick={() => navigate({ name: 'assistant' })}><Maximize2 size={15} /></IconButton>
              <IconButton size="sm" label="Close the Assistant" onClick={close}><X size={16} /></IconButton>
            </div>
          </header>
          <AssistantChat compact />
        </motion.aside>
      )}
    </AnimatePresence>,
    document.body,
  );
}
