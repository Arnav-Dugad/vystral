/**
 * Track AA: startup bookkeeping that runs beside the store.
 *  - Startup marks (`vystral:*` performance marks), reported once to VYSTRAL's local log (never sent anywhere else).
 *  - Keeping the first-paint snapshot current: after the library or settings change (debounced), and right
 *    away when the window is hidden. Identical snapshots aren't saved again.
 *  - Answering the after-update self-check's round trip.
 */
import { useEffect } from 'react';
import { call, on } from '../bridge/bridge';
import { buildFirstPaint, firstPaintKey, type FirstPaint } from '../lib/firstPaint';
import { useStore } from './store';

const SAVE_DELAY_MS = 4000;

export function markOnce(name: string) {
  try {
    if (typeof performance === 'undefined' || performance.getEntriesByName(`vystral:${name}`, 'mark').length) return;
    performance.mark(`vystral:${name}`);
  } catch {
    // marks are diagnostics only
  }
}

/** Marks the first frame on which a view rendered from `name`'s data (after it is painted). */
export function useStartupMark(name: string | null) {
  useEffect(() => {
    if (!name) return;
    const raf = requestAnimationFrame(() => markOnce(name));
    return () => cancelAnimationFrame(raf);
  }, [name]);
}

let reported = false;
/** Sends this start's marks to the host log, once, a moment after the interface is ready. */
function reportMarks() {
  if (reported) return;
  reported = true;
  const send = () => {
    try {
      const marks: Record<string, number> = {};
      for (const m of performance.getEntriesByType('mark')) if (m.name.startsWith('vystral:')) marks[m.name.slice(8)] = Math.round(m.startTime * 10) / 10;
      const fcp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
      if (fcp) marks.fcp = Math.round(fcp.startTime * 10) / 10;
      void call('app.startupMarks', { timeOrigin: performance.timeOrigin, marks }).catch(() => {});
    } catch {
      // diagnostics only
    }
  };
  // After the live Home has had a chance to paint.
  window.setTimeout(send, 1500);
}

let saveTimer: number | undefined;
let lastKey: string | null = null;

function saveNow() {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  const s = useStore.getState();
  if (!s.libraryLoaded || !s.settings) return;
  let fp: FirstPaint | null;
  try {
    fp = buildFirstPaint(s.library.games.filter((g) => !g.hidden), s.settings, Date.now());
  } catch {
    return; // never let a snapshot problem reach the interface
  }
  if (!fp) {
    // Nothing to show (empty library, onboarding): don't leave an old Home to flash up on the next start.
    if (lastKey !== 'cleared') {
      lastKey = 'cleared';
      void call('app.firstPaint.clear').catch(() => {});
    }
    return;
  }
  const key = firstPaintKey(fp);
  if (key === lastKey) return;
  lastKey = key;
  void call('app.firstPaint.save', { snapshot: fp }).catch(() => {
    lastKey = null; // try again with the next change
  });
}

let started = false;
/** Called once from main.tsx. */
export function startStartupTracking(initial: FirstPaint | null) {
  if (started) return;
  started = true;
  if (initial) lastKey = firstPaintKey(initial);

  useStore.subscribe((s, prev) => {
    if (s.ready && !prev.ready) {
      markOnce('ready');
      reportMarks();
    }
    if (!s.libraryLoaded || !s.settings) return;
    if (s.library === prev.library && s.settings === prev.settings && s.libraryLoaded === prev.libraryLoaded) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, SAVE_DELAY_MS);
  });

  // Minimized or closing: write a pending snapshot now rather than lose it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveTimer !== undefined) saveNow();
  });
  addEventListener('pagehide', () => {
    if (saveTimer !== undefined) saveNow();
  });

  // The after-update self-check: echo exactly what arrived (it checks that nothing changed on the way).
  on('selfcheck.ping', (p) => {
    if (!p || typeof p.nonce !== 'string' || typeof p.probe !== 'string') return;
    void call('update.selfCheck.echo', { nonce: p.nonce, probe: p.probe }).catch(() => {});
  });
}
