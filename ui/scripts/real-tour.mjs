// Dev helper: screenshots the main pages of the running real app (CDP port 9333) into an output folder.
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const pages = (process.argv[3] ?? 'Home,Library,Journal,Performance,Moments,Storage,Constellation,Assistant').split(',');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
for (const name of pages) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${name}`) }).first().click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${out}/tour-${name.toLowerCase()}.png` });
}
console.log('errors', JSON.stringify(errors));
await browser.close();
