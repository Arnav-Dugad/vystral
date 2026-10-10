// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_INDEX } from '../views/settings/settingsIndex';
import { findSettingsRow, rowId, rowSlug, searchSettings, sectionsMatching } from './settingsSearch';

const SECTION_IDS = ['appearance', 'library', 'sources', 'cloud', 'launching', 'controller', 'windows', 'ai', 'updates', 'privacy', 'data', 'about'];

describe('settings search', () => {
  it('finds a row by its words, best match first, with the section path', () => {
    const [first] = searchSettings(SETTINGS_INDEX, 'pay a month');
    expect(first.entry.label).toBe('What you pay a month (optional)');
    expect(first.entry.section).toBe('library');
    expect(first.row).toBe('subs-price');
    expect(searchSettings(SETTINGS_INDEX, 'currency')[0].entry.label).toBe('Show prices in');
    expect(searchSettings(SETTINGS_INDEX, 'vibration')[0].entry.label).toBe('Gentle vibration feedback');
  });

  it('matches hints and keywords, not just labels', () => {
    const labels = searchSettings(SETTINGS_INDEX, 'rupee').map((h) => h.entry.label);
    expect(labels).toContain('Show prices in');
    expect(searchSettings(SETTINGS_INDEX, 'crash').map((h) => h.entry.label)).toContain('Stability');
    expect(searchSettings(SETTINGS_INDEX, 'rate limit').map((h) => h.entry.label)).toContain('Data sources at a glance');
  });

  it('needs every word to match and ignores one-letter queries', () => {
    expect(searchSettings(SETTINGS_INDEX, 'vibration currency')).toEqual([]);
    expect(searchSettings(SETTINGS_INDEX, 'a')).toEqual([]);
    expect(searchSettings(SETTINGS_INDEX, '   ')).toEqual([]);
  });

  it('highlights word starts only (never the “a” inside “What”)', () => {
    const [hit] = searchSettings(SETTINGS_INDEX, 'pay a month');
    const label = hit.entry.label.toLowerCase();
    expect(hit.marks.map(([a, b]) => label.slice(a, b))).toEqual(['pay', 'a', 'month']);
    expect(hit.marks[1][0]).toBe(label.indexOf(' a ') + 1);
  });

  it('narrows the section list to sections with a match', () => {
    const s = sectionsMatching(SETTINGS_INDEX, 'vibration');
    expect([...s]).toEqual(['controller']);
  });

  it('makes stable row ids', () => {
    expect(rowSlug('What you pay a month (optional)')).toBe('what-you-pay-a-month-optional');
    expect(rowSlug('Your PC’s gaming wattage')).toBe('your-pcs-gaming-wattage');
  });
});

describe('the index', () => {
  const root = join(__dirname, '..');
  const sources = [
    join(root, 'views', 'Settings.tsx'),
    ...readdirSync(join(root, 'views', 'settings')).filter((f) => f.endsWith('.tsx')).map((f) => join(root, 'views', 'settings', f)),
    join(root, 'components', 'ai', 'AiProvidersSettings.tsx'),
    join(root, 'components', 'controller', 'BatteryHistoryCard.tsx'),
  ];
  const text = sources.map((f) => readFileSync(f, 'utf8')).join('\n').replace(/&amp;/g, '&');

  it('only names real sections, and every row id is unique within its section', () => {
    const seen = new Set<string>();
    for (const e of SETTINGS_INDEX) {
      expect(SECTION_IDS).toContain(e.section);
      const key = `${e.section}:${rowId(e)}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('every label still exists on its page (or the row is marked with data-row)', () => {
    const missing = SETTINGS_INDEX.filter((e) => !text.includes(e.label) && !text.includes(`data-row="${rowId(e)}"`) && !(rowId(e).startsWith('cache-') && text.includes('data-row={`cache-${c.id}`}')));
    expect(missing.map((e) => `${e.section}: ${e.label}`)).toEqual([]);
  });

  it('finds rows on the page by data-row, by label, or falls back to the group', () => {
    document.body.innerHTML = `
      <div id="root">
        <section class="sgroup"><h2 class="sgroup__title">Theme</h2><div class="theme-picker"></div></section>
        <section class="sgroup"><h2 class="sgroup__title">Controller</h2>
          <div class="srow"><div class="srow__text"><label class="srow__label">Gentle vibration feedback<span>New</span></label></div><button role="switch">x</button></div>
        </section>
        <div class="srow" data-row="subs-price"><label class="srow__label">What you pay a month (optional)</label><input id="subs-price"></div>
      </div>`;
    const rootEl = document.getElementById('root')!;
    const by = (label: string) => SETTINGS_INDEX.find((e) => e.label === label)!;
    expect(findSettingsRow(rootEl, by('What you pay a month (optional)'))?.dataset.row).toBe('subs-price');
    expect(findSettingsRow(rootEl, by('Gentle vibration feedback'))?.className).toBe('srow');
    expect(findSettingsRow(rootEl, by('Theme'))?.querySelector('h2')?.textContent).toBe('Theme');
    expect(findSettingsRow(rootEl, by('Navigate with a controller'))?.querySelector('h2')?.textContent).toBe('Controller'); // not rendered: its group
  });
});
