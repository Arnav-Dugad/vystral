import { lazy, Suspense, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { isPanelShortcut } from '../../lib/assistant';
import { exit, pick, spring } from '../../lib/motion';
import { openAssistant, useAssistant } from '../../state/assistant';
import { useReducedMotion, useStore } from '../../state/store';
import './assistant-ui.css';

/**
 * Track D3: the Assistant on every page. A floating launcher (bottom right) and Ctrl+J open a side panel with the same
 * conversation as the Assistant page; it knows the page and game you're on. The panel doesn't block the page (it isn't
 * modal); Escape closes it and focus returns to where it was. Rendered only in the desktop shell, so Immersive Mode
 * stays controller-clean.
 */
const Panel = lazy(() => import('./AssistantSheet'));

export function AssistantHost() {
  const open = useAssistant((s) => s.panelOpen);
  const route = useStore((s) => s.route.name);
  const launcherOn = useStore((s) => s.settings?.['assistant.launcher'] ?? true);
  const onboarding = useStore((s) => !!s.settings && !s.settings['onboarding.completed']);
  // The panel's code loads the first time it opens and then stays (its exit animation needs it mounted).
  const [loaded, setLoaded] = useState(false);
  if (open && !loaded) setLoaded(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the panel when nothing else (a dialog or menu) owns the keyboard and focus isn't in another field.
      if (e.key === 'Escape' && useAssistant.getState().panelOpen && !document.querySelector('[data-dialog-open], [data-menu-open]')) {
        const a = document.activeElement;
        if (!a || a === document.body || a.closest('.asx-panel')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          useAssistant.getState().closePanel();
        }
        return;
      }
      if (!isPanelShortcut(e)) return;
      if (document.querySelector('[data-dialog-open]:not(.asx-panel), .onb')) return;
      e.preventDefault();
      if (useAssistant.getState().panelOpen) useAssistant.getState().closePanel();
      else openAssistant();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);

  // The Assistant page shows the conversation itself.
  useEffect(() => {
    if (route === 'assistant' && useAssistant.getState().panelOpen) useAssistant.getState().closePanel();
  }, [route]);

  if (onboarding) return null;
  return (
    <>
      {launcherOn && route !== 'assistant' && <Launcher hidden={open} />}
      {loaded && <Suspense fallback={null}><Panel open={open && route !== 'assistant'} /></Suspense>}
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

