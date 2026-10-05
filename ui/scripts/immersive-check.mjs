// Dev helper: drives Immersive Mode in a fresh browser against the dev server and saves frames.
// Usage (from ui/, with `npm run dev -- --port 5173` running): node scripts/immersive-check.mjs [outDir]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? '../.playwright-mcp/imm';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/?nointro');
await page.waitForSelector('.shell [data-game-id]');
await page.waitForTimeout(300);
await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true })));
await page.waitForSelector('.imm__card');
await page.waitForTimeout(900);
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const state = () =>
  page.evaluate(() => {
    const f = document.querySelector('.imm__card[data-focused="true"]');
    const fr = f?.querySelector('.imm__card-frame')?.getBoundingClientRect();
    const ring = document.querySelector('.imm__ring')?.getBoundingClientRect();
    return {
      tab: document.querySelector('.imm__tab[aria-current]')?.textContent,
      row: document.querySelector('.imm__row[data-active="true"] .imm__row-title')?.firstChild?.textContent,
      focused: f?.getAttribute('aria-label'),
      ringMatchesCard: !!fr && !!ring && Math.abs(fr.x - ring.x) < 2 && Math.abs(fr.y - ring.y) < 2 && Math.abs(fr.width - ring.width) < 2,
      panel: !!document.querySelector('.imm-panel__card'),
    };
  });

const log = [];
await shot('01-start');
log.push(['start', await state()]);
for (const k of ['ArrowRight', 'ArrowRight']) await page.keyboard.press(k);
await page.waitForTimeout(120);
await shot('02-mid-move');
await page.waitForTimeout(800);
log.push(['right x2', await state()]);
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(900);
await shot('03-down');
log.push(['down', await state()]);
// Rapid input must not desync or blank anything.
for (let i = 0; i < 6; i++) await page.keyboard.press(i % 2 ? 'ArrowDown' : 'ArrowRight');
await page.waitForTimeout(1000);
await shot('04-rapid');
log.push(['rapid', await state()]);
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
await shot('05-panel');
log.push(['panel', await state()]);
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
log.push(['escape', await state()]);
await page.keyboard.press('e');
await page.waitForTimeout(900);
await shot('06-all-games');
log.push(['all games', await state()]);
for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
await page.waitForTimeout(900);
await shot('07-all-games-down');
log.push(['all games down', await state()]);

for (const [step, s] of log) console.log(step.padEnd(16), JSON.stringify(s));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
