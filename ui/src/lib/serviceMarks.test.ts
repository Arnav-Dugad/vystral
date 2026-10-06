// The app tsconfig has no Node types, so the notices file is read with Node's fs directly; vitest
// always runs from the ui/ folder (see styles/tokens.test.ts).
// @ts-expect-error -- Node built-in without type definitions in the app program
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOklch } from './color';
import { logoMotion } from './logoMotion';
import { DATA_SOURCE_SERVICE, hardwareVendor, SERVICE_MARKS, type ServiceId } from './serviceMarks';
import { markViewBox, OPTICAL_SIZES, STORE_MARKS, type BrandMark } from './storeMarks';

const notices = (readFileSync('../THIRD-PARTY-NOTICES.md', 'utf8') as string).replace(/\r\n/g, '\n');

const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/**
 * A strict SVG path-data walker: every command must get whole argument groups, arc flags must be
 * 0/1, and it returns the bounding box of every on-curve point (absolute; Bézier control points may
 * legitimately lie outside), so a drawing that was moved or scaled wrongly falls off the 24-unit grid.
 */
function walk(d: string): { minX: number; minY: number; maxX: number; maxY: number; subpaths: number } {
  let i = 0;
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, subpaths: 0 };
  const skip = () => { while (i < d.length && /[\s,]/.test(d[i])) i++; };
  const num = () => {
    skip();
    const re = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;
    re.lastIndex = i;
    const m = re.exec(d);
    if (!m) throw new Error(`number expected at ${i}: “${d.slice(i, i + 12)}”`);
    i = re.lastIndex;
    return parseFloat(m[0]);
  };
  const flag = () => {
    skip();
    const c = d[i++];
    if (c !== '0' && c !== '1') throw new Error(`arc flag expected at ${i - 1}`);
  };
  const add = (x: number, y: number) => {
    box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
  };
  let x = 0, y = 0, sx = 0, sy = 0;
  let cmd = '';
  skip();
  if (!/^[Mm]/.test(d.slice(i))) throw new Error('path must start with a moveto');
  for (;;) {
    skip();
    if (i >= d.length) break;
    if (/[a-zA-Z]/.test(d[i])) {
      cmd = d[i++];
      if (!(cmd.toLowerCase() in ARGS)) throw new Error(`unknown command ${cmd}`);
      if (cmd.toLowerCase() === 'z') { x = sx; y = sy; continue; }
    } else if (!cmd || cmd.toLowerCase() === 'z') throw new Error(`stray number at ${i}`);
    const rel = cmd === cmd.toLowerCase();
    const lc = cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (lc) {
      case 'm': x = ox + num(); y = oy + num(); sx = x; sy = y; box.subpaths++; add(x, y); cmd = rel ? 'l' : 'L'; break;
      case 'l': case 't': x = ox + num(); y = oy + num(); add(x, y); break;
      case 'h': x = ox + num(); add(x, y); break;
      case 'v': y = (rel ? y : 0) + num(); add(x, y); break;
      case 'c': for (let k = 0; k < 4; k++) num(); x = ox + num(); y = oy + num(); add(x, y); break;
      case 's': case 'q': num(); num(); x = ox + num(); y = oy + num(); add(x, y); break;
      case 'a': num(); num(); num(); flag(); flag(); x = ox + num(); y = oy + num(); add(x, y); break;
    }
  }
  return box;
}

const brandStoreMarks = Object.entries(STORE_MARKS).filter((e): e is [string, BrandMark] => e[1].kind === 'brand');
const brandServiceMarks = Object.entries(SERVICE_MARKS).filter((e): e is [string, BrandMark & { name: string; hue: string }] => e[1].kind === 'brand');

