// Renders the installer splash image (assets/brand/installer-splash.png).
// Usage (from ui/): node scripts/render-splash.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const svg = readFileSync(resolve(root, 'assets/brand/vystral-mark.svg'), 'utf8').replace('width="512" height="512"', 'width="132" height="132"');
const font = (name, file) => `data:font/woff2;base64,${readFileSync(resolve(root, `ui/node_modules/@fontsource-variable/${name}/files/${file}`)).toString('base64')}`;
const html = `<!doctype html><html><head><style>
@font-face { font-family: Unbounded; src: url('${font('unbounded', 'unbounded-latin-wght-normal.woff2')}'); font-weight: 200 900; }
@font-face { font-family: Geist; src: url('${font('geist', 'geist-latin-wght-normal.woff2')}'); font-weight: 100 900; }
html,body{margin:0;width:640px;height:400px;overflow:hidden}
body{display:grid;place-items:center;background:
 radial-gradient(70% 80% at 80% 0%, oklch(0.42 0.16 292 / .55), transparent 70%),
 radial-gradient(60% 70% at 0% 100%, oklch(0.4 0.14 255 / .5), transparent 70%), #09090e; color:#f4f2ff;font-family:Geist}
.c{text-align:center}.w{margin-top:22px;font-family:Unbounded;font-weight:600;font-size:30px;letter-spacing:.5em;text-indent:.5em}
.t{margin-top:10px;font-size:13px;letter-spacing:.24em;color:#a9a3c2}
</style></head><body><div class="c">${svg}<div class="w">VYSTRAL</div><div class="t">YOUR UNIVERSE OF PLAY</div></div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
await page.setContent(html);
await page.waitForTimeout(300);
await page.screenshot({ path: resolve(root, 'assets/brand/installer-splash.png') });
await browser.close();
console.log('Rendered installer-splash.png');
