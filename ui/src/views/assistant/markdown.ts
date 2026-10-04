/**
 * "Markdown-lite" for local model output. The result is a tree of plain strings rendered as
 * React text nodes — never HTML — so model output can't inject markup. Supported: paragraphs,
 * bullet lines (- or *), numbered lines (1. / 1)), headings (# …, shown as strong lines),
 * and **bold**. Everything else is kept verbatim.
 */

export interface Inline {
  text: string;
  bold: boolean;
}

export type Block =
  | { type: 'p'; lines: Inline[][] }
  | { type: 'h'; inline: Inline[] }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; start: number; items: Inline[][] };

/** Splits `**bold**` runs. An unclosed `**` (e.g. mid-stream) stays literal. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let plain = '';
  while (i < src.length) {
    if (src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        if (plain) {
          out.push({ text: plain, bold: false });
          plain = '';
        }
        out.push({ text: src.slice(i + 2, end), bold: true });
        i = end + 2;
        continue;
      }
    }
    plain += src[i];
    i++;
  }
  if (plain) out.push({ text: plain, bold: false });
  return mergeAdjacent(out);
}

function mergeAdjacent(parts: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.bold === p.bold) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

const BULLET = /^\s{0,6}[-*•]\s+(.*)$/;
const NUMBERED = /^\s{0,6}(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let current: Block | null = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'h', inline: parseInline(heading[1]) });
      continue;
    }
    const bullet = BULLET.exec(line);
    // "**Bold** text" starts with an asterisk but is not a bullet; BULLET needs whitespace after it.
    if (bullet) {
      if (current?.type !== 'ul') {
        flush();
        current = { type: 'ul', items: [] };
      }
      current.items.push(parseInline(bullet[1]));
      continue;
    }
    const numbered = NUMBERED.exec(line);
    if (numbered) {
      if (current?.type !== 'ol') {
        flush();
        current = { type: 'ol', start: Number(numbered[1]), items: [] };
      }
      current.items.push(parseInline(numbered[2]));
      continue;
    }
    // Indented continuation of a list item joins that item.
    if ((current?.type === 'ul' || current?.type === 'ol') && /^\s{2,}\S/.test(line) && current.items.length) {
      const items: Inline[][] = current.items;
      items[items.length - 1] = mergeAdjacent([...items[items.length - 1], { text: ' ', bold: false }, ...parseInline(line.trim())]);
      continue;
    }
    if (current?.type !== 'p') {
      flush();
      current = { type: 'p', lines: [] };
    }
    current.lines.push(parseInline(line.trim()));
  }
  flush();
  return blocks;
}
