/** Data hooks for Track B panels in the Performance view. */
import { useEffect, useMemo, useState } from 'react';
import { call, errorMessage } from '../../bridge/bridge';
import type { InsightSample } from '../../bridge/types';
import { throttleBands, type Band } from './insight';

const insightCache = new Map<string, InsightSample[]>();

/** Per-sample throttling / FPS data for a session ('sessions.insightSamples'). Empty for older sessions. */
export function useInsightSamples(id: string | null): { status: 'idle' | 'loading' | 'ready' | 'error'; samples: InsightSample[]; error: string | null } {
  const [loaded, setLoaded] = useState<{ id: string; samples: InsightSample[]; error: string | null } | null>(null);
  const cached = id ? insightCache.get(id) : undefined;
  useEffect(() => {
    if (!id || insightCache.has(id)) return;
    let alive = true;
    call<InsightSample[]>('sessions.insightSamples', { sessionId: id })
      .then((list) => {
        const samples = Array.isArray(list) ? list : [];
        if (insightCache.size > 24) insightCache.delete(insightCache.keys().next().value as string);
        insightCache.set(id, samples);
        if (alive) setLoaded({ id, samples, error: null });
      })
      .catch((err) => {
        if (alive) setLoaded({ id, samples: [], error: errorMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [id]);
  if (!id) return { status: 'idle', samples: [], error: null };
  if (cached) return { status: 'ready', samples: cached, error: null };
  if (loaded?.id === id) return loaded.error ? { status: 'error', samples: [], error: loaded.error } : { status: 'ready', samples: loaded.samples, error: null };
  return { status: 'loading', samples: [], error: null };
}

export function useThrottleBands(samples: InsightSample[]): Band[] {
  return useMemo(() => throttleBands(samples), [samples]);
}
