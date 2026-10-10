import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Maximize2, Plus, Sparkles, X } from 'lucide-react';
import { isPanelShortcut } from '../../lib/assistant';
import { exit, pick, spring } from '../../lib/motion';
import { openAssistant, useAssistant } from '../../state/assistant';
import { useReducedMotion, useStore } from '../../state/store';
import { IconButton } from '../ui/primitives';
import { AssistantChat } from './AssistantChat';
import { ProviderSwitcher } from './ProviderSwitcher';
import './assistant-ui.css';

/**
 * Track D3: the Assistant on every page. A floating launcher (bottom right) and Ctrl+J open a side panel with the same
 * conversation as the Assistant page; it knows the page and game you're on. The panel doesn't block the page (it isn't
 * modal); Escape closes it and focus returns to where it was. Rendered only in the desktop shell, so Immersive Mode
 * stays controller-clean.
 */
export function AssistantHost() {
  const open = useAssistant((s) => s.panelOpen);
  const route = useStore((s) => s.route.name);
  const launcherOn = useStore((s) => s.settings?.['assistant.launcher'] ?? true);
  const onboarding = useStore((s) => !!s.settings && !s.settings['onboarding.completed']);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPanelShortcut(e)) return;
      if (document.querySelector('[data-dialog-open]:not(.asx-panel), .onb')) return;
      e.preventDefault();
      if (useAssistant.getState().panelOpen) useAssistant.getState().closePanel();
      else openAssistant();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // The Assistant page shows the conversation itself.
  useEffect(() => {
    if (route === 'assistant' && useAssistant.getState().panelOpen) useAssistant.getState().closePanel();
  }, [route]);

  if (onboarding) return null;
  return (
    <>
      {launcherOn && route !== 'assistant' && <Launcher hidden={open} />}
      <Panel open={open && route !== 'assistant'} />
    </>
  );
}

function Launcher({ hidden }: { hidden: boolean }) {
  const reduce = useReducedMotion();
  const busy = useAssistant((s) => !!s.activeRequest);
  return (
    <AnimatePresence>
      {!hidden && (
        <motion.button
          type="button"
          className="asx-launcher"
          data-busy={busy || undefined}
          aria-label="Open the Assistant"
          aria-keyshortcuts="Control+J"
          title="Assistant (Ctrl+J)"
          onClick={() => openAssistant()}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.7, transition: exit }}
          transition={pick(reduce, spring.hero)}
          whileTap={reduce ? undefined : { scale: 0.92 }}
        >
          <span className="asx-launcher__glow" aria-hidden />
          <Sparkles size={22} aria-hidden />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

function Panel({ open }: { open: boolean }) {
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
    return () => {
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
