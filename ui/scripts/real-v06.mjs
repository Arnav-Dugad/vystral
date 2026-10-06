// Dev helper: tours v0.6 features in the running real app (CDP port 9333). Changes no settings.
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const nav = (n) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${n}`) }).first().click();
const shot = async (n) => { await page.waitForTimeout(1300); await page.screenshot({ path: `${out}/${n}.png` }); };
if (await page.locator('.imm').count()) { await page.keyboard.press('F11'); await page.waitForTimeout(2500); }
await nav('Home'); await shot('home');
await nav('Library'); await page.waitForTimeout(800); await shot('library');
await page.getByRole('button', { name: /Library health/ }).first().click(); await page.waitForTimeout(3500); await shot('health');
await page.mouse.wheel(0, 900); await shot('health2');
await nav('Library'); await page.waitForTimeout(800);
await page.locator('.vgrid .card[aria-label^="EA SPORTS FC 26"]').first().click(); await page.waitForTimeout(2500); await shot('detail');
const ctl = page.getByRole('tab', { name: /Controls/ }).first();
if (await ctl.count()) { await ctl.click(); await page.waitForTimeout(2500); await shot('detail-controls'); } else console.log('no controls tab');
await nav('Storage'); await page.waitForTimeout(2500); await shot('storage');
await nav('Settings'); await page.getByRole('button', { name: 'Cloud play' }).first().click(); await shot('settings-cloud');
await page.getByRole('button', { name: /Controller/ }).first().click(); await shot('settings-controller');
const voices = await page.evaluate(() => new Promise((r) => { const v = () => speechSynthesis.getVoices().map((x) => `${x.name}|${x.lang}|local=${x.localService}`); const now = v(); if (now.length) r(now); else { speechSynthesis.onvoiceschanged = () => r(v()); setTimeout(() => r(v()), 3000); } }));
console.log('voices', JSON.stringify(voices));
await page.keyboard.press('F11'); await page.waitForTimeout(4000); await shot('imm-home');
await page.keyboard.press('Enter'); await page.waitForTimeout(1800); await shot('imm-page');
for (let i = 0; i < 4; i++) { await page.keyboard.press('e'); await page.waitForTimeout(500); }
await shot('imm-page-controls');
await page.keyboard.press('Escape'); await page.waitForTimeout(1200);
console.log('errors', JSON.stringify(errors));
await browser.close();
