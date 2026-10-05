// Dev helper: screenshots Library list view and the command bar in the running real app (CDP port 9333).
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Library/ }).click();
await page.waitForTimeout(1200);
await page.getByText('List', { exact: true }).locator('..').click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/library-list.png` });
await page.getByText('Grid', { exact: true }).locator('..').click();
await page.keyboard.press('Control+K');
await page.waitForTimeout(500);
await page.keyboard.type('not installed racing', { delay: 30 });
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/command-bar.png` });
await page.keyboard.press('Escape');
await browser.close();
