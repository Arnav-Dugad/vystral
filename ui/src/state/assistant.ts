import { create } from 'zustand';
import { call, errorMessage, on } from '../bridge/bridge';
import type { AssistantConversationInfo, AssistantEvent, AssistantStatus, GameStatus } from '../bridge/types';
import {
  applyEvent, contextFromRoute, newConversation, newId, restoreConversation, titleFrom, toWire, type ChatAction, type ChatMessage, type Conversation,
} from '../lib/assistant';
import { createCollection, toggleFavorite } from './actions';
import { setGameStatus } from './statusActions';
import { settingsSettled, useStore, type Route } from './store';

/**
 * Track D3: the one Assistant's state, shared by the side panel and the full Assistant page (the same conversation
 * continues in both). Answers stream in as `assistant.event`s; deltas are coalesced to one render per frame.
 * Proposed actions run only from the user's click, through the same calls the rest of the app uses.
 */
interface AssistantState {
  panelOpen: boolean;
  status: AssistantStatus | null;
  conversation: Conversation;
  list: AssistantConversationInfo[];
  activeRequest: string | null;
  draft: string;
  /** Bumped to ask the composer to take focus. */
  focusTick: number;

  openPanel(opts?: { prompt?: string; send?: boolean; sessionId?: string }): void;
  closePanel(): void;
  togglePanel(): void;
  setDraft(text: string): void;
  refreshStatus(): Promise<void>;
  loadList(): Promise<void>;
  send(text?: string, extra?: { sessionId?: string }): Promise<void>;
  stop(): Promise<void>;
  retry(): void;
  newChat(): void;
  open(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  clearAll(): Promise<void>;
  approve(allow: boolean, always: boolean): Promise<void>;
  runAction(messageId: string, actionId: string): Promise<void>;
  dismissAction(messageId: string, actionId: string): void;
}

let subscribed = false;
let pendingText = '';
let flushRaf = 0;
let saveTimer: number | undefined;

const app = () => useStore.getState();

function patchMessage(id: string, fn: (m: ChatMessage) => ChatMessage) {
  useAssistant.setState((s) => ({ conversation: { ...s.conversation, messages: s.conversation.messages.map((m) => (m.id === id ? fn(m) : m)) } }));
}

function activeMessage(): ChatMessage | undefined {
  const { conversation, activeRequest } = useAssistant.getState();
  return activeRequest ? conversation.messages.find((m) => m.requestId === activeRequest) : undefined;
}

function flush() {
  flushRaf = 0;
  const m = activeMessage();
  const text = pendingText;
  pendingText = '';
  if (m && text) patchMessage(m.id, (x) => ({ ...x, content: x.content + text }));
}

function scheduleSave(delay = 400) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void save(), delay);
}

async function save() {
  const { conversation, status } = useAssistant.getState();
  if (!conversation.messages.length || status?.keepHistory === false) return;
  try {
    const saved = await call<boolean>('assistant.conversation.save', { id: conversation.id, conversation: { ...conversation, updatedAt: undefined } });
    if (saved) void useAssistant.getState().loadList();
  } catch {
    // Saving is best effort: the conversation stays on screen either way.
  }
}

function onEvent(e: AssistantEvent) {
  const s = useAssistant.getState();
  if (!e || e.requestId !== s.activeRequest) return;
  const m = activeMessage();
  if (!m) return;
  if (e.type === 'delta') {
    pendingText += e.text;
    flushRaf ||= requestAnimationFrame(flush);
    return;
  }
  cancelAnimationFrame(flushRaf);
  flush();
  patchMessage(m.id, (x) => applyEvent(x, e));
  if (e.type === 'done' || e.type === 'error') {
    useAssistant.setState({ activeRequest: null });
    if (e.type === 'error' && e.setup) void s.refreshStatus();
    scheduleSave(100);
  }
}

function subscribe() {
  if (subscribed) return;
  subscribed = true;
  on('assistant.event', onEvent);
  on('aiCloud.changed', () => void useAssistant.getState().refreshStatus());
  on('settings.changed', () => void useAssistant.getState().refreshStatus());
}

function withSession(c: ReturnType<typeof contextFromRoute>, sessionId?: string) {
  return sessionId && /^[0-9a-f]{32}$/.test(sessionId) ? { ...c, sessionId } : c;
}

function routeContext(route: Route) {
  return contextFromRoute(route as { name: string; id?: string; sessionId?: string });
}

