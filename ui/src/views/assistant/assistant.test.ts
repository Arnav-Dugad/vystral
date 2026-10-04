import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline } from './markdown';
import { IDLE_PULL, describePull, formatModelBytes, reducePull, toWireMessages, type ChatMessage } from './chat';

describe('parseInline', () => {
  it('splits bold runs', () => {
    expect(parseInline('Play **Ashen Crown** tonight')).toEqual([
      { text: 'Play ', bold: false },
      { text: 'Ashen Crown', bold: true },
      { text: ' tonight', bold: false },
    ]);
  });
  it('keeps unclosed or empty markers literal', () => {
    expect(parseInline('a **b')).toEqual([{ text: 'a **b', bold: false }]);
    expect(parseInline('****')).toEqual([{ text: '****', bold: false }]);
  });
  it('never interprets HTML', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ text: '<img src=x onerror=alert(1)>', bold: false }]);
  });
});

describe('parseBlocks', () => {
  it('builds paragraphs, bullet and numbered lists', () => {
    const blocks = parseBlocks('Here are ideas:\nsecond line\n\n- **One** thing\n* Two\n\n1. First\n2) Second\n\nDone.');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'ul', 'ol', 'p']);
    const p = blocks[0];
    expect(p.type === 'p' && p.lines.length).toBe(2);
    const ul = blocks[1];
    expect(ul.type === 'ul' && ul.items[0]).toEqual([
      { text: 'One', bold: true },
      { text: ' thing', bold: false },
    ]);
    const ol = blocks[2];
    expect(ol.type === 'ol' && ol.start).toBe(1);
    expect(ol.type === 'ol' && ol.items.length).toBe(2);
  });

  it('treats a leading **bold** as text, not a bullet', () => {
    const blocks = parseBlocks('**Tonight:** Nebula Drift');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('p');
  });

  it('renders headings as their own block and joins list continuations', () => {
    const blocks = parseBlocks('## Picks\n- Glasswing\n  short and calm\n- Tidebreaker');
    expect(blocks[0]).toEqual({ type: 'h', inline: [{ text: 'Picks', bold: false }] });
    const ul = blocks[1];
    expect(ul.type === 'ul' && ul.items[0]).toEqual([{ text: 'Glasswing short and calm', bold: false }]);
  });

  it('normalises CRLF and ignores blank input', () => {
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks('a\r\n\r\nb').map((b) => b.type)).toEqual(['p', 'p']);
  });
});

describe('toWireMessages', () => {
  const m = (role: ChatMessage['role'], content: string, status?: ChatMessage['status']): ChatMessage => ({ id: content, role, content, status });

  it('drops errors, streaming and empty replies, and starts with the user', () => {
    const wire = toWireMessages([m('assistant', 'hello'), m('user', 'q1'), m('assistant', '', 'error'), m('user', 'q2'), m('assistant', 'partial', 'streaming')]);
    expect(wire).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('keeps stopped replies and trims oldest turns to the budget', () => {
    const wire = toWireMessages([m('user', 'x'.repeat(50)), m('assistant', 'y'.repeat(50), 'stopped'), m('user', 'last')], 60);
    expect(wire).toEqual([{ role: 'user', content: 'last' }]);
  });
});

describe('reducePull', () => {
  it('tracks progress, done, cancel and error', () => {
    let s = reducePull(IDLE_PULL, { model: 'm', status: 'pulling manifest' });
    expect(s).toMatchObject({ phase: 'pulling', percent: null });
    s = reducePull(s, { model: 'm', status: 'pulling abc', total: 200, completed: 50 });
    expect(s.percent).toBe(25);
    s = reducePull(s, { model: 'm', status: 'pulling abc' });
    expect(s.percent).toBe(25);
    expect(reducePull(s, { model: 'm', status: 'success' }).phase).toBe('done');
    expect(reducePull(s, { model: 'm', status: 'x', done: true }).phase).toBe('done');
    expect(reducePull(s, { model: 'm', status: 'cancelled' }).phase).toBe('cancelled');
    expect(reducePull(s, { model: 'm', status: 'x', error: 'disk full' })).toMatchObject({ phase: 'error', error: 'disk full' });
  });

  it('formats model sizes in decimal units like Ollama', () => {
    expect(formatModelBytes(2.5e9)).toBe('2.5 GB');
    expect(formatModelBytes(763e6)).toBe('763 MB');
    expect(formatModelBytes(null)).toBe('—');
  });

  it('describes statuses', () => {
    expect(describePull('pulling manifest')).toBe('Preparing download…');
    expect(describePull('pulling 8eeb52dfb3bb')).toBe('Downloading…');
    expect(describePull('verifying sha256 digest')).toBe('Verifying download…');
  });
});
