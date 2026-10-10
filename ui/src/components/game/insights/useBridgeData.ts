import { useCallback, useEffect, useRef, useState } from 'react';
import { call, errorMessage } from '../../../bridge/bridge';

/**
 * Track C4: one bridge call for a game page tile. Only the newest request may answer (switching games quickly never
 * shows another game's data), a failed refresh keeps what's on screen, and `params === null` means "nothing to ask".
 * `key` is any string that changes when the call should run again (the game, a setting…).
 */
export function useBridgeData<T>(method: string, params: Record<string, unknown> | null, key: string) {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null; loading: boolean }>({ key, data: null, error: null, loading: !!params });
  const seq = useRef(0);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const load = useCallback(async (extra: Record<string, unknown> = {}) => {
    const p = paramsRef.current;
    if (!p) return false;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await call<T>(method, { ...p, ...extra }, 60_000);
      if (mine === seq.current) setState({ key, data, error: null, loading: false });
      return true;
    } catch (err) {
      if (mine === seq.current) setState((s) => ({ ...s, key, error: errorMessage(err), loading: false }));
      return false;
    }
  }, [method, key]);

  useEffect(() => {
    if (!paramsRef.current) {
      setState({ key, data: null, error: null, loading: false });
      return;
    }
    setState({ key, data: null, error: null, loading: true });
    void load();
    return () => { seq.current++; };
  }, [key, load]);

  const current = state.key === key;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: current ? state.loading : !!params, reload: load };
}
