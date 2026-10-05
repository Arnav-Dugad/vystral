// Dev helper: verifies attract mode starts after idle and that the waking input is swallowed.
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/?nointro&attractTest');
await page.waitForSelector('.shell [data-game-id]');
await page.waitForTimeout(300);
await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true })));
await page.waitForSelector('.imm__card');
const before = await page.evaluate(() => document.querySelector('.imm__card[data-focused="true"]')?.getAttribute('aria-label'));
await page.waitForSelector('.attract', { timeout: 15000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: '../.playwright-mcp/imm/08-attract.png' });
await page.waitForTimeout(9000);
await page.screenshot({ path: '../.playwright-mcp/imm/09-attract-next.png' });
// Waking with Right must NOT move focus.
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(800);
const after = await page.evaluate(() => ({
  attract: !!document.querySelector('.attract'),
  focused: document.querySelector('.imm__card[data-focused="true"]')?.getAttribute('aria-label'),
}));
console.log({ before, after, swallowed: before === after.focused, errors });
await browser.close();
