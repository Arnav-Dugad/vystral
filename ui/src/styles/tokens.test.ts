// The app tsconfig has no Node types (and vitest returns CSS as an empty string even with ?raw),
// so the file is read with Node's fs directly; vitest always runs from the ui/ folder.
// @ts-expect-error -- Node built-in without type definitions in the app program
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, gamutMap, lchToRgb, parseOklch, type LCh } from '../lib/color';

/** WCAG checks on the colour tokens themselves (light theme text on white, text on accent). */
const css = (readFileSync('src/styles/tokens.css', 'utf8') as string).replace(/\r\n/g, '\n');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector}`);
  return css.slice(start, css.indexOf('\n}', start));
}

function token(scope: string, name: string): LCh {
  const m = new RegExp(`${name}:\\s*(oklch\\([^)]*\\))`).exec(scope);
  const v = parseOklch(m?.[1]);
  if (!v) throw new Error(`token ${name} is not a plain oklch() colour`);
  return v;
}

const rgb = (lch: LCh) => lchToRgb(gamutMap(lch));

describe('light theme tokens', () => {
  const light = block(":root[data-theme='light']");
  const surfaces = ['--bg-0', '--bg-1', '--bg-2'].map((n) => rgb(token(light, n)));

  it.each(['--ok', '--warn', '--danger', '--info'])('%s is readable as text on every light surface', (name) => {
    const c = rgb(token(light, name));
    for (const s of surfaces) expect(contrastRatio(c, s)).toBeGreaterThanOrEqual(4.5);
  });

  it('text on accent is readable on any game accent (clamped lightness, both gradient stops)', () => {
    const clamp = /--accent:\s*oklch\(from var\(--game\) clamp\(([\d.]+), l, ([\d.]+)\) c h\)/.exec(light);
    expect(clamp).not.toBeNull();
    const [lo, hi] = [Number(clamp![1]), Number(clamp![2])];
    const onAccent = rgb(token(light, '--text-on-accent'));
    for (let h = 0; h < 360; h += 15) {
      for (const L of [0.3, 0.5, 0.7, 0.9]) {
        const accent = Math.min(hi, Math.max(lo, L));
        for (const stop of [accent, accent - 0.08]) {
          expect(contrastRatio(onAccent, rgb([stop, 0.17, h]))).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
