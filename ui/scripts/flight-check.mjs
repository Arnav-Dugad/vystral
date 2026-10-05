// Dev helper: card -> detail flight and exact return (scroll + focus) on Back.
import { chromium } from '@playwright/test';

const out = '../.playwright-mcp/imm';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1536, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/?nointro&games=400');
await page.waitForSelector('.shell [data-game-id]');
await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
await page.waitForSelector('.vgrid [data-game-id]');
await page.waitForTimeout(600);
// Scroll well down the grid, then open a card that is on screen.
await page.evaluate(() => (document.querySelector('[data-scroll-main]').scrollTop = 2400));
await page.waitForTimeout(1500); // let smooth scrolling settle
const target = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.vgrid button.card')].filter((c) => {
    const r = c.getBoundingClientRect();
    return r.top > 150 && r.bottom < innerHeight - 50;
  });
  const c = cards[3];
  return { id: c.getAttribute('data-game-id'), label: c.getAttribute('aria-label') };
});
const scrollBefore = await page.evaluate(() => document.querySelector('[data-scroll-main]').scrollTop);
await page.locator(`.vgrid button.card[data-game-id="${target.id}"]`).click();
await page.waitForTimeout(90);
await page.screenshot({ path: `${out}/flight-1-mid.png` });
await page.waitForTimeout(160);
await page.screenshot({ path: `${out}/flight-2-mid.png` });
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/flight-3-detail.png` });
await page.keyboard.press('Alt+ArrowLeft');
const trace = await page.evaluate(async () => {
  const t = [];
  for (let i = 0; i < 14; i++) {
    const els = [...document.querySelectorAll('[data-scroll-main]')];
    t.push(els.map((e) => Math.round(e.scrollTop) + '/' + Math.round(e.scrollHeight)).join(' | '));
    await new Promise((r) => setTimeout(r, 60));
  }
  return t;
});
console.log('trace', trace);
await page.screenshot({ path: `${out}/flight-4-return-mid.png` });
await page.waitForTimeout(1100);
const after = await page.evaluate(() => ({
  scroll: document.querySelector('[data-scroll-main]').scrollTop,
  focused: document.activeElement?.getAttribute('data-game-id'),
}));
await page.screenshot({ path: `${out}/flight-5-returned.png` });
console.log({ target, scrollBefore, after, scrollRestored: Math.abs(after.scroll - scrollBefore) < 4, focusRestored: after.focused === target.id, errors });
await browser.close();
