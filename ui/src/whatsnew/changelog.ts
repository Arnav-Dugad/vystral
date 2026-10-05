/**
 * CHANGELOG.md → structured releases. Runs at build time inside the Vite plugin (see
 * vite.config.ts, `virtual:vystral-changelog`) and in unit tests, so it must stay free of DOM
 * and of imports. The CHANGELOG format is unchanged:
 *
 *   ## [0.4.0] — 2026-10-12
 *   Optional intro paragraph.
 *   ### Section
 *   - **Bold lead.** The rest of the item, possibly
 *     continued on indented lines.
 */

export interface ChangelogItem {
  /** The bold lead-in ("Updates could look stuck"), without its trailing punctuation. */
  lead: string | null;
  /** Plain text after the lead (or the whole item). */
  text: string;
}

export interface ChangelogSection {
  title: string;
  items: ChangelogItem[];
}

export interface ChangelogRelease {
  version: string;
  date: string | null;
  intro: string;
  sections: ChangelogSection[];
}

export interface Highlight {
  eyebrow: string;
  title: string;
  body: string;
}

const RELEASE = /^##\s+\[?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\]?\s*(?:[—–-]\s*(.+))?$/;
const SECTION = /^###\s+(.+)$/;
const BULLET = /^[-*]\s+(.*)$/;

/** Markdown inline → plain text: links keep their text, emphasis and code markers are dropped. */
export function plain(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseItem(raw: string): ChangelogItem {
  const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(raw.trim());
  if (!m) return { lead: null, text: plain(raw) };
  const lead = plain(m[1]).replace(/[.:!]+$/, '').trim();
  return { lead: lead || null, text: plain(m[2]) };
}

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let section: ChangelogSection | null = null;
  let item: string | null = null;
  const intro: string[] = [];

  const flushItem = () => {
    if (item !== null && release) {
      if (!section) release.sections.push((section = { title: '', items: [] }));
      section.items.push(parseItem(item));
    }
    item = null;
  };
  const flushRelease = () => {
    flushItem();
    if (release) {
      release.intro = plain(intro.join(' '));
      release.sections = release.sections.filter((s) => s.items.length > 0);
      releases.push(release);
    }
    intro.length = 0;
  };

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const r = RELEASE.exec(line.trim());
    if (r && line.startsWith('## ')) {
      flushRelease();
      release = { version: r[1], date: r[2]?.trim() || null, intro: '', sections: [] };
      section = null;
      continue;
    }
    if (!release) continue;
    if (line.startsWith('# ')) continue;
    const s = SECTION.exec(line.trim());
    if (s && line.startsWith('###')) {
      flushItem();
      release.sections.push((section = { title: plain(s[1]), items: [] }));
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      flushItem();
      item = b[1];
      continue;
    }
    if (item !== null && /^\s+\S/.test(line)) {
      item += ' ' + line.trim();
      continue;
    }
    if (line.trim() === '') {
      flushItem();
      continue;
    }
    if (!section && item === null) intro.push(line.trim());
  }
  flushRelease();
  return releases;
}

/** Sections that aren't tour material. */
const QUIET = /fix|known|research|note|internal|security|deprecat/i;

/** Clips to the first sentence(s) that fit, never mid-word. */
export function clip(text: string, max = 200): string {
  if (text.length <= max) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = '';
  for (const s of sentences) {
    if ((out + s).trim().length > max) break;
    out += s;
  }
  if (out.trim()) return out.trim();
  const cut = text.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…';
}

/** The release's tour-worthy items: bold-lead items outside fix/known-issue sections. */
export function highlightsOf(release: ChangelogRelease, max = 5): Highlight[] {
  const out: Highlight[] = [];
  for (const section of release.sections) {
    if (QUIET.test(section.title)) continue;
    for (const item of section.items) {
      if (!item.lead) continue;
      out.push({ eyebrow: section.title || 'New', title: item.lead, body: clip(item.text) });
      if (out.length >= max) return out;
    }
  }
  return out;
}
