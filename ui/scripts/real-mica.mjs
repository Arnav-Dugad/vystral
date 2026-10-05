// Dev helper: toggles Living Canvas off in the running real app so the Mica backdrop shows, then restores it.
import { chromium } from '@playwright/test';
const step = process.argv[2] ?? 'off';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
await page.getByRole('button', { name: 'Appearance' }).first().click();
await page.waitForTimeout(600);
const toggle = page.getByRole('switch', { name: 'Living Canvas' });
const on = (await toggle.getAttribute('aria-checked')) === 'true';
if ((step === 'off' && on) || (step === 'on' && !on)) await toggle.click();
await page.waitForTimeout(1500);
console.log(JSON.stringify({ was: on, backdrop: await page.evaluate(() => document.documentElement.dataset.backdrop ?? null) }));
await browser.close();
