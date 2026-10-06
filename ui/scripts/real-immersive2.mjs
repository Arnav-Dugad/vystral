// Dev helper: tours v0.5 Immersive features in the running real app (CDP port 9333).
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const shot = async (n) => { await page.waitForTimeout(900); await page.screenshot({ path: `${out}/${n}.png` }); };
const skip = page.getByRole('button', { name: /Skip tour/i });
if (await skip.count()) await skip.click();
await shot('imm-home');
await page.keyboard.press('m'); await shot('imm-quickmenu'); await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await page.keyboard.press('Enter'); await shot('imm-gamepage');
await page.keyboard.press('e'); await shot('imm-gamepage-tab2');
await page.keyboard.press('Escape'); await page.waitForTimeout(600);
await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await shot('imm-rows');
console.log('errors', JSON.stringify(errors));
await browser.close();
