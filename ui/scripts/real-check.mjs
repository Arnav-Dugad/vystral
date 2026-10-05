// Dev helper: walks the running real app (CDP port 9333) through the v0.2 surfaces and screenshots each.
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral')) ?? browser.contexts()[0].pages()[0];
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${out}/${name}.png` }); };
console.log('intro visible:', await page.locator('.intro').count());
await shot('0-start');
await page.waitForTimeout(4500);
await shot('1-home');
const nav = page.getByRole('navigation', { name: 'Main' });
const games = await page.evaluate(() => document.querySelectorAll('[data-game-id]').length);
console.log('game elements:', games);
await nav.getByRole('button', { name: /Library/ }).click(); await shot('2-library');
const card = page.locator('.game-card, [data-game-id]').first();
if (await card.count()) { await card.click(); await page.waitForTimeout(3500); await shot('3-detail');
  console.log('trailer video:', await page.locator('video').count(), 'status picker:', await page.getByText(/Backlog|Playing|Set status/i).count());
  await page.keyboard.press('Escape'); await page.goBack?.().catch(() => {}); }
await nav.getByRole('button', { name: 'Storage' }).click(); await page.waitForTimeout(1500); await shot('4-storage');
await nav.getByRole('button', { name: 'Performance' }).click(); await shot('5-performance');
await nav.getByRole('button', { name: 'Settings' }).click(); await page.waitForTimeout(800);
for (const t of ['Steam Web API', 'Frame-rate capture', 'Windows integration']) {
  const el = page.getByText(t, { exact: false }).first();
  if (await el.count()) { await el.scrollIntoViewIfNeeded(); await shot('6-settings-' + t.replace(/\W+/g, '-')); }
  else console.log('missing settings section:', t);
}
console.log('bell:', await page.getByRole('button', { name: /notification/i }).count());
console.log('errors:', JSON.stringify(errors));
await browser.close();
