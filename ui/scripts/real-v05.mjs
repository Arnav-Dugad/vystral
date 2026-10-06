// Dev helper: tours v0.5 desktop features in the running real app (CDP port 9333).
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const nav = (n) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${n}`) }).first().click();
const shot = async (n) => { await page.waitForTimeout(1200); await page.screenshot({ path: `${out}/${n}.png` }); };
if (await page.locator('.imm').count()) { await page.keyboard.press('F11'); await page.waitForTimeout(2500); }
await nav('Home'); await shot('home');
await nav('Library'); await page.waitForTimeout(800);
const steamChip = page.getByRole('button', { name: /^Steam/ }).first();
if (await steamChip.count()) { await steamChip.hover(); await page.waitForTimeout(700); }
await shot('library-chips');
await page.locator('.vgrid .card[aria-label^="EA SPORTS FC 26"]').first().click(); await page.waitForTimeout(2500); await shot('detail-fc26');
await nav('Performance'); await page.waitForTimeout(1200);
const replay = page.getByRole('button', { name: /Replay/ }).first();
if (await replay.count()) { await replay.click(); await page.waitForTimeout(6000); await shot('replay'); await page.keyboard.press('Escape'); }
else console.log('no replay button');
await nav('Settings'); await page.getByRole('button', { name: 'Library & stores' }).first().click(); await page.waitForTimeout(800);
const ap = page.getByText(/Art packs/i).first(); if (await ap.count()) await ap.scrollIntoViewIfNeeded();
await shot('settings-artpacks');
console.log('errors', JSON.stringify(errors));
await browser.close();
