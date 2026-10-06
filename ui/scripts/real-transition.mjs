// Dev helper: films the desktop → Immersive transition in the running real app (CDP port 9333).
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// Dismiss anything modal (what's new tour) first.
await page.keyboard.press('Escape');
await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Home/ }).click().catch(() => {});
await page.waitForTimeout(1500);
const t0 = Date.now();
await page.keyboard.press('F11');
for (let i = 0; i < 9; i++) {
  await page.screenshot({ path: `${out}/enter-${i}.png` }).catch(() => {});
  console.log(i, Date.now() - t0, 'ms');
}
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/immersive.png` });
console.log('mode', await page.evaluate(() => document.documentElement.dataset.mode ?? (document.querySelector('.imm') ? 'immersive' : 'desktop')));
console.log('errors', JSON.stringify(errors));
await browser.close();
