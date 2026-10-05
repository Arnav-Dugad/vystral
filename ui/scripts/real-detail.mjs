// Dev helper: opens game pages by title in the running real app (CDP port 9333) and screenshots them.
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const titles = (process.argv[3] ?? 'EA SPORTS FC 27 Lite').split('|');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
for (const [i, title] of titles.entries()) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Library/ }).click();
  await page.waitForTimeout(1000);
  await page.locator(`.vgrid .card[aria-label^="${title}"]`).first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/detail-${i}-a.png` });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${out}/detail-${i}-b.png` });
  console.log(title, JSON.stringify(await page.evaluate(() => ({
    play: document.querySelector('.play-btn, [class*="play-btn"]')?.textContent?.trim().slice(0, 40) ?? null,
    ghost: !!document.querySelector('[class*="ghost"] path, [class*="ghost"] polyline'),
    video: document.querySelector('video')?.paused === false,
    canvasGame: getComputedStyle(document.documentElement).getPropertyValue('--game').trim().slice(0, 60),
  }))));
}
console.log('errors', JSON.stringify(errors));
await browser.close();
