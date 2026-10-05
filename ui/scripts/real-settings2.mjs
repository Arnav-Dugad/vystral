// Dev helper: screenshots v0.4 settings sections in the running real app (CDP port 9333) and runs a network health check.
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
for (const [tab, anchor, name] of [['Launching & sessions', /background/i, 'tracking'], ['Library & stores', /SteamGridDB/i, 'sources']]) {
  await page.getByRole('button', { name: tab }).first().click();
  await page.waitForTimeout(800);
  const el = page.getByText(anchor).first();
  if (await el.count()) await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/settings-${name}.png` });
}
await page.getByRole('button', { name: 'Privacy' }).first().click();
await page.waitForTimeout(600);
await page.getByText('Network health').first().scrollIntoViewIfNeeded();
const check = page.getByRole('button', { name: /Check now|Check all/i }).first();
if (await check.count()) { await check.click(); await page.waitForTimeout(9000); }
await page.getByText('Network health').first().scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/settings-network.png` });
await browser.close();
