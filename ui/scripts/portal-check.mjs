// Dev helper: captures the launch portal opening and the return iris (preview backend simulates a session).
import { chromium } from '@playwright/test';
const out = '../.playwright-mcp/imm';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1536, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/?nointro');
await page.waitForSelector('.shell [data-game-id]');
await page.waitForTimeout(500);
await page.getByRole('button', { name: 'Play', exact: true }).first().click();
for (const ms of [150, 450, 1200]) {
  await page.waitForTimeout(ms === 150 ? 150 : ms === 450 ? 300 : 750);
  await page.screenshot({ path: `${out}/portal-${ms}.png` });
}
// The preview backend ends the session ~7s after launch; capture the return iris.
await page.waitForFunction(() => document.querySelector('.launch--return'), null, { timeout: 15000 });
await page.waitForTimeout(450);
await page.screenshot({ path: `${out}/portal-return.png` });
await page.waitForTimeout(1600);
console.log({ launchingAttr: await page.evaluate(() => document.documentElement.dataset.launching ?? null), errors });
await browser.close();
