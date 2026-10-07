// Dev helper: tours v0.7 features in the running real app (CDP port 9333). Changes no settings.
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const nav = (n) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${n}`) }).first().click();
const shot = async (n) => { await page.waitForTimeout(1300); await page.screenshot({ path: `${out}/${n}.png` }); };
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log('STEP FAILED', name, String(e).slice(0, 160)); } };
if (await page.locator('.imm').count()) { await page.keyboard.press('F11'); await page.waitForTimeout(2500); }
await step('home', async () => { await nav('Home'); await shot('home'); await page.mouse.wheel(0, 1400); await shot('home2'); });
await step('library forza', async () => { await nav('Library'); await page.getByPlaceholder(/Filter/).fill('forza'); await shot('library-forza'); await page.getByPlaceholder(/Filter/).fill(''); });
await step('discover', async () => {
  await nav('Discover'); await page.getByRole('searchbox', { name: 'Search every source' }).fill('elden ring'); await page.waitForTimeout(5000); await shot('discover');
  await page.locator('.dcard').first().click(); await page.waitForTimeout(5000); await shot('discover-game');
});
await step('game page', async () => {
  await nav('Library'); await page.locator('.vgrid .card[aria-label^="EA SPORTS FC 26"]').first().click(); await page.waitForTimeout(2500); await shot('detail');
  await page.mouse.wheel(0, 700); await shot('detail-docked'); await page.mouse.wheel(0, -2000);
  for (const t of ['News', 'Files', 'Achievements', 'Controls']) { const tab = page.getByRole('tab', { name: new RegExp(`^${t}`) }).first(); if (await tab.count()) { await tab.click(); await page.waitForTimeout(2500); await page.mouse.wheel(0, 600); await shot(`detail-${t.toLowerCase()}`); await page.mouse.wheel(0, -2000); } else console.log('no tab', t); }
});
await step('journal', async () => { await nav('Journal'); await page.waitForTimeout(1500); await page.mouse.wheel(0, 1200); await shot('journal'); await page.mouse.wheel(0, 1200); await shot('journal2'); });
await step('performance', async () => { await nav('Performance'); await page.mouse.wheel(0, 1600); await shot('performance'); });
await step('settings', async () => {
  await nav('Settings'); await page.getByRole('button', { name: 'Library & stores' }).first().click(); await shot('settings-library');
  await page.getByRole('button', { name: /^Updates/ }).first().click(); await shot('settings-updates');
  await page.getByRole('button', { name: /^Data & recovery/ }).first().click(); await shot('settings-data');
});
console.log('errors', JSON.stringify(errors));
await browser.close();
