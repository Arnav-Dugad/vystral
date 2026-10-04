import type { BridgeEvents } from './types';

/**
 * Typed client for the native bridge. In the real app messages travel through WebView2's
 * postMessage channel; in a plain browser (development, tests) a preview backend with
 * sample data answers instead, and the UI shows a "Preview" badge so it is never mistaken
 * for real library data.
 */

interface WebViewChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
}

declare global {
  interface Window {
    chrome?: { webview?: WebViewChannel };
  }
}

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BridgeError';
  }
}

type Listener<T> = (payload: T) => void;
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: number };

const channel = typeof window !== 'undefined' ? window.chrome?.webview : undefined;
export const isNative = !!channel;

const pending = new Map<string, Pending>();
const listeners = new Map<string, Set<Listener<unknown>>>();
let seq = 0;

type Backend = { call(method: string, params?: unknown): Promise<unknown>; attach(emit: (n: string, p: unknown) => void): void };
let preview: Backend | null = null;
let previewLoading: Promise<Backend> | null = null;

function loadPreview(): Promise<Backend> {
  previewLoading ??= import('./preview').then((m) => {
    preview = m.createPreviewBackend();
    preview.attach(dispatchEvent);
    return preview;
  });
  return previewLoading;
}

function dispatchEvent(name: string, payload: unknown) {
  listeners.get(name)?.forEach((fn) => {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[bridge] listener for ${name} failed`, err);
    }
  });
}

if (channel) {
  channel.addEventListener('message', (e) => {
    const msg = e.data as { kind?: string; id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string }; name?: string; payload?: unknown };
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'res' && msg.id) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      window.clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new BridgeError(msg.error?.code ?? 'internal', msg.error?.message ?? 'Unknown error'));
    } else if (msg.kind === 'evt' && typeof msg.name === 'string') {
      dispatchEvent(msg.name, msg.payload);
    }
  });
}

/** Calls a native method. Rejects with a BridgeError carrying a user-presentable message. */
export async function call<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
  if (!channel) {
    const backend = preview ?? (await loadPreview());
    return backend.call(method, params) as Promise<T>;
  }
  const id = `r${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new BridgeError('timeout', 'VYSTRAL took too long to respond. Please try again.'));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    channel.postMessage(JSON.stringify({ kind: 'req', id, method, params }));
  });
}

/** Subscribes to a native event. Returns an unsubscribe function. */
export function on<K extends keyof BridgeEvents>(name: K, fn: Listener<BridgeEvents[K]>): () => void {
  let set = listeners.get(name);
  if (!set) listeners.set(name, (set = new Set()));
  set.add(fn as Listener<unknown>);
  if (!channel) void loadPreview();
  return () => set.delete(fn as Listener<unknown>);
}

export function errorMessage(err: unknown): string {
  if (err instanceof BridgeError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
