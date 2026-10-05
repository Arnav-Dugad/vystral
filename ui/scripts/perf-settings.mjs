// Dev helper: measures main-thread long tasks per page with the CPU throttled (simulates slow PCs).
// Usage (from ui/, with `npx vite --port 5311` running): node scripts/perf-settings.mjs [rate]
import { chromium } from '@playwright/test';
const rate = Number(process.argv[2] ?? 6);
const browser = await chromium.launch({ args: ['--disable-gpu'] });
async function measure(label, query, setup) {
  const page = await browser.newPage({ viewport: { width: 1536, height: 960 } });
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  await page.goto(`http://localhost:5311/${query}`);
  await page.locator('.shell').first().waitFor();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  if (setup) await setup(page);
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.__lt = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt += e.duration; }).observe({ type: 'longtask', buffered: false }); });
  await page.waitForTimeout(5000);
  console.log(label, 'long-task ms in 5 s:', Math.round(await page.evaluate(() => window.__lt)));
  await page.close();
}
await measure('home', '', null);
await measure('settings', '', async (p) => { await p.keyboard.press('Control+,'); });
await measure('settings reduced', '?reduced', async (p) => { await p.keyboard.press('Control+,'); });
await measure('library', '', async (p) => { await p.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click(); });
await browser.close();
