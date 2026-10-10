import type {
  AiProviderChoice, AssistantApproval, AssistantCard, AssistantChatParams, AssistantEvent, AssistantPage, AssistantProposal, AssistantToolCall,
} from '../bridge/types';
import type { ServiceId } from './serviceMarks';

/**
 * Track D3: pure helpers for the one Assistant (unit tested): the message model, folding `assistant.event`s into a
 * message, what goes back to the model, context from the current page, suggested prompts and provider marks.
 */

export type ActionState = 'pending' | 'running' | 'done' | 'dismissed' | 'failed';

export interface ChatAction extends AssistantProposal {
  state: ActionState;
  result?: string;
}

export interface ChatApproval extends AssistantApproval {
  state: 'pending' | 'allowed' | 'declined' | 'expired';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: number;
  requestId?: string;
  status?: 'streaming' | 'done' | 'stopped' | 'error';
  error?: string;
  /** The error means no AI is set up: offer the way to set one up. */
  setup?: boolean;
  engine?: string;
  cloud?: boolean;
  provider?: string;
  note?: string | null;
  sent?: string | null;
  notices?: string[];
  tools?: AssistantToolCall[];
  cards?: { toolId: string; card: AssistantCard }[];
  actions?: ChatAction[];
  approval?: ChatApproval | null;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  /** The user allowed look-up results to go to the cloud AI for the rest of this conversation. */
  shareApproved: boolean;
  updatedAt: number;
}

/** Backend limits (AppBackend.Assistant.cs): up to 60 messages of up to 8,000 characters. */
export const MAX_WIRE_MESSAGES = 40;
export const MAX_WIRE_CHARS = 8000;

let seq = 0;
export function newId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 14)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
  return `${prefix.slice(0, 6)}-${(++seq).toString(36)}-${rand}`.slice(0, 40);
}

export function newConversation(): Conversation {
  return { id: newId('conv'), title: '', messages: [], shareApproved: false, updatedAt: Date.now() };
}

/** A short title from the first question: one line, at most ~48 characters, cut at a word. */
export function titleFrom(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= 48) return one;
  const cut = one.slice(0, 48);
  const space = cut.lastIndexOf(' ');
  return `${(space > 24 ? cut.slice(0, space) : cut).replace(/[,;:.!?-]+$/, '')}…`;
}

/** Folds one event into the assistant message it belongs to. */
export function applyEvent(m: ChatMessage, e: AssistantEvent): ChatMessage {
  switch (e.type) {
    case 'start':
      return { ...m, engine: e.engine, cloud: e.cloud, provider: e.provider, note: e.note ?? m.note ?? null, status: 'streaming' };
    case 'delta':
      return { ...m, content: m.content + e.text };
    case 'tool': {
      const tools = [...(m.tools ?? [])];
      const at = tools.findIndex((t) => t.id === e.call.id);
      if (at >= 0) tools[at] = e.call;
      else tools.push(e.call);
      const cards = e.card && !(m.cards ?? []).some((c) => c.toolId === e.call.id) ? [...(m.cards ?? []), { toolId: e.call.id, card: e.card }] : m.cards;
      return { ...m, tools, cards };
    }
    case 'approval':
      return { ...m, approval: { ...e.approval, state: 'pending' } };
    case 'action':
      return (m.actions ?? []).some((a) => a.id === e.action.id) ? m : { ...m, actions: [...(m.actions ?? []), { ...e.action, state: 'pending' }] };
    case 'notice':
      return { ...m, notices: [...(m.notices ?? []), e.message] };
    case 'done':
      return {
        ...m,
        status: e.stopped ? 'stopped' : 'done',
        engine: e.engine || m.engine,
        cloud: e.cloud,
        note: e.note ?? m.note ?? null,
        sent: e.sent ?? null,
        approval: m.approval?.state === 'pending' ? { ...m.approval, state: 'expired' } : m.approval,
        tools: (m.tools ?? []).map((t) => (t.status === 'running' ? { ...t, status: 'error' as const, summary: 'Stopped' } : t)),
      };
    case 'error':
      return { ...m, status: 'error', error: e.message, setup: !!e.setup };
    default:
      return m;
  }
}

function actionNote(a: ChatAction): string {
  switch (a.state) {
    case 'done': return `[You prepared “${a.title}”. The user confirmed it and it was done.]`;
    case 'dismissed': return `[You prepared “${a.title}”. The user chose not to do it.]`;
    case 'failed': return `[You prepared “${a.title}”. The user confirmed it but it failed: ${a.result ?? 'unknown error'}.]`;
    default: return `[You prepared “${a.title}”. The user hasn’t confirmed it yet.]`;
  }
}

