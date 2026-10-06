import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { describeField, fieldLabel, isTextField, pressEnter, writeSelection, writeValue } from './textEntry';

afterEach(cleanup);

function Controlled({ onValue, upper }: { onValue: (v: string) => void; upper?: boolean }) {
  const [v, setV] = useState('');
  return (
    <input
      aria-label="Collection name"
      value={v}
      maxLength={60}
      onChange={(e) => {
        const next = upper ? e.target.value.toUpperCase() : e.target.value;
        setV(next);
        onValue(next);
      }}
    />
  );
}

describe('writeValue', () => {
  it('updates a React-controlled input through onChange', () => {
    const seen = vi.fn();
    const { getByLabelText } = render(<Controlled onValue={seen} />);
    const input = getByLabelText('Collection name') as HTMLInputElement;
    act(() => writeValue(input, 'Backlog'));
    expect(seen).toHaveBeenLastCalledWith('Backlog');
    expect(input.value).toBe('Backlog');
    act(() => writeValue(input, 'Backlog'));
    expect(seen).toHaveBeenCalledTimes(1); // no event when nothing changed
  });

  it('lets the app reshape the value', () => {
    const { getByLabelText } = render(<Controlled onValue={() => {}} upper />);
    const input = getByLabelText('Collection name') as HTMLInputElement;
    act(() => writeValue(input, 'abc'));
    expect(input.value).toBe('ABC');
  });

  it('works for textareas and keeps a selection', () => {
    const ta = document.createElement('textarea');
    document.body.append(ta);
    const onInput = vi.fn();
    ta.addEventListener('input', onInput);
    writeValue(ta, 'line one');
    expect(onInput).toHaveBeenCalledTimes(1);
    writeSelection(ta, 2, 6);
    expect([ta.selectionStart, ta.selectionEnd, ta.selectionDirection]).toEqual([2, 6, 'backward']);
    ta.remove();
  });
});

describe('fields', () => {
  it('recognises text fields and skips the rest', () => {
    const make = (html: string) => {
      const box = document.createElement('div');
      box.innerHTML = html;
      document.body.append(box);
      return box.firstElementChild!;
    };
    expect(isTextField(make('<input>'))).toBe(true);
    expect(isTextField(make('<input type="password">'))).toBe(true);
    expect(isTextField(make('<input type="checkbox">'))).toBe(false);
    expect(isTextField(make('<input type="range">'))).toBe(false);
    expect(isTextField(make('<input disabled>'))).toBe(false);
    expect(isTextField(make('<input inputmode="none">'))).toBe(false);
    expect(isTextField(make('<button></button>'))).toBe(false);
  });

  it('reads labels from aria, <label> and placeholders', () => {
    document.body.innerHTML = `
      <span id="t">Steam API key</span><input id="a" aria-labelledby="t" type="password" maxlength="64">
      <label for="b">Notes</label><textarea id="b"></textarea>
      <input id="c" placeholder="e.g. -fullscreen">`;
    const a = document.getElementById('a') as HTMLInputElement;
    expect(fieldLabel(a)).toBe('Steam API key');
    expect(describeField(a).spec).toMatchObject({ secret: true, maxLength: 64, predict: 'none' });
    expect(fieldLabel(document.getElementById('b') as HTMLTextAreaElement)).toBe('Notes');
    expect(fieldLabel(document.getElementById('c') as HTMLInputElement)).toBe('e.g. -fullscreen');
  });
});

describe('pressEnter', () => {
  it('fires Enter, and submits the form only when nothing handled it', () => {
    document.body.innerHTML = '<form><input id="k"><button type="submit">Go</button></form>';
    const input = document.getElementById('k') as HTMLInputElement;
    const form = input.form!;
    const submit = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submit);
    const keys: string[] = [];
    input.addEventListener('keydown', (e) => keys.push(e.key));
    pressEnter(input);
    expect(keys).toEqual(['Enter']);
    expect(submit).toHaveBeenCalledTimes(1);

    input.addEventListener('keydown', (e) => e.preventDefault());
    pressEnter(input);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
