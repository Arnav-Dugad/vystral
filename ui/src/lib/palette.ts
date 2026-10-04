import type { Game } from '../bridge/types';
import { call } from '../bridge/bridge';
import { fallbackPalette, hashString, type Palette } from './color';

const cache = new Map<string, Palette>();
const inflight = new Map<string, Promise<Palette>>();
let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (p: Palette | null) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./palette.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; palette?: Palette; error?: string }>) => {
      waiting.get(e.data.id)?.(e.data.palette ?? null);
      waiting.delete(e.data.id);
    };
  }
  return worker;
}

/** Hue derived from the title so games without artwork still get a stable, distinct colour. */
export function titleHue(title: string): number {
  return hashString(title) % 360;
}

/**
 * Palette for a game: stored result → memory cache → worker analysis of the cover/hero art →
 * deterministic fallback. Results from artwork are persisted so analysis runs once per image.
 */
export function paletteFor(game: Game): Promise<Palette> {
  const art = game.art.hero ?? game.art.cover ?? game.art.header;
  const key = `${game.id}|${art ?? ''}`;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  if (game.palette) {
    try {
      const stored = JSON.parse(game.palette) as Palette & { source?: string };
      if (stored.source === art && stored.accent) {
        cache.set(key, stored);
        return Promise.resolve(stored);
      }
    } catch {
      // ignore corrupt stored palette; recompute
    }
  }
  if (!art) {
    const p = fallbackPalette(titleHue(game.title));
    cache.set(key, p);
    return Promise.resolve(p);
  }
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = new Promise<Palette>((resolve) => {
    const id = ++seq;
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      resolve(fallbackPalette(titleHue(game.title)));
    }, 4000);
    waiting.set(id, (p) => {
      window.clearTimeout(timer);
      const result = p ?? fallbackPalette(titleHue(game.title));
      cache.set(key, result);
      if (p) void call('game.savePalette', { gameId: game.id, palette: { ...p, source: art } }).catch(() => {});
      resolve(result);
    });
    getWorker().postMessage({ id, url: art });
  }).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function peekPalette(game: Game): Palette | undefined {
  return cache.get(`${game.id}|${game.art.hero ?? game.art.cover ?? game.art.header ?? ''}`);
}