export const useAssistant = create<AssistantState>((set, get) => ({
  panelOpen: false,
  status: null,
  conversation: newConversation(),
  list: [],
  activeRequest: null,
  draft: '',
  focusTick: 0,

  openPanel(opts) {
    subscribe();
    set((s) => ({ panelOpen: true, focusTick: s.focusTick + 1, draft: opts?.prompt && !opts.send ? opts.prompt : s.draft }));
    void get().refreshStatus();
    if (opts?.prompt && opts.send) void get().send(opts.prompt, { sessionId: opts.sessionId });
  },
  closePanel() {
    set({ panelOpen: false });
  },
  togglePanel() {
    if (get().panelOpen) get().closePanel();
    else get().openPanel();
  },
  setDraft(text) {
    set({ draft: text });
  },

  async refreshStatus() {
    subscribe();
    try {
      set({ status: await call<AssistantStatus>('assistant.status') });
    } catch {
      // Status is advisory; the chat reports its own problems.
    }
  },

  async loadList() {
    try {
      set({ list: await call<AssistantConversationInfo[]>('assistant.conversations') });
    } catch {
      set({ list: [] });
    }
  },

  async send(text, extra) {
    subscribe();
    const content = (text ?? get().draft).trim();
    if (!content || get().activeRequest) return;
    await settingsSettled();
    const conv = get().conversation;
    const user: ChatMessage = { id: newId('m'), role: 'user', content: content.slice(0, 8000), at: Date.now() };
    const requestId = newId('ask');
    const reply: ChatMessage = { id: newId('m'), role: 'assistant', content: '', at: Date.now(), requestId, status: 'streaming' };
    const history = [...conv.messages, user];
    set({
      draft: text === undefined ? '' : get().draft,
      activeRequest: requestId,
      conversation: { ...conv, title: conv.title || titleFrom(content), messages: [...history, reply], updatedAt: Date.now() },
    });
    pendingText = '';
    try {
      await call('assistant.chat', { requestId, messages: toWire(history), context: withSession(routeContext(app().route), extra?.sessionId), shareApproved: conv.shareApproved }, 30_000);
    } catch (err) {
      if (get().activeRequest === requestId) {
        patchMessage(reply.id, (m) => ({ ...m, status: 'error', error: errorMessage(err) }));
        set({ activeRequest: null });
      }
    }
  },

  async stop() {
    const id = get().activeRequest;
    if (!id) return;
    try {
      await call('assistant.cancel', { requestId: id });
    } catch {
      // Already finished.
    }
    // The backend ends with a "done … stopped" event; if it never comes, end it here.
    window.setTimeout(() => {
      if (get().activeRequest !== id) return;
      const m = activeMessage();
      if (m) patchMessage(m.id, (x) => ({ ...x, status: 'stopped' }));
      set({ activeRequest: null });
    }, 1500);
  },

  retry() {
    const { conversation, activeRequest } = get();
    if (activeRequest) return;
    const lastUser = conversation.messages.map((m) => m.role).lastIndexOf('user');
    if (lastUser < 0) return;
    const question = conversation.messages[lastUser].content;
    set({ conversation: { ...conversation, messages: conversation.messages.slice(0, lastUser) } });
    void get().send(question);
  },

  newChat() {
    if (get().activeRequest) void get().stop();
    set((s) => ({ conversation: newConversation(), draft: '', focusTick: s.focusTick + 1 }));
  },

  async open(id) {
    if (get().conversation.id === id) return;
    if (get().activeRequest) await get().stop();
    try {
      const restored = restoreConversation(await call('assistant.conversation.get', { id }));
      if (restored) set((s) => ({ conversation: restored, focusTick: s.focusTick + 1 }));
    } catch (err) {
      app().toast({ tone: 'warning', title: 'Couldn’t open that conversation', body: errorMessage(err) });
      void get().loadList();
    }
  },

  async remove(id) {
    try {
      await call('assistant.conversation.delete', { id });
    } catch (err) {
      app().toast({ tone: 'danger', title: 'Couldn’t delete the conversation', body: errorMessage(err) });
    }
    if (get().conversation.id === id) get().newChat();
    void get().loadList();
  },

  async clearAll() {
    try {
      await call('assistant.conversation.clear');
      get().newChat();
      set({ list: [] });
      app().toast({ tone: 'success', title: 'Conversations deleted', body: 'Nothing from past chats is kept on this PC.' });
    } catch (err) {
      app().toast({ tone: 'danger', title: 'Couldn’t delete conversations', body: errorMessage(err) });
    }
  },

  async approve(allow, always) {
    const m = get().conversation.messages.find((x) => x.approval?.state === 'pending');
    if (!m?.approval || !m.requestId) return;
    const approvalId = m.approval.id;
    patchMessage(m.id, (x) => (x.approval ? { ...x, approval: { ...x.approval, state: allow ? 'allowed' : 'declined' } } : x));
    if (allow && always) set((s) => ({ conversation: { ...s.conversation, shareApproved: true } }));
    try {
      await call('assistant.approve', { requestId: m.requestId, approvalId, allow, always });
    } catch {
      // The answer already ended; nothing was shared.
    }
  },

  async runAction(messageId, actionId) {
    const m = get().conversation.messages.find((x) => x.id === messageId);
    const a = m?.actions?.find((x) => x.id === actionId);
    if (!m || !a || a.state !== 'pending') return;
    const mark = (state: ChatAction['state'], result?: string) =>
      patchMessage(messageId, (x) => ({ ...x, actions: x.actions?.map((y) => (y.id === actionId ? { ...y, state, result } : y)) }));
    mark('running');
    try {
      await perform(a);
      mark('done');
    } catch (err) {
      mark('failed', errorMessage(err));
    }
    scheduleSave();
  },

  dismissAction(messageId, actionId) {
    patchMessage(messageId, (x) => ({ ...x, actions: x.actions?.map((y) => (y.id === actionId ? { ...y, state: 'dismissed' } : y)) }));
    scheduleSave();
  },
}));