describe('logo registries', () => {
  it('every brand path parses and stays on the 24-unit grid', () => {
    for (const [id, m] of [...brandStoreMarks, ...brandServiceMarks]) {
      const b = walk(m.path);
      expect(b.subpaths, id).toBeGreaterThan(0);
      expect(b.minX, id).toBeGreaterThanOrEqual(-0.05);
      expect(b.minY, id).toBeGreaterThanOrEqual(-0.05);
      expect(b.maxX, id).toBeLessThanOrEqual(24.05);
      expect(b.maxY, id).toBeLessThanOrEqual(24.05);
      // Uses the grid: the mark's longer side spans at least most of it.
      expect(Math.max(b.maxX - b.minX, b.maxY - b.minY), id).toBeGreaterThan(17);
    }
  });

  it('the Xbox sphere fills the grid like Steam’s disc (the 16-unit drawing was scaled exactly 1.5×)', () => {
    const b = walk((STORE_MARKS.xbox as BrandMark).path);
    // On-curve points only, so the round edge sits a hair inside 0 and 24.
    for (const v of [b.minX, b.minY]) expect(v).toBeLessThan(0.3);
    for (const v of [b.maxX, b.maxY]) expect(v).toBeGreaterThan(23.7);
    expect((STORE_MARKS.xbox as BrandMark).inset).toBe((STORE_MARKS.steam as BrandMark).inset);
  });

  it('every viewBox is square, centred on the grid and only slightly inset', () => {
    for (const [id, m] of [...Object.entries(STORE_MARKS), ...Object.entries(SERVICE_MARKS)]) {
      for (const size of OPTICAL_SIZES) {
        const [x, y, w, h] = markViewBox(m, size).split(' ').map(Number);
        expect([x, y, w, h].every(Number.isFinite), id).toBe(true);
        expect(w, id).toBe(h);
        expect(x, id).toBe(y);
        expect(w, id).toBeCloseTo(24 - 2 * x, 6);
        expect(w, id).toBeGreaterThanOrEqual(24);
        expect(w, id).toBeLessThanOrEqual(26);
      }
    }
  });

  it('every drawing is credited in THIRD-PARTY-NOTICES.md', () => {
    for (const [id, m] of [...brandStoreMarks, ...brandServiceMarks]) {
      if (m.slug.startsWith('bootstrap-icons:')) {
        expect(notices, id).toMatch(/Bootstrap Icons\]?\(?[^\n]*1\.13\.1/);
        expect(notices, id).toContain(`\`${m.slug.split(':')[1]}\``);
        expect(notices, id).toContain('The Bootstrap Authors');
      } else {
        expect(notices, `${id} → simple-icons slug ${m.slug}`).toContain(`\`${m.slug}\``);
      }
    }
    expect(notices).toContain('Simple Icons');
    expect(notices).toContain('16.34.0');
  });

  it('service marks have a readable hue, and generic ones say why there is no logo', () => {
    for (const [id, m] of Object.entries(SERVICE_MARKS)) {
      expect(m.name.length, id).toBeGreaterThan(1);
      if (m.kind === 'brand') {
        if (m.hue.startsWith('var(')) expect(m.hue, id).toMatch(/^var\(--p-[a-z]+\)$/);
        else {
          const c = parseOklch(m.hue);
          expect(c, id).not.toBeNull();
          // Like the store tokens: light enough to read on the dark surfaces (Light darkens them in CSS).
          expect(c![0], id).toBeGreaterThanOrEqual(0.65);
        }
      } else {
        expect(m.reason.length, id).toBeGreaterThan(10);
      }
    }
  });

  it('includes the marks cloud play needs', () => {
    expect(SERVICE_MARKS['geforce-now'].kind).toBe('brand');
    expect((SERVICE_MARKS['geforce-now'] as BrandMark).path).toBe((SERVICE_MARKS.nvidia as BrandMark).path);
    expect((SERVICE_MARKS['xbox-cloud'] as BrandMark).path).toBe((STORE_MARKS.xbox as BrandMark).path);
  });

  it('maps every data source to a mark', () => {
    for (const service of Object.values(DATA_SOURCE_SERVICE)) expect(SERVICE_MARKS[service as ServiceId]).toBeDefined();
    expect(SERVICE_MARKS[DATA_SOURCE_SERVICE.steamdeck].kind).toBe('brand');
    expect(SERVICE_MARKS[DATA_SOURCE_SERVICE.awacy].kind).toBe('generic');
  });

  it('service marks move like store marks: simple ones trace, wordmarks sweep', () => {
    expect(logoMotion(SERVICE_MARKS.steamdeck, { interactive: true })).toBe('trace');
    expect(logoMotion(SERVICE_MARKS.intel, { interactive: true })).toBe('sweep');
    expect(logoMotion(SERVICE_MARKS.wikidata, { interactive: true })).toBe('sweep');
    expect(logoMotion(SERVICE_MARKS.ollama, { interactive: false })).toBe('none');
  });

  it('names a graphics card’s maker only when the name says so', () => {
    expect(hardwareVendor('NVIDIA GeForce RTX 4060 Laptop GPU')).toBe('nvidia');
    expect(hardwareVendor('GeForce GTX 1080')).toBe('nvidia');
    expect(hardwareVendor('AMD Radeon RX 7800 XT')).toBe('amd');
    expect(hardwareVendor('Radeon(TM) 780M Graphics')).toBe('amd');
    expect(hardwareVendor('Intel(R) Arc(TM) A770 Graphics')).toBe('intel');
    expect(hardwareVendor('Intel(R) UHD Graphics 770')).toBe('intel');
    expect(hardwareVendor('Microsoft Basic Display Adapter')).toBeNull();
    expect(hardwareVendor('Parsec Virtual Display Adapter')).toBeNull();
    expect(hardwareVendor('')).toBeNull();
    expect(hardwareVendor(null)).toBeNull();
  });
});
