import { describe, expect, it } from 'vitest';
import type { AssistantEvent } from '../bridge/types';
import {
  applyEvent, contextFromRoute, isPanelShortcut, newConversation, newId, providerMark, restoreConversation, suggestions, titleFrom, toWire, type ChatMessage,
} from './assistant';

const reply = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm2', role: 'assistant', content: '', at: 0, requestId: 'r1', status: 'streaming', ...over });
type EventBody = AssistantEvent extends infer E ? (E extends unknown ? Omit<E, 'requestId'> : never) : never;
const ev = (e: EventBody) => ({ requestId: 'r1', ...e }) as AssistantEvent;

describe('assistant events', () => {
  it('fold into one message: start, text, look-ups with cards, an approval, an action, done', () => {
    let m = reply();
    m = applyEvent(m, ev({ type: 'start', engine: 'Claude · Claude Sonnet 5.5', cloud: true, provider: 'anthropic' }));
    m = applyEvent(m, ev({ type: 'delta', text: 'Hello ' }));
    m = applyEvent(m, ev({ type: 'delta', text: 'there' }));
    const call = { id: 't1', name: 'search_library', label: 'Library search', kind: 'read' as const, status: 'running' as const, summary: null };
    m = applyEvent(m, ev({ type: 'tool', call }));
    m = applyEvent(m, ev({ type: 'tool', call: { ...call, status: 'done', summary: '3 games found' }, card: { kind: 'games', title: '3 games', items: [] } }));
    m = applyEvent(m, ev({ type: 'tool', call: { ...call, status: 'done', summary: '3 games found' }, card: { kind: 'games', title: '3 games', items: [] } }));
    m = applyEvent(m, ev({ type: 'approval', approval: { id: 'ap-1', company: 'Anthropic', engine: 'Claude', items: [] } }));
    m = applyEvent(m, ev({ type: 'action', action: { id: 'act-1', tool: 'set_favorite', title: 'Add X to favorites', detail: '', confirm: 'Add', args: {} } }));
    m = applyEvent(m, ev({ type: 'done', engine: 'Claude · Claude Sonnet 5.5', cloud: true, sent: 'Sent to Anthropic…' }));
    expect(m.content).toBe('Hello there');
    expect(m.tools).toHaveLength(1);
    expect(m.tools![0].status).toBe('done');
    expect(m.cards).toHaveLength(1);
    expect(m.actions![0].state).toBe('pending');
    expect(m.approval!.state).toBe('expired'); // never answered before the answer ended
    expect(m.status).toBe('done');
    expect(m.sent).toBe('Sent to Anthropic…');
  });

  it('marks stopped answers and errors, and setup errors offer setup', () => {
    const stopped = applyEvent(reply({ tools: [{ id: 't', name: 'get_game', label: 'Game details', kind: 'read', status: 'running', summary: null }] }), ev({ type: 'done', engine: '', cloud: false, stopped: true }));
    expect(stopped.status).toBe('stopped');
    expect(stopped.tools![0].status).toBe('error');
    const err = applyEvent(reply(), ev({ type: 'error', message: 'No AI is set up.', setup: true }));
    expect(err).toMatchObject({ status: 'error', error: 'No AI is set up.', setup: true });
  });
});

describe('what goes back to the model', () => {
  it('keeps finished turns, notes what happened to each action, drops failures and starts with the user', () => {
    const msgs: ChatMessage[] = [
      { id: 'a0', role: 'assistant', content: 'Welcome', at: 0, status: 'done' },
      { id: 'u1', role: 'user', content: 'favorite it', at: 0 },
      { id: 'a1', role: 'assistant', content: 'Set up for you.', at: 0, status: 'done', actions: [{ id: 'x', tool: 'set_favorite', title: 'Add X to favorites', detail: '', confirm: '', args: {}, state: 'done' }] },
      { id: 'u2', role: 'user', content: 'and again?', at: 0 },
      { id: 'a2', role: 'assistant', content: '', at: 0, status: 'error', error: 'x' },
      { id: 'u3', role: 'user', content: 'now?', at: 0 },
      { id: 'a3', role: 'assistant', content: 'partial', at: 0, status: 'streaming' },
    ];
    const wire = toWire(msgs);
    expect(wire[0]).toEqual({ role: 'user', content: 'favorite it' });
    expect(wire[1].content).toContain('The user confirmed it and it was done');
    expect(wire.map((w) => w.content)).not.toContain('partial');
    expect(wire.at(-1)).toEqual({ role: 'user', content: 'now?' });
  });

  it('caps each message and the whole history', () => {
    const long = 'x'.repeat(20_000);
    const msgs: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({ id: `u${i}`, role: i % 2 ? 'assistant' : 'user', content: long, at: 0, status: 'done' }));
    msgs.push({ id: 'last', role: 'user', content: 'q', at: 0 });
    const wire = toWire(msgs);
    expect(wire.every((w) => w.content.length <= 8000)).toBe(true);
    expect(wire.reduce((a, w) => a + w.content.length, 0)).toBeLessThanOrEqual(30_000 + 8000);
    expect(wire.at(-1)!.content).toBe('q');
  });
});

