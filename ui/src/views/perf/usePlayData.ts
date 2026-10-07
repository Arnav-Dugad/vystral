/** Track Y: a small bridge hook for the play-data cards (hardware history, energy, battery). */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { call, errorMessage, on } from '../../bridge/bridge';

export interface PlayDataState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  set: (data: T) => void;
}

/**
 * Loads `method` with `params` whenever `key` changes, and again when a tracked session ends. Only the
 * newest request may answer; while a reload runs the previous data stays on screen (no skeleton flash).
 */
export function usePlayData<T>(method: string, params: unknown, key: string): PlayDataState<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean; key: string }>({ data: null, error: null, loading: true, key });
  const seq = useRef(0);
  const paramsRef = useRef(params);
  useLayoutEffect(() => {
    paramsRef.current = params;
  });
  if (state.key !== key) setState({ data: null, error: null, loading: true, key });

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    try {
      const data = await call<T>(method, paramsRef.current);
      if (mine === seq.current) setState((s) => ({ ...s, data, error: null, loading: false }));
    } catch (err) {
      if (mine === seq.current) setState((s) => ({ ...s, error: errorMessage(err), loading: false }));
    }
  }, [method]);

  useEffect(() => {
    void load();
    const off = on('launch.state', (l) => {
      if (l.phase === 'ended' && l.sessionId) void load();
    });
    return () => {
      seq.current++;
      off();
    };
  }, [load, key]);

  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    reload: load,
    set: (data: T) => {
      seq.current++;
      setState((s) => ({ ...s, data, error: null, loading: false }));
    },
  };
}
