// Dev helper: tours v0.9 features in the running real app (CDP port 9333). Only presses Refresh on the wishlist.
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
await step('home', async () => { await nav('Home'); await page.waitForTimeout(2500); await page.mouse.wheel(0, 900); await shot('home-picks'); });
await step('wishlist', async () => { await nav('Wishlist'); await page.waitForTimeout(1500); const r = page.getByRole('button', { name: /^Refresh/ }).first(); if (await r.count()) { await r.click(); await page.waitForTimeout(25000); } await shot('wishlist-cal'); await page.getByRole('button', { name: 'Show as list' }).click(); await page.waitForTimeout(1500); await shot('wishlist-list'); await page.getByRole('button', { name: 'Show as calendar' }).click(); });
await step('discover', async () => { await nav('Discover'); await page.waitForTimeout(6000); await page.mouse.wheel(0, 700); await shot('discover'); });
await step('fh4', async () => { await nav('Library'); await page.getByPlaceholder(/Filter/).fill('forza'); await page.waitForTimeout(800); await page.locator('.vgrid [data-game-id]').first().click(); await page.waitForTimeout(6000); await shot('fh4'); await page.mouse.wheel(0, 900); await shot('fh4-2'); await page.mouse.wheel(0, 1400); await shot('fh4-3'); });
await step('assistant', async () => { await page.keyboard.press('Control+j'); await page.waitForTimeout(1500); await shot('assistant-panel'); await page.keyboard.press('Escape'); });
await step('settings', async () => { await nav('Settings'); await page.getByRole('button', { name: /^Data sources/ }).first().click(); await shot('settings-sources'); await page.getByRole('button', { name: /^Data & recovery/ }).first().click(); await shot('settings-caches'); await page.getByRole('button', { name: /^Appearance/ }).first().click(); await page.getByTestId('currency-settings').scrollIntoViewIfNeeded(); await shot('settings-currency'); });
console.log('errors', JSON.stringify(errors));
await browser.close();
