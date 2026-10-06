import { chromium } from '@playwright/test';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1536, height: 960 } });
await p.goto('http://localhost:5311/?reduced', { waitUntil: 'networkidle' });
await p.keyboard.press('Control+,'); await p.waitForTimeout(800);
await p.getByRole('button', { name: /Controller/ }).first().click(); await p.waitForTimeout(800);
const l = p.locator('.pad-legend'); await l.scrollIntoViewIfNeeded(); await p.waitForTimeout(400);
await l.screenshot({ path: process.argv[2] }); await b.close();
