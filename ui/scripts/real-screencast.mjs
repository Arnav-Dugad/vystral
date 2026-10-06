// Dev helper: records a CDP screencast of the running real app (port 9333) while pressing a key, saving frames.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const [, , out = '.', key = 'F11', prefix = 'f'] = process.argv;
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('vystral'));
const cdp = await page.context().newCDPSession(page);
const frames = [];
const t0 = Date.now();
cdp.on('Page.screencastFrame', async (f) => {
  frames.push({ t: Date.now() - t0, data: f.data });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 960, everyNthFrame: 1 });
await page.waitForTimeout(300);
await page.keyboard.press(key);
await page.waitForTimeout(2600);
await cdp.send('Page.stopScreencast');
console.log('frames', frames.length, frames.map((f) => f.t).join(','));
const pick = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.7, 0.9].map((q) => frames[Math.min(frames.length - 1, Math.floor(q * frames.length))]);
pick.forEach((f, i) => writeFileSync(`${out}/${prefix}-${i}-${f.t}ms.jpg`, Buffer.from(f.data, 'base64')));
await browser.close();