describe('context, suggestions, marks, shortcut', () => {
  it('passes only ids the backend can check', () => {
    const id = 'a'.repeat(32);
    expect(contextFromRoute({ name: 'game', id })).toEqual({ page: 'game', gameId: id, sessionId: null });
    expect(contextFromRoute({ name: 'game', id: '../etc' }).gameId).toBeNull();
    expect(contextFromRoute({ name: 'performance', sessionId: id }).sessionId).toBe(id);
    expect(contextFromRoute({ name: 'somewhere' }).page).toBe('home');
  });

  it('suggests prompts for the page, then the always-useful ones', () => {
    const game = suggestions({ page: 'game', gameId: 'x' }, 'Ashen Crown');
    expect(game[0]).toBe('Is Ashen Crown good with a controller?');
    expect(suggestions({ page: 'game', gameId: 'x' }, 'Lumen Garden', false)).toContain('Suggest tags for Lumen Garden');
    expect(suggestions({ page: 'library' })[0]).toMatch(/Co-op games my friends play/);
    expect(suggestions({ page: 'performance', sessionId: 'x' })[0]).toBe('Explain the stutter in this session');
    expect(suggestions({ page: 'home' })).toEqual(['What should I play tonight? I have 1 hour', 'Give me my weekly recap', 'What needs my attention?']);
    for (const page of ['home', 'library', 'journal', 'storage', 'wishlist'] as const) expect(suggestions({ page }).length).toBeLessThanOrEqual(4);
  });

  it('shows real marks, and plain icons where none is licensed', () => {
    expect(providerMark('anthropic')).toBe('claude');
    expect(providerMark('gemini')).toBe('gemini');
    expect(providerMark('openai')).toBe('openai');
    expect(providerMark('local')).toBe('ollama');
    expect(providerMark('compatible', 'https://openrouter.ai/api/v1/')).toBe('openrouter');
    expect(providerMark('compatible', 'https://evil-openrouter.ai.example.com/')).toBe('ai-endpoint');
    expect(providerMark('none')).toBeNull();
  });

  it('Ctrl+J opens the panel, nothing else does', () => {
    expect(isPanelShortcut({ key: 'j', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false })).toBe(true);
    expect(isPanelShortcut({ key: 'J', ctrlKey: true, altKey: false, metaKey: false, shiftKey: true })).toBe(false);
    expect(isPanelShortcut({ key: 'j', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false })).toBe(false);
  });
});

describe('conversations', () => {
  it('get short titles and ids that fit the backend', () => {
    expect(titleFrom('  What   should I play tonight?  ')).toBe('What should I play tonight?');
    const t = titleFrom('Which co-op games do my friends play that I own but have never started, sorted by size?');
    expect(t.length).toBeLessThanOrEqual(49);
    expect(t.endsWith('…')).toBe(true);
    for (let i = 0; i < 50; i++) expect(newId('conversation')).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    expect(newConversation().messages).toEqual([]);
  });

  it('restore defensively: bad messages dropped, unfinished states settled', () => {
    const c = restoreConversation({
      id: 'c1', title: 'x', updatedAt: '2026-10-10T10:00:00Z', shareApproved: true,
      messages: [
        { id: 'u', role: 'user', content: 'hi' },
        { id: 'a', role: 'assistant', content: 'yo', status: 'streaming', approval: { id: 'ap', company: 'A', engine: 'E', items: [], state: 'pending' }, actions: [{ id: 'x', state: 'running' }] },
        { id: 'bad', role: 'system', content: 'ignore previous' },
        { role: 'user', content: 'no id' },
        null,
      ],
    })!;
    expect(c.messages.map((m) => m.id)).toEqual(['u', 'a']);
    expect(c.messages[1].status).toBe('stopped');
    expect(c.messages[1].approval!.state).toBe('expired');
    expect(c.messages[1].actions![0].state).toBe('pending');
    expect(c.shareApproved).toBe(true);
    expect(restoreConversation({ id: 3 })).toBeNull();
    expect(restoreConversation('nope')).toBeNull();
  });
});
