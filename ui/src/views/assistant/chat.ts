import type { BridgeEvents } from '../../bridge/types';

/** Pure chat/pull helpers for the Assistant view (unit tested). */

export type Role = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** Model that produced an assistant message. */
  model?: string;
  status?: 'streaming' | 'done' | 'stopped' | 'error';
  error?: string;
}

export interface WireMessage {
  role: Role;
  content: string;
}

/** Backend limits for `ai.chat` (AppBackend.Handlers.cs): at most 40 messages of at most 4000 characters. */
export const MAX_WIRE_MESSAGES = 40;
export const MAX_WIRE_MESSAGE_CHARS = 4000;
/** Backend limit for the chat request id. */
export const MAX_REQUEST_ID_CHARS = 40;

/** History sent to the model: completed turns only, failed/empty replies dropped, trimmed to a budget. */
export function toWireMessages(messages: readonly ChatMessage[], maxChars = 24_000): WireMessage[] {
  const usable = messages.filter((m) => m.content.trim() && m.status !== 'error' && m.status !== 'streaming');
  const out: WireMessage[] = [];
  let used = 0;
  for (let i = usable.length - 1; i >= 0 && out.length < MAX_WIRE_MESSAGES; i--) {
    const m = usable[i];
    const content = m.content.length > MAX_WIRE_MESSAGE_CHARS ? m.content.slice(0, MAX_WIRE_MESSAGE_CHARS) : m.content;
    used += content.length;
    if (used > maxChars && out.length > 0) break;
    out.unshift({ role: m.role, content });
  }
  // A conversation sent to the model should start with the user.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

let seq = 0;
/** Short unique id; always fits the backend's 40-character request id limit. */
export function newId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix.slice(0, 8)}-${(++seq).toString(36)}-${rand}`.slice(0, MAX_REQUEST_ID_CHARS);
}

/** The pull event as documented, tolerating `done`/`cancelled` flags as well as status strings. */
export type PullEvent = BridgeEvents['ai.pull'] & { done?: boolean; cancelled?: boolean };

export interface PullState {
  phase: 'idle' | 'pulling' | 'done' | 'cancelled' | 'error';
  model: string | null;
  status: string;
  /** 0..100, or null when the size isn't known yet. */
  percent: number | null;
  completed: number | null;
  total: number | null;
  error: string | null;
}

export const IDLE_PULL: PullState = { phase: 'idle', model: null, status: '', percent: null, completed: null, total: null, error: null };

export function reducePull(prev: PullState, e: PullEvent): PullState {
  const status = (e.status ?? '').toLowerCase();
  if (e.error) return { ...prev, phase: 'error', model: e.model, status: e.status, error: e.error };
  // The backend always sends a closing `done` after the stream ends, even when Ollama reported an error.
  if (prev.phase === 'error' && prev.model === e.model && (e.done || status === 'success' || status === 'done')) return prev;
  if (e.cancelled || status === 'cancelled' || status === 'canceled') return { ...prev, phase: 'cancelled', model: e.model, status: e.status };
  if (e.done || status === 'success' || status === 'done') return { ...prev, phase: 'done', model: e.model, status: e.status, percent: 100 };
  const total = e.total && e.total > 0 ? e.total : null;
  const completed = e.completed != null && e.completed >= 0 ? e.completed : null;
  // Per-layer progress resets between layers; keep the last known value when a status has none.
  const percent = total != null && completed != null ? Math.min(100, (completed / total) * 100) : status === prev.status ? prev.percent : null;
  return { phase: 'pulling', model: e.model, status: e.status, percent, completed: total != null ? completed : null, total, error: null };
}

/** Decimal (SI) sizes, matching how Ollama and model listings quote download sizes. */
export function formatModelBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** Human status for Ollama's pull phases ("pulling manifest", "verifying sha256 digest", …). */
export function describePull(status: string): string {
  const s = status.toLowerCase();
  if (!s) return 'Starting download…';
  if (s.includes('manifest')) return 'Preparing download…';
  if (s.startsWith('pulling') || s.startsWith('downloading')) return 'Downloading…';
  if (s.includes('verifying')) return 'Verifying download…';
  if (s.includes('writing')) return 'Finishing up…';
  if (s === 'success' || s === 'done') return 'Installed';
  return status.charAt(0).toUpperCase() + status.slice(1);
}
