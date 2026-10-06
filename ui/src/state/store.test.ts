import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../bridge/types';

/** Every bridge call waits here until the test answers it. */
interface Pending {
  method: string;
  params: { key: string; value: unknown };
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}
const pending: Pending[] = [];

vi.mock('../bridge/bridge', () => ({
  call: (method: string, params: Pending['params']) => new Promise((resolve, reject) => pending.push({ method, params, resolve, reject })),
  errorMessage: (e: unknown) => String(e),
  isNative: false,
  on: () => () => {},
}));

const { useStore } = await import('./store');

const BASE = { 'appearance.gridSize': 180, 'appearance.canvasIntensity': 0.7 } as unknown as Settings;
const flush = () => new Promise((r) => setTimeout(r, 0));
const value = (k: 'appearance.gridSize' | 'appearance.canvasIntensity') => useStore.getState().settings?.[k];

describe('setSetting', () => {
  beforeEach(() => {
    pending.length = 0;
    useStore.setState({ settings: { ...BASE }, toasts: [], notifications: [] });
  });

  it('a failed older save never reverts a newer value of the same key', async () => {
    const first = useStore.getState().setSetting('appearance.gridSize', 200);
    const second = useStore.getState().setSetting('appearance.gridSize', 220);
    expect(value('appearance.gridSize')).toBe(220);
    pending[0].reject(new Error('disk busy'));
    await first;
    expect(value('appearance.gridSize')).toBe(220);
    pending[1].resolve({ ...BASE, 'appearance.gridSize': 220 });
    await second;
    expect(value('appearance.gridSize')).toBe(220);
  });

  it('a reply for one key keeps another key that is still being saved', async () => {
    const a = useStore.getState().setSetting('appearance.gridSize', 240);
    const b = useStore.getState().setSetting('appearance.canvasIntensity', 0.3);
    // The grid-size reply is a snapshot taken before the intensity change reached the backend.
    pending[0].resolve({ ...BASE, 'appearance.gridSize': 240 });
    await a;
    expect(value('appearance.canvasIntensity')).toBe(0.3);
    pending[1].resolve({ ...BASE, 'appearance.gridSize': 240, 'appearance.canvasIntensity': 0.3 });
    await b;
    expect(value('appearance.gridSize')).toBe(240);
    expect(value('appearance.canvasIntensity')).toBe(0.3);
  });

  it('a failure reverts only its own key and says so', async () => {
    const a = useStore.getState().setSetting('appearance.gridSize', 260);
    const b = useStore.getState().setSetting('appearance.canvasIntensity', 0.9);
    pending[1].resolve({ ...BASE, 'appearance.canvasIntensity': 0.9 });
    await b;
    pending[0].reject(new Error('nope'));
    await a;
    await flush();
    expect(value('appearance.gridSize')).toBe(180);
    expect(value('appearance.canvasIntensity')).toBe(0.9);
    expect(useStore.getState().toasts.map((t) => t.title)).toContain('Setting not saved');
  });
});

describe('toasts', () => {
  beforeEach(() => useStore.setState({ toasts: [], notifications: [] }));

  it('make room by dropping the oldest auto-dismissing toast, never a sticky one first', () => {
    const { toast } = useStore.getState();
    toast({ tone: 'warning', title: 'sticky', sticky: true });
    toast({ tone: 'info', title: 'one' });
    toast({ tone: 'info', title: 'two' });
    toast({ tone: 'info', title: 'three' });
    toast({ tone: 'info', title: 'four' });
    expect(useStore.getState().toasts.map((t) => t.title)).toEqual(['sticky', 'two', 'three', 'four']);
  });

  it('hold their timers while paused', () => {
    vi.useFakeTimers();
    try {
      const { toast, setToastsPaused } = useStore.getState();
      toast({ tone: 'info', title: 'held' });
      setToastsPaused(true);
      vi.advanceTimersByTime(20_000);
      expect(useStore.getState().toasts.map((t) => t.title)).toEqual(['held']);
      setToastsPaused(false);
      vi.advanceTimersByTime(6_000);
      expect(useStore.getState().toasts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
