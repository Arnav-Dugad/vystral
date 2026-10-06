/** Data and layout hooks shared by the Journal and Performance views. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { Session } from '../../bridge/types';
import { isObserved } from '../../lib/sessions';

export interface SessionsState {
  status: 'loading' | 'ready' | 'error';
  sessions: Session[];
  error: string | null;
  /** When the current list was fetched; use as "now" so every figure on a page agrees. */
  loadedAt: number;
  reload: () => Promise<void>;
}

/** All VYSTRAL-tracked sessions, newest first. Reloads when a tracked session ends. */
export function useTrackedSessions(): SessionsState {
  const [state, setState] = useState<Omit<SessionsState, 'reload'>>({ status: 'loading', sessions: [], error: null, loadedAt: 0 });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const list = await call<Session[]>('sessions.list', { gameId: null, limit: 10000 });
      if (mine !== seq.current) return; // a newer reload (or unmount) superseded this one
      setState({ status: 'ready', sessions: Array.isArray(list) ? list.filter((s) => isObserved(s.source)) : [], error: null, loadedAt: Date.now() });
    } catch (err) {
      if (mine !== seq.current) return;
      setState((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : 'error', error: errorMessage(err), loadedAt: s.loadedAt || Date.now() }));
    }
  }, []);
  useEffect(() => {
    void load();
    const off = on('launch.state', (l) => {
      if (l.phase === 'ended' && l.sessionId) void load();
    });
    return () => {
      seq.current++;
      off();
    };
  }, [load]);
  return { ...state, reload: load };
}

/** Content-box width of an element, kept current with a ResizeObserver. */
export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback = 640): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(120, Math.floor(el.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
