/**
 * Track D6: Settings search. Pure ranking over the index (unit-tested) plus the DOM side of the jump: find the row on
 * the page, scroll it into view, move focus to its control and pulse a highlight ring twice.
 */
import type { SettingsEntry } from '../views/settings/settingsIndex';

export interface SettingsHit {
  entry: SettingsEntry;
  row: string;
  score: number;
  /** Ranges of the label to highlight. */
  marks: [number, number][];
}

export const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').replace(/&amp;/g, '&');

/** A stable id for a label: "What you pay a month (optional)" → "what-you-pay-a-month-optional". */
export function rowSlug(label: string): string {
  return norm(label).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

export const rowId = (e: SettingsEntry) => e.row ?? rowSlug(e.label);

function wordStarts(text: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);
}

/**
 * Every entry matching all the words of the query, best first: label prefix > a word of the label > label
 * substring > the group > hint and keywords. Ties keep the index order (which follows the page).
 */
export function searchSettings(index: SettingsEntry[], query: string, limit = 30): SettingsHit[] {
  const terms = norm(query).trim().split(/\s+/).filter((t) => t.length > 0);
  if (!terms.length || terms.join('').length < 2) return [];
  const hits: SettingsHit[] = [];
  index.forEach((entry, order) => {
    const label = norm(entry.label);
    const group = norm(entry.group);
    const rest = norm(`${entry.hint ?? ''} ${entry.keywords ?? ''}`);
    let score = 0;
    for (const t of terms) {
      if (label.startsWith(t)) score += 100;
      else if (wordStarts(label, t)) score += 70;
      else if (label.includes(t)) score += 40;
      else if (wordStarts(group, t)) score += 25;
      else if (wordStarts(rest, t)) score += 15;
      else if (rest.includes(t) || group.includes(t)) score += 6;
      else return;
    }
    const marks: [number, number][] = [];
    for (const t of terms) {
      const i = label.indexOf(t);
      if (i >= 0) marks.push([i, i + t.length]);
    }
    hits.push({ entry, row: rowId(entry), score: score - order * 0.001, marks: merge(marks) });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function merge(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/** Sections with at least one matching entry (to narrow the section list as before). */
export function sectionsMatching(index: SettingsEntry[], query: string): Set<string> {
  return new Set(searchSettings(index, query, 500).map((h) => h.entry.section));
}

// ---------------- the jump (DOM) ----------------

const ROWISH = '[data-row], .srow, .adapter, .dsrc-card, .dsh-row, .theme-picker';

function labelOf(el: Element): string {
  const own = el.matches('.sgroup')
    ? el.querySelector('.sgroup__title')
    : el.querySelector('.srow__label, .dsrc-card__title h4, .dsh-row__name, .platform-badge');
  return norm((own ?? el).textContent ?? '').replace(/\bnew\b\s*$/, '').trim();
}

/** The element for an entry inside the settings content: by `data-row`, else by its label, else its group. */
export function findSettingsRow(root: ParentNode, entry: SettingsEntry): HTMLElement | null {
  const id = rowId(entry);
  const byId = root.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
  if (byId) return byId;
  const want = norm(entry.label).trim();
  const rows = [...root.querySelectorAll<HTMLElement>(ROWISH)];
  const exact = rows.find((el) => labelOf(el) === want) ?? rows.find((el) => labelOf(el).startsWith(want));
  if (exact) return exact;
  const groups = [...root.querySelectorAll<HTMLElement>('.sgroup')];
  return groups.find((g) => labelOf(g) === want) ?? groups.find((g) => labelOf(g).startsWith(norm(entry.group))) ?? null;
}

const PULSE = 'settings-hit';

/** Scrolls the row into view, focuses its first control (without scrolling again) and pulses its ring twice. */
export function revealSettingsRow(el: HTMLElement, opts: { reduce?: boolean; focus?: boolean } = {}): void {
  el.scrollIntoView({ block: 'center', behavior: opts.reduce ? 'auto' : 'smooth' });
  if (opts.focus !== false) {
    const control = el.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), select:not([disabled]), button:not([disabled]), [role=switch], [role=radio][tabindex="0"], [tabindex="0"]');
    (control ?? el).focus({ preventScroll: true });
    if (!control) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    }
  }
  el.classList.remove(PULSE);
  void el.offsetWidth; // restart the animation when the same row is chosen twice
  el.classList.add(PULSE);
  window.setTimeout(() => el.classList.remove(PULSE), 2400);
}