/** History sent to the model: finished turns, with what happened to each proposed action, trimmed to a budget. */
export function toWire(messages: readonly ChatMessage[], maxChars = 30_000): AssistantChatParams['messages'] {
  const out: AssistantChatParams['messages'] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0 && out.length < MAX_WIRE_MESSAGES; i--) {
    const m = messages[i];
    if (m.status === 'streaming') continue;
    let content = m.content.trim();
    if (m.role === 'assistant') {
      if (m.status === 'error' && !content) continue;
      const notes = (m.actions ?? []).map(actionNote).join('\n');
      if (notes) content = `${content}\n\n${notes}`.trim();
      if (!content) continue;
    }
    if (!content) continue;
    if (content.length > MAX_WIRE_CHARS) content = content.slice(0, MAX_WIRE_CHARS);
    used += content.length;
    if (used > maxChars && out.length > 0) break;
    out.unshift({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/** What the assistant knows about where the user is. Only ids it can check natively are passed. */
export function contextFromRoute(route: { name: string; id?: string; sessionId?: string }): AssistantChatParams['context'] {
  const pages: AssistantPage[] = ['home', 'library', 'game', 'journal', 'performance', 'moments', 'constellation', 'assistant', 'storage', 'health', 'discover', 'discoverGame', 'wishlist', 'settings'];
  const page = (pages as string[]).includes(route.name) ? (route.name as AssistantPage) : 'home';
  const hex = (s?: string) => (s && /^[0-9a-f]{32}$/.test(s) ? s : null);
  return {
    page,
    gameId: page === 'game' ? hex(route.id) : null,
    sessionId: page === 'performance' ? hex(route.sessionId) : null,
  };
}

/** Suggested prompts for where the user is (the first ones fit the page; the rest are always useful). */
export function suggestions(context: AssistantChatParams['context'], gameTitle?: string | null, gameIsSteam = true): string[] {
  const always = ['What should I play tonight? I have 1 hour', 'Give me my weekly recap', 'What needs my attention?'];
  let own: string[];
  switch (context.page) {
    case 'game':
      own = gameTitle
        ? [
            `Is ${gameTitle} good with a controller?`,
            gameIsSteam ? `Any recent news or patch notes for ${gameTitle}?` : `Suggest tags for ${gameTitle}`,
            `How long until I finish ${gameTitle}?`,
          ]
        : [];
      break;
    case 'library':
      own = ['Co-op games my friends play that I own but haven’t started', 'Make a smart collection of short games I haven’t finished'];
      break;
    case 'journal':
      own = ['What did I play most this month?', 'Which days of the week do I play most?'];
      break;
    case 'performance':
      own = context.sessionId ? ['Explain the stutter in this session'] : ['Explain the stutter in my last session', 'How is my PC doing in recent games?'];
      break;
    case 'storage':
      own = ['What could I uninstall to free up space?'];
      break;
    case 'wishlist':
      own = ['What’s on sale on my wishlist?'];
      break;
    case 'discover':
    case 'discoverGame':
      own = ['Find cozy co-op games to buy'];
      break;
    case 'health':
      own = ['Which library problems should I fix first?'];
      break;
    default:
      own = [];
  }
  return [...own, ...always.filter((a) => !own.includes(a))].slice(0, 4);
}

/** The mark for whoever answers: a provider id, or the engine id from `assistant.status`. */
export function providerMark(provider: AiProviderChoice | 'none' | string | undefined, baseUrl?: string | null): ServiceId | null {
  switch (provider) {
    case 'anthropic': return 'claude';
    case 'gemini': return 'gemini';
    case 'openai': return 'openai';
    case 'compatible': return baseUrl && /(^|\.)openrouter\.ai(\/|:|$)/.test(baseUrl.replace(/^https:\/\//, '')) ? 'openrouter' : 'ai-endpoint';
    case 'local': return 'ollama';
    default: return null;
  }
}

/** Ctrl+J opens the panel; never while typing in another field's own shortcut handling (Ctrl+J has none in VYSTRAL). */
export function isPanelShortcut(e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  return e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'j';
}

/** Saved conversations come back from disk: keep only well-formed messages (the page owns this shape). */
export function restoreConversation(raw: unknown): Conversation | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !Array.isArray(o.messages)) return null;
  const messages: ChatMessage[] = [];
  for (const m of o.messages.slice(0, 200)) {
    if (!m || typeof m !== 'object') continue;
    const x = m as Record<string, unknown>;
    if ((x.role !== 'user' && x.role !== 'assistant') || typeof x.content !== 'string' || typeof x.id !== 'string') continue;
    const status = x.status === 'streaming' ? 'stopped' : (x.status as ChatMessage['status']);
    const approval = x.approval as ChatApproval | null | undefined;
    messages.push({
      ...(x as unknown as ChatMessage),
      status,
      approval: approval && approval.state === 'pending' ? { ...approval, state: 'expired' } : approval ?? null,
      actions: Array.isArray(x.actions) ? (x.actions as ChatAction[]).map((a) => (a.state === 'running' ? { ...a, state: 'pending' } : a)) : undefined,
    });
  }
  return {
    id: o.id,
    title: typeof o.title === 'string' ? o.title.slice(0, 120) : '',
    messages,
    shareApproved: o.shareApproved === true,
    updatedAt: typeof o.updatedAt === 'string' ? Date.parse(o.updatedAt) || Date.now() : Date.now(),
  };
}
