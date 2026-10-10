import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Settings/ }).first().click();
await page.getByRole('button', { name: 'Library & stores' }).first().click();
await page.waitForTimeout(1000);
const b = page.getByRole('button', { name: /Sync now|Refresh now|Sync/ }).first();
console.log('button', await b.textContent());
await b.click();
await page.waitForTimeout(15000);
const toasts = await page.locator('[role=status], .toast').allTextContents();
console.log('toasts', JSON.stringify(toasts.filter((t) => /Steam|library/i.test(t)).slice(0, 4)));
await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Library/ }).first().click();
await page.waitForTimeout(1500);
const chip = page.getByRole('button', { name: /No longer owned/ });
console.log('chip', await chip.count());
if (await chip.count()) { await chip.first().click(); await page.waitForTimeout(1200); await page.screenshot({ path: process.argv[2] }); console.log(await page.locator('.vgrid [data-game-id]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).slice(0, 10))); }
await browser.close();
