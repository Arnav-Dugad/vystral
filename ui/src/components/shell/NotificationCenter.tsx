import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Bell, BellOff, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { formatRelative } from '../../lib/format';
import { exit, pick, spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { IconButton } from '../ui/primitives';
import { HoldToConfirm } from '../controller/HoldToConfirm';

const ICONS = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, info: Info };

/** Title-bar bell with an unread badge; opens the notification centre drawer. */
export function NotificationBell() {
  const unread = useStore((s) => s.notifications.filter((n) => !n.read).length);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={buttonRef}
        label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="bell"
      >
        <Bell size={15} />
        <AnimatePresence>
          {unread > 0 && (
            <motion.span className="bell__badge num" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={spring.micro} aria-hidden>
              {unread > 9 ? '9+' : unread}
            </motion.span>
          )}
        </AnimatePresence>
      </IconButton>
      <NotificationDrawer open={open} onClose={() => { setOpen(false); buttonRef.current?.focus(); }} />
    </>
  );
}

function NotificationDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const notifications = useStore((s) => s.notifications);
  const markRead = useStore((s) => s.markNotificationsRead);
  const clearOne = useStore((s) => s.clearNotification);
  const clearAll = useStore((s) => s.clearNotifications);
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    markRead();
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('button')?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.bell')) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open, markRead, onClose]);

  const groups = useMemo(() => {
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    const map = new Map<string, typeof notifications>();
    for (const n of notifications) {
      const d = new Date(n.at).toDateString();
      const label = d === today ? 'Today' : d === yesterday ? 'Yesterday' : new Date(n.at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
      map.set(label, [...(map.get(label) ?? []), n]);
    }
    return [...map.entries()];
  }, [notifications]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.aside
          ref={ref}
          className="notif-drawer"
          role="dialog"
          aria-label="Notifications"
          data-dialog-open
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, x: 16, transition: exit }}
          transition={pick(reduce, spring.panel)}
        >
          <header className="notif-drawer__head">
            <h2>Notifications</h2>
            <div style={{ display: 'flex', gap: 4 }}>
              {notifications.length > 0 && <HoldToConfirm size="sm" variant="ghost" holdFor="pad" onConfirm={clearAll}>Clear all</HoldToConfirm>}
              <IconButton label="Close notifications" size="sm" onClick={onClose}><X size={14} /></IconButton>
            </div>
          </header>
          {notifications.length === 0 ? (
            <div className="notif-drawer__empty">
              <BellOff size={26} aria-hidden />
              <p>You’re all caught up.</p>
              <span>Session summaries, updates and anything that needs your attention show up here.</span>
            </div>
          ) : (
            <div className="notif-drawer__list">
              {groups.map(([label, items]) => (
                <section key={label}>
                  <div className="caps notif-drawer__group">{label}</div>
                  <AnimatePresence initial={false}>
                    {items.map((n) => {
                      const Icon = ICONS[n.tone];
                      return (
                        <motion.div
                          key={n.id}
                          layout={!reduce}
                          className={`notif notif--${n.tone}`}
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0, transition: { duration: 0.18 } }}
                        >
                          <Icon size={17} className="notif__icon" aria-hidden />
                          <div className="notif__text">
                            <div className="notif__title">{n.title}</div>
                            {n.body && <div className="notif__body">{n.body}</div>}
                            <div className="notif__time">{formatRelative(new Date(n.at).toISOString())}</div>
                            {n.action && (
                              <button className="notif__action" onClick={() => { n.action!.run(); onClose(); }}>{n.action.label}</button>
                            )}
                          </div>
                          <IconButton label="Dismiss notification" size="sm" onClick={() => clearOne(n.id)}><X size={13} /></IconButton>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </section>
              ))}
            </div>
          )}
        </motion.aside>
      )}
    </AnimatePresence>,
    document.body,
  );
}
