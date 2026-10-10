// Dev helper: tours v0.8 features in the running real app (CDP port 9333). Changes no settings.
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const nav = (n) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${n}`) }).first().click();
const shot = async (n) => { await page.waitForTimeout(1500); await page.screenshot({ path: `${out}/${n}.png` }); };
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log('STEP FAILED', name, String(e).slice(0, 200)); } };
if (await page.locator('.imm').count()) { await page.keyboard.press('F11'); await page.waitForTimeout(2500); }
console.log('caption', await page.evaluate(() => [getComputedStyle(document.documentElement).getPropertyValue('--caption-inset-right'), innerWidth, devicePixelRatio]));
await step('home', async () => { await nav('Home'); await page.waitForTimeout(2000); console.log('continue', await page.evaluate(() => [...document.querySelectorAll('section')].filter((s) => /Continue playing/.test(s.querySelector('h2,h3')?.textContent ?? '')).map((s) => [...s.querySelectorAll('[aria-label]')].map((c) => c.getAttribute('aria-label')).slice(0, 5)))); });
await step('library notowned', async () => { await nav('Library'); await page.waitForTimeout(1200); const chip = page.getByRole('button', { name: /No longer owned/ }); console.log('notowned chip', await chip.count()); if (await chip.count()) { await chip.first().click(); await shot('library-notowned'); } });
await step('storage', async () => { await nav('Storage'); await page.waitForTimeout(3000); await shot('storage'); });
await step('performance', async () => { await nav('Performance'); await shot('perf-overview'); for (const t of ['Sessions', 'Compare', 'System']) { await page.getByRole('tab', { name: new RegExp(`^${t}`) }).first().click(); await shot(`perf-${t.toLowerCase()}`); } });
await step('discover', async () => { await nav('Discover'); await page.waitForTimeout(6000); await shot('discover'); await page.mouse.wheel(0, 900); await shot('discover2'); });
await step('game fh4', async () => { await nav('Library'); await page.getByPlaceholder(/Filter/).fill('forza'); await page.waitForTimeout(800); await page.locator('.vgrid [data-game-id]').first().click(); await page.waitForTimeout(4000); await shot('game-fh4'); await page.mouse.wheel(0, 800); await shot('game-fh4-2'); });
await step('game fc26', async () => { await nav('Library'); await page.getByPlaceholder(/Filter/).fill('FC 26'); await page.waitForTimeout(800); await page.locator('.vgrid [data-game-id]').first().click(); await page.waitForTimeout(5000); await page.mouse.wheel(0, 700); await shot('game-fc26'); await page.mouse.wheel(0, 900); await shot('game-fc26-2'); });
await step('settings', async () => { await nav('Settings'); await page.getByRole('button', { name: /^About/ }).first().click(); await shot('settings-about'); await page.getByRole('button', { name: /^AI/ }).first().click(); await shot('settings-ai'); });
await step('journal', async () => { await nav('Journal'); await page.getByRole('tab', { name: /Records/ }).first().click(); await shot('journal-records'); });
console.log('errors', JSON.stringify(errors));
await browser.close();
