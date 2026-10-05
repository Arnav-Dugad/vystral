// Dev helper: captures the startup animation in a fresh browser (no stored session flags).
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1536, height: 960 } });
await page.goto('http://localhost:5173/', { waitUntil: 'commit' });
await page.waitForSelector('.intro');
const t0 = Date.now();
for (const ms of [400, 1000, 1600, 2200]) {
  await page.waitForTimeout(Math.max(0, ms - (Date.now() - t0)));
  await page.screenshot({ path: `../.playwright-mcp/imm/intro-${ms}.png` });
  console.log(Date.now() - t0, 'ms: intro visible =', await page.locator('.intro').isVisible().catch(() => false));
}
await page.waitForTimeout(2000);
console.log('after ~4s: intro visible =', await page.locator('.intro').isVisible().catch(() => false));
await browser.close();
