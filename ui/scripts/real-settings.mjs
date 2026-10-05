// Dev helper: screenshots the v0.2 settings sections of the running real app (CDP port 9333).
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral')) ?? browser.contexts()[0].pages()[0];
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
for (const [tab, anchor] of [['Library & stores', /Steam Web API/i], ['Launching & sessions', /Frame-rate capture/i], ['Windows integration', /hotkey|shortcut/i], ['Privacy', /Data saver|metered/i]]) {
  await page.getByRole('tab', { name: tab }).or(page.getByRole('button', { name: tab })).first().click();
  await page.waitForTimeout(600);
  const el = page.getByText(anchor).first();
  if (await el.count()) await el.scrollIntoViewIfNeeded(); else console.log('missing', tab, anchor);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/settings-${tab.replace(/\W+/g, '-')}.png` });
}
console.log('errors:', JSON.stringify(errors));
await browser.close();
