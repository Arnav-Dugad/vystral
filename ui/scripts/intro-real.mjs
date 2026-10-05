import { chromium } from '@playwright/test';
const out = process.argv[2];
let browser;
for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9333'); } catch { await new Promise((r) => setTimeout(r, 100)); } }
let page;
for (let i = 0; i < 50 && !page; i++) { page = browser.contexts()[0]?.pages().find((p) => p.url().includes('vystral')); if (!page) await new Promise((r) => setTimeout(r, 100)); }
const t0 = Date.now();
for (let i = 0; i < 6; i++) {
  const n = await page.locator('.intro').count();
  await page.screenshot({ path: `${out}/intro-${i}.png` });
  console.log(`t+${Date.now() - t0}ms intro=${n}`);
  await page.waitForTimeout(450);
}
await browser.close();
