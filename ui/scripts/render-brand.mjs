// Renders the brand mark SVG to PNG sizes and a multi-resolution .ico.
// Usage (from ui/): node scripts/render-brand.mjs
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const svg = readFileSync(resolve(root, 'assets/brand/vystral-mark.svg'), 'utf8');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512];
const out = resolve(root, 'assets/brand/png');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const pngs = {};
for (const size of sizes) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`,
  );
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  pngs[size] = buf;
  writeFileSync(resolve(out, `vystral-${size}.png`), buf);
}
await browser.close();

// ICO container with embedded PNG images (supported since Windows Vista).
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);
const entries = [];
const images = [];
let offset = 6 + 16 * icoSizes.length;
for (const size of icoSizes) {
  const data = pngs[size];
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0);
  e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  entries.push(e);
  images.push(data);
}
const ico = Buffer.concat([header, ...entries, ...images]);
writeFileSync(resolve(root, 'assets/brand/vystral.ico'), ico);
writeFileSync(resolve(root, 'src/Vystral.App/Assets/vystral.ico'), ico);
mkdirSync(resolve(root, 'ui/public'), { recursive: true });
writeFileSync(resolve(root, 'ui/public/favicon.svg'), svg);
writeFileSync(resolve(root, 'ui/public/vystral-mark.svg'), svg);
console.log('Rendered', sizes.join(', '), 'and vystral.ico');
