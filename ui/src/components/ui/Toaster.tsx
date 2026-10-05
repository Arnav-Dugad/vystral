import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useReducedMotion, useStore } from '../../state/store';
import { exit, pick, spring } from '../../lib/motion';
import { IconButton } from './primitives';
import { ToastMedia } from './ToastMedia';
import { bestTier } from '../../lib/shimmer';
import './shimmer.css';

const ICONS = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, info: Info };

export function Toaster() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const reduce = useReducedMotion();
  return (
    <div className="toaster" role="region" aria-label="Notifications" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICONS[t.tone];
          // Track K: achievement toasts get a rarity-tinted shimmer sweep.
          const tier = t.media?.length ? bestTier(t.media.map((m) => m.rare ?? 'common')) : null;
          return (
            <motion.div
              key={t.id}
              layout={!reduce}
              className={`toast toast--${t.tone}${tier ? ' shimmer' : ''}`}
              data-tier={tier ?? undefined}
              role={t.tone === 'danger' ? 'alert' : 'status'}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: 24, transition: exit }}
              transition={pick(reduce, spring.panel)}
            >
              <Icon className="toast__icon" size={18} aria-hidden />
              <div>
                <div className="toast__title">{t.title}</div>
                {t.body && <div className="toast__body">{t.body}</div>}
                {t.media && t.media.length > 0 && <ToastMedia media={t.media} />}
                {t.action && (
                  <button className="btn btn--ghost btn--sm" style={{ marginTop: 6, marginLeft: -10 }} onClick={() => { t.action!.run(); dismiss(t.id); }}>
                    {t.action.label}
                  </button>
                )}
              </div>
              <IconButton label="Dismiss" size="sm" onClick={() => dismiss(t.id)}>
                <X size={14} />
              </IconButton>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