/** Runs a confirmed proposal with the app's own actions. Throws with a readable message when it can't. */
async function perform(a: ChatAction): Promise<void> {
  const s = app();
  const str = (k: string) => (typeof a.args[k] === 'string' ? (a.args[k] as string) : '');
  const game = () => {
    const g = s.gamesById.get(str('gameId'));
    if (!g) throw new Error('That game is no longer in your library.');
    return g;
  };
  switch (a.tool) {
    case 'open_page': {
      const page = str('page');
      const pages = ['home', 'library', 'journal', 'performance', 'moments', 'constellation', 'storage', 'health', 'discover', 'wishlist', 'settings'];
      if (!pages.includes(page)) throw new Error('Unknown page.');
      s.navigate({ name: page } as Route);
      return;
    }
    case 'open_game':
      s.navigate({ name: 'game', id: game().id });
      return;
    case 'set_favorite': {
      const g = game();
      if (g.favorite === (a.args.favorite !== false)) return;
      if (!(await toggleFavorite(g))) throw new Error('Favorites weren’t updated.');
      return;
    }
    case 'set_status': {
      const status = str('status');
      if (!['backlog', 'playing', 'beaten', 'completed', 'abandoned', 'none'].includes(status)) throw new Error('Unknown status.');
      if (!(await setGameStatus(game(), status === 'none' ? null : (status as GameStatus)))) throw new Error('The status wasn’t saved.');
      return;
    }
    case 'create_collection': {
      const ids = Array.isArray(a.args.gameIds) ? (a.args.gameIds as unknown[]).filter((x): x is string => typeof x === 'string' && s.gamesById.has(x)) : [];
      const id = await createCollection(str('name').slice(0, 60));
      if (!id) throw new Error('The collection wasn’t created.');
      for (const gameId of ids) await call('collections.setMembership', { collectionId: id, gameId, member: true });
      await s.refreshLibrary();
      s.navigate({ name: 'library', collectionId: id });
      return;
    }
    case 'create_smart_collection': {
      const id = await call<string>('collections.create', { name: str('name').slice(0, 60), icon: null, rule: a.args.filter });
      await s.refreshLibrary();
      s.navigate({ name: 'library', collectionId: id });
      s.toast({ tone: 'success', title: `“${str('name')}” created`, body: 'It’s a smart collection: games join and leave it as your library changes.' });
      return;
    }
    case 'start_discover_search':
      s.navigate({ name: 'discover', query: str('query').slice(0, 100) });
      return;
    case 'watch_game':
      await call('discover.watch', { key: str('key'), on: true });
      s.toast({ tone: 'success', title: `Watching ${str('title')}`, body: 'You’ll hear about price drops and its release.' });
      return;
    default:
      throw new Error('Unknown action.');
  }
}

/** Ctrl+J and the launcher open the panel; the Assistant page shows the same conversation instead. */
export function openAssistant(prompt?: string, send = false, sessionId?: string) {
  const s = app();
  if (s.route.name === 'assistant') {
    if (prompt) {
      if (send) void useAssistant.getState().send(prompt, { sessionId });
      else useAssistant.getState().setDraft(prompt);
    }
    useAssistant.setState((x) => ({ focusTick: x.focusTick + 1 }));
    return;
  }
  useAssistant.getState().openPanel({ prompt, send, sessionId });
}
