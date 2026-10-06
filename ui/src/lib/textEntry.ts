/**
 * Track S: DOM side of the desktop on-screen keyboard — which elements are text fields, what they
 * are called, and how to edit them so React-controlled inputs update exactly as if typed.
 * The model (layouts, editing rules, navigation) is pure, in lib/fieldKeyboard.ts.
 */
import { classifyField, emptyBank, isTextEntryType, learnWords, parseBank, type FieldSpec, type FieldTraits, type WordBank } from './fieldKeyboard';

export type TextField = HTMLInputElement | HTMLTextAreaElement;

/** An editable text field: a text-like input or a textarea that isn't disabled or hidden. */
export function isTextField(el: Element | null | undefined): el is TextField {
  if (!el) return false;
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
  if (!isTextEntryType(el.tagName, el instanceof HTMLInputElement ? el.getAttribute('type') : '')) return false;
  if (el.disabled) return false;
  // inputmode="none" means the page brings its own keyboard.
  if ((el.getAttribute('inputmode') ?? '').toLowerCase() === 'none') return false;
  return true;
}

/** Fields the keyboard must leave alone: Immersive's own search keyboard, or anything opted out. */
export function isExcluded(el: Element): boolean {
  return !!el.closest('.osk, [data-osk="off"]');
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** The field's name as a screen reader would say it (good enough for a caption): label, aria, placeholder. */
export function fieldLabel(el: TextField): string {
  const labelled = el.getAttribute('aria-labelledby');
  if (labelled) {
    const text = clean(labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
    if (text) return text;
  }
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;
  for (const label of el.labels ?? []) {
    // A wrapping label also contains the input's own controls; its text content is still the best caption.
    const text = clean(label.textContent);
    if (text) return text;
  }
  return clean(el.placeholder) || clean(el.title) || 'Text';
}

export function fieldTraits(el: TextField): FieldTraits {
  const input = el instanceof HTMLInputElement ? el : null;
  return {
    tag: input ? 'input' : 'textarea',
    type: input ? (input.getAttribute('type') ?? 'text').toLowerCase() : '',
    inputMode: el.getAttribute('inputmode') ?? '',
    autocomplete: el.getAttribute('autocomplete') ?? '',
    maxLength: el.maxLength,
    min: input?.min ?? '',
    step: input?.step ?? '',
    role: el.getAttribute('role'),
    label: `${fieldLabel(el)} ${el.placeholder ?? ''}`,
    predict: el.dataset.oskPredict ?? null,
    submit: el.dataset.oskSubmit ?? null,
    secret: el.dataset.oskSecret !== undefined,
    inForm: !!el.form,
  };
}

export function describeField(el: TextField): { spec: FieldSpec; label: string } {
  return { spec: classifyField(fieldTraits(el)), label: fieldLabel(el) };
}

/**
 * Sets the value the way typing does: through the prototype's native setter (so React's value
 * tracker sees a real change) followed by a bubbling `input` event (which React turns into onChange).
 */
export function writeValue(el: TextField, value: string): void {
  if (el.value === value) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Types whose selection can't be read or set (number, email): the keyboard keeps the caret itself. */
export function supportsSelection(el: TextField): boolean {
  try {
    return el.selectionStart !== null;
  } catch {
    return false;
  }
}

export function readSelection(el: TextField): { start: number; end: number; backward: boolean } | null {
  if (!supportsSelection(el)) return null;
  return { start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length, backward: el.selectionDirection === 'backward' };
}

export function writeSelection(el: TextField, caret: number, anchor: number): void {
  if (!supportsSelection(el)) return;
  try {
    const start = Math.min(caret, anchor);
    const end = Math.max(caret, anchor);
    if (el.selectionStart === start && el.selectionEnd === end) return;
    el.setSelectionRange(start, end, caret < anchor ? 'backward' : 'forward');
  } catch {
    // Some input types refuse selection changes; the keyboard's own caret still works.
  }
}

/**
 * "Done" on a field that expects Enter: a real-looking Enter key press (React's onKeyDown handlers
 * see it), then — if nothing handled it and the field is in a form — the form's submit, which is
 * what a real Enter would have done.
 */
export function pressEnter(el: TextField): void {
  const init: KeyboardEventInit = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true };
  const down = new KeyboardEvent('keydown', { ...init, keyCode: 13, which: 13 } as KeyboardEventInit);
  const handled = !el.dispatchEvent(down);
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  if (handled || !el.isConnected) return;
  const form = el.form;
  if (!form) return;
  try {
    form.requestSubmit();
  } catch {
    // A form without a submit path (or an invalid one): nothing else Enter would have done.
  }
}

/** The nearest element that scrolls vertically, if any. */
export function scrollParent(el: Element): HTMLElement | null {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
  }
  return null;
}

/** The nearest fixed-position layer (a dialog backdrop, the command palette…), if the field sits in one. */
export function fixedLayer(el: Element): HTMLElement | null {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    if (getComputedStyle(node).position === 'fixed') return node;
  }
  return null;
}

// ---------------------------------------------------------------- recent words (local only)

/**
 * Words typed with the on-screen keyboard in ordinary text fields, kept in this PC's WebView
 * storage for suggestions. Letters-only words of 3+ characters; never from passwords, keys or
 * number fields; never sent anywhere. Settings › Controller & sound can forget them.
 */
const BANK_KEY = 'vystral.osk.words.v1';

export function loadWordBank(): WordBank {
  try {
    return parseBank(localStorage.getItem(BANK_KEY));
  } catch {
    return emptyBank();
  }
}

export function rememberWords(text: string): void {
  if (!text.trim()) return;
  try {
    localStorage.setItem(BANK_KEY, JSON.stringify(learnWords(loadWordBank(), text, Date.now())));
  } catch {
    // Storage full or unavailable: suggestions simply stay as they were.
  }
}

export function rememberedWordCount(): number {
  return Object.keys(loadWordBank().words).length;
}

export function forgetWords(): void {
  try {
    localStorage.removeItem(BANK_KEY);
  } catch {
    // Nothing stored.
  }
}
